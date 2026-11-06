// 想法池 Markdown 语法：解析、序列化、追加 / 替换 / 删除想法块。
//
// 结构（单文件、不按月切）：
//   frontmatter（type: idea-pool, format: 1）+ 一个 `## 想法` 区块
//   每个想法 = 一行元数据 + 紧随其后的 2 空格缩进详细描述（空行结束描述块）
//
// 原则与任务清单一致：能读就读、能保留就保留；写入只动目标想法块，其他行逐字节不变。
import {
  DEFAULT_IDEA_MATURITY, DEFAULT_IDEA_STATUS, FIELD_SEP, FORMAT_VERSION,
  IDEA_DESC_MAX, IDEA_FILE_TYPE, IDEA_MATURITIES, IDEA_SECTION, IDEA_STATUSES,
  isIdeaMaturity, isIdeaStatus, isValidDate, singleLine,
} from './contract.js'

const IDEA_LINE_RE = /^- `(I-\d{8}-\d{2})`(?:\s*｜\s*(.*))?$/
const H2_RE = /^##\s+(.*?)\s*$/
const FIELD_RE = /^([^：:]{1,12})[：:]\s*(.*)$/
const KNOWN_FIELDS = new Set(['状态', '成熟度', '分类', '创建', '更新', '完成'])
const DESC_INDENT = '  '

function canonicalStatus(value) {
  return IDEA_STATUSES.includes(value) ? value : DEFAULT_IDEA_STATUS
}

function canonicalMaturity(value) {
  return IDEA_MATURITIES.includes(value) ? value : DEFAULT_IDEA_MATURITY
}

