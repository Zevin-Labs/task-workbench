// 视图派生：今日 / 本周 / 总表 / 概览。纯函数，UI、HTTP、AI 工具、测试共用。
import {
  addDays, comparePriority, compareTime, diffDays, isRangeTask, isValidTime, monthOf, taskEndDate, todayStr, weekStartOf,
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

/**
 * 一组任务在给定日期集合上的统计。total/done/overdue/doing 相加自洽；
 * daysWithTasks 与 busiest 按「任务区间是否覆盖该日」计算（跨周期任务覆盖的每一天都算）。
 */
function statsForDays(tasks, days, today) {
  const total = tasks.length
  const done = tasks.filter((task) => task.done === true).length
  const overdue = tasks.filter((task) => !task.done && taskEndDate(task) < today).length
  let daysWithTasks = 0
  let busiest = { date: null, count: 0 }
  for (const date of days) {
    let count = 0
    for (const task of tasks) {
      if (task.date <= date && taskEndDate(task) >= date) count++
    }
    if (count > 0) daysWithTasks++
    if (count > busiest.count) busiest = { date, count }
  }
  return { total, done, doing: total - done - overdue, overdue, daysWithTasks, busiest }
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
  const weekSingles = singleTasks.filter((task) => task.date >= start && task.date <= end)
  const weekRanges = rangeTasks.filter((task) => task.date <= end && task.endDate >= start)
  const stats = statsForDays(
    [...weekSingles, ...weekRanges],
    WEEKDAY_LABELS.map((_, index) => addDays(start, index)),
    today,
  )
  return {
    start,
    end,
    today,
    days,
    spans,
    stats,
    counts: {
      open: days.reduce((sum, day) => sum + day.openCount, 0) + openSpans.length,
      total: days.reduce((sum, day) => sum + day.count, 0) + spans.length,
      rangeOpen: openSpans.length,
    },
  }
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const MONTH_GRID_WEEKS = 6

/**
 * 月历：固定 6 行 × 7 列（周一到周日），相邻月份补位。
 * 口径：任务集合 = 日期区间与本月相交的任务（跨周期按区间相交、去重）；
 * 已完成 + 进行中 + 逾期 = 总数；日格只给「单日任务」点，跨周期任务给区间与截止标记。
 */
export function deriveMonth(model, month = monthOf(todayStr()), today = todayStr()) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) throw new Error(`无法计算月份：${month}`)
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const start = `${month}-01`
  const daysInMonth = new Date(year, monthNumber, 0).getDate()
  const end = `${month}-${String(daysInMonth).padStart(2, '0')}`
  const leading = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7
  const gridStart = addDays(start, -leading)

  const rangeTasks = model.tasks.filter((task) => isRangeTask(task))
  const singleTasks = model.tasks.filter((task) => !isRangeTask(task))
  const monthRanges = rangeTasks.filter((task) => task.date <= end && task.endDate >= start)
  const monthSingles = singleTasks.filter((task) => task.date >= start && task.date <= end)
  const monthTasks = [...monthSingles, ...monthRanges]

  const monthDays = Array.from({ length: daysInMonth }, (_, index) => addDays(start, index))
  const stats = statsForDays(monthTasks, monthDays, today)

  const days = []
  for (let index = 0; index < MONTH_GRID_WEEKS * 7; index++) {
    const date = addDays(gridStart, index)
    const inMonth = date >= start && date <= end
    const weekdayIndex = index % 7
    if (!inMonth) {
      days.push({
        date,
        day: Number(date.slice(8, 10)),
        inMonth: false,
        isToday: date === today,
        isWeekend: weekdayIndex >= 5,
        open: 0,
        done: 0,
        total: 0,
        spanCovered: false,
        spanDeadline: false,
        items: [],
      })
      continue
    }
    const active = monthTasks.filter((task) => task.date <= date && taskEndDate(task) >= date)
    days.push({
      date,
      day: Number(date.slice(8, 10)),
      inMonth: true,
      isToday: date === today,
      isWeekend: weekdayIndex >= 5,
      open: active.filter((task) => !isRangeTask(task) && !task.done).length,
      done: active.filter((task) => !isRangeTask(task) && task.done === true).length,
      total: active.length,
      spanCovered: active.some((task) => isRangeTask(task)),
      spanDeadline: monthRanges.some((task) => task.endDate === date),
      items: active.map((task) => ({
        id: task.id,
        title: task.title,
        range: isRangeTask(task),
        done: task.done === true,
        deadline: isRangeTask(task) && task.endDate === date,
      })),
    })
  }

  const rows = []
  for (let week = 0; week < MONTH_GRID_WEEKS; week++) {
    const rowStart = addDays(gridStart, week * 7)
    const rowEnd = addDays(rowStart, 6)
    const spans = monthRanges
      .filter((task) => task.date <= rowEnd && task.endDate >= rowStart)
      .map((task) => {
        const clipStart = task.date < start ? start : task.date
        const clipEnd = task.endDate > end ? end : task.endDate
        const from = clipStart < rowStart ? rowStart : clipStart
        const to = clipEnd > rowEnd ? rowEnd : clipEnd
        return {
          id: task.id,
          title: task.title,
          done: task.done === true,
          startIndex: diffDays(from, rowStart),
          endIndex: diffDays(to, rowStart),
          startsBefore: task.date < start,
          endsAfter: task.endDate > end,
          deadlineIndex: task.endDate >= start && task.endDate <= end && task.endDate >= rowStart && task.endDate <= rowEnd
            ? diffDays(task.endDate, rowStart)
            : null,
        }
      })
      .sort((a, b) => a.startIndex - b.startIndex || b.endIndex - a.endIndex || String(a.id).localeCompare(String(b.id)))
    // 区间细线按并集绘制：重叠/相邻的跨度合成一段，避免多条线叠出接缝。
    const segments = []
    for (const span of spans) {
      const last = segments[segments.length - 1]
      if (last && span.startIndex <= last.endIndex + 1) {
        last.endIndex = Math.max(last.endIndex, span.endIndex)
        last.open = last.open || span.done !== true
      } else {
        segments.push({ startIndex: span.startIndex, endIndex: span.endIndex, open: span.done !== true })
      }
    }
    rows.push({ start: rowStart, end: rowEnd, spans, segments })
  }

  return {
    month,
    label: `${year} 年 ${monthNumber} 月`,
    start,
    end,
    today,
    gridStart,
    days,
    rows,
    stats,
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
