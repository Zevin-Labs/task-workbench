import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveReviewBoard, dueReviewPrompts, isReviewWritable, lastDayOfMonth, periodOfKey,
  previousMonthKey, reviewsInRange, summarizePeriodTasks, weeklyReviewsOfMonth,
} from '../lib/core/review-window.js'
import {
  assertReviewKey, normalizeReviewText, normalizeReviewWriteInput,
} from '../lib/core/review-validate.js'

test('review-window: 日 / 周 / 月 的窗口口径', () => {
  // 周四 2026-11-05：日=今天；周=上周（10/26–11/01）；月未到期
  const thu = dueReviewPrompts('2026-11-05')
  assert.deepEqual(thu.map((p) => [p.kind, p.key]), [['daily', '2026-11-05'], ['weekly', '2026-10-26']])
  assert.deepEqual(thu[1], {
    kind: 'weekly', key: '2026-10-26', windowStart: '2026-11-02', windowEnd: '2026-11-08',
  })
  assert.equal(thu.some((p) => p.kind === 'monthly'), false)

  // 周一 2026-11-02：日=11-02；周=10-26；月=补写 10 月（1–3 日窗口）
  const mon = dueReviewPrompts('2026-11-02')
  assert.deepEqual(mon.map((p) => [p.kind, p.key]), [['daily', '2026-11-02'], ['weekly', '2026-10-26'], ['monthly', '2026-10']])
  assert.deepEqual(mon[2], { kind: 'monthly', key: '2026-10', windowStart: '2026-10-31', windowEnd: '2026-11-03' })

  // 周日 2026-11-08：周复盘仍复盘 10/26 那一周
  assert.equal(dueReviewPrompts('2026-11-08')[1].key, '2026-10-26')
  // 下周一 2026-11-09：切到 11/02 那一周
  assert.equal(dueReviewPrompts('2026-11-09')[1].key, '2026-11-02')

  // 月末：11/30（30 天月）出现「本月」复盘，可写到次月 3 日
  const nov30 = dueReviewPrompts('2026-11-30')
  assert.deepEqual(nov30.find((p) => p.kind === 'monthly'), {
    kind: 'monthly', key: '2026-11', windowStart: '2026-11-30', windowEnd: '2026-12-03',
  })
  // 无 31 号的月份：2 月 28 出现（2026 非闰年）
  assert.equal(lastDayOfMonth('2026-02-10'), '2026-02-28')
  assert.equal(dueReviewPrompts('2026-02-28').find((p) => p.kind === 'monthly').key, '2026-02')
  assert.equal(dueReviewPrompts('2026-04-30').find((p) => p.kind === 'monthly').key, '2026-04')
  // 次月 1–3 日补写上月；4 日起不再提示
  assert.equal(dueReviewPrompts('2026-12-01').find((p) => p.kind === 'monthly').key, '2026-11')
  assert.equal(dueReviewPrompts('2026-12-03').find((p) => p.kind === 'monthly').key, '2026-11')
  assert.equal(dueReviewPrompts('2026-12-04').some((p) => p.kind === 'monthly'), false)
  // 跨年：1 月 1–3 日补写上一年 12 月
  assert.equal(dueReviewPrompts('2026-01-01').find((p) => p.kind === 'monthly').key, '2025-12')
  assert.equal(previousMonthKey('2026-01'), '2025-12')
})

test('review-window: 可写窗口只放行当前那个周期', () => {
  assert.equal(isReviewWritable('daily', '2026-11-05', '2026-11-05'), true)
  assert.equal(isReviewWritable('daily', '2026-11-04', '2026-11-05'), false)
  assert.equal(isReviewWritable('weekly', '2026-10-26', '2026-11-05'), true)
  assert.equal(isReviewWritable('weekly', '2026-11-02', '2026-11-05'), false)
  assert.equal(isReviewWritable('monthly', '2026-11', '2026-11-30'), true)
  assert.equal(isReviewWritable('monthly', '2026-11', '2026-12-02'), true)
  assert.equal(isReviewWritable('monthly', '2026-11', '2026-11-25'), false)
  assert.equal(isReviewWritable('monthly', '2026-10', '2026-11-02'), true)
  assert.equal(isReviewWritable('monthly', '2026-10', '2026-11-05'), false)
})

