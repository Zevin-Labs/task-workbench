import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TaskStore } from '../lib/host/store.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { ReviewService } from '../lib/host/review-service.js'
import { toolActor, userActor } from '../lib/host/service.js'

const TASK_SHARD_OCT = [
  '---', 'title: 任务清单 2026-10', 'type: task-list', 'format: 1', 'month: 2026-10',
  'created: 2026-10-01', 'updated: 2026-10-31', '---', '', '# 任务清单 · 2026-10', '',
  '## 任务', '',
  '- [ ] `T-20261001-01`｜十月没做完｜日期：2026-10-30', '',
  '## 已完成', '',
  '- [x] `T-20261001-02`｜十月做完｜日期：2026-10-28｜优先级：重要紧急｜完成：2026-10-28', '',
].join('\n')

const TASK_SHARD_NOV = [
  '---', 'title: 任务清单 2026-11', 'type: task-list', 'format: 1', 'month: 2026-11',
  'created: 2026-11-01', 'updated: 2026-11-20', '---', '', '# 任务清单 · 2026-11', '',
  '## 任务', '',
  '- [ ] `T-20261101-01`｜十一月待办｜日期：2026-11-20', '',
  '## 已完成', '',
  '- [x] `T-20261101-02`｜十一月做完｜日期：2026-11-01｜完成：2026-11-01', '',
].join('\n')

const DAILY_FIXTURE = [
  '---', 'title: 日复盘', 'type: review-daily', 'format: 1', 'created: 2026-10-20', 'updated: 2026-11-05',
  '---', '', '# 日复盘', '', '## 记录', '',
  '- `2026-10-28`｜更新：2026-10-28 21:00', '  十月二十八的复盘', '',
  '- `2026-10-30`｜更新：2026-10-30 21:00', '  十月三十的复盘', '',
  '- `2026-11-01`｜更新：2026-11-01 21:00', '  十一月一的复盘', '',
  '- `2026-11-03`｜更新：2026-11-03 21:00', '  十一月三的复盘', '',
].join('\n')

const WEEKLY_FIXTURE = [
  '---', 'title: 周复盘', 'type: review-weekly', 'format: 1', 'created: 2026-10-20', 'updated: 2026-11-20',
  '---', '', '# 周复盘', '', '## 记录', '',
  '- `2026-11-02`｜更新：2026-11-09 10:00', '  十一月第一周', '',
  '- `2026-12-07`｜更新：2026-12-14 10:00', '  十二月那一周', '',
].join('\n')

// 月复盘材料要覆盖「包含 1 号那一周」的跨月周，单独用这份含 10/26 的 fixture。
const MONTHLY_WEEKLY_FIXTURE = [
  '---', 'title: 周复盘', 'type: review-weekly', 'format: 1', 'created: 2026-10-20', 'updated: 2026-12-14',
  '---', '', '# 周复盘', '', '## 记录', '',
  '- `2026-10-26`｜更新：2026-11-02 10:00', '  十月最后一周', '',
  '- `2026-11-02`｜更新：2026-11-09 10:00', '  十一月第一周', '',
  '- `2026-12-07`｜更新：2026-12-14 10:00', '  十二月那一周', '',
].join('\n')

