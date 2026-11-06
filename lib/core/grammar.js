// Markdown 分片语法：解析、校验、序列化。
// 原则：能读就读、能保留就保留；未涉及的行逐字节不动（写入器只替换/插入/移除目标行）。
import {
  DEFAULT_PRIORITY, FIELD_SEP, FORMAT_VERSION, PRIORITIES, SECTION_DONE, SECTION_TODO,
  TASK_ID_RE, isValidDate, isValidTime, singleLine,
} from './contract.js'

const TASK_LINE_RE = /^(\s*)- \[([ xX])\]\s+`(T-\d{8}-\d{2})`(?:\s*｜\s*(.*))?$/
const H2_RE = /^##\s+(.*?)\s*$/
const FIELD_RE = /^([^：:]{1,12})[：:]\s*(.*)$/
const KNOWN_FIELDS = new Set(['日期', '时间', '结束日期', '结束时间', '优先级', '备注', '完成'])

function canonicalPriority(value) {
  return PRIORITIES.includes(value) ? value : DEFAULT_PRIORITY
}

/** 一行的字段解析：返回 { title, fields, unknown, warning }。 */
function parseTaskBody(body) {
  const parts = String(body ?? '').split(FIELD_SEP)
  const title = parts.shift() ?? ''
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
      // 未知键原样保留在行末，写入器不丢字段、也不重排。
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
  return { title, fields, unknown, warnings }
}

/** 序列化一条任务行（canonical 形式）。 */
export function buildTaskLine(task) {
  const done = task.done === true
  const parts = [`- [${done ? 'x' : ' '}] \`${task.id}\`${FIELD_SEP}${task.title}`]
  if (task.date) parts.push(`日期：${task.date}`)
  if (task.time) parts.push(`时间：${task.time}`)
  if (task.endDate) parts.push(`结束日期：${task.endDate}`)
  if (task.endTime) parts.push(`结束时间：${task.endTime}`)
  const priority = canonicalPriority(task.priority)
  if (priority !== DEFAULT_PRIORITY) parts.push(`优先级：${priority}`)
  if (task.note) parts.push(`备注：${task.note}`)
  for (const raw of task.unknown ?? []) parts.push(raw)
  if (done) parts.push(`完成：${task.completed || task.date || ''}`)
  return parts.join(FIELD_SEP)
}

function normalizeText(text) {
  let value = String(text ?? '')
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
  return value.replace(/\r\n?/g, '\n')
}

/**
 * 解析一份月分片。
 * @returns {{
 *   lines: string[], frontmatter: object|null, sections: object,
 *   tasks: object[], warnings: string[], errors: object[],
 *   readOnly: boolean, readOnlyReason: string|null, format: number,
 * }}
 */
export function parseShard(text, { file = '' } = {}) {
  const normalized = normalizeText(text)
  const rawLines = normalized.split('\n')
  // 末尾换行会切出一个空串；模型里不保留这个尾元素，序列化时统一补一个换行。
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
      message: `分片格式版本为 ${formatText ?? '空'}，当前只支持 format: ${FORMAT_VERSION}，只读打开`,
    })
  }

  // H2 区块
  const headings = []
  for (let i = bodyStart; i < lines.length; i++) {
    const m = H2_RE.exec(lines[i])
    if (m) headings.push({ index: i, title: m[1].trim() })
  }
  const pick = (name) => headings.filter((h) => h.title === name)
  const todoHeads = pick(SECTION_TODO)
  const doneHeads = pick(SECTION_DONE)
  if (todoHeads.length !== 1) {
    errors.push({ code: 'parse-error', message: `需要且只能有一个「## ${SECTION_TODO}」区块，实际 ${todoHeads.length} 个` })
  }
  if (doneHeads.length !== 1) {
    errors.push({ code: 'parse-error', message: `需要且只能有一个「## ${SECTION_DONE}」区块，实际 ${doneHeads.length} 个` })
  }
  const sectionOf = (head) => {
    if (!head) return null
    const next = headings.find((h) => h.index > head.index)
    return { headingIndex: head.index, start: head.index + 1, end: next ? next.index : lines.length }
  }
  const sections = { todo: sectionOf(todoHeads[0]), done: sectionOf(doneHeads[0]) }

  const tasks = []
  const seen = new Map()
  for (const [sectionKey, section] of Object.entries(sections)) {
    if (!section) continue
    const occursInDone = sectionKey === 'done'
    for (let i = section.start; i < section.end; i++) {
      const line = lines[i]
      if (!line.trim().startsWith('-')) continue
      const m = TASK_LINE_RE.exec(line)
      if (!m) {
        const looksLikeTask = /T-\d{8}-\d{2}/.test(line)
        warnings.push(`${file || '分片'}:${i + 1} 不是合法的任务行${looksLikeTask ? '（ID 格式或格式不符）' : ''}，已原样保留`)
        continue
      }
      const checked = m[2].toLowerCase() === 'x'
      const body = parseTaskBody(m[4])
      const taskWarnings = [...body.warnings]
      if (!body.title.trim()) taskWarnings.push('标题为空')
      const checkedSection = occursInDone
      if (checked !== checkedSection) {
        taskWarnings.push(checked ? '已完成任务出现在「## 任务」区块' : '未完成任务出现在「## 已完成」区块')
      }
      const date = body.fields['日期'] ?? null
      if (!date) taskWarnings.push('缺少日期')
      const time = body.fields['时间'] ?? null
      if (time !== null && !isValidTime(time)) taskWarnings.push(`时间「${time}」不是 HH:mm，按全天处理`)
      const endDate = body.fields['结束日期'] ?? null
      if (endDate !== null && !isValidDate(endDate)) {
        taskWarnings.push(`结束日期「${endDate}」不是合法的 YYYY-MM-DD，按单日任务处理`)
      } else if (endDate && date && endDate <= date) {
        taskWarnings.push('结束日期必须晚于开始日期，按单日任务处理')
      }
      const endTime = body.fields['结束时间'] ?? null
      if (endTime !== null && !isValidTime(endTime)) taskWarnings.push(`结束时间「${endTime}」不是 HH:mm，已忽略`)
      if (!endDate && endTime) taskWarnings.push('有结束时间但缺少结束日期，结束时间已忽略')
      const completed = body.fields['完成'] ?? null
      if (checked && !completed) taskWarnings.push('已完成但缺少完成日期')
      if (!checked && completed) taskWarnings.push('未完成但带有完成日期')
      const priority = canonicalPriority(body.fields['优先级'])
      if (body.fields['优先级'] !== undefined && !PRIORITIES.includes(body.fields['优先级'])) {
        taskWarnings.push(`优先级「${body.fields['优先级']}」非法，按默认值处理`)
      }
      const id = m[3]
      if (seen.has(id)) {
        warnings.push(`任务 ID 重复：${id}（第 ${seen.get(id) + 1} 行与第 ${i + 1} 行）`)
      } else {
        seen.set(id, i)
      }
      tasks.push({
        id,
        title: body.title.trim(),
        date,
        time,
        endDate,
        endTime,
        priority,
        done: checked,
        note: body.fields['备注'] ?? '',
        completed,
        unknown: body.unknown,
        section: sectionKey,
        lineIndex: i,
        order: i,
        warnings: taskWarnings,
      })
    }
  }
  // 按文件行序编号（用于稳定排序）
  tasks.sort((a, b) => a.lineIndex - b.lineIndex)
  tasks.forEach((task, index) => { task.order = index })

  const readOnly = errors.length > 0
  const readOnlyReason = readOnly ? errors[0].code : null
  return {
    lines,
    frontmatter,
    sections,
    tasks,
    warnings,
    errors,
    readOnly,
    readOnlyReason,
    format,
  }
}