test('review-window: 周期换算与材料汇总', () => {
  assert.deepEqual(periodOfKey('daily', '2026-11-05'), { start: '2026-11-05', end: '2026-11-05' })
  assert.deepEqual(periodOfKey('weekly', '2026-11-02'), { start: '2026-11-02', end: '2026-11-08' })
  assert.deepEqual(periodOfKey('monthly', '2026-11'), { start: '2026-11-01', end: '2026-11-30' })

  const tasks = [
    { id: 'T-1', title: '完成于周期内', date: '2026-11-03', done: true, completed: '2026-11-04', priority: '重要紧急' },
    { id: 'T-2', title: '周期内到期未完成', date: '2026-11-02', done: false, priority: '重要不紧急' },
    { id: 'T-3', title: '周期外完成', date: '2026-11-10', done: true, completed: '2026-11-10', priority: '重要紧急' },
    { id: 'T-4', title: '跨周期未完成', date: '2026-11-02', endDate: '2026-11-09', done: false, priority: '不重要紧急' },
  ]
  const summary = summarizePeriodTasks(tasks, '2026-11-02', '2026-11-08')
  assert.equal(summary.completedCount, 1)
  assert.equal(summary.completed[0].id, 'T-1')
  assert.equal(summary.pendingCount, 1)
  assert.equal(summary.pending[0].id, 'T-2')

  const entries = [
    { key: '2026-10-25', text: '上周日' },
    { key: '2026-11-01', text: '周日的日复盘' },
    { key: '2026-11-02', text: '周一的日复盘' },
    { key: '2026-11-05', text: '周四' },
  ]
  assert.deepEqual(reviewsInRange(entries, '2026-11-02', '2026-11-08').map((e) => e.key), ['2026-11-02', '2026-11-05'])

  const weeks = [
    { key: '2026-10-19', text: 'a' },
    { key: '2026-10-26', text: 'b' },
    { key: '2026-11-02', text: 'c' },
    { key: '2026-11-30', text: 'd' },
    { key: '2026-12-07', text: 'e' },
  ]
  assert.deepEqual(weeklyReviewsOfMonth(weeks, '2026-11').map((w) => w.key), ['2026-10-26', '2026-11-02', '2026-11-30'])
})

test('review-window: 复盘板状态与材料挂载', () => {
  const board = deriveReviewBoard({
    today: '2026-11-05',
    entriesByKind: {
      daily: [{ key: '2026-11-05', text: '今天的复盘', updatedAt: '2026-11-05 21:50' }],
      weekly: [{ key: '2026-10-26', text: '上周复盘', updatedAt: '2026-11-02 10:00' }],
    },
    materialsByKind: { weekly: { completedCount: 3, completed: [], pendingCount: 1, pending: [], dailyReviews: [] } },
  })
  assert.equal(board.prompts.length, 2)
  assert.equal(board.prompts[0].kind, 'daily')
  assert.equal(board.prompts[0].state, 'done')
  assert.equal(board.prompts[0].review.text, '今天的复盘')
  assert.equal(board.prompts[1].state, 'done')
  assert.equal(board.prompts[1].label, '上周')
  assert.equal(board.prompts[1].materials.completedCount, 3)
  assert.equal(board.prompts[1].periodStart, '2026-10-26')
  assert.equal(board.prompts[1].periodEnd, '2026-11-01')
})

test('review-validate: 键与正文校验（正文可含 ｜ / # / 多段）', () => {
  assert.equal(assertReviewKey('daily', '2026-11-05'), '2026-11-05')
  assert.throws(() => assertReviewKey('weekly', '2026-11-05'), /周一/)
  assert.throws(() => assertReviewKey('monthly', '2026-11-05'), /YYYY-MM/)
  assert.throws(() => assertReviewKey('nope', '2026-11-05'), /daily \/ weekly \/ monthly/)

  const body = '第一段：a｜b\n\n## 不是标题\n- 不是列表'
  assert.deepEqual(normalizeReviewWriteInput({ text: `\r\n\r\n${body}\r\n\r\n` }), { text: body })
  assert.equal(normalizeReviewText('  第一行  \n\n第二行  '), '  第一行\n\n第二行')
  assert.throws(() => normalizeReviewWriteInput({ text: '   ' }), /不能为空/)
  assert.throws(() => normalizeReviewWriteInput({ text: 42 }), /必须是文本/)
  assert.throws(() => normalizeReviewWriteInput({ text: 'x'.repeat(20001) }), /最多 20000/)
})
