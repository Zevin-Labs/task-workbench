import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchDatabase } from '../lib/host/db.js'
import { TaskService, toolActor, userActor } from '../lib/host/service.js'
import { ReviewService } from '../lib/host/review-service.js'

async function makeEnv({ now = '2026-11-05T10:00:00', initialized = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twb-review-'))
  let current = new Date(now)
  const nowFn = () => current
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7 }
  const db = new WorkbenchDatabase({ settings, now: nowFn })
  if (initialized) db.init()
  const env = {
    root,
    settings,
    db,
    taskService: new TaskService({ db, now: nowFn }),
    service: new ReviewService({ db, now: nowFn }),
    setNow: (value) => { current = new Date(value) },
    query(sql, ...params) { return env.db.ensureInitialized().prepare(sql).all(...params) },
    one(sql, ...params) { return env.db.ensureInitialized().prepare(sql).get(...params) },
    seedReview(kind, key, text, updatedAt) {
      env.db.ensureInitialized().prepare('INSERT INTO reviews (kind, period_key, text, updated_at) VALUES (?, ?, ?, ?)')
        .run(kind, key, text, updatedAt)
    },
    reopen() {
      db.close()
      env.db = new WorkbenchDatabase({ settings, now: nowFn })
      env.service = new ReviewService({ db: env.db, now: nowFn })
      return env.service
    },
    async cleanup() {
      env.db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
  return env
}

const agent = () => toolActor({ agent: { session: { id: 'session-review' } } })

function writeState(env) {
  const db = env.db.ensureInitialized()
  return {
    reviews: db.prepare('SELECT * FROM reviews ORDER BY kind, period_key').all(),
    audit: db.prepare('SELECT * FROM write_log ORDER BY id').all(),
    versions: db.prepare('SELECT * FROM meta ORDER BY meta_key').all(),
  }
}

test('review-service: 空数据 → 复盘板给出日/周提示，不写库', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const board = await env.service.board()
  assert.equal(board.date, '2026-11-05')
  assert.deepEqual(board.prompts.map((p) => [p.kind, p.key]), [['daily', '2026-11-05'], ['weekly', '2026-10-26']])
  const daily = board.prompts[0]
  assert.equal(daily.state, 'pending')
  assert.equal(daily.version, 0)
  assert.equal(daily.materials, null)
  const weekly = board.prompts[1]
  assert.equal(weekly.state, 'pending')
  assert.deepEqual(weekly.materials.dailyReviews, [])
  assert.equal(weekly.materials.completedCount, 0)
  assert.deepEqual(board.versions, { daily: 0, weekly: 0, monthly: 0 })
  assert.equal(env.one('SELECT COUNT(*) AS n FROM reviews').n, 0)
})

test('review-service: 复盘板只读窗口所需正文，不扫描整张表', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  env.seedReview('daily', '2026-10-01', '窗口外的日复盘', '2026-10-01 21:00')
  env.seedReview('weekly', '2026-09-28', '窗口外的周复盘', '2026-10-05 10:00')

  const board = await env.service.board()
  const daily = board.prompts.find((prompt) => prompt.kind === 'daily')
  const weekly = board.prompts.find((prompt) => prompt.kind === 'weekly')
  assert.equal(daily.state, 'pending')
  assert.equal(daily.review, null)
  assert.equal(weekly.state, 'pending')
  assert.deepEqual(weekly.materials.dailyReviews, [])
  assert.equal(env.one('SELECT COUNT(*) AS n FROM reviews').n, 2, '窗口外的复盘仍在库里，只是复盘板不读取')
})

test('review-service: 提交日复盘 + 再次提交更新 + 审计', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const created = await env.service.save('daily', '2026-11-05', { text: '今天完成了 A。\n\n发现：B 卡住。' }, userActor())
  assert.equal(created.created, true)
  assert.equal(created.review.text, '今天完成了 A。\n\n发现：B 卡住。')
  assert.equal(created.review.updatedAt, '2026-11-05 10:00')
  assert.equal(created.version, 1)
  assert.equal(env.one('SELECT COUNT(*) AS n FROM reviews').n, 1)

  let board = await env.service.board()
  assert.equal(board.prompts[0].state, 'done')
  assert.equal(board.prompts[0].review.text, '今天完成了 A。\n\n发现：B 卡住。')
  assert.equal(board.prompts[0].version, 1)

  env.setNow('2026-11-05T21:30:00')
  const updated = await env.service.save('daily', '2026-11-05', {
    text: '改过的正文', baseVersion: created.version,
  }, userActor())
  assert.equal(updated.created, false)
  assert.equal(updated.review.updatedAt, '2026-11-05 21:30')
  assert.equal(updated.version, 2)
  assert.equal(env.one('SELECT COUNT(*) AS n FROM reviews').n, 1, '同一天只有一条记录')
  assert.equal(env.one('SELECT text FROM reviews WHERE kind = ? AND period_key = ?', 'daily', '2026-11-05').text, '改过的正文')

  const log = env.query('SELECT actor, actor_kind, op, domain, target FROM write_log ORDER BY id')
  assert.deepEqual(log.map((entry) => entry.op), ['review-create', 'review-update'])
  assert.equal(log[0].actor, 'user')
  assert.equal(log[0].domain, 'review')
  assert.equal(log[0].target, 'daily:2026-11-05')
})

