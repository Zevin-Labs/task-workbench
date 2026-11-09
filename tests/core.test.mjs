import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveCounts, deriveMonth, deriveToday, deriveWeek, publicTask } from '../lib/core/derive.js'
import { normalizeCreateInput, normalizeUpdateChanges, assertTaskTiming } from '../lib/core/validate.js'

function task(overrides = {}) {
  return {
    id: 'T-1',
    title: '任务',
    date: '2026-11-05',
    time: null,
    endDate: null,
    endTime: null,
    priority: '重要不紧急',
    done: false,
    note: '',
    completed: null,
    order: 1,
    ...overrides,
  }
}

test('derive: 今日分类与排序（逾期 / 今天 / 今天完成）', () => {
  const tasks = [
    task({ id: 'T-1', title: '今天B', date: '2026-11-05', priority: '不重要紧急', order: 1 }),
    task({ id: 'T-2', title: '今天A', date: '2026-11-05', priority: '重要紧急', order: 2 }),
    task({ id: 'T-3', title: '逾期A', date: '2026-11-03', priority: '不重要不紧急', order: 3 }),
    task({ id: 'T-4', title: '逾期B', date: '2026-11-04', priority: '重要紧急', order: 4 }),
    task({ id: 'T-5', title: '今天完成', date: '2026-11-03', done: true, completed: '2026-11-05', order: 5 }),
    task({ id: 'T-6', title: '昨天完成', date: '2026-11-03', done: true, completed: '2026-11-04', order: 6 }),
  ]
  const today = deriveToday({ tasks }, '2026-11-05')
  assert.deepEqual(today.open.map((item) => item.title), ['今天A', '今天B'])
  assert.deepEqual(today.overdue.map((item) => item.title), ['逾期A', '逾期B'])
  assert.equal(today.overdue[0].overdueDays, 2)
  assert.deepEqual(today.completed.map((item) => item.title), ['今天完成'])
  assert.deepEqual(today.counts, { overdue: 2, open: 2, completed: 1, totalOpen: 4, rangeOpen: 0 })
})

test('derive: 跨周期任务进入今日 / 逾期口径', () => {
  const tasks = [
    task({ id: 'T-1', title: '进行中', date: '2026-11-03', endDate: '2026-11-08', order: 1 }),
    task({ id: 'T-2', title: '明天开始', date: '2026-11-06', endDate: '2026-11-09', order: 2 }),
    task({ id: 'T-3', title: '已结束', date: '2026-11-01', endDate: '2026-11-04', order: 3 }),
    task({ id: 'T-4', title: '今天单日', date: '2026-11-05', order: 4 }),
  ]
  const today = deriveToday({ tasks }, '2026-11-05')
  assert.deepEqual(today.open.map((item) => item.title), ['进行中', '今天单日'])
  assert.equal(today.open[0].type, 'range')
  assert.deepEqual(today.overdue.map((item) => item.title), ['已结束'])
  assert.equal(today.overdue[0].overdueDays, 1)
  assert.equal(today.counts.rangeOpen, 1)
})

test('derive: 本周 7 列落位、今天标记与跨周期裁剪', () => {
  const tasks = [
    task({ id: 'T-1', title: '周一做', date: '2026-11-02', order: 1 }),
    task({ id: 'T-2', title: '周三做', date: '2026-11-04', order: 2 }),
    task({ id: 'T-3', title: '周四做', date: '2026-11-05', order: 3 }),
    task({ id: 'T-4', title: '下周做', date: '2026-11-09', order: 4 }),
    task({ id: 'T-5', title: '跨周任务', date: '2026-11-03', endDate: '2026-11-10', order: 5 }),
    task({ id: 'T-6', title: '周内跨周期', date: '2026-11-05', endDate: '2026-11-07', order: 6 }),
  ]
  const week = deriveWeek({ tasks }, '2026-11-05', '2026-11-05')
  assert.equal(week.start, '2026-11-02')
  assert.equal(week.end, '2026-11-08')
  assert.equal(week.days.length, 7)
  assert.deepEqual(week.days.map((day) => day.open.length), [1, 0, 1, 1, 0, 0, 0])
  assert.equal(week.days[3].isToday, true)
  assert.equal(week.days[0].isPast, true)
  assert.equal(week.days[6].isFuture, true)
  assert.equal(week.spans.length, 2)
  const longSpan = week.spans.find((span) => span.title === '跨周任务')
  assert.equal(longSpan.startIndex, 1)
  assert.equal(longSpan.endIndex, 6)
  assert.equal(longSpan.startsBefore, false)
  assert.equal(longSpan.endsAfter, true)
  assert.equal(week.counts.rangeOpen, 2)
})

