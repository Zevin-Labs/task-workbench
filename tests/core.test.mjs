import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskLine, parseShard, serializeShard, appendTaskLine, removeTaskLine, replaceTaskLine, findTask } from '../lib/core/grammar.js'
import { deriveCounts, deriveList, deriveToday, deriveWeek } from '../lib/core/derive.js'
import { normalizeCreateInput, normalizeUpdateChanges, assertTaskTiming } from '../lib/core/validate.js'
import { buildShardText } from '../lib/host/store.js'

const SAMPLE = `---
title: 任务清单 2026-11
type: task-list
format: 1
month: 2026-11
created: 2026-11-01
updated: 2026-11-05
---

# 任务清单 · 2026-11

## 任务

- [ ] \`T-20261105-01\`｜写周报｜日期：2026-11-05｜优先级：重要不紧急｜备注：只写结论
- [ ] \`T-20261104-02\`｜约客户电话｜日期：2026-11-06｜优先级：重要紧急

## 已完成

- [x] \`T-20261104-01\`｜整理会议纪要｜日期：2026-11-04｜优先级：重要不紧急｜完成：2026-11-04
`

function shardWith(taskLines, doneLines = []) {
  const text = buildShardText('2026-11', '2026-11-05', [])
  const todoBlock = taskLines.join('\n')
  const doneBlock = doneLines.join('\n')
  return text.replace('## 任务\n', `## 任务\n${todoBlock ? `\n${todoBlock}\n` : '\n'}`)
    .replace('## 已完成\n', `## 已完成\n${doneBlock ? `\n${doneBlock}\n` : '\n'}`)
}

test('grammar: 解析规范分片', () => {
  const model = parseShard(SAMPLE)
  assert.equal(model.readOnly, false)
  assert.equal(model.errors.length, 0)
  assert.equal(model.tasks.length, 3)
  const weekly = findTask(model, 'T-20261105-01')
  assert.equal(weekly.title, '写周报')
  assert.equal(weekly.date, '2026-11-05')
  assert.equal(weekly.priority, '重要不紧急')
  assert.equal(weekly.note, '只写结论')
  assert.equal(weekly.done, false)
  assert.equal(weekly.section, 'todo')
  const done = findTask(model, 'T-20261104-01')
  assert.equal(done.done, true)
  assert.equal(done.completed, '2026-11-04')
  assert.equal(done.section, 'done')
  assert.deepEqual(model.warnings, [])
})

test('grammar: 解析 → 序列化 roundtrip 逐字节一致', () => {
  const model = parseShard(SAMPLE)
  assert.equal(serializeShard(model), SAMPLE)
})

test('grammar: append 只插入目标行，其他任务行不变', () => {
  const next = appendTaskLine(SAMPLE, 'todo', {
    id: 'T-20261105-03', title: '买咖啡豆', date: '2026-11-05', priority: '重要紧急', note: '', done: false,
  }, '2026-11-05')
  const beforeLines = SAMPLE.split('\n')
  const afterLines = next.split('\n')
  assert.equal(afterLines.length, beforeLines.length + 1)
  assert.ok(next.includes('- [ ] `T-20261105-03`｜买咖啡豆｜日期：2026-11-05｜优先级：重要紧急'))
  assert.ok(next.includes('updated: 2026-11-05'))
  // 原有任务行逐字节不变
  for (const line of beforeLines.filter((line) => line.startsWith('- [') && !line.includes('T-20261105-03'))) {
    assert.ok(afterLines.includes(line), `行丢失：${line}`)
  }
})

test('grammar: remove 精确移除一行并合并空行', () => {
  const next = removeTaskLine(SAMPLE, 'T-20261105-01', '2026-11-05')
  assert.equal(next.includes('T-20261105-01'), false)
  assert.equal(next.includes('T-20261104-02'), true)
  assert.equal((next.match(/\n\n\n/g) || []).length, 0)
  const model = parseShard(next)
  assert.equal(model.tasks.length, 2)
  assert.equal(model.readOnly, false)
})

test('grammar: replace 保持行位置并保留未知字段', () => {
  const text = SAMPLE.replace(
    '- [ ] `T-20261105-01`｜写周报｜日期：2026-11-05｜优先级：重要不紧急｜备注：只写结论',
    '- [ ] `T-20261105-01`｜写周报｜日期：2026-11-05｜优先级：重要不紧急｜备注：只写结论｜其他：保留我',
  )
  const task = findTask(parseShard(text), 'T-20261105-01')
  const next = replaceTaskLine(text, 'T-20261105-01', { ...task, title: '写月报', date: '2026-11-06' }, '2026-11-05')
  const nextTask = findTask(parseShard(next), 'T-20261105-01')
  assert.equal(nextTask.title, '写月报')
  assert.equal(nextTask.date, '2026-11-06')
  assert.equal(nextTask.note, '只写结论')
  assert.deepEqual(nextTask.unknown, ['其他：保留我'])
  assert.ok(next.includes('｜其他：保留我'))
  assert.equal(next.split('\n').length, text.split('\n').length)
})

