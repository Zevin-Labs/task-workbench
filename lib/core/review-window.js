// 复盘窗口与派生：什么时候出现、复盘哪一段周期、材料汇总。纯函数，UI / HTTP / 工具 / 测试共用。
//
// 口径（已与用户拍板）：
//   日复盘：每天出现，只写「今天」。
//   周复盘：本周一 → 周日出现，只复盘「上一个自然周」，不累积。
//   月复盘：当月最后一天（28/29/30/31 按实际）出现，复盘「本月」；次月 1–3 日仍可补写。
// 过了可写窗口即只读（服务端强制）；历史内容只能打开 Markdown 修改。
import {
  addDays, comparePriority, diffDays, isRangeTask, parseDate, taskEndDate, weekStartOf,
} from './contract.js'

const pad2 = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD → YYYY-MM。 */
export function monthKeyOf(dateStr) {
  return typeof dateStr === 'string' && dateStr.length >= 7 ? dateStr.slice(0, 7) : null
}

/** 当月最后一天（YYYY-MM-DD）。 */
export function lastDayOfMonth(dateStr) {
  const dt = parseDate(dateStr)
  if (!dt) return null
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate())}`
}

/** 上一个自然月（YYYY-MM）。 */
export function previousMonthKey(monthKey) {
  const [year, month] = String(monthKey ?? '').split('-').map(Number)
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null
  const dt = new Date(year, month - 2, 1)
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`
}

/** 复盘周期键 → { start, end }（YYYY-MM-DD）。 */
export function periodOfKey(kind, key) {
  if (kind === 'daily') return { start: key, end: key }
  if (kind === 'weekly') {
    const end = addDays(key, 6)
    return end ? { start: key, end } : null
  }
  if (kind === 'monthly') {
    const start = `${key}-01`
    const end = lastDayOfMonth(start)
    return end ? { start, end } : null
  }
  return null
}

/**
 * 今天应该出现哪些复盘提示（服务端据此生成复盘板，写入侧用 isReviewWritable 兜底校验）。
 * @returns {Array<{ kind: string, key: string, windowStart: string, windowEnd: string }>}
 */
export function dueReviewPrompts(today) {
  const prompts = []
  if (!parseDate(today)) return prompts

  // 日复盘：每天都有，写今天。
  prompts.push({ kind: 'daily', key: today, windowStart: today, windowEnd: today })

  // 周复盘：本周（周一→周日）出现，复盘上一个自然周。
  const weekStart = weekStartOf(today)
  const weekEnd = addDays(weekStart, 6)
  prompts.push({
    kind: 'weekly',
    key: addDays(weekStart, -7),
    windowStart: weekStart,
    windowEnd: weekEnd,
  })

  // 月复盘：当月最后一天出现（复盘本月）；次月 1–3 日补写上月。
  const month = monthKeyOf(today)
  const lastDay = lastDayOfMonth(today)
  const firstDay = `${month}-01`
  if (today === lastDay) {
    prompts.push({ kind: 'monthly', key: month, windowStart: lastDay, windowEnd: addDays(lastDay, 3) })
  } else {
    const offset = diffDays(today, firstDay)
    if (offset !== null && offset >= 0 && offset <= 2) {
      const prevMonth = previousMonthKey(month)
      const prevLast = lastDayOfMonth(`${prevMonth}-01`)
      prompts.push({ kind: 'monthly', key: prevMonth, windowStart: prevLast, windowEnd: addDays(prevLast, 3) })
    }
  }
  return prompts
}

/** 该周期现在是否可写：只允许当前窗口里的那一个周期键。 */
export function isReviewWritable(kind, key, today) {
  return dueReviewPrompts(today).some((prompt) => prompt.kind === kind && prompt.key === key)
}

/** 相对今天的人类可读标签（UI 用）：今天 / 上周 / 本月 / 上月。 */
export function relativeReviewLabel(kind, key, today) {
  if (kind === 'daily') return key === today ? '今日' : key
  if (kind === 'weekly') return key === addDays(weekStartOf(today), -7) ? '上周' : '周'
  if (kind === 'monthly') return key === monthKeyOf(today) ? '本月' : '上月'
  return key
}