async function makeEnv({ now = '2026-11-05T10:00:00', initialized = true, fixtures = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ptw-review-'))
  let current = new Date(now)
  const nowFn = () => current
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized }
  const taskStore = new TaskStore({ settings, persistSettings: () => {}, now: nowFn })
  const store = new ReviewStore({
    settings,
    persistSettings: () => {},
    now: nowFn,
    isDataRootReady: () => settings.initialized === true,
  })
  const service = new ReviewService({ store, taskStore, stateDir: join(root, 'state'), now: nowFn })
  const write = async (relPath, text) => {
    const file = join(settings.dataRoot, relPath)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
  if (fixtures) {
    await write(join('任务清单', '2026-10.md'), TASK_SHARD_OCT)
    await write(join('任务清单', '2026-11.md'), TASK_SHARD_NOV)
    await write(join('复盘', '日复盘.md'), DAILY_FIXTURE)
    await write(join('复盘', '周复盘.md'), WEEKLY_FIXTURE)
  }
  return {
    root,
    settings,
    store,
    taskStore,
    service,
    write,
    setNow: (value) => { current = new Date(value) },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const agent = () => toolActor({ agent: { session: { id: 'session-review' } } })

test('review-service: 空数据 → 复盘板给出日/周提示，不写任何文件', async (t) => {
  const env = await makeEnv({ fixtures: false })
  t.after(env.cleanup)

  const board = await env.service.board()
  assert.equal(board.date, '2026-11-05')
  assert.deepEqual(board.prompts.map((p) => [p.kind, p.key]), [['daily', '2026-11-05'], ['weekly', '2026-10-26']])
  const daily = board.prompts[0]
  assert.equal(daily.state, 'pending')
  assert.equal(daily.hash, null)
  assert.equal(daily.fileExists, false)
  assert.equal(daily.readOnly, false)
  assert.equal(daily.materials, null)
  const weekly = board.prompts[1]
  assert.equal(weekly.state, 'pending')
  assert.deepEqual(weekly.materials.dailyReviews, [])
  assert.equal(weekly.materials.completedCount, 0)
  assert.deepEqual(await readdir(join(env.settings.dataRoot, '复盘')).catch(() => null), null, '读复盘板不应创建文件')
})

test('review-service: 提交日复盘自动建文件 + 再次提交更新 + 备份 + 审计', async (t) => {
  const env = await makeEnv({ fixtures: false })
  t.after(env.cleanup)

  const created = await env.service.save('daily', '2026-11-05', { text: '今天完成了 A。\n\n发现：B 卡住。' }, userActor())
  assert.equal(created.created, true)
  assert.equal(created.review.text, '今天完成了 A。\n\n发现：B 卡住。')
  assert.equal(created.review.updatedAt, '2026-11-05 10:00')
  assert.equal(created.hash.length, 64)

  const file = join(env.settings.dataRoot, '复盘', '日复盘.md')
  const text = await readFile(file, 'utf8')
  assert.ok(text.includes('type: review-daily'))
  assert.ok(text.includes('## 记录'))
  assert.ok(text.includes('- `2026-11-05`｜更新：2026-11-05 10:00'))
  assert.ok(text.includes('  今天完成了 A。'))
  assert.ok(text.includes('\n  \n'))

  let board = await env.service.board()
  assert.equal(board.prompts[0].state, 'done')
  assert.equal(board.prompts[0].review.text, '今天完成了 A。\n\n发现：B 卡住。')

  env.setNow('2026-11-05T21:30:00')
  const updated = await env.service.save('daily', '2026-11-05', {
    text: '改过的正文', baseHash: created.hash,
  }, userActor())
  assert.equal(updated.created, false)
  assert.equal(updated.review.updatedAt, '2026-11-05 21:30')
  const afterText = await readFile(file, 'utf8')
  assert.equal(afterText.includes('改过的正文'), true)
  assert.equal(afterText.includes('今天完成了 A。'), false)
  assert.equal((afterText.match(/- `2026-11-05`/g) ?? []).length, 1, '同一天只有一条记录')

  // 写前备份：日复盘-<HHMMSS>.md
  const backups = await readdir(join(env.settings.dataRoot, '备份', '2026-11-05'))
  assert.ok(backups.some((name) => name.startsWith('日复盘-')))

  // 审计：review-create / review-update，actor=user
  const log = await readFile(join(env.root, 'state', 'writes.log'), 'utf8')
  const ops = log.trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.op?.startsWith('review-'))
  assert.deepEqual(ops.map((entry) => entry.op), ['review-create', 'review-update'])
  assert.equal(ops[0].actor, 'user')
  assert.equal(ops[0].reviewKey, '2026-11-05')
})

test('review-service: 可写窗口外拒绝写入；AI 不能写；baseHash 冲突', async (t) => {
  const env = await makeEnv({ fixtures: false })
  t.after(env.cleanup)

  await assert.rejects(
    env.service.save('daily', '2026-11-04', { text: '补写昨天' }, userActor()),
    (error) => error.code === 'validation-error' && /可写窗口/.test(error.message),
  )
  await assert.rejects(
    env.service.save('weekly', '2026-11-02', { text: '写成这周' }, userActor()),
    (error) => error.code === 'validation-error',
  )
  await assert.rejects(
    env.service.save('monthly', '2026-11', { text: '月中写月复盘' }, userActor()),
    (error) => error.code === 'validation-error',
  )
  await assert.rejects(
    env.service.save('daily', '2026-11-05', { text: 'AI 写的' }, agent()),
    (error) => error.code === 'permission-denied',
  )
  const dailyFile = join(env.settings.dataRoot, '复盘', '日复盘.md')
  await assert.rejects(readFile(dailyFile, 'utf8'), /ENOENT/, '被拒绝的写入不应创建文件')

  const saved = await env.service.save('weekly', '2026-10-26', { text: '上周复盘' }, userActor())
  // 外部改动后，旧 baseHash 的写入被拒绝
  const weeklyFile = join(env.settings.dataRoot, '复盘', '周复盘.md')
  const current = await readFile(weeklyFile, 'utf8')
  await writeFile(weeklyFile, current.replace('上周复盘', '被外部改过'), 'utf8')
  await assert.rejects(
    env.service.save('weekly', '2026-10-26', { text: '覆盖', baseHash: saved.hash }, userActor()),
    (error) => error.code === 'external-change',
  )
  // 重新读取后可以继续写
  const latest = await env.service.board()
  const weeklyPrompt = latest.prompts.find((p) => p.kind === 'weekly')
  const ok = await env.service.save('weekly', '2026-10-26', { text: '重新写', baseHash: weeklyPrompt.hash }, userActor())
  assert.equal(ok.review.text, '重新写')
})

test('review-service: 周复盘材料 = 上周日复盘 + 跨月任务概况（只读合并上月分片）', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const octBefore = await readFile(join(env.settings.dataRoot, '任务清单', '2026-10.md'), 'utf8')
  const board = await env.service.board()
  const weekly = board.prompts.find((p) => p.kind === 'weekly')
  assert.equal(weekly.key, '2026-10-26')
  assert.equal(weekly.periodStart, '2026-10-26')
  assert.equal(weekly.periodEnd, '2026-11-01')
  assert.deepEqual(weekly.materials.dailyReviews.map((entry) => entry.key), ['2026-10-28', '2026-10-30', '2026-11-01'])
  assert.equal(weekly.materials.completedCount, 2, '10/28 与 11/01 各一条')
  assert.equal(weekly.materials.pendingCount, 1, '10/30 到期未完成')
  assert.deepEqual(weekly.materials.warnings, [])
  assert.equal(
    await readFile(join(env.settings.dataRoot, '任务清单', '2026-10.md'), 'utf8'),
    octBefore,
    '读材料不得改动历史分片',
  )

  const saved = await env.service.save('weekly', '2026-10-26', { text: '上周整体推进得不错。' }, userActor())
  assert.equal(saved.created, true)
  const weeklyFile = await readFile(join(env.settings.dataRoot, '复盘', '周复盘.md'), 'utf8')
  assert.ok(weeklyFile.includes('- `2026-10-26`｜更新：2026-11-05 10:00'))
  const again = await env.service.board()
  assert.equal(again.prompts.find((p) => p.kind === 'weekly').state, 'done')
})

test('review-service: 月复盘在月末出现、次月 1–3 日可补写、材料含本月周复盘', async (t) => {
  const env = await makeEnv({ now: '2026-11-30T22:00:00' })
  t.after(env.cleanup)
  await env.write(join('复盘', '周复盘.md'), MONTHLY_WEEKLY_FIXTURE)

  const board = await env.service.board()
  assert.deepEqual(board.prompts.map((p) => [p.kind, p.key]), [
    ['daily', '2026-11-30'], ['weekly', '2026-11-23'], ['monthly', '2026-11'],
  ])
  const monthly = board.prompts.find((p) => p.kind === 'monthly')
  assert.equal(monthly.periodStart, '2026-11-01')
  assert.equal(monthly.periodEnd, '2026-11-30')
  assert.deepEqual(monthly.materials.weeklyReviews.map((entry) => entry.key), ['2026-10-26', '2026-11-02'])
  assert.equal(monthly.materials.completedCount, 1)
  assert.equal(monthly.materials.pendingCount, 1)

  const saved = await env.service.save('monthly', '2026-11', { text: '十一月复盘正文' }, userActor())
  assert.equal(saved.created, true)

  // 次月 2 日仍可补写（已写则是更新），4 日起不再出现
  env.setNow('2026-12-02T09:00:00')
  const december = await env.service.board()
  const monthlyInDec = december.prompts.find((p) => p.kind === 'monthly')
  assert.equal(monthlyInDec.key, '2026-11')
  assert.equal(monthlyInDec.state, 'done')
  const cleared = await env.service.clear('monthly', '2026-11', {}, userActor())
  assert.equal(cleared.deleted.key, '2026-11')

  env.setNow('2026-12-04T09:00:00')
  assert.equal((await env.service.board()).prompts.some((p) => p.kind === 'monthly'), false)
})

test('review-service: 清空复盘（备份 + 审计），再清空 not-found；窗口外不可清空', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const saved = await env.service.save('daily', '2026-11-05', { text: '要删掉的复盘' }, userActor())
  const cleared = await env.service.clear('daily', '2026-11-05', { baseHash: saved.hash }, userActor())
  assert.deepEqual(cleared.deleted, { kind: 'daily', key: '2026-11-05', updatedAt: '2026-11-05 10:00' })

  const text = await readFile(join(env.settings.dataRoot, '复盘', '日复盘.md'), 'utf8')
  assert.equal(text.includes('要删掉的复盘'), false)
  assert.equal((await env.service.board()).prompts[0].state, 'pending')

  await assert.rejects(env.service.clear('daily', '2026-11-05', {}, userActor()), (e) => e.code === 'not-found')
  await assert.rejects(
    env.service.clear('daily', '2026-11-04', {}, userActor()),
    (e) => e.code === 'validation-error',
  )
  const log = await readFile(join(env.root, 'state', 'writes.log'), 'utf8')
  assert.ok(log.includes('"op":"review-delete"'))
})

