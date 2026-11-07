// 视图派生：今日 / 本周 / 总表 / 概览。纯函数，UI、HTTP、AI 工具、测试共用。
import {
  addDays, comparePriority, compareTime, diffDays, isRangeTask, isValidTime, taskEndDate, todayStr, weekStartOf,
} from './contract.js'

export function publicTask(task) {
  const range = isRangeTask(task)
  return {
    id: task.id,
    title: task.title,
    date: task.date,
    time: isValidTime(task.time) ? task.time : null,
    endDate: range ? task.endDate : null,
    endTime: range && isValidTime(task.endTime) ? task.endTime : null,
    type: range ? 'range' : 'single',
    priority: task.priority,
    done: task.done === true,
    note: task.note ?? '',
    completed: task.completed ?? null,
  }
}

const byOrder = (a, b) => a.order - b.order

/** 同优先级内：全天任务在前，再按 HH:mm。 */
function byTimeThenOrder(a, b) {
  return compareTime(a.time, b.time) || byOrder(a, b)
}

function sortTodayOpen(tasks) {
  return [...tasks].sort((a, b) => comparePriority(a.priority, b.priority) || byTimeThenOrder(a, b))
}

function sortOverdue(tasks) {
  return [...tasks].sort((a, b) => String(taskEndDate(a)).localeCompare(String(taskEndDate(b)))
    || comparePriority(a.priority, b.priority)
    || byTimeThenOrder(a, b))
}

function sortByPriorityThenDate(tasks) {
  return [...tasks].sort((a, b) => comparePriority(a.priority, b.priority)
    || String(a.date ?? '').localeCompare(String(b.date ?? ''))
    || byTimeThenOrder(a, b))
}

/** 今日：逾期未完成 + 今天待办（含进行中的跨周期）+ 今天已完成。 */
export function deriveToday(model, today = todayStr()) {
  const tasks = model.tasks
  const overdue = sortOverdue(tasks.filter((task) => {
    if (task.done || !task.date) return false
    return taskEndDate(task) < today
  }))
  const open = sortTodayOpen(tasks.filter((task) => {
    if (task.done || !task.date) return false
    return task.date <= today && taskEndDate(task) >= today
  }))
  const completed = tasks
    .filter((task) => task.done && (task.completed === today || (!task.completed && task.date === today)))
    .sort(byOrder)
  return {
    date: today,
    overdue: overdue.map((task) => ({ ...publicTask(task), overdueDays: diffDays(today, taskEndDate(task)) })),
    open: open.map(publicTask),
    completed: completed.map(publicTask),
    counts: {
      overdue: overdue.length,
      open: open.length,
      completed: completed.length,
      totalOpen: overdue.length + open.length,
      rangeOpen: open.filter((task) => isRangeTask(task)).length,
    },
  }
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 本周：自然周（周一→周日）7 列；单日任务按日期落列，跨周期任务生成按周裁剪的区间数据（UI 顶部摘要条 + 悬停高亮用）。 */
export function deriveWeek(model, anchor = todayStr(), today = todayStr()) {
  const start = weekStartOf(anchor)
  if (!start) throw new Error(`无法计算周起点：${anchor}`)
  const end = addDays(start, 6)
  const rangeTasks = model.tasks.filter((task) => isRangeTask(task))
  const singleTasks = model.tasks.filter((task) => !isRangeTask(task))
  const days = WEEKDAY_LABELS.map((label, index) => {
    const date = addDays(start, index)
    const dayTasks = singleTasks
      .filter((task) => task.date === date)
      .sort((a, b) => comparePriority(a.priority, b.priority) || byTimeThenOrder(a, b))
    const open = dayTasks.filter((task) => !task.done)
    const completed = dayTasks.filter((task) => task.done)
    return {
      date,
      label,
      weekday: index + 1,
      isToday: date === today,
      isPast: date < today,
      isFuture: date > today,
      open: open.map(publicTask),
      completed: completed.map(publicTask),
      count: dayTasks.length,
      openCount: open.length,
    }
  })
  const spans = rangeTasks
    .filter((task) => task.date <= end && task.endDate >= start)
    .map((task) => {
      const clipStart = task.date < start ? start : task.date
      const clipEnd = task.endDate > end ? end : task.endDate
      const startIndex = diffDays(clipStart, start)
      const endIndex = diffDays(clipEnd, start)
      return {
        ...publicTask(task),
        startIndex,
        endIndex,
        clipStart,
        clipEnd,
        startsBefore: task.date < start,
        endsAfter: task.endDate > end,
      }
    })
    .sort((a, b) => a.startIndex - b.startIndex || comparePriority(a.priority, b.priority) || byOrder(a, b))
  const openSpans = spans.filter((span) => !span.done)
  return {
    start,
    end,
    today,
    days,
    spans,
    counts: {
      open: days.reduce((sum, day) => sum + day.openCount, 0) + openSpans.length,
      total: days.reduce((sum, day) => sum + day.count, 0) + spans.length,
      rangeOpen: openSpans.length,
    },
  }
}

/** 概览计数（bootstrap / Dock 徽章可用）。跨周期任务按「今天是否在区间内」计入待办。 */
export function deriveCounts(model, today = todayStr()) {
  let overdue = 0
  let open = 0
  let completedToday = 0
  let totalOpen = 0
  let totalDone = 0
  let rangeOpen = 0
  for (const task of model.tasks) {
    if (task.done) {
      totalDone++
      if (task.completed === today) completedToday++
      continue
    }
    totalOpen++
    if (!task.date) continue
    const end = taskEndDate(task)
    if (task.date <= today && end >= today) {
      open++
      if (isRangeTask(task)) rangeOpen++
    } else if (end < today) {
      overdue++
    }
  }
  return { overdue, open, completedToday, totalOpen, totalDone, badge: overdue + open, rangeOpen }
}

export { sortByPriorityThenDate }
