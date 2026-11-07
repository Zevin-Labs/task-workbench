// 复盘（日/周/月）共享契约：类型、正文上限、周期键格式。
// 复盘是「人写、AI 只读」的长期记录；键是天然周期键（日=日期 / 周=该周周一 / 月=YYYY-MM），
// 数据落在 SQLite 的 reviews 表，主键 (kind, period_key)。
import { isValidDate, weekStartOf } from './contract.js'

export const REVIEW_KINDS = ['daily', 'weekly', 'monthly']
export const REVIEW_TITLES = {
  daily: '日复盘',
  weekly: '周复盘',
  monthly: '月复盘',
}
export const REVIEW_TEXT_MAX = 20000
export const REVIEW_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function isReviewKind(value) {
  return REVIEW_KINDS.includes(value)
}

/**
 * 周期键是否合法：日=YYYY-MM-DD；周=该自然周周一（YYYY-MM-DD）；月=YYYY-MM。
 * 只做格式与语义校验，不判断是否在可写窗口内（那是 review-window 的事）。
 */
export function isReviewKey(kind, value) {
  if (typeof value !== 'string' || value === '') return false
  if (kind === 'daily') return isValidDate(value)
  if (kind === 'weekly') return isValidDate(value) && weekStartOf(value) === value
  if (kind === 'monthly') return REVIEW_MONTH_RE.test(value)
  return false
}