test('derive: 概览计数', () => {
  const tasks = [
    task({ id: 'T-1', title: '写周报', date: '2026-11-05', order: 1 }),
    task({ id: 'T-2', title: '约客户电话', date: '2026-11-06', priority: '重要紧急', order: 2 }),
    task({ id: 'T-3', title: '整理会议纪要', date: '2026-11-04', done: true, completed: '2026-11-04', order: 3 }),
  ]
  assert.deepEqual(deriveCounts({ tasks }, '2026-11-05'), {
    overdue: 0, open: 1, completedToday: 0, totalOpen: 2, totalDone: 1, badge: 1, rangeOpen: 0,
  })
})

test('derive: publicTask 输出类型与字段', () => {
  const single = publicTask(task({ id: 'T-1', title: '单日', time: '09:30' }))
  assert.equal(single.type, 'single')
  assert.equal(single.endDate, null)
  assert.equal(single.endTime, null)
  assert.equal(single.time, '09:30')
  const range = publicTask(task({ id: 'T-2', title: '跨周期', time: '09:30', endDate: '2026-11-12', endTime: '18:00' }))
  assert.equal(range.type, 'range')
  assert.equal(range.endDate, '2026-11-12')
  assert.equal(range.endTime, '18:00')
})

test('validate: 跨周期与时间规则', () => {
  const created = normalizeCreateInput({
    title: 'x', date: '2026-11-05', time: '09:30', endDate: '2026-11-12', endTime: '18:00',
  }, '2026-11-05')
  assert.deepEqual(created, {
    title: 'x', date: '2026-11-05', time: '09:30', endDate: '2026-11-12', endTime: '18:00', priority: null, note: '',
  })
  for (const bad of [
    { title: 'x', date: '2026-11-05', endDate: '2026-11-05' },
    { title: 'x', date: '2026-11-05', endDate: '2026-11-04' },
    { title: 'x', date: '2026-11-05', endTime: '18:00' },
    { title: 'x', date: '2026-11-05', time: '24:00' },
  ]) {
    assert.throws(() => normalizeCreateInput(bad, '2026-11-05'), (error) => error.code === 'validation-error', JSON.stringify(bad))
  }
  assert.deepEqual(normalizeUpdateChanges({ endDate: '', endTime: '', time: '' }), { time: '', endDate: '', endTime: '' })
  assert.throws(() => assertTaskTiming({ date: '2026-11-05', endDate: '2026-11-04' }), (error) => error.code === 'validation-error')
})

test('validate: 文本只保留产品语义限制（不再禁全角分隔符）', () => {
  const created = normalizeCreateInput({
    title: '写周报｜只写结论',
    note: '备注里可以有｜和#',
    date: '2026-11-05',
  }, '2026-11-05')
  assert.equal(created.title, '写周报｜只写结论')
  assert.equal(created.note, '备注里可以有｜和#')

  assert.throws(
    () => normalizeCreateInput({ title: '带\n换行', date: '2026-11-05' }, '2026-11-05'),
    (error) => error.code === 'validation-error',
  )
  assert.throws(
    () => normalizeCreateInput({ title: 'x'.repeat(201), date: '2026-11-05' }, '2026-11-05'),
    (error) => error.code === 'validation-error',
  )
  assert.throws(
    () => normalizeCreateInput({ title: 'x', date: '2026-11-05', note: 'x'.repeat(501) }, '2026-11-05'),
    (error) => error.code === 'validation-error',
  )
})

