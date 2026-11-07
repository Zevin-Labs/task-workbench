// 想法池视图派生：列表投影、计数、停滞天数。纯函数，UI / HTTP / AI 工具 / 测试共用。
import {
  IDEA_MATURITY_RANK, IDEA_STATUS_RANK, diffDays, todayStr,
} from './contract.js'

const isOpenStatus = (status) => status === '待实现' || status === '推进中'

/** 对外暴露的想法结构（UI / AI 共用）。 */
export function publicIdea(idea, today = todayStr()) {
  const open = isOpenStatus(idea.status)
  const staleDays = open && idea.updated ? Math.max(0, diffDays(today, idea.updated) ?? 0) : 0
  return {
    id: idea.id,
    name: idea.name,
    description: idea.description ?? '',
    status: idea.status,
    maturity: idea.maturity,
    category: idea.category ?? '',
    created: idea.created ?? null,
    updated: idea.updated ?? null,
    completed: idea.completed ?? null,
    staleDays,
  }
}

export function emptyIdeaCounts() {
  return { total: 0, todo: 0, doing: 0, done: 0, dropped: 0, open: 0 }
}

/** 计数：总数 + 四态 + 未关闭（待实现 + 推进中）。 */
export function deriveIdeaCounts(model) {
  const counts = emptyIdeaCounts()
  for (const idea of model.ideas) {
    counts.total += 1
    if (idea.status === '待实现') counts.todo += 1
    else if (idea.status === '推进中') counts.doing += 1
    else if (idea.status === '完成') counts.done += 1
    else if (idea.status === '放弃') counts.dropped += 1
  }
  counts.open = counts.todo + counts.doing
  return counts
}

/** 默认排序：状态（待实现 → 推进中 → 完成 → 放弃）→ 更新日期倒序 → 创建日期倒序 → 文件行序。 */
export function compareIdea(a, b) {
  return (IDEA_STATUS_RANK[a.status] ?? 0) - (IDEA_STATUS_RANK[b.status] ?? 0)
    || String(b.updated ?? '').localeCompare(String(a.updated ?? ''))
    || String(b.created ?? '').localeCompare(String(a.created ?? ''))
    || (a.order ?? 0) - (b.order ?? 0)
}

/** 想法列表（默认按状态优先 + 更新倒序）；UI 在前端再做筛选。 */
export function deriveIdeaList(model, { today = todayStr() } = {}) {
  const sorted = [...model.ideas].sort(compareIdea)
  let lastUpdated = null
  for (const idea of model.ideas) {
    if (idea.updated && (!lastUpdated || idea.updated > lastUpdated)) lastUpdated = idea.updated
  }
  return {
    ideas: sorted.map((idea) => publicIdea(idea, today)),
    counts: deriveIdeaCounts(model),
    lastUpdated,
  }
}

export { IDEA_MATURITY_RANK, isOpenStatus }