test('grammar: [X] 视为已完成，写回统一小写', () => {
  const text = SAMPLE.replace('- [x] `T-20261104-01`', '- [X] `T-20261104-01`')
  const model = parseShard(text)
  const task = findTask(model, 'T-20261104-01')
  assert.equal(task.done, true)
  assert.ok(buildTaskLine(task).startsWith('- [x]'))
})

test('grammar: 缺字段 / 非法字段保留原行并给 warning', () => {
  const text = shardWith([
    '- [ ] `T-20261105-09`｜没有日期｜优先级：重要紧急',
    '- [ ] `T-20261105-10`｜坏优先级｜日期：2026-11-05｜优先级：超级紧急',
    '- [ ] `T-20261105-11`｜已完成但没日期｜日期：2026-11-05',
  ])
  const model = parseShard(text)
  assert.equal(model.readOnly, false)
  assert.equal(model.tasks.length, 3)
  assert.ok(model.tasks[0].warnings.includes('缺少日期'))
  assert.ok(model.tasks[1].warnings.some((w) => w.includes('优先级')))
  assert.equal(model.tasks[1].priority, '重要不紧急')
})

test('grammar: 区块缺失 → 只读 + parse-error', () => {
  const text = SAMPLE.replace('## 已完成', '## 其他')
  const model = parseShard(text)
  assert.equal(model.readOnly, true)
  assert.equal(model.errors[0].code, 'parse-error')
  assert.throws(() => appendTaskLine(text, 'todo', {
    id: 'T-20261105-12', title: 'x', date: '2026-11-05', priority: '重要不紧急', done: false,
  }, '2026-11-05'), (error) => error.code === 'parse-error')
})

test('grammar: 缺少 frontmatter format → 只读', () => {
  const text = SAMPLE.replace('format: 1\n', '')
  const model = parseShard(text)
  assert.equal(model.readOnly, true)
  assert.equal(model.readOnlyReason, 'format-version-unsupported')
})

test('derive: 今日分类与排序', () => {
  const text = shardWith([
    '- [ ] `T-20261105-01`｜今天B｜日期：2026-11-05｜优先级：不重要紧急',
    '- [ ] `T-20261105-02`｜今天A｜日期：2026-11-05｜优先级：重要紧急',
    '- [ ] `T-20261104-03`｜逾期A｜日期：2026-11-03｜优先级：不重要不紧急',
    '- [ ] `T-20261104-04`｜逾期B｜日期：2026-11-04｜优先级：重要紧急',
  ], [
    '- [x] `T-20261103-05`｜今天完成｜日期：2026-11-03｜优先级：重要不紧急｜完成：2026-11-05',
    '- [x] `T-20261103-06`｜昨天完成｜日期：2026-11-03｜优先级：重要不紧急｜完成：2026-11-04',
  ])
  const model = parseShard(text)
  const today = deriveToday(model, '2026-11-05')
  assert.deepEqual(today.open.map((t) => t.title), ['今天A', '今天B'])
  assert.deepEqual(today.overdue.map((t) => t.title), ['逾期A', '逾期B'])
  assert.equal(today.overdue[0].overdueDays, 2)
  assert.deepEqual(today.completed.map((t) => t.title), ['今天完成'])
  assert.deepEqual(today.counts, { overdue: 2, open: 2, completed: 1, totalOpen: 4, rangeOpen: 0 })
})

test('derive: 本周 7 列落位与今天标记', () => {
  const text = shardWith([
    '- [ ] `T-20261105-01`｜周一做｜日期：2026-11-02',
    '- [ ] `T-20261105-02`｜周三做｜日期：2026-11-04',
    '- [ ] `T-20261105-03`｜周四做｜日期：2026-11-05',
    '- [ ] `T-20261105-04`｜下周做｜日期：2026-11-09',
  ])
  const model = parseShard(text)
  const week = deriveWeek(model, '2026-11-05', '2026-11-05')
  assert.equal(week.start, '2026-11-02')
  assert.equal(week.end, '2026-11-08')
  assert.equal(week.days.length, 7)
  assert.deepEqual(week.days.map((day) => day.open.length), [1, 0, 1, 1, 0, 0, 0])
  assert.equal(week.days[3].isToday, true)
  assert.equal(week.days[0].isPast, true)
  assert.equal(week.days[6].isFuture, true)
  assert.equal(week.counts.open, 3)
})

test('derive: 总表默认只看未完成，可按优先级排序', () => {
  const model = parseShard(SAMPLE)
  const open = deriveList(model, {})
  assert.deepEqual(open.map((task) => task.id), ['T-20261104-02', 'T-20261105-01'])
  const all = deriveList(model, { includeCompleted: true })
  assert.equal(all.length, 3)
  assert.equal(all[0].id, 'T-20261104-02')
})