test('deriveWeek: 周统计（完成 / 进行中 / 逾期 / 有任务天数 / 最忙）', () => {
  const tasks = [
    task({ id: 'T-1', title: '今天', date: '2026-11-05', order: 1 }),
    task({ id: 'T-2', title: '本周完成', date: '2026-11-03', done: true, completed: '2026-11-04', order: 2 }),
    task({ id: 'T-3', title: '本周逾期', date: '2026-11-02', order: 3 }),
    task({ id: 'T-4', title: '周内跨周期', date: '2026-11-05', endDate: '2026-11-07', order: 4 }),
  ]
  const week = deriveWeek({ tasks }, '2026-11-05', '2026-11-05')
  assert.equal(week.stats.total, 4)
  assert.equal(week.stats.done, 1)
  assert.equal(week.stats.overdue, 1)
  assert.equal(week.stats.doing, 2)
  assert.equal(week.stats.daysWithTasks, 5)
  assert.deepEqual(week.stats.busiest, { date: '2026-11-05', count: 2 })
})

test('deriveWeek: 跨周期轨道排序（截止晚→重要度→开始日→创建序）', () => {
  const tasks = [
    task({ id: 'T-1', date: '2026-11-04', endDate: '2026-11-09', priority: '重要不紧急', order: 1 }),
    task({ id: 'T-2', date: '2026-11-06', endDate: '2026-11-09', priority: '重要不紧急', order: 2 }),
    task({ id: 'T-3', date: '2026-11-09', endDate: '2026-11-11', priority: '重要不紧急', order: 3 }),
    task({ id: 'T-4', date: '2026-11-09', endDate: '2026-11-11', priority: '重要紧急', order: 4 }),
    task({ id: 'T-5', date: '2026-11-12', endDate: '2026-11-20', priority: '重要不紧急', order: 5 }),
  ]
  const week = deriveWeek({ tasks }, '2026-11-09', '2026-11-09')
  // 截止晚的在上：T-5(11/20) → T-4/T-3(11/11，重要紧急在前) → T-1/T-2(11/9，开始早的在前)
  assert.deepEqual(week.spans.map((span) => span.id), ['T-5', 'T-4', 'T-3', 'T-1', 'T-2'])
  assert.deepEqual(week.spans.map((span) => span.lane), [0, 1, 2, 3, 4])
})

test('deriveWeek: 每格带高 = 当天最大轨道号 + 1，截止卡落在本周最后一天', () => {
  const tasks = [
    task({ id: 'T-1', date: '2026-11-04', endDate: '2026-11-09', order: 1 }),
    task({ id: 'T-2', date: '2026-11-06', endDate: '2026-11-09', order: 2 }),
    task({ id: 'T-3', date: '2026-11-09', endDate: '2026-11-11', order: 3 }),
    task({ id: 'T-4', date: '2026-11-12', endDate: '2026-11-20', order: 4 }),
  ]
  const week = deriveWeek({ tasks }, '2026-11-09', '2026-11-09')
  const day = (date) => week.days.find((item) => item.date === date)
  // 周一 4 条都在跑 → 4 轨；周二起 T-1/T-2 结束
  // 周一在跑的是 T-1/T-2/T-3，占轨道 1..3；T-4 还没开始，所以第 0 轨空着
  assert.equal(day('2026-11-09').spanLanes, 4)
  assert.equal(day('2026-11-09').spanActive, 3)
  assert.deepEqual(day('2026-11-09').spanEnds, ['T-1', 'T-2'])
  // 周二只剩 T-3（轨道 1）→ 带高 2；周三 T-3 收尾
  assert.equal(day('2026-11-10').spanLanes, 2)
  assert.deepEqual(day('2026-11-11').spanEnds, ['T-3'])
  // 延续到下周的 T-4 落在周日；周日只剩它一条
  assert.equal(day('2026-11-15').spanLanes, 1)
  assert.deepEqual(day('2026-11-15').spanEnds, ['T-4'])
  // 没有跨周期任务的日子，带高为 0（不占位）
  const empty = deriveWeek({ tasks: [] }, '2026-11-09', '2026-11-09')
  assert.deepEqual(empty.days.map((item) => item.spanLanes), [0, 0, 0, 0, 0, 0, 0])
})