test('review-service: 可写窗口外拒绝写入；AI 不能写；baseVersion 冲突', async (t) => {
  const env = await makeEnv()
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
  assert.equal(env.one('SELECT COUNT(*) AS n FROM reviews').n, 0, '被拒绝的写入不应落库')

  const saved = await env.service.save('weekly', '2026-10-26', { text: '上周复盘' }, userActor())
  await assert.rejects(
    env.service.save('weekly', '2026-10-26', { text: '覆盖', baseVersion: 0 }, userActor()),
    (error) => error.code === 'external-change',
  )
  const latest = await env.service.board()
  const weeklyPrompt = latest.prompts.find((p) => p.kind === 'weekly')
  const ok = await env.service.save('weekly', '2026-10-26', { text: '重新写', baseVersion: weeklyPrompt.version }, userActor())
  assert.equal(ok.review.text, '重新写')
  assert.equal(ok.version, saved.version + 1)
})

test('review-service: 周材料 = 上周日复盘 + 跨月任务概况（同一任务真源、不重计）', async (t) => {
  const env = await makeEnv({ now: '2026-10-20T09:00:00' })
  t.after(env.cleanup)

  const a = await env.taskService.create({ title: '十月完成', date: '2026-10-28' }, userActor())
  const b = await env.taskService.create({ title: '十一月完成', date: '2026-11-01' }, userActor())
  await env.taskService.create({ title: '十月到期未完成', date: '2026-10-30' }, userActor())
  await env.taskService.create({ title: '十一月待办', date: '2026-11-20' }, userActor())

  env.setNow('2026-10-28T21:00:00')
  await env.taskService.complete(a.task.id, true, {}, userActor())
  await env.service.save('daily', '2026-10-28', { text: '十月二十八的复盘' }, userActor())

  env.setNow('2026-10-30T21:00:00')
  await env.service.save('daily', '2026-10-30', { text: '十月三十的复盘' }, userActor())

  env.setNow('2026-11-01T21:00:00')
  await env.taskService.complete(b.task.id, true, {}, userActor())
  await env.service.save('daily', '2026-11-01', { text: '十一月一的复盘' }, userActor())

  env.setNow('2026-11-05T10:00:00')
  const tasksBefore = env.one('SELECT COUNT(*) AS n FROM tasks').n
  const board = await env.service.board()
  const weekly = board.prompts.find((p) => p.kind === 'weekly')
  assert.equal(weekly.key, '2026-10-26')
  assert.equal(weekly.periodStart, '2026-10-26')
  assert.equal(weekly.periodEnd, '2026-11-01')
  assert.deepEqual(weekly.materials.dailyReviews.map((entry) => entry.key), ['2026-10-28', '2026-10-30', '2026-11-01'])
  assert.equal(weekly.materials.completedCount, 2, '10/28 与 11/01 各一条')
  assert.equal(weekly.materials.pendingCount, 1, '10/30 到期未完成')
  assert.equal(env.one('SELECT COUNT(*) AS n FROM tasks').n, tasksBefore, '读材料不得复制或改写任务')

  const saved = await env.service.save('weekly', '2026-10-26', { text: '上周整体推进得不错。' }, userActor())
  assert.equal(saved.created, true)
  const again = await env.service.board()
  assert.equal(again.prompts.find((p) => p.kind === 'weekly').state, 'done')
})