/** 详细描述规整：去 BOM、统一换行、去行尾空白、去首尾空行；保留内部空行。 */
export function normalizeIdeaDescription(value) {
  let text = String(value ?? '')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

/** 一行的字段解析：返回 { name, fields, unknown, warnings }。 */
function parseIdeaBody(body) {
  const parts = String(body ?? '').split(FIELD_SEP)
  const name = (parts.shift() ?? '').trim()
  const fields = {}
  const unknown = []
  const warnings = []
  for (const part of parts) {
    if (part === '') continue
    const m = FIELD_RE.exec(part)
    if (!m) {
      unknown.push(part)
      warnings.push(`无法识别的字段「${part.slice(0, 40)}」，已原样保留`)
      continue
    }
    const key = m[1].trim()
    const value = m[2].trim()
    if (!KNOWN_FIELDS.has(key)) {
      unknown.push(part)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      unknown.push(part)
      warnings.push(`重复字段「${key}」，后一个已原样保留`)
      continue
    }
    fields[key] = value
  }
  return { name, fields, unknown, warnings }
}

/** 序列化想法元数据行（canonical 形式）。 */
export function buildIdeaLine(idea) {
  const parts = [`- \`${idea.id}\`${FIELD_SEP}${idea.name}`]
  parts.push(`状态：${canonicalStatus(idea.status)}`)
  parts.push(`成熟度：${canonicalMaturity(idea.maturity)}`)
  if (idea.category) parts.push(`分类：${idea.category}`)
  if (idea.created) parts.push(`创建：${idea.created}`)
  if (idea.updated) parts.push(`更新：${idea.updated}`)
  if (idea.completed) parts.push(`完成：${idea.completed}`)
  for (const raw of idea.unknown ?? []) parts.push(raw)
  return parts.join(FIELD_SEP)
}

/** 序列化一个完整想法块（元数据行 + 缩进描述行）。 */
export function buildIdeaBlock(idea) {
  const lines = [buildIdeaLine(idea)]
  const description = normalizeIdeaDescription(idea.description)
  if (description !== '') {
    for (const line of description.split('\n')) lines.push(`${DESC_INDENT}${line}`)
  }
  return lines.join('\n')
}

function normalizeText(text) {
  let value = String(text ?? '')
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
  return value.replace(/\r\n?/g, '\n')
}

/**
 * 解析想法池文件。
 * @returns {{
 *   lines: string[], frontmatter: object|null, section: object|null,
 *   ideas: object[], warnings: string[], errors: object[],
 *   readOnly: boolean, readOnlyReason: string|null, format: number,
 * }}
 */
export function parseIdeaPool(text, { file = '' } = {}) {
  const normalized = normalizeText(text)
  const rawLines = normalized.split('\n')
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines

  const warnings = []
  const errors = []
  let frontmatter = null
  let bodyStart = 0

  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (close === -1) {
      errors.push({ code: 'parse-error', message: 'frontmatter 缺少结束分隔线 ---' })
    } else {
      const fields = {}
      let updatedLine = -1
      for (let i = 1; i < close; i++) {
        const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i])
        if (!m) continue
        fields[m[1]] = m[2].trim()
        if (m[1] === 'updated') updatedLine = i
      }
      frontmatter = { fields, start: 0, end: close, updatedLine }
      bodyStart = close + 1
    }
  }

  const formatText = frontmatter?.fields.format
  let format = Number.parseInt(formatText ?? '', 10)
  if (!Number.isFinite(format)) format = 0
  if (!frontmatter) {
    errors.push({ code: 'format-version-unsupported', message: '缺少 frontmatter（format: 1），只读打开' })
  } else if (format !== FORMAT_VERSION) {
    errors.push({
      code: 'format-version-unsupported',
      message: `文件格式版本为 ${formatText ?? '空'}，当前只支持 format: ${FORMAT_VERSION}，只读打开`,
    })
  } else if (frontmatter.fields.type !== IDEA_FILE_TYPE) {
    errors.push({
      code: 'parse-error',
      message: `不是想法池文件（type: ${frontmatter.fields.type ?? '空'}），只读打开`,
    })
  }

  const headings = []
  for (let i = bodyStart; i < lines.length; i++) {
    const m = H2_RE.exec(lines[i])
    if (m) headings.push({ index: i, title: m[1].trim() })
  }
  const ideaHeads = headings.filter((head) => head.title === IDEA_SECTION)
  if (ideaHeads.length !== 1) {
    errors.push({
      code: 'parse-error',
      message: `需要且只能有一个「## ${IDEA_SECTION}」区块，实际 ${ideaHeads.length} 个`,
    })
  }
  const next = ideaHeads[0] ? headings.find((head) => head.index > ideaHeads[0].index) : null
  const section = ideaHeads[0]
    ? { headingIndex: ideaHeads[0].index, start: ideaHeads[0].index + 1, end: next ? next.index : lines.length }
    : null

  const ideas = []
  const seen = new Map()
  if (section) {
    let i = section.start
    while (i < section.end) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      const m = IDEA_LINE_RE.exec(line)
      if (!m) {
        warnings.push(`${file || '想法池'}:${i + 1} 不是合法的想法行，已原样保留`)
        i += 1
        continue
      }
      const id = m[1]
      const body = parseIdeaBody(m[2])
      const ideaWarnings = [...body.warnings]
      if (!body.name) ideaWarnings.push('想法名称为空')

      let j = i + 1
      const descLines = []
      while (j < section.end && lines[j].startsWith(DESC_INDENT)) {
        descLines.push(lines[j].slice(DESC_INDENT.length))
        j += 1
      }
      const description = descLines.join('\n')
      if (description.length > IDEA_DESC_MAX) {
        ideaWarnings.push(`详细描述超过 ${IDEA_DESC_MAX} 字，已完整保留`)
      }

      const statusRaw = body.fields['状态']
      const status = canonicalStatus(statusRaw)
      if (statusRaw !== undefined && !isIdeaStatus(statusRaw)) {
        ideaWarnings.push(`状态「${statusRaw}」非法，按「${DEFAULT_IDEA_STATUS}」处理`)
      }
      const maturityRaw = body.fields['成熟度']
      const maturity = canonicalMaturity(maturityRaw)
      if (maturityRaw !== undefined && !isIdeaMaturity(maturityRaw)) {
        ideaWarnings.push(`成熟度「${maturityRaw}」非法，按「${DEFAULT_IDEA_MATURITY}」处理`)
      }

      const idDate = `${id.slice(2, 6)}-${id.slice(6, 8)}-${id.slice(8, 10)}`
      const createdRaw = body.fields['创建']
      const created = createdRaw && isValidDate(createdRaw) ? createdRaw : idDate
      if (createdRaw !== undefined && !isValidDate(createdRaw)) {
        ideaWarnings.push(`创建日期「${createdRaw}」非法，按 ID 日期处理`)
      }
      const updatedRaw = body.fields['更新']
      const updated = updatedRaw && isValidDate(updatedRaw) ? updatedRaw : created
      if (updatedRaw !== undefined && !isValidDate(updatedRaw)) {
        ideaWarnings.push(`更新日期「${updatedRaw}」非法，按创建日期处理`)
      }
      const completedRaw = body.fields['完成']
      let completed = completedRaw && isValidDate(completedRaw) ? completedRaw : null
      if (completedRaw !== undefined && !isValidDate(completedRaw)) {
        ideaWarnings.push(`完成日期「${completedRaw}」非法，已忽略`)
      }
      if (status === '完成' && !completed) ideaWarnings.push('状态为完成但缺少完成日期')
      if (status !== '完成' && completed) {
        ideaWarnings.push('非完成状态但带有完成日期，已忽略')
        completed = null
      }

      if (seen.has(id)) {
        warnings.push(`想法 ID 重复：${id}（第 ${seen.get(id) + 1} 行与第 ${i + 1} 行）`)
      } else {
        seen.set(id, i)
      }

      ideas.push({
        id,
        name: body.name,
        description,
        status,
        maturity,
        category: body.fields['分类'] ?? '',
        created,
        updated,
        completed,
        unknown: body.unknown,
        lineIndex: i,
        descStart: i + 1,
        endLine: j,
        order: 0,
        warnings: ideaWarnings,
      })
      i = j
    }
  }
  ideas.forEach((idea, index) => { idea.order = index })

  const readOnly = errors.length > 0
  return {
    lines,
    frontmatter,
    section,
    ideas,
    warnings,
    errors,
    readOnly,
    readOnlyReason: readOnly ? errors[0].code : null,
    format,
  }
}

