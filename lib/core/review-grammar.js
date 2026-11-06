// 复盘 Markdown 语法：解析、序列化、追加 / 替换 / 删除复盘块。
//
// 结构（每类一个单文件、不按月切）：
//   frontmatter（type: review-daily|review-weekly|review-monthly, format: 1）+ 一个 `## 记录` 区块
//   每条复盘 = 一行元数据 + 紧随其后的 2 空格缩进正文（空行结束正文块）
//
// 与想法池同一套容错原则：能读就读、能保留就保留；写入只动目标复盘块，其他行逐字节不变。
import { FORMAT_VERSION } from './contract.js'
import {
  FIELD_SEP, REVIEW_FILE_TYPES, REVIEW_SECTION, REVIEW_TEXT_MAX, isReviewKey,
} from './review-contract.js'

const ENTRY_LINE_RE = /^- `([^`]+)`(?:\s*｜\s*(.*))?$/
const H2_RE = /^##\s+(.*?)\s*$/
const FIELD_RE = /^([^：:]{1,12})[：:]\s*(.*)$/
const KNOWN_FIELDS = new Set(['更新'])
const BODY_INDENT = '  '
const UPDATED_AT_RE = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?$/

/** 正文规整：去 BOM、统一换行、去行尾空白、去首尾空行；保留内部空行。 */
export function normalizeReviewText(value) {
  let text = String(value ?? '')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

function normalizeText(text) {
  let value = String(text ?? '')
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
  return value.replace(/\r\n?/g, '\n')
}

/** 解析元数据行：返回 { fields, unknown, warnings }。 */
function parseEntryBody(body) {
  const parts = String(body ?? '').split(FIELD_SEP)
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
  return { fields, unknown, warnings }
}

/** 序列化复盘元数据行（canonical 形式）。 */
export function buildReviewLine(review) {
  const parts = [`- \`${review.key}\`${FIELD_SEP}更新：${review.updatedAt}`]
  for (const raw of review.unknown ?? []) parts.push(raw)
  return parts.join(FIELD_SEP)
}

/** 序列化一个完整复盘块（元数据行 + 缩进正文行）。 */
export function buildReviewBlock(review) {
  const lines = [buildReviewLine(review)]
  const text = normalizeReviewText(review.text)
  if (text !== '') {
    for (const line of text.split('\n')) lines.push(`${BODY_INDENT}${line}`)
  }
  return lines.join('\n')
}

/**
 * 解析一个复盘文件。
 * @param {string} text
 * @param {{ kind: string, file?: string }} options
 */
