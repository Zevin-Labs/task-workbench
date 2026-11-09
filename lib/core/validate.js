// 任务入参校验：UI 与 AI 工具共用；错误统一抛 TaskError('validation-error')。
// 文本只保留产品语义限制：标题单行、详情多行（存储/API 字段名仍为 note），长度上限；
// 不再因旧 Markdown 分隔符禁字符。
import {
  NOTE_MAX, PRIORITIES, TASK_ID_RE, TITLE_MAX, TaskError, isPriority, isValidDate, isValidTime,
} from './contract.js'

function fail(message) {
  throw new TaskError('validation-error', message, 400)
}

export function assertTaskId(taskId) {
  const text = typeof taskId === 'string' ? taskId.trim() : ''
  if (!TASK_ID_RE.test(text) || Number(text.slice(2)) <= 0) fail('任务 ID 必须形如 T-1')
  return text
}

/**
 * 清理文本字段。
 * 默认单行：拒绝换行；multiline: true 时允许换行，并先把 \r\n 与孤立 \r 归一化为 \n 再 trim。
 */
function cleanText(value, { field, max, multiline = false }) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(`${field}必须是文本`)
  if (!multiline && /[\r\n]/.test(value)) fail(`${field}不能包含换行`)
  const normalized = multiline ? value.replace(/\r\n?/g, '\n') : value
  const text = normalized.trim()
  if (text.length > max) fail(`${field}最多 ${max} 个字`)
  return text
}

/** 可选时间 HH:mm；空值表示全天。 */
function cleanOptionalTime(value, field) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !isValidTime(value)) fail(`${field}必须是 HH:mm（24 小时制），留空表示全天`)
  return value
}

/** 可选日期 YYYY-MM-DD；空值表示不设置。 */
function cleanOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !isValidDate(value)) fail(`${field}必须是合法的 YYYY-MM-DD`)
  return value
}

/** 校验一条任务整体时间口径（创建与编辑合并后都走这里）。 */
export function assertTaskTiming(task) {
  const date = task?.date
  if (!isValidDate(date)) fail('日期必须是合法的 YYYY-MM-DD')
  const time = cleanOptionalTime(task?.time, '时间')
  const endDate = cleanOptionalDate(task?.endDate, '结束日期')
  const endTime = cleanOptionalTime(task?.endTime, '结束时间')
  if (endDate === '') {
    if (endTime !== '') fail('结束时间需要同时提供结束日期；单日任务只支持一个时间')
  } else {
    if (endDate <= date) fail('跨周期任务的结束日期必须晚于开始日期；同一天的任务请用「当天」类型')
  }
  return { time, endDate, endTime }
}

/** 新建任务的入参规整。date 缺省为今天。 */
export function normalizeCreateInput(input = {}, today) {
  const title = cleanText(input.title, { field: '标题', max: TITLE_MAX })
  if (!title) fail('标题不能为空')
  const date = input.date === undefined || input.date === null || input.date === '' ? today : input.date
  if (typeof date !== 'string' || !isValidDate(date)) fail('日期必须是合法的 YYYY-MM-DD')
  const time = cleanOptionalTime(input.time, '时间')
  const endDate = cleanOptionalDate(input.endDate, '结束日期')
  const endTime = cleanOptionalTime(input.endTime, '结束时间')
  if (endDate === '' && endTime !== '') fail('结束时间需要同时提供结束日期；单日任务只支持一个时间')
  if (endDate !== '' && endDate <= date) fail('跨周期任务的结束日期必须晚于开始日期；同一天的任务请用「当天」类型')
  let priority = input.priority === undefined || input.priority === null || input.priority === '' ? null : input.priority
  if (priority !== null && !isPriority(priority)) fail('优先级只能是：' + PRIORITIES.join(' / '))
  const note = cleanText(input.note, { field: '详情', max: NOTE_MAX, multiline: true })
  return { title, date, time, endDate, endTime, priority, note }
}

/** 编辑任务的字段白名单。可选字段传空字符串或 null 表示清除。 */
export function normalizeUpdateChanges(changes = {}) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) fail('changes 必须是对象')
  const allowed = new Set(['title', 'date', 'time', 'endDate', 'endTime', 'priority', 'note'])
  const unknown = Object.keys(changes).filter((key) => !allowed.has(key))
  if (unknown.length > 0) fail(`不支持修改字段：${unknown.join('、')}`)
  const out = {}
  if (Object.prototype.hasOwnProperty.call(changes, 'title')) {
    const title = cleanText(changes.title, { field: '标题', max: TITLE_MAX })
    if (!title) fail('标题不能为空')
    out.title = title
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'date')) {
    if (typeof changes.date !== 'string' || !isValidDate(changes.date)) fail('日期必须是合法的 YYYY-MM-DD')
    out.date = changes.date
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'time')) {
    out.time = cleanOptionalTime(changes.time, '时间')
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'endDate')) {
    out.endDate = cleanOptionalDate(changes.endDate, '结束日期')
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'endTime')) {
    out.endTime = cleanOptionalTime(changes.endTime, '结束时间')
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'priority')) {
    if (!isPriority(changes.priority)) fail('优先级只能是：' + PRIORITIES.join(' / '))
    out.priority = changes.priority
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'note')) {
    out.note = cleanText(changes.note, { field: '详情', max: NOTE_MAX, multiline: true })
  }
  if (Object.keys(out).length === 0) fail('没有要修改的字段')
  return out
}