test('derive: 概览计数', () => {
  const model = parseShard(SAMPLE)
  const counts = deriveCounts(model, '2026-11-05')
  assert.deepEqual(counts, { overdue: 0, open: 1, completedToday: 0, totalOpen: 2, totalDone: 1, badge: 1, rangeOpen: 0 })
})

test('store: buildShardText 骨架可被解析', () => {
  const text = buildShardText('2026-11', '2026-11-05', ['- [ ] `T-20261105-01`｜结转｜日期：2026-11-05'])
  const model = parseShard(text)
  assert.equal(model.readOnly, false)
  assert.equal(model.tasks.length, 1)
  assert.equal(model.tasks[0].title, '结转')
  assert.equal(model.frontmatter.fields.month, '2026-11')
})


test('grammar: 跨周期与时间字段解析、序列化', () => {
  const text = shardWith([
    '- [ ] `T-20261105-01`｜工作台开发｜日期：2026-11-05｜时间：09:30｜结束日期：2026-11-12｜结束时间：18:00｜优先级：重要紧急',
    '- [ ] `T-20261105-02`｜全天任务｜日期：2026-11-06',
  ])
  const model = parseShard(text)
  const range = findTask(model, 'T-20261105-01')
  assert.equal(range.time, '09:30')
  assert.equal(range.endDate, '2026-11-12')
  assert.equal(range.endTime, '18:00')
  const line = buildTaskLine(range)
  assert.ok(line.includes('时间：09:30'))
  assert.ok(line.includes('结束日期：2026-11-12'))
  assert.ok(line.includes('结束时间：18:00'))
  assert.equal(buildTaskLine(findTask(model, 'T-20261105-02')).includes('结束日期'), false)
  const round = parseShard(serializeShard(model))
  assert.equal(findTask(round, 'T-20261105-01').endDate, '2026-11-12')
})

test('grammar: 非法结束日期/时间给 warning，不阻断读取', () => {
  const text = shardWith([
    '- [ ] `T-20261105-01`｜坏结束｜日期：2026-11-05｜结束日期：2026-11-01',
    '- [ ] `T-20261105-02`｜坏时间｜日期：2026-11-05｜时间：25:00',
    '- [ ] `T-20261105-03`｜只有结束时间｜日期：2026-11-05｜结束时间：18:00',
  ])
  const model = parseShard(text)
  assert.ok(findTask(model, 'T-20261105-01').warnings.some((w) => w.includes('结束日期')))
  assert.ok(findTask(model, 'T-20261105-02').warnings.some((w) => w.includes('时间')))
  assert.ok(findTask(model, 'T-20261105-03').warnings.some((w) => w.includes('结束时间')))
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

test('derive: 跨周期任务进入今日 / 逾期口径', () => {
  const text = shardWith([
    '- [ ] `T-20261105-01`｜进行中｜日期：2026-11-03｜结束日期：2026-11-08',
    '- [ ] `T-20261105-02`｜明天开始｜日期：2026-11-06｜结束日期：2026-11-09',
    '- [ ] `T-20261105-03`｜已结束｜日期：2026-11-01｜结束日期：2026-11-04',
    '- [ ] `T-20261105-04`｜今天单日｜日期：2026-11-05',
  ])
  const model = parseShard(text)
  const today = deriveToday(model, '2026-11-05')
  assert.deepEqual(today.open.map((task) => task.title), ['进行中', '今天单日'])
  assert.equal(today.open[0].type, 'range')
  assert.deepEqual(today.overdue.map((task) => task.title), ['已结束'])
  assert.equal(today.overdue[0].overdueDays, 1)
  assert.equal(today.counts.rangeOpen, 1)
})

test('derive: 本周跨周期任务生成横跨区间并按周裁剪', () => {
  const text = shardWith([
    '- [ ] `T-20261105-01`｜跨周任务｜日期：2026-11-03｜结束日期：2026-11-10',
    '- [ ] `T-20261105-02`｜周内跨周期｜日期：2026-11-05｜结束日期：2026-11-07',
    '- [ ] `T-20261105-03`｜周一单日｜日期：2026-11-02',
  ])
  const model = parseShard(text)
  const week = deriveWeek(model, '2026-11-05', '2026-11-05')
  assert.equal(week.spans.length, 2)
  const longSpan = week.spans.find((span) => span.title === '跨周任务')
  assert.equal(longSpan.startIndex, 1)
  assert.equal(longSpan.endIndex, 6)
  assert.equal(longSpan.startsBefore, false)
  assert.equal(longSpan.endsAfter, true)
  assert.equal(week.days[0].open.length, 1)
  assert.equal(week.counts.open, 3)
  assert.equal(week.counts.rangeOpen, 2)
})
