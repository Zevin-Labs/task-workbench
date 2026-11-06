// AI 工具面（复盘）：只有只读工具。复盘内容必须由人写，AI 没有 create / update / delete 工具；
// service 层也会拒绝非 user actor 的写入（兜底）。
import { REVIEW_KINDS, REVIEW_TITLES } from '../core/review-contract.js'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value) }],
  }
}

const objectParams = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
})

const kindParam = str('复盘类型：daily（日）/ weekly（周）/ monthly（月）；不传 = 三类都列', {
  enum: REVIEW_KINDS,
})
const keyParam = str('周期键：日=YYYY-MM-DD；周=该自然周周一（YYYY-MM-DD）；月=YYYY-MM')

function labelOf(kind) {
  return REVIEW_TITLES[kind] ?? kind
}

export function createReviewTools(service) {
  return [
    {
      name: 'ptw_review_list',
      description: '列出复盘记录（日/周/月，只读）。可按类型与周期范围筛选；只返回正文摘要，完整正文用 ptw_review_get。复盘内容只能由人在工作台里写，AI 不能创建、修改或删除。',
      parameters: objectParams({
        kind: kindParam,
        from: str('起始日期 YYYY-MM-DD：只返回周期与 [from, to] 有交集的复盘（可选）'),
        to: str('结束日期 YYYY-MM-DD（可选）'),
      }),
      output: textOutput(),
      async execute(args) {
        const data = await service.list(args ?? {})
        const lines = data.reviews.map((review) => {
          const label = labelOf(review.kind)
          const period = review.kind === 'daily' ? review.key : `${review.periodStart} → ${review.periodEnd}`
          return `- ${label}｜${review.key}｜${period}｜更新 ${review.updatedAt ?? '—'}｜${review.textLength} 字｜${review.preview}`
        })
        return {
          ok: true,
          message: `复盘共 ${data.total} 条${data.filters?.kind ? `（${labelOf(data.filters.kind)}）` : ''}。${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`,
          data,
        }
      },
    },
    {
      name: 'ptw_review_get',
      description: '读取一条复盘的完整正文（只读）。日复盘 key 用 YYYY-MM-DD；周复盘 key 用该自然周的周一；月复盘 key 用 YYYY-MM。复盘由人写，AI 只能读。',
      parameters: objectParams({ kind: kindParam, key: keyParam }, ['kind', 'key']),
      output: textOutput(),
      async execute(args) {
        const data = await service.get(args?.kind, args?.key)
        const review = data.review
        return {
          ok: true,
          message: `${labelOf(review.kind)} ${review.key}（${review.periodStart} → ${review.periodEnd}，更新 ${review.updatedAt ?? '—'}）：\n${review.text}`,
          data,
        }
      },
    },
  ]
}