export function parseReviewFile(text, { kind, file = '' } = {}) {
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
  const expectedType = REVIEW_FILE_TYPES[kind]
  if (!frontmatter) {
    errors.push({ code: 'format-version-unsupported', message: '缺少 frontmatter（format: 1），只读打开' })
  } else if (format !== FORMAT_VERSION) {
    errors.push({
      code: 'format-version-unsupported',
      message: `文件格式版本为 ${formatText ?? '空'}，当前只支持 format: ${FORMAT_VERSION}，只读打开`,
    })
  } else if (frontmatter.fields.type !== expectedType) {
    errors.push({
      code: 'parse-error',
      message: `不是${kind === 'daily' ? '日' : kind === 'weekly' ? '周' : '月'}复盘文件（type: ${frontmatter.fields.type ?? '空'}），只读打开`,
    })
  }

  const headings = []
  for (let i = bodyStart; i < lines.length; i++) {
    const m = H2_RE.exec(lines[i])
    if (m) headings.push({ index: i, title: m[1].trim() })
  }
  const sectionHeads = headings.filter((head) => head.title === REVIEW_SECTION)
  if (sectionHeads.length !== 1) {
    errors.push({
      code: 'parse-error',
      message: `需要且只能有一个「## ${REVIEW_SECTION}」区块，实际 ${sectionHeads.length} 个`,
    })
  }
  const nextHead = sectionHeads[0] ? headings.find((head) => head.index > sectionHeads[0].index) : null
  const section = sectionHeads[0]
    ? { headingIndex: sectionHeads[0].index, start: sectionHeads[0].index + 1, end: nextHead ? nextHead.index : lines.length }
    : null

  const reviews = []
  const seen = new Map()
  if (section) {
    let i = section.start
    while (i < section.end) {
      const line = lines[i]
      if (line.trim() === '') {
        i += 1
        continue
      }
      const m = ENTRY_LINE_RE.exec(line)
      if (!m) {
        warnings.push(`${file || '复盘文件'}:${i + 1} 不是合法的复盘行，已原样保留`)
        i += 1
        continue
      }
      const key = m[1].trim()
      if (!isReviewKey(kind, key)) {
        warnings.push(`${file || '复盘文件'}:${i + 1} 复盘键「${key}」不符合${kind === 'daily' ? '日期' : kind === 'weekly' ? '周一日期' : '年月'}格式，已原样保留`)
        i += 1
        continue
      }
      const body = parseEntryBody(m[2])
      const entryWarnings = [...body.warnings]

      let j = i + 1
      const bodyLines = []
      while (j < section.end && lines[j].startsWith(BODY_INDENT)) {
        bodyLines.push(lines[j].slice(BODY_INDENT.length))
        j += 1
      }
      const content = normalizeReviewText(bodyLines.join('\n'))
      if (content.length > REVIEW_TEXT_MAX) entryWarnings.push(`复盘正文超过 ${REVIEW_TEXT_MAX} 字，已完整保留`)
      if (content === '') entryWarnings.push('复盘正文为空')

      const updatedRaw = body.fields['更新']
      let updatedAt = null
      if (updatedRaw !== undefined) {
        const match = UPDATED_AT_RE.exec(updatedRaw)
        if (!match) {
          entryWarnings.push(`更新时间「${updatedRaw}」格式非法，已忽略`)
        } else {
          updatedAt = match[2] ? `${match[1]} ${match[2]}` : match[1]
        }
      }
      if (updatedAt === null) {
        entryWarnings.push('缺少更新时间')
        updatedAt = key.length === 7 ? `${key}-01` : key
      }

      if (seen.has(key)) {
        warnings.push(`复盘周期重复：${key}（第 ${seen.get(key) + 1} 行与第 ${i + 1} 行）`)
      } else {
        seen.set(key, i)
      }

      reviews.push({
        key,
        kind,
        text: content,
        updatedAt,
        unknown: body.unknown,
        lineIndex: i,
        bodyStart: i + 1,
        endLine: j,
        order: 0,
        warnings: entryWarnings,
      })
      i = j
    }
  }
  reviews.forEach((review, index) => { review.order = index })

  const readOnly = errors.length > 0
  return {
    lines,
    frontmatter,
    section,
    reviews,
    warnings,
    errors,
    readOnly,
    readOnlyReason: readOnly ? errors[0].code : null,
    format,
  }
}

export function serializeReviewFile(model) {
  return `${model.lines.join('\n')}\n`
}

export function findReview(model, key) {
  return model.reviews.find((review) => review.key === key) ?? null
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
    throw Object.assign(new Error(`缺少「## ${REVIEW_SECTION}」区块`), { code: 'parse-error', status: 422 })
  }
}

/** 在区块末尾追加一条复盘；块与块之间留一个空行。 */
export function appendReviewBlock(text, kind, review, today) {
  const model = parseReviewFile(text, { kind })
  assertWritable(model)
  assertSection(model)
  const lines = [...model.lines]
  const block = buildReviewBlock(review).split('\n')
  let index = model.section.end
  while (index > model.section.start && lines[index - 1].trim() === '') index -= 1
  lines.splice(index, 0, '', ...block)
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 原地替换一条复盘（元数据 + 正文），保持块位置。 */
export function replaceReviewBlock(text, kind, key, review, today) {
  const model = parseReviewFile(text, { kind })
  assertWritable(model)
  const existing = findReview(model, key)
  if (!existing) {
    throw Object.assign(new Error(`复盘 ${key} 不存在`), { code: 'not-found', status: 404 })
  }
  const lines = [...model.lines]
  const block = buildReviewBlock(review).split('\n')
  lines.splice(existing.lineIndex, existing.endLine - existing.lineIndex, ...block)
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 删除一条复盘；顺手合并因此产生的连续空行。 */
export function removeReviewBlock(text, kind, key, today) {
  const model = parseReviewFile(text, { kind })
  assertWritable(model)
  const existing = findReview(model, key)
  if (!existing) {
    throw Object.assign(new Error(`复盘 ${key} 不存在`), { code: 'not-found', status: 404 })
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