test('deriveWeek: 轨道平手时按开始时间、创建序兜底', () => {
  const tasks = [
    task({ id: 'T-1', date: '2026-11-09', endDate: '2026-11-10', order: 2 }),
    task({ id: 'T-2', date: '2026-11-09', endDate: '2026-11-10', order: 1 }),
    task({ id: 'T-3', date: '2026-11-09', endDate: '2026-11-10', time: '09:00', order: 3 }),
  ]
  const week = deriveWeek({ tasks }, '2026-11-09', '2026-11-09')
  // 全天在前（T-2 创建早于 T-1），再按 HH:mm
  assert.deepEqual(week.spans.map((span) => span.id), ['T-2', 'T-1', 'T-3'])
})

test('deriveMonth: 6 行网格 / 相邻月补位 / 今日 / 统计自洽', () => {
  const tasks = [
    task({ id: 'T-1', title: '本月单日', date: '2026-11-09', order: 1 }),
    task({ id: 'T-2', title: '本月跨周期', date: '2026-11-04', endDate: '2026-11-09', order: 2 }),
    task({ id: 'T-3', title: '本月完成', date: '2026-11-02', done: true, completed: '2026-11-02', order: 3 }),
    task({ id: 'T-4', title: '上月任务', date: '2026-10-20', order: 4 }),
  ]
  const month = deriveMonth({ tasks }, '2026-11', '2026-11-09')
  assert.equal(month.month, '2026-11')
  assert.equal(month.label, '2026 年 11 月')
  assert.equal(month.start, '2026-11-01')
  assert.equal(month.end, '2026-11-30')
  assert.equal(month.gridStart, '2026-10-26')
  assert.equal(month.days.length, 42)
  assert.equal(month.rows.length, 6)
  // 第一行 10/26–11/1：只有 11/1 属于本月
  assert.deepEqual(month.days.slice(0, 7).map((day) => day.inMonth), [false, false, false, false, false, false, true])
  assert.equal(month.days[6].date, '2026-11-01')
  // 相邻月格子不显示任何标记
  assert.equal(month.days[0].total, 0)
  assert.equal(month.days[0].open, 0)
  assert.equal(month.days[0].items.length, 0)
  // 今日
  const today = month.days.find((day) => day.date === '2026-11-09')
  assert.equal(today.isToday, true)
  assert.equal(today.open, 1)
  assert.equal(today.spanCovered, true)
  assert.equal(today.spanDeadline, true)
  assert.deepEqual(today.items.map((item) => item.title).sort(), ['本月单日', '本月跨周期'].sort())
  // 上月任务不进入本月集合
  assert.equal(month.stats.total, 3)
  assert.equal(month.stats.done, 1)
  assert.equal(month.stats.overdue, 0)
  assert.equal(month.stats.doing, 2)
  assert.equal(month.stats.done + month.stats.doing + month.stats.overdue, month.stats.total)
  // 跨周期行：11/4–11/9 在第二行（11/2 起）索引 2..6
  const row = month.rows[1]
  const span = row.spans.find((item) => item.id === 'T-2')
  assert.equal(span.startIndex, 2)
  assert.equal(span.endIndex, 6)
  assert.equal(span.deadlineIndex, null) // 截止 11/9 落在下一行
  assert.equal(span.startsBefore, false)
  assert.equal(span.endsAfter, false)
  const deadlineRow = month.rows[2].spans.find((item) => item.id === 'T-2')
  assert.equal(deadlineRow.startIndex, 0)
  assert.equal(deadlineRow.endIndex, 0)
  assert.equal(deadlineRow.deadlineIndex, 0)
  assert.equal(row.spans.filter((item) => item.id === 'T-1').length, 0)
})

