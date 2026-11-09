// 任务入参校验：UI 与 AI 工具共用；错误统一抛 TaskError('validation-error')。
// 文本只保留产品语义限制：标题单行、详情多行（存储/API 字段名仍为 note），长度上限；
// 时间模型：开始/截止都是「日期 + 整点」，未填由派生层补默认值（不落库）。
import {
  NOTE_MAX, PRIORITIES, TASK_ID_RE, TITLE_MAX,
  TaskError, effectiveInterval, isPriority, isValidDate, isValidTime,
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

/** 可选时刻 HH:mm；空值表示使用默认值。 */
function cleanOptionalTime(value, field) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !isValidTime(value)) fail(`${field}必须是 HH:mm（24 小时制），留空表示使用默认时间`)
  return value
}

/** 可选整点 HH:00（本阶段只新增整点，历史分钟值仍可原样保留）。 */
function cleanOptionalHour(value, field) {
  const time = cleanOptionalTime(value, field)
  if (time && !time.endsWith(':00')) fail(`${field}只支持整点（分钟为 00）`)
  return time
}

/** 可选日期 YYYY-MM-DD；空值表示不设置。 */
function cleanOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !isValidDate(value)) fail(`${field}必须是合法的 YYYY-MM-DD`)
  return value
}

/**
 * 校验并归一化任务时间区间。
 * - 截止日期允许等于开始日期；等于时归一化为空（= 当天任务，不落 end_date）。
 * - 用完整时刻比较：endAt 必须严格晚于 startAt；同一天即要求截止小时更晚。
 * - 历史分钟值（如 20:45）照常接受；新增值是否必须整点由调用路径决定。
 */
export function assertTaskTiming(task) {
  const date = task?.date
  if (!isValidDate(date)) fail('日期必须是合法的 YYYY-MM-DD')
  const time = cleanOptionalTime(task?.time, '开始时间')
  let endDate = cleanOptionalDate(task?.endDate, '截止日期')
  const endTime = cleanOptionalTime(task?.endTime, '截止时间')
  if (endDate !== '' && endDate < date) fail('截止日期不能早于开始日期')
  if (endDate === date) endDate = ''
  const interval = effectiveInterval({ date, time, endDate, endTime })
  if (!interval.startAt || !interval.endAt || interval.endAt <= interval.startAt) fail('截止时间必须晚于开始时间')
  return { time, endDate, endTime }
}

/**
 * 编辑变更「新值」策略：
 * - 新填/改动的开始/截止时刻必须是整点；
 * - 新填/改动的截止日期不能早于今天。
 * 与数据库现值相同的字段放行，兼容历史分钟值与历史日期。
 */
export function assertTaskChangePolicy(changes, existing, today) {
  for (const [field, label] of [['time', '开始时间'], ['endTime', '截止时间']]) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue
    const next = changes[field]
    const prev = existing?.[field] ?? ''
    if (next && next !== prev && !next.endsWith(':00')) fail(`${label}只支持整点（分钟为 00）`)
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'endDate')) {
    const next = changes.endDate
    const prev = existing?.endDate ?? ''
    if (next && next !== prev && today && next < today) fail('截止日期不能早于今天')
  }
}

/** 新建任务的入参规整。date 缺省为今天；时间缺省由派生层补 08:00 / 22:00。 */
export function normalizeCreateInput(input = {}, today) {
  const title = cleanText(input.title, { field: '标题', max: TITLE_MAX })
  if (!title) fail('标题不能为空')
  const date = input.date === undefined || input.date === null || input.date === '' ? today : input.date
  if (typeof date !== 'string' || !isValidDate(date)) fail('日期必须是合法的 YYYY-MM-DD')
  const time = cleanOptionalHour(input.time, '开始时间')
  const endDate = cleanOptionalDate(input.endDate, '截止日期')
  const endTime = cleanOptionalHour(input.endTime, '截止时间')
  if (endDate !== '' && today && endDate < today) fail('截止日期不能早于今天')
  const timing = assertTaskTiming({ date, time, endDate, endTime })
  let priority = input.priority === undefined || input.priority === null || input.priority === '' ? null : input.priority
  if (priority !== null && !isPriority(priority)) fail('优先级只能是：' + PRIORITIES.join(' / '))
  const note = cleanText(input.note, { field: '详情', max: NOTE_MAX, multiline: true })
  return {
    title,
    date,
    time: timing.time,
    endDate: timing.endDate,
    endTime: timing.endTime,
    priority,
    note,
  }
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
    out.time = cleanOptionalTime(changes.time, '开始时间')
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'endDate')) {
    out.endDate = cleanOptionalDate(changes.endDate, '截止日期')
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'endTime')) {
    out.endTime = cleanOptionalTime(changes.endTime, '截止时间')
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