export function serializePool(model) {
  return `${model.lines.join('\n')}\n`
}

export function findIdea(model, ideaId) {
  return model.ideas.find((idea) => idea.id === ideaId) ?? null
}

/** 更新 frontmatter 的 updated 行；没有该字段就保持原样。 */
function touchUpdated(lines, frontmatter, today) {
  if (!frontmatter || frontmatter.updatedLine < 0) return lines
  lines[frontmatter.updatedLine] = `updated: ${today}`
  return lines
}

function assertWritable(model) {
  if (model.readOnly) {
    const error = model.errors[0]
    throw Object.assign(new Error(error.message), { code: error.code, status: 422 })
  }
}

function assertSection(model) {
  if (!model.section) {
    throw Object.assign(new Error(`缺少「## ${IDEA_SECTION}」区块`), { code: 'parse-error', status: 422 })
  }
}

/** 在区块末尾追加一个想法块；块与块之间留一个空行。 */
export function appendIdeaBlock(text, idea, today) {
  const model = parseIdeaPool(text)
  assertWritable(model)
  assertSection(model)
  const lines = [...model.lines]
  const block = buildIdeaBlock(idea).split('\n')
  let index = model.section.end
  while (index > model.section.start && lines[index - 1].trim() === '') index -= 1
  lines.splice(index, 0, '', ...block)
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 原地替换一个想法块（元数据 + 描述），保持块位置。 */
export function replaceIdeaBlock(text, ideaId, idea, today) {
  const model = parseIdeaPool(text)
  assertWritable(model)
  const existing = findIdea(model, ideaId)
  if (!existing) {
    throw Object.assign(new Error(`想法 ${ideaId} 不存在`), { code: 'not-found', status: 404 })
  }
  const lines = [...model.lines]
  const block = buildIdeaBlock(idea).split('\n')
  lines.splice(existing.lineIndex, existing.endLine - existing.lineIndex, ...block)
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 删除一个想法块；顺手合并因此产生的连续空行。 */
export function removeIdeaBlock(text, ideaId, today) {
  const model = parseIdeaPool(text)
  assertWritable(model)
  const existing = findIdea(model, ideaId)
  if (!existing) {
    throw Object.assign(new Error(`想法 ${ideaId} 不存在`), { code: 'not-found', status: 404 })
  }
  const lines = [...model.lines]
  lines.splice(existing.lineIndex, existing.endLine - existing.lineIndex)
  const index = existing.lineIndex
  if (index > 0 && lines[index - 1] === '' && (lines[index] === '' || lines[index] === undefined)) {
    lines.splice(index, 1)
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 读取 / 写入前统一把想法对象规整成可序列化字段。 */
export function normalizeIdea(idea) {
  return {
    id: idea.id,
    name: String(idea.name ?? '').trim(),
    description: normalizeIdeaDescription(idea.description ?? ''),
    status: canonicalStatus(idea.status),
    maturity: canonicalMaturity(idea.maturity),
    category: singleLine(idea.category ?? ''),
    created: isValidDate(idea.created) ? idea.created : null,
    updated: isValidDate(idea.updated) ? idea.updated : null,
    completed: idea.completed && isValidDate(idea.completed) ? idea.completed : null,
    unknown: Array.isArray(idea.unknown) ? idea.unknown : [],
  }
}

export { IDEA_LINE_RE, DESC_INDENT }
