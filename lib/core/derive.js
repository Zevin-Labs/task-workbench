// 视图派生：今日 / 本周 / 总表 / 概览。纯函数，UI、HTTP、AI 工具、测试共用。
import {
  addDays, comparePriority, compareTime, diffDays, effectiveInterval, isRangeTask, isValidTime, monthOf, taskEndDate, todayStr, weekStartOf,
} from './contract.js'

export function publicTask(task) {
  const range = isRangeTask(task)
  const interval = effectiveInterval(task)
  return {
    id: task.id,
    title: task.title,
    date: task.date,
    time: isValidTime(task.time) ? task.time : null,
    endDate: range ? task.endDate : null,
    endTime: isValidTime(task.endTime) ? task.endTime : null,
    type: range ? 'range' : 'single',
    priority: task.priority,
    done: task.done === true,
    note: task.note ?? '',
    completed: task.completed ?? null,
    startAt: interval.startAt,
    endAt: interval.endAt,
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

/**
 * 跨周期任务在本周的轨道排序（轨道号 = 行号，越小越靠上）。
 * 规则：截止日越晚越靠上（下周及以后自然排最上）→ 重要度 → 开始日 → 开始时间 → 创建序。
 * 这条顺序保证「仍在进行中的任务占据顶部连续轨道」，所以每格只需按当天最大轨道号留出带高，不会留空行。
 */
function compareLane(a, b) {
  return String(b.endDate).localeCompare(String(a.endDate))
    || comparePriority(a.priority, b.priority)
    || String(a.date).localeCompare(String(b.date))
    || compareTime(a.time, b.time)
    || byOrder(a, b)
}

/** 本周：自然周（周一→周日）7 列；单日任务按日期落列，跨周期任务按轨道贯穿并落在截止日那一格。 */
export function deriveWeek(model, anchor = todayStr(), today = todayStr()) {
  const start = weekStartOf(anchor)
  if (!start) throw new Error(`无法计算周起点：${anchor}`)
  const end = addDays(start, 6)
  const rangeTasks = model.tasks.filter((task) => isRangeTask(task))
  const singleTasks = model.tasks.filter((task) => !isRangeTask(task))
  const weekDates = WEEKDAY_LABELS.map((_, index) => addDays(start, index))
  // 跨周期任务：先按周裁剪，再按轨道规则排序；序号即轨道（0 在最上）。
  const spans = rangeTasks
    .filter((task) => task.date <= end && task.endDate >= start)
    .sort(compareLane)
    .map((task, lane) => {
      const clipStart = task.date < start ? start : task.date
      const clipEnd = task.endDate > end ? end : task.endDate
      return {
        ...publicTask(task),
        lane,
        startIndex: diffDays(clipStart, start),
        endIndex: diffDays(clipEnd, start),
        clipStart,
        clipEnd,
        startsBefore: task.date < start,
        endsAfter: task.endDate > end,
      }
    })
  const days = WEEKDAY_LABELS.map((label, index) => {
    const date = weekDates[index]
    const dayTasks = singleTasks
      .filter((task) => task.date === date)
      .sort((a, b) => comparePriority(a.priority, b.priority) || byTimeThenOrder(a, b))
    const open = dayTasks.filter((task) => !task.done)
    const completed = dayTasks.filter((task) => task.done)
    const active = spans.filter((span) => span.startIndex <= index && span.endIndex >= index)
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
      // 该日顶部需要留出的轨道行数（0 = 没有跨周期任务经过）与落在该日的截止卡
      spanLanes: active.length === 0 ? 0 : Math.max(...active.map((span) => span.lane)) + 1,
      spanActive: active.length,
      spanEnds: spans.filter((span) => span.endIndex === index).map((span) => span.id),
    }
  })
  const openSpans = spans.filter((span) => !span.done)
  const weekSingles = singleTasks.filter((task) => task.date >= start && task.date <= end)
  const weekRanges = rangeTasks.filter((task) => task.date <= end && task.endDate >= start)
  const stats = statsForDays([...weekSingles, ...weekRanges], weekDates, today)
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
 * 已完成 + 进行中 + 逾期 = 总数。日格不画跨周期区间：单日任务与跨周期截止日
 * 各落一个任务点；items 给出当天全部相关任务，供当天详情弹窗使用。
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
        items: [],
      })
      continue
    }
    const active = monthTasks
      .filter((task) => task.date <= date && taskEndDate(task) >= date)
      .sort((a, b) => Number(a.done) - Number(b.done) || comparePriority(a.priority, b.priority) || byTimeThenOrder(a, b))
    const singles = active.filter((task) => !isRangeTask(task))
    const dueItems = active.filter((task) => isRangeTask(task) && task.endDate === date)
    const openSingles = singles.filter((task) => !task.done)
    const openDue = dueItems.some((task) => !task.done)
    // 日格任务点：单日任务落当天，跨周期任务只落截止日；null 表示当天不落点。
    const point = singles.length === 0 && dueItems.length === 0
      ? null
      : (openSingles.length > 0 || openDue ? 'open' : 'done')
    days.push({
      date,
      day: Number(date.slice(8, 10)),
      inMonth: true,
      isToday: date === today,
      isWeekend: weekdayIndex >= 5,
      open: openSingles.length,
      done: singles.length - openSingles.length,
      total: active.length,
      point,
      items: active.map((task) => ({
        ...publicTask(task),
        deadline: isRangeTask(task) && task.endDate === date,
      })),
    })
  }

  const rows = []
  for (let week = 0; week < MONTH_GRID_WEEKS; week++) {
    const rowStart = addDays(gridStart, week * 7)
    rows.push({ start: rowStart, end: addDays(rowStart, 6) })
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