test('review-service: 月复盘在月末出现、次月 1–3 日可补写、材料含本月周复盘', async (t) => {
  const env = await makeEnv({ now: '2026-11-01T09:00:00' })
  t.after(env.cleanup)

  const b = await env.taskService.create({ title: '十一月完成', date: '2026-11-01' }, userActor())
  await env.taskService.create({ title: '十一月待办', date: '2026-11-20' }, userActor())
  env.setNow('2026-11-01T21:00:00')
  await env.taskService.complete(b.task.id, true, {}, userActor())

  env.setNow('2026-11-05T10:00:00')
  await env.service.save('weekly', '2026-10-26', { text: '十月最后一周' }, userActor())
  env.setNow('2026-11-09T10:00:00')
  await env.service.save('weekly', '2026-11-02', { text: '十一月第一周' }, userActor())

  env.setNow('2026-11-30T22:00:00')
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
  const cleared = await env.service.clear('monthly', '2026-11', { baseVersion: monthlyInDec.version }, userActor())
  assert.equal(cleared.deleted.key, '2026-11')
  assert.ok(cleared.backupPath.endsWith('.sqlite'))

  const backup = new DatabaseSync(cleared.backupPath, { readOnly: true })
  try {
    const row = backup.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get('monthly', '2026-11')
    assert.equal(row.text, '十一月复盘正文')
  } finally {
    backup.close()
  }

  env.setNow('2026-12-04T09:00:00')
  assert.equal((await env.service.board()).prompts.some((p) => p.kind === 'monthly'), false)
})

test('review-service: 清空复盘（备份可读回 + 审计），再清空 not-found；窗口外不可清空', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const saved = await env.service.save('daily', '2026-11-05', { text: '要删掉的复盘' }, userActor())
  const cleared = await env.service.clear('daily', '2026-11-05', { baseVersion: saved.version }, userActor())
  assert.deepEqual(cleared.deleted, { kind: 'daily', key: '2026-11-05', updatedAt: '2026-11-05 10:00' })
  assert.equal(env.one('SELECT COUNT(*) AS n FROM reviews').n, 0)
  assert.equal((await env.service.board()).prompts[0].state, 'pending')

  const backup = new DatabaseSync(cleared.backupPath, { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const row = backup.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get('daily', '2026-11-05')
    assert.equal(row.text, '要删掉的复盘')
  } finally {
    backup.close()
  }

  await assert.rejects(env.service.clear('daily', '2026-11-05', {}, userActor()), (e) => e.code === 'not-found')
  await assert.rejects(
    env.service.clear('daily', '2026-11-04', {}, userActor()),
    (e) => e.code === 'validation-error',
  )
  const log = env.query('SELECT op FROM write_log ORDER BY id')
  assert.ok(log.some((entry) => entry.op === 'review-delete'))
})

for (const stage of ['audit', 'bumpVersion']) {
  test(`review-service: ${stage} 已写入后失败，正文、审计和版本整体回滚`, async (t) => {
    const env = await makeEnv()
    t.after(env.cleanup)
    await env.service.save('daily', '2026-11-05', { text: '原正文' }, userActor())
    const before = writeState(env)
    const original = env.db[stage]
    env.db[stage] = function (...args) {
      original.apply(this, args)
      throw new Error(`injected ${stage} failure`)
    }
    const save = () => env.service.save('daily', '2026-11-05', { text: '应回滚' }, userActor(), { requestId: 'failed-write' })
    try {
      await assert.rejects(save(), new RegExp(`injected ${stage} failure`))
      assert.deepEqual(writeState(env), before)
    } finally {
      env.db[stage] = original
    }
    assert.equal((await save()).review.text, '应回滚', '失败结果不能进入幂等缓存')
  })
}

for (const failure of ['generation', 'verification']) {
  test(`review-service: 备份 ${failure} 失败时保留正文、审计和版本`, async (t) => {
    const env = await makeEnv()
    t.after(env.cleanup)
    await env.service.save('daily', '2026-11-05', { text: '不能清空' }, userActor())
    const before = writeState(env)
    let verifiedRecord = false
    if (failure === 'generation') {
      await writeFile(env.db.backupDir, '阻止创建备份目录')
    } else {
      const original = env.db.backup
      env.db.backup = function (options) {
        return original.call(this, { ...options, verify(backup) {
          verifiedRecord = options.verify(backup)
          return false
        } })
      }
    }
    await assert.rejects(env.service.clear('daily', '2026-11-05', {}, userActor()),
      (error) => error.code === 'backup-failed' && (failure !== 'verification' || /校验失败/.test(error.message)))
    if (failure === 'verification') assert.equal(verifiedRecord, true, '真实快照必须已通过待删记录检查')
    assert.deepEqual(writeState(env), before)
  })
}

