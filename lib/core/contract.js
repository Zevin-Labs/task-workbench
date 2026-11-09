// 共享契约：优先级、错误码、日期与文本工具。UI / HTTP / AI 工具共用同一套口径。
// 存储已改为 SQLite（lib/host/db.js）；这里只保留与存储无关的产品语义。

export const PRIORITIES = ['重要紧急', '重要不紧急', '不重要紧急', '不重要不紧急']
export const DEFAULT_PRIORITY = '重要不紧急'
export const PRIORITY_RANK = { 重要紧急: 0, 重要不紧急: 1, 不重要紧急: 2, 不重要不紧急: 3 }

export const TITLE_MAX = 200
export const NOTE_MAX = 500

// ── 想法池（Idea Pool）契约 ────────────────────────────────────────────────
export const IDEA_STATUSES = ['待实现', '推进中', '完成', '放弃']
export const DEFAULT_IDEA_STATUS = '待实现'
export const IDEA_STATUS_RANK = { 待实现: 0, 推进中: 1, 完成: 2, 放弃: 3 }
export const IDEA_MATURITIES = ['低', '中', '高']
export const DEFAULT_IDEA_MATURITY = '低'
export const IDEA_NAME_MAX = 200
export const IDEA_DESC_MAX = 10000
export const IDEA_CATEGORY_MAX = 20

// ID 由数据库自增序号派生，不再依赖创建日期，删除后也不复用。
export const TASK_ID_RE = /^T-[1-9]\d*$/
export const IDEA_ID_RE = /^I-[1-9]\d*$/
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 带错误码的业务异常；HTTP 层和工具层都把它转成结构化错误。 */
export class TaskError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.name = 'TaskError'
    this.code = code
    this.status = status
    this.details = details
  }
}

const STATUS_BY_CODE = {
  'validation-error': 400,
  'duplicate-suspected': 409,
  'permission-denied': 403,
  'not-found': 404,
  'file-missing': 409,
  'already-initialized': 409,
  'external-change': 409,
  'history-readonly': 409,
  'backup-failed': 500,
  'write-failed': 500,
  'config-invalid': 500,
  'forbidden-path': 403,
  'internal-error': 500,
}

export function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 500
}

export function errorPayload(error) {
  if (error instanceof TaskError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === null || error.details === undefined ? {} : { details: error.details }),
    }
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 解析 YYYY-MM-DD（本地时区）；非法返回 null。 */
export function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
  return dt
}

export function isValidDate(value) {
  return parseDate(value) !== null
}

/** Date → YYYY-MM-DD（本地时区）。 */
export function formatDate(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`
}

export function todayStr(now = new Date()) {
  return formatDate(now)
}

export function monthOf(dateStr) {
  return typeof dateStr === 'string' && DATE_RE.test(dateStr) ? dateStr.slice(0, 7) : null
}

/** 自然周周一（含今天）。 */
export function weekStartOf(dateStr) {
  const dt = parseDate(dateStr)
  if (!dt) return null
  const diff = (dt.getDay() + 6) % 7
  dt.setDate(dt.getDate() - diff)
  return formatDate(dt)
}

export function addDays(dateStr, days) {
  const dt = parseDate(dateStr)
  if (!dt) return null
  dt.setDate(dt.getDate() + days)
  return formatDate(dt)
}

/** a - b，按天。 */
export function diffDays(a, b) {
  const da = parseDate(a)
  const db = parseDate(b)
  if (!da || !db) return null
  return Math.round((da.getTime() - db.getTime()) / 86400000)
}

export function isPriority(value) {
  return PRIORITIES.includes(value)
}

export function isIdeaStatus(value) {
  return IDEA_STATUSES.includes(value)
}

export function isIdeaMaturity(value) {
  return IDEA_MATURITIES.includes(value)
}

/** 时间 HH:mm（24 小时制）；空字符串/缺省表示全天。 */
export function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value)
}

/** 是否为跨周期任务（有合法结束日期且晚于开始日期）。 */
export function isRangeTask(task) {
  return Boolean(
    task?.endDate && task?.date
    && isValidDate(task.date) && isValidDate(task.endDate)
    && task.endDate > task.date,
  )
}

/** 任务结束日期：跨周期取 endDate，单日取 date。 */
export function taskEndDate(task) {
  return isRangeTask(task) ? task.endDate : (task?.date ?? null)
}

// ── 任务时间模型（2026-11-09）─────────────────────────────────────────────
// 任务 = 连续时间区间 startAt → endAt；未填的日期/时刻按默认规则补齐。
// 默认值只做派生（不落库）：开始 08:00、截止 22:00；开始日期默认今天，截止日期默认开始日期。
// 小时粒度：本阶段只支持整点（分钟 00）；历史数据里的分钟值按原样展示，不做迁移。
export const DEFAULT_START_HOUR = '08:00'
export const DEFAULT_END_HOUR = '22:00'

/** 有效时间区间：补齐默认值并给出是否跨天；不校验合法性。 */
export function effectiveInterval(task) {
  const date = task?.date ?? null
  const endDate = isValidDate(task?.endDate) && task.endDate > date ? task.endDate : date
  const startTime = isValidTime(task?.time) ? task.time : DEFAULT_START_HOUR
  const endTime = isValidTime(task?.endTime) ? task.endTime : DEFAULT_END_HOUR
  return {
    startDate: date,
    startTime,
    endDate,
    endTime,
    crossDay: Boolean(date && endDate && endDate > date),
    startAt: date ? `${date} ${startTime}` : null,
    endAt: endDate ? `${endDate} ${endTime}` : null,
  }
}

/** 时间排序：全天（空）在前，其余按 HH:mm 升序。 */
export function compareTime(a, b) {
  const left = isValidTime(a) ? a : ''
  const right = isValidTime(b) ? b : ''
  if (left === right) return 0
  if (left === '') return -1
  if (right === '') return 1
  return left.localeCompare(right)
}

export function comparePriority(a, b) {
  return (PRIORITY_RANK[a] ?? 1) - (PRIORITY_RANK[b] ?? 1)
}
