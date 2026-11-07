import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveCounts, deriveToday, deriveWeek, publicTask } from '../lib/core/derive.js'
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