function taskBrief(task) {
  return {
    id: task.id,
    title: task.title,
    date: task.date ?? null,
    endDate: isRangeTask(task) ? task.endDate : null,
    priority: task.priority ?? null,
    completed: task.completed ?? null,
  }
}

/**
 * 周期内任务概况（周复盘 / 月复盘的材料）：
 * - completed：完成日期落在周期内的任务；
 * - pending：结束日期落在周期内、仍未完成的任务（该周期该做没做完的）。
 * 只统计调用方给的那几个月份分片；跨月周/月由 service 合并相邻分片后传入。
 */
export function summarizePeriodTasks(tasks, start, end) {
  const completed = []
  const pending = []
  if (!start || !end) return { completedCount: 0, completed: [], pendingCount: 0, pending: [] }
  for (const task of tasks ?? []) {
    if (task.done) {
      const doneDate = task.completed ?? null
      if (doneDate && doneDate >= start && doneDate <= end) completed.push(task)
      continue
    }
    const due = taskEndDate(task)
    if (due && due >= start && due <= end) pending.push(task)
  }
  const sortedCompleted = [...completed].sort((a, b) => String(b.completed).localeCompare(String(a.completed))
    || comparePriority(a.priority, b.priority))
  const sortedPending = [...pending].sort((a, b) => String(taskEndDate(a)).localeCompare(String(taskEndDate(b)))
    || comparePriority(a.priority, b.priority))
  return {
    completedCount: sortedCompleted.length,
    completed: sortedCompleted.map(taskBrief),
    pendingCount: sortedPending.length,
    pending: sortedPending.map(taskBrief),
  }
}

/** 复盘条目的对外结构（UI 材料 / AI 只读工具共用）。 */
export function publicReview(review) {
  const period = periodOfKey(review.kind, review.key)
  return {
    kind: review.kind,
    key: review.key,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    text: review.text ?? '',
    updatedAt: review.updatedAt ?? null,
    warnings: review.warnings ?? [],
  }
}

/** 周期内（键落在 [start, end]）的日复盘，按日期升序。 */
export function reviewsInRange(entries, start, end) {
  if (!start || !end) return []
  return (entries ?? [])
    .filter((entry) => entry.key >= start && entry.key <= end)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({ key: entry.key, text: entry.text ?? '', updatedAt: entry.updatedAt ?? null }))
}

/**
 * 某个月的周复盘：周键从「包含 1 号那一周的周一」到「月末」。
 * 允许跨月周（如 11 月里出现 10/26 这一周），保证月初那周不丢。
 */
export function weeklyReviewsOfMonth(entries, month) {
  if (!month) return []
  const monthStart = `${month}-01`
  const monthEnd = lastDayOfMonth(monthStart)
  const lower = weekStartOf(monthStart)
  if (!monthEnd || !lower) return []
  return (entries ?? [])
    .filter((entry) => entry.key >= lower && entry.key <= monthEnd)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({ key: entry.key, text: entry.text ?? '', updatedAt: entry.updatedAt ?? null }))
}

/**
 * 复盘板：今天的提示 + 是否已写 + 材料。
 * @param {{ today: string, entriesByKind?: object, materialsByKind?: object }} input
 */
export function deriveReviewBoard({ today, entriesByKind = {}, materialsByKind = {} }) {
  const prompts = dueReviewPrompts(today).map((prompt) => {
    const period = periodOfKey(prompt.kind, prompt.key)
    const entry = (entriesByKind[prompt.kind] ?? []).find((item) => item.key === prompt.key) ?? null
    return {
      kind: prompt.kind,
      key: prompt.key,
      label: relativeReviewLabel(prompt.kind, prompt.key, today),
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      windowStart: prompt.windowStart,
      windowEnd: prompt.windowEnd,
      state: entry ? 'done' : 'pending',
      review: entry ? { text: entry.text ?? '', updatedAt: entry.updatedAt ?? null } : null,
      materials: materialsByKind[prompt.kind] ?? null,
    }
  })
  return { date: today, prompts }
}