test('review-service: AI 只读 list / get；正文摘要与范围筛选', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const all = await env.service.list()
  assert.equal(all.total, 6, '4 条日复盘 + 2 条周复盘')
  assert.equal(all.reviews[0].text, undefined, '列表不返回完整正文')
  assert.ok(all.reviews.some((review) => review.kind === 'daily' && review.textLength === '十月二十八的复盘'.length))

  const daily = await env.service.list({ kind: 'daily' })
  assert.equal(daily.total, 4)
  const ranged = await env.service.list({ kind: 'daily', from: '2026-10-29', to: '2026-11-02' })
  assert.deepEqual(ranged.reviews.map((review) => review.key).sort(), ['2026-10-30', '2026-11-01'])

  const one = await env.service.get('weekly', '2026-11-02')
  assert.equal(one.review.text, '十一月第一周')
  assert.equal(one.review.periodStart, '2026-11-02')
  await assert.rejects(env.service.get('weekly', '2026-10-27'), (error) => error.code === 'validation-error')
  await assert.rejects(env.service.get('daily', '2026-01-01'), (error) => error.code === 'not-found')
})

test('review-service: 文件损坏只影响该类型（只读标记），其他类型照常', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.write(join('复盘', '日复盘.md'), '## 记录\n')

  const board = await env.service.board()
  const daily = board.prompts.find((p) => p.kind === 'daily')
  const weekly = board.prompts.find((p) => p.kind === 'weekly')
  assert.equal(daily.readOnly, true)
  assert.equal(daily.readOnlyReason, 'format-version-unsupported')
  assert.equal(weekly.readOnly, false)
  await assert.rejects(
    env.service.save('daily', '2026-11-05', { text: 'x' }, userActor()),
    (error) => error.code === 'read-only',
  )
  await assert.rejects(env.service.list({ kind: 'daily' }), (error) => error.code === 'read-only')
  // 周复盘仍可写
  const saved = await env.service.save('weekly', '2026-10-26', { text: '周复盘还能写' }, userActor())
  assert.equal(saved.created, true)
})

test('review-service: 数据根未初始化时拒绝建文件', async (t) => {
  const env = await makeEnv({ fixtures: false, initialized: false })
  t.after(env.cleanup)
  await assert.rejects(
    env.service.save('daily', '2026-11-05', { text: 'x' }, userActor()),
    (error) => error.code === 'file-missing' && /初始化/.test(error.message),
  )
})