test('deriveMonth: 5 行月份也补满 6 行；跨年月份正确衔接', () => {
  // 2027-02：28 天且 2/1 是周一 → 只需 4 行，仍补满 6 行
  const feb = deriveMonth({ tasks: [] }, '2027-02', '2027-02-10')
  assert.equal(feb.days.length, 42)
  assert.equal(feb.rows.length, 6)
  assert.equal(feb.days[0].date, '2027-02-01')
  assert.equal(feb.days[27].inMonth, true)
  assert.equal(feb.days[28].inMonth, false)
  assert.equal(feb.days[28].date, '2027-03-01')

  // 2026-12 → 网格跨到 2027-01
  const dec = deriveMonth({ tasks: [] }, '2026-12', '2026-12-15')
  assert.equal(dec.days[0].date, '2026-11-30')
  assert.equal(dec.days[41].date, '2027-01-10')
  assert.equal(dec.days.filter((day) => day.inMonth).length, 31)
})

test('deriveMonth: 空月与非法月份', () => {
  const empty = deriveMonth({ tasks: [] }, '2026-11', '2026-11-09')
  assert.deepEqual(empty.stats, { total: 0, done: 0, doing: 0, overdue: 0, daysWithTasks: 0, busiest: { date: null, count: 0 } })
  assert.equal(empty.rows.every((row) => row.spans.length === 0), true)
  assert.throws(() => deriveMonth({ tasks: [] }, '2026-13', '2026-11-09'))
  assert.throws(() => deriveMonth({ tasks: [] }, '2026/11', '2026-11-09'))
  assert.throws(() => deriveMonth({ tasks: [] }, '', '2026-11-09'))
})

test('deriveMonth: 跨月任务截断到本月边界，且只在本月画线', () => {
  const tasks = [
    task({ id: 'T-1', title: '跨月', date: '2026-10-28', endDate: '2026-11-03', order: 1 }),
    task({ id: 'T-2', title: '跨到下月', date: '2026-11-28', endDate: '2026-12-05', order: 2 }),
  ]
  const month = deriveMonth({ tasks }, '2026-11', '2026-11-09')
  const first = month.rows[0].spans.find((item) => item.id === 'T-1')
  assert.equal(first.startIndex, 6)
  assert.equal(first.endIndex, 6)
  assert.equal(first.startsBefore, true)
  const lastRow = month.rows[5]
  const tail = lastRow.spans.find((item) => item.id === 'T-2')
  assert.equal(tail.startIndex, 0)
  assert.equal(tail.endIndex, 0) // 本月只画到 11/30
  assert.equal(tail.endsAfter, true)
  assert.equal(tail.deadlineIndex, null)
  // 12/5 的截止不在本月，因此本月 11/30 不出现截止旗
  assert.equal(month.days.find((day) => day.date === '2026-11-30').spanDeadline, false)
})


test('deriveMonth: 区间并集（重叠合并、不相交分段、完成态区分）', () => {
  const tasks = [
    task({ id: 'T-1', title: 'A', date: '2026-11-04', endDate: '2026-11-09', order: 1 }),
    task({ id: 'T-2', title: 'B', date: '2026-11-06', endDate: '2026-11-09', order: 2 }),
    task({ id: 'T-3', title: 'C', date: '2026-11-07', endDate: '2026-11-10', order: 3 }),
    task({ id: 'T-4', title: 'D', date: '2026-11-20', endDate: '2026-11-21', order: 4 }),
    task({ id: 'T-5', title: 'E', date: '2026-11-23', endDate: '2026-11-24', done: true, completed: '2026-11-24', order: 5 }),
  ]
  const month = deriveMonth({ tasks }, '2026-11', '2026-11-09')
  // 第二行（11/2–11/8）：3 条重叠 → 并成一段
  assert.deepEqual(month.rows[1].segments, [{ startIndex: 2, endIndex: 6, open: true }])
  // 第三行（11/9–11/15）：截止日只有 11/9–11/10
  assert.deepEqual(month.rows[2].segments, [{ startIndex: 0, endIndex: 1, open: true }])
  // 第四行（11/16–11/22）：只有一条不相交区间
  assert.deepEqual(month.rows[3].segments, [{ startIndex: 4, endIndex: 5, open: true }])
  // 第五行（11/23–11/29）：已完成 → open=false
  assert.deepEqual(month.rows[4].segments, [{ startIndex: 0, endIndex: 1, open: false }])
})