export function serializeShard(model) {
  return `${model.lines.join('\n')}\n`
}

export function findTask(model, taskId) {
  return model.tasks.find((task) => task.id === taskId) ?? null
}

/** 更新 frontmatter 的 updated 行；没有该字段就保持原样。 */
function touchUpdated(lines, frontmatter, today) {
  if (!frontmatter || frontmatter.updatedLine < 0) return lines
  lines[frontmatter.updatedLine] = `updated: ${today}`
  return lines
}

/** 往指定区块末尾插入一行；自动跳过区块尾部空行。 */
export function appendTaskLine(text, sectionKey, task, today) {
  const model = parseShard(text)
  if (model.readOnly) {
    const error = model.errors[0]
    throw Object.assign(new Error(error.message), { code: error.code, status: 422 })
  }
  const section = model.sections[sectionKey]
  if (!section) {
    throw Object.assign(new Error(`缺少「## ${sectionKey === 'todo' ? SECTION_TODO : SECTION_DONE}」区块`), {
      code: 'parse-error', status: 422,
    })
  }
  const lines = [...model.lines]
  const line = buildTaskLine(task)
  let index = section.end
  while (index > section.start && lines[index - 1].trim() === '') index--
  if (index === section.start) {
    lines.splice(section.start, 0, '', line)
  } else {
    lines.splice(index, 0, line)
  }
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 删除一行任务；顺手合并因此产生的连续空行。 */
export function removeTaskLine(text, taskId, today) {
  const model = parseShard(text)
  if (model.readOnly) {
    const error = model.errors[0]
    throw Object.assign(new Error(error.message), { code: error.code, status: 422 })
  }
  const task = findTask(model, taskId)
  if (!task) {
    throw Object.assign(new Error(`任务 ${taskId} 不存在`), { code: 'not-found', status: 404 })
  }
  const lines = [...model.lines]
  const index = task.lineIndex
  lines.splice(index, 1)
  if (index > 0 && lines[index - 1] === '' && lines[index] === '') lines.splice(index, 1)
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 原地替换一行任务（保持行位置，不做区块移动）。 */
export function replaceTaskLine(text, taskId, task, today) {
  const model = parseShard(text)
  if (model.readOnly) {
    const error = model.errors[0]
    throw Object.assign(new Error(error.message), { code: error.code, status: 422 })
  }
  const existing = findTask(model, taskId)
  if (!existing) {
    throw Object.assign(new Error(`任务 ${taskId} 不存在`), { code: 'not-found', status: 404 })
  }
  const lines = [...model.lines]
  lines[existing.lineIndex] = buildTaskLine(task)
  touchUpdated(lines, model.frontmatter, today)
  return `${lines.join('\n')}\n`
}

/** 读取/写入前统一把任务对象规整成可序列化字段。 */
export function normalizeTask(task) {
  return {
    id: task.id,
    title: String(task.title ?? '').trim(),
    date: task.date ?? null,
    time: isValidTime(task.time) ? task.time : null,
    endDate: isValidDate(task.endDate) ? task.endDate : null,
    endTime: isValidTime(task.endTime) ? task.endTime : null,
    priority: canonicalPriority(task.priority),
    done: task.done === true,
    note: singleLine(task.note ?? ''),
    completed: task.completed ? String(task.completed).slice(0, 10) : null,
    unknown: Array.isArray(task.unknown) ? task.unknown : [],
  }
}

export { TASK_LINE_RE, TASK_ID_RE }
