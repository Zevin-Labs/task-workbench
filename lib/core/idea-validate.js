// 想法池入参校验：UI 与 AI 工具共用；错误统一抛 TaskError('validation-error')。
// 名称/分类单行，详细描述多行 TEXT；不再因旧 Markdown 分隔符禁字符。
import {
  IDEA_CATEGORY_MAX, IDEA_DESC_MAX, IDEA_ID_RE, IDEA_MATURITIES,
  IDEA_NAME_MAX, IDEA_STATUSES, TaskError, isIdeaMaturity, isIdeaStatus,
} from './contract.js'

function fail(message) {
  throw new TaskError('validation-error', message, 400)
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

export function assertIdeaId(ideaId) {
  const text = typeof ideaId === 'string' ? ideaId.trim() : ''
  if (!IDEA_ID_RE.test(text) || Number(text.slice(2)) <= 0) fail('想法 ID 必须形如 I-1')
  return text
}

function cleanName(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('想法名称必须是文本')
  if (/[\r\n]/.test(value)) fail('想法名称不能包含换行')
  const text = value.trim()
  if (text.length > IDEA_NAME_MAX) fail(`想法名称最多 ${IDEA_NAME_MAX} 个字`)
  return text
}

function cleanCategory(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('分类必须是文本')
  if (/[\r\n]/.test(value)) fail('分类不能包含换行')
  const text = value.trim()
  if (text.length > IDEA_CATEGORY_MAX) fail(`分类最多 ${IDEA_CATEGORY_MAX} 个字`)
  return text
}

function cleanDescription(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail('详细描述必须是文本')
  const text = normalizeIdeaDescription(value)
  if (text.length > IDEA_DESC_MAX) fail(`详细描述最多 ${IDEA_DESC_MAX} 个字`)
  return text
}

function cleanMaturity(value) {
  if (!isIdeaMaturity(value)) fail('成熟度只能是：' + IDEA_MATURITIES.join(' / '))
  return value
}

function cleanStatus(value) {
  if (!isIdeaStatus(value)) fail('状态只能是：' + IDEA_STATUSES.join(' / '))
  return value
}

/** 新建想法：名称必填；描述 / 成熟度 / 分类可选；状态固定默认「待实现」。 */
export function normalizeIdeaCreateInput(input = {}, today) {
  const name = cleanName(input.name)
  if (!name) fail('想法名称不能为空')
  const maturity = input.maturity === undefined || input.maturity === null || input.maturity === ''
    ? '低'
    : cleanMaturity(input.maturity)
  return {
    name,
    description: cleanDescription(input.description),
    maturity,
    category: cleanCategory(input.category),
    created: today,
  }
}

/** 编辑想法的字段白名单；可选字段传空字符串表示清除。 */
export function normalizeIdeaUpdateChanges(changes = {}) {
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) fail('changes 必须是对象')
  const allowed = new Set(['name', 'description', 'maturity', 'category', 'status'])
  const unknown = Object.keys(changes).filter((key) => !allowed.has(key))
  if (unknown.length > 0) fail(`不支持修改字段：${unknown.join('、')}`)
  const out = {}
  if (Object.prototype.hasOwnProperty.call(changes, 'name')) {
    const name = cleanName(changes.name)
    if (!name) fail('想法名称不能为空')
    out.name = name
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'description')) {
    out.description = cleanDescription(changes.description)
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'maturity')) {
    out.maturity = cleanMaturity(changes.maturity)
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'category')) {
    out.category = cleanCategory(changes.category)
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'status')) {
    out.status = cleanStatus(changes.status)
  }
  if (Object.keys(out).length === 0) fail('没有要修改的字段')
  return out
}
