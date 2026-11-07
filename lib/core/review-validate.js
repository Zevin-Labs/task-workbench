// 复盘入参校验：UI 与 HTTP 共用；错误统一抛 TaskError('validation-error')。
import { TaskError, isValidDate } from './contract.js'
import { REVIEW_TEXT_MAX, isReviewKey, isReviewKind } from './review-contract.js'

function fail(message) {
  throw new TaskError('validation-error', message, 400)
}

/** 正文规整：去 BOM、统一换行、去行尾空白、去首尾空行；保留内部空行。 */
export function normalizeReviewText(value) {
  let text = String(value ?? '')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

export function assertReviewKind(kind) {
  if (!isReviewKind(kind)) fail('复盘类型只能是：daily / weekly / monthly')
  return kind
}

export function assertReviewKey(kind, key) {
  assertReviewKind(kind)
  if (!isReviewKey(kind, key)) {
    const hint = kind === 'daily'
      ? '日复盘键必须是 YYYY-MM-DD'
      : kind === 'weekly'
        ? '周复盘键必须是该自然周的周一（YYYY-MM-DD）'
        : '月复盘键必须是 YYYY-MM'
    fail(`${hint}，收到：${String(key)}`)
  }
  return key
}

/** 复盘板查询日期：缺省今天；传了就必须是合法日期。 */
export function assertReviewDate(value) {
  if (value === undefined || value === null || value === '') return null
  if (!isValidDate(value)) fail('复盘查询日期必须是 YYYY-MM-DD')
  return value
}

/** 写入正文：必须非空、≤ 上限；换行/首尾空行规整后才落盘。 */
export function normalizeReviewWriteInput(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('复盘入参必须是对象')
  if (typeof input.text !== 'string') fail('复盘正文必须是文本')
  const text = normalizeReviewText(input.text)
  if (text === '') fail('复盘正文不能为空')
  if (text.length > REVIEW_TEXT_MAX) fail(`复盘正文最多 ${REVIEW_TEXT_MAX} 字`)
  return { text }
}