test('review-service: 人的提交与清空不能通过幂等缓存被 AI 回放', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const kind = 'daily'
  const key = '2026-11-05'
  const requestId = 'human-save'
  await env.service.save(kind, key, { text: '人写的复盘' }, userActor(), { requestId })
  const savedState = writeState(env)
  await assert.rejects(env.service.save(kind, key, { text: '人写的复盘' }, agent(), { requestId }),
    (error) => error.code === 'permission-denied')
  assert.deepEqual(writeState(env), savedState)

  const clearRequestId = 'human-clear'
  await env.service.clear(kind, key, {}, userActor(), { requestId: clearRequestId })
  const clearedState = writeState(env)
  await assert.rejects(env.service.clear(kind, key, {}, agent(), { requestId: clearRequestId }),
    (error) => error.code === 'permission-denied')
  assert.deepEqual(writeState(env), clearedState)
})

test('review-service: AI 只读 list / get；正文摘要与范围筛选', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  env.seedReview('daily', '2026-10-28', '十月二十八的复盘', '2026-10-28 21:00')
  env.seedReview('daily', '2026-10-30', '十月三十的复盘', '2026-10-30 21:00')
  env.seedReview('daily', '2026-11-01', '十一月一的复盘', '2026-11-01 21:00')
  env.seedReview('daily', '2026-11-03', '十一月三的复盘', '2026-11-03 21:00')
  const longWeeklyText = `${'a'.repeat(119)}😀尾部文字`
  env.seedReview('weekly', '2026-10-26', longWeeklyText, '2026-11-02 10:00')
  env.seedReview('weekly', '2026-11-02', '十一月第一周', '2026-11-09 10:00')
  env.seedReview('weekly', '2026-12-07', '十二月那一周', '2026-12-14 10:00')

  const all = await env.service.list()
  assert.equal(all.total, 7, '4 条日复盘 + 3 条周复盘')
  assert.equal(all.reviews[0].text, undefined, '列表不返回完整正文')
  assert.ok(all.reviews.some((review) => review.kind === 'daily' && review.textLength === '十月二十八的复盘'.length))

  const daily = await env.service.list({ kind: 'daily' })
  assert.equal(daily.total, 4)
  const ranged = await env.service.list({ kind: 'daily', from: '2026-10-29', to: '2026-11-02' })
  assert.deepEqual(ranged.reviews.map((review) => review.key).sort(), ['2026-10-30', '2026-11-01'])

  const weeklyRange = await env.service.list({ kind: 'weekly', from: '2026-10-28', to: '2026-10-30' })
  assert.deepEqual(weeklyRange.reviews.map((review) => review.key), ['2026-10-26'], '按周周期与查询日期重叠筛选')
  assert.equal(weeklyRange.reviews[0].preview, `${longWeeklyText.slice(0, 120)}…`)
  assert.equal(weeklyRange.reviews[0].textLength, longWeeklyText.length, '摘要长度保持 JavaScript UTF-16 口径')
  assert.equal(weeklyRange.reviews[0].text, undefined, '列表仍不返回完整正文')

  const one = await env.service.get('weekly', '2026-11-02')
  assert.equal(one.review.text, '十一月第一周')
  assert.equal(one.review.periodStart, '2026-11-02')
  assert.equal(one.version, 0)
  await assert.rejects(env.service.get('weekly', '2026-10-27'), (error) => error.code === 'validation-error')
  await assert.rejects(env.service.get('daily', '2026-01-01'), (error) => error.code === 'not-found')
})

test('review-service: 持久化重开', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.save('daily', '2026-11-05', { text: '重开保留' }, userActor())

  const service = env.reopen()
  const board = await service.board()
  assert.equal(board.prompts[0].state, 'done')
  assert.equal(board.prompts[0].review.text, '重开保留')
  assert.equal(board.prompts[0].version, 1)
  const got = await service.get('daily', '2026-11-05')
  assert.equal(got.review.text, '重开保留')
})

test('review-service: 数据根未初始化时读取为空、写入被拒', async (t) => {
  const env = await makeEnv({ initialized: false })
  t.after(env.cleanup)

  const board = await env.service.board()
  assert.equal(board.prompts.length, 2)
  assert.equal(board.prompts[0].state, 'pending')
  assert.equal(board.prompts[1].materials.completedCount, 0)
  assert.deepEqual(board.versions, { daily: 0, weekly: 0, monthly: 0 })

  await assert.rejects(
    env.service.save('daily', '2026-11-05', { text: 'x' }, userActor()),
    (error) => error.code === 'file-missing' && /初始化/.test(error.message),
  )
})
