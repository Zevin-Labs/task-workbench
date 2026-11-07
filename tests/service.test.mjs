import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchDatabase } from '../lib/host/db.js'
import { TaskService, toolActor, userActor } from '../lib/host/service.js'

const OLD_MARKDOWN = `---
title: 任务清单 2026-11
type: task-list
format: 1
month: 2026-11
---

## 任务

- [ ] \`T-20261105-01\`｜旧文件里的任务｜日期：2026-11-05
`

async function makeEnv({ now = '2026-11-05T10:00:00' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twb-task-'))
  let current = new Date(now)
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7 }
  const nowFn = () => current
  const env = {
    root,
    settings,
    db: new WorkbenchDatabase({ settings, now: nowFn }),
    setNow: (value) => { current = new Date(value) },
    query(sql, ...params) { return env.db.ensureInitialized().prepare(sql).all(...params) },
    one(sql, ...params) { return env.db.ensureInitialized().prepare(sql).get(...params) },
    reopen() {
      env.db.close()
      env.db = new WorkbenchDatabase({ settings, now: nowFn })
      env.service = new TaskService({ db: env.db, now: nowFn })
      return env.service
    },
    async cleanup() {
      env.db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
  env.service = new TaskService({ db: env.db, now: nowFn })
  return env
}

function writeState(env) {
  const db = env.db.ensureInitialized()
  return {
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM write_log ORDER BY id').all(),
    versions: db.prepare('SELECT * FROM meta ORDER BY meta_key').all(),
  }
}

test('service: 未初始化 → init → 空库；旧 Markdown 文件不读不写', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const oldFile = join(env.settings.dataRoot, '任务清单', '2026-11.md')
  await mkdir(join(env.settings.dataRoot, '任务清单'), { recursive: true })
  await writeFile(oldFile, OLD_MARKDOWN, 'utf8')

  const before = await env.service.bootstrap()
  assert.equal(before.initialized, false)
  assert.equal(before.version, 0)
  assert.equal(before.database, join(env.settings.dataRoot, 'workbench.sqlite'))
  assert.deepEqual(before.counts, { overdue: 0, open: 0, completedToday: 0, totalOpen: 0, totalDone: 0, badge: 0, rangeOpen: 0 })

  const after = await env.service.init(userActor())
  assert.equal(after.initialized, true)
  assert.equal(after.version, 0)
  assert.equal(after.counts.totalOpen, 0)
  assert.equal((await stat(env.db.file)).mode & 0o777, 0o600, '新数据库仅当前用户可读写')
  assert.equal(await readFile(oldFile, 'utf8'), OLD_MARKDOWN, '旧 Markdown 文件必须原样保留')

  const list = await env.service.list({ includeCompleted: true })
  assert.deepEqual(list.tasks, [], '初始化不导入旧 Markdown 数据')

  await assert.rejects(env.service.init(userActor()), (error) => error.code === 'already-initialized')
  await assert.rejects(
    env.service.init(toolActor({ agent: { session: { id: 's1' } } })),
    (error) => error.code === 'permission-denied',
  )
})

test('service: 创建、默认值、疑似重复与 AI 创建审计', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())

  const first = await env.service.create({ title: '写周报', date: '2026-11-05' }, userActor())
  assert.equal(first.task.id, 'T-1')
  assert.equal(first.task.priority, '重要不紧急')
  assert.equal(first.task.done, false)
  assert.equal(first.version, 1)

  await assert.rejects(
    env.service.create({ title: '写周报', date: '2026-11-05' }, userActor()),
    (error) => error.code === 'duplicate-suspected',
  )
  const second = await env.service.create({ title: '写周报', date: '2026-11-05', confirmDuplicate: true }, userActor())
  assert.equal(second.task.id, 'T-2')

  const agent = toolActor({ agent: { session: { id: 'session-42' } } })
  const byAgent = await env.service.create({ title: 'AI 建的任务', date: '2026-11-06', priority: '重要紧急' }, agent)
  assert.equal(byAgent.task.id, 'T-3')
  assert.equal(byAgent.task.priority, '重要紧急')

  const rows = env.query('SELECT id, title FROM tasks ORDER BY id')
  assert.deepEqual(rows.map((row) => row.title), ['写周报', '写周报', 'AI 建的任务'])

  const log = env.query('SELECT actor, actor_kind, op, domain, target FROM write_log ORDER BY id')
  assert.equal(log.length, 3)
  assert.deepEqual({ ...log[2] }, { actor: 'agent:session-42', actor_kind: 'agent', op: 'create', domain: 'task', target: 'T-3' })
})

test('service: 完成/撤销仅人，完成日期与过月历史只读', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())

  const { task } = await env.service.create({ title: '约客户', date: '2026-11-05', priority: '重要紧急' }, userActor())
  const done = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(done.task.done, true)
  assert.equal(done.task.completed, '2026-11-05')
  assert.equal(env.one('SELECT done, completed FROM tasks WHERE id = 1').done, 1)

  const again = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(again.noop, true)

  const reopened = await env.service.complete(task.id, false, {}, userActor())
  assert.equal(reopened.task.done, false)
  assert.equal(reopened.task.completed, null)

  await assert.rejects(
    env.service.complete(task.id, true, {}, toolActor({ agent: { session: { id: 's1' } } })),
    (error) => error.code === 'permission-denied',
  )

  // 十一月完成 → 十二月只读；未完成任务保持同一条、可继续编辑。
  await env.service.complete(task.id, true, {}, userActor())
  const open = await env.service.create({ title: '跨月未完成', date: '2026-11-30' }, userActor())
  env.setNow('2026-12-01T09:00:00')

  const boot = await env.service.bootstrap()
  assert.equal(boot.initialized, true)
  const list = await env.service.list({ includeCompleted: true })
  assert.deepEqual(list.tasks.map((item) => item.id), [open.task.id], '过月完成不进入本月总表，未完成仍是同一条')
  const updated = await env.service.update(open.task.id, { changes: { title: '跨月未完成（改）' } }, userActor())
  assert.equal(updated.task.title, '跨月未完成（改）')

  await assert.rejects(
    env.service.update(task.id, { changes: { title: '改历史' } }, userActor()),
    (error) => error.code === 'history-readonly',
  )
  await assert.rejects(
    env.service.remove(task.id, {}, userActor()),
    (error) => error.code === 'history-readonly',
  )
  await assert.rejects(
    env.service.complete(task.id, false, {}, userActor()),
    (error) => error.code === 'history-readonly',
  )
  const noop = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(noop.noop, true)

  const read = await env.service.getTask(task.id)
  assert.equal(read.task.done, true)
})

test('service: 编辑与硬删除，写前备份可读回记录，ID 不复用', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const { task } = await env.service.create({ title: '原标题', date: '2026-11-05', note: '旧备注' }, userActor())

  const updated = await env.service.update(task.id, {
    changes: { title: '新标题', date: '2026-11-06', priority: '不重要紧急', note: '' },
  }, userActor())
  assert.equal(updated.task.title, '新标题')
  assert.equal(updated.task.date, '2026-11-06')
  assert.equal(updated.task.priority, '不重要紧急')
  assert.equal(updated.task.note, '')
  assert.deepEqual(await readdir(join(env.settings.dataRoot, '备份')).catch(() => null), null, '正常编辑不生成备份')

  const removed = await env.service.remove(task.id, {}, userActor())
  assert.equal(removed.deleted.title, '新标题')
  assert.ok(removed.backupPath.endsWith('.sqlite'))
  assert.equal((await stat(removed.backupPath)).mode & 0o777, 0o600, 'SQLite 快照仅当前用户可读写')
  assert.equal(env.one('SELECT COUNT(*) AS n FROM tasks').n, 0)

  const backup = new DatabaseSync(removed.backupPath, { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const row = backup.prepare('SELECT * FROM tasks WHERE id = 1').get()
    assert.equal(row.title, '新标题')
    assert.equal(row.note, '')
  } finally {
    backup.close()
  }

  const next = await env.service.create({ title: '删除后新建', date: '2026-11-05' }, userActor())
  assert.equal(next.task.id, 'T-2', 'AUTOINCREMENT 保证删除后不复用')
})

test('service: baseVersion 不匹配拒绝覆盖', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())

  const first = await env.service.create({ title: '已有任务', date: '2026-11-05' }, userActor())
  await assert.rejects(
    env.service.create({ title: '冲突任务', date: '2026-11-05', baseVersion: 0 }, userActor()),
    (error) => error.code === 'external-change',
  )
  const second = await env.service.create({ title: '第二条', date: '2026-11-05', baseVersion: first.version }, userActor())
  assert.equal(second.version, 2)

  await assert.rejects(
    env.service.update(first.task.id, { changes: { title: '覆盖' }, baseVersion: 1 }, userActor()),
    (error) => error.code === 'external-change',
  )
  assert.equal((await env.service.getTask(first.task.id)).task.title, '已有任务')
})

test('service: 总表通过真实 Service 筛选并按优先级、日期、时间排序', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const a = await env.service.create({ title: 'A', date: '2026-11-06', note: '只写结论' }, userActor())
  const b = await env.service.create({ title: 'B', date: '2026-11-05', priority: '重要紧急' }, userActor())
  const c = await env.service.create({ title: 'C', date: '2026-11-05' }, userActor())
  await env.service.complete(c.task.id, true, {}, userActor())

  const open = await env.service.list()
  assert.deepEqual(open.tasks.map((item) => item.id), [b.task.id, a.task.id])
  assert.equal(open.tasks.find((item) => item.id === a.task.id).note, '只写结论')
  const all = await env.service.list({ includeCompleted: true })
  assert.deepEqual(all.tasks.map((item) => item.id), [b.task.id, c.task.id, a.task.id])

  const early = await env.service.create({ title: '同日较早', date: '2026-11-06', time: '09:00' }, userActor())
  const late = await env.service.create({ title: '同日较晚', date: '2026-11-06', time: '14:00' }, userActor())
  assert.deepEqual((await env.service.list()).tasks.map((item) => item.id),
    [b.task.id, a.task.id, early.task.id, late.task.id])
})

for (const stage of ['audit', 'bumpVersion']) {
  test(`service: ${stage} 已写入后失败，任务、审计和版本整体回滚`, async (t) => {
    const env = await makeEnv()
    t.after(env.cleanup)
    await env.service.init(userActor())
    const { task } = await env.service.create({ title: '原任务' }, userActor())
    const before = writeState(env)
    const original = env.db[stage]
    env.db[stage] = function (...args) {
      original.apply(this, args)
      throw new Error(`injected ${stage} failure`)
    }
    const update = () => env.service.update(task.id, { changes: { title: '应回滚' } }, userActor(), { requestId: 'failed-write' })
    try {
      await assert.rejects(update(), new RegExp(`injected ${stage} failure`))
      assert.deepEqual(writeState(env), before)
    } finally {
      env.db[stage] = original
    }
    assert.equal((await update()).task.title, '应回滚', '失败结果不能进入幂等缓存')
  })
}

for (const failure of ['generation', 'verification']) {
  test(`service: 备份 ${failure} 失败时保留任务、审计和版本`, async (t) => {
    const env = await makeEnv()
    t.after(env.cleanup)
    await env.service.init(userActor())
    const { task } = await env.service.create({ title: '不能删除' }, userActor())
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
    await assert.rejects(env.service.remove(task.id, {}, userActor()),
      (error) => error.code === 'backup-failed' && (failure !== 'verification' || /校验失败/.test(error.message)))
    if (failure === 'verification') assert.equal(verifiedRecord, true, '真实快照必须已通过待删记录检查')
    assert.deepEqual(writeState(env), before)
  })
}

test('service: 完成与撤销的幂等缓存不能被 AI 回放', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const { task } = await env.service.create({ title: '权限回放检查' }, userActor())
  for (const done of [true, false]) {
    const requestId = `complete-${done}`
    await env.service.complete(task.id, done, {}, userActor(), { requestId })
    const before = writeState(env)
    await assert.rejects(env.service.complete(task.id, done, {}, toolActor({}), { requestId }),
      (error) => error.code === 'permission-denied')
    assert.deepEqual(writeState(env), before)
  }
})

test('service: requestId 幂等，重复提交只创建一次', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const payload = { title: '幂等任务', date: '2026-11-05', requestId: 'req-1' }
  const first = await env.service.create(payload, userActor(), { requestId: 'req-1' })
  const second = await env.service.create(payload, userActor(), { requestId: 'req-1' })
  assert.equal(first.task.id, second.task.id)
  assert.equal(first.version, second.version)
  const list = await env.service.list({ includeCompleted: true })
  assert.equal(list.tasks.length, 1)
  assert.equal(env.one('SELECT COUNT(*) AS n FROM write_log').n, 1)
})

test('service: 校验错误不写库、不写审计', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const before = await env.service.bootstrap()
  for (const bad of [
    { title: '', date: '2026-11-05' },
    { title: '带\n换行', date: '2026-11-05' },
    { title: '坏日期', date: '2026-02-30' },
    { title: '坏优先级', date: '2026-11-05', priority: '最紧急' },
    { title: '超长备注', date: '2026-11-05', note: 'x'.repeat(501) },
    { title: '范围倒置', date: '2026-11-05', endDate: '2026-11-04' },
    { title: '范围同天', date: '2026-11-05', endDate: '2026-11-05' },
    { title: '坏时间', date: '2026-11-05', time: '25:00' },
    { title: '只有结束时间', date: '2026-11-05', endTime: '18:00' },
  ]) {
    await assert.rejects(env.service.create(bad, userActor()), (error) => error.code === 'validation-error', JSON.stringify(bad))
  }
  const after = await env.service.bootstrap()
  assert.equal(before.version, after.version)
  assert.equal(after.counts.totalOpen, 0)
  assert.equal(env.one('SELECT COUNT(*) AS n FROM write_log').n, 0)

  // 旧 Markdown 分隔符不再被禁。
  const allowed = await env.service.create({ title: '写周报｜只写结论', date: '2026-11-05' }, userActor())
  assert.equal(allowed.task.title, '写周报｜只写结论')
})

test('service: 创建跨周期/带时间任务，可改回当天', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())

  const { task } = await env.service.create({
    title: '工作台开发', date: '2026-11-05', time: '09:30', endDate: '2026-11-12', endTime: '18:00', priority: '重要紧急',
  }, userActor())
  assert.equal(task.id, 'T-1')
  assert.equal(task.type, 'range')
  assert.equal(task.time, '09:30')
  assert.equal(task.endDate, '2026-11-12')
  assert.equal(task.endTime, '18:00')

  const today = await env.service.today()
  assert.equal(today.open.length, 1)
  assert.equal(today.open[0].type, 'range')
  assert.equal(today.counts.rangeOpen, 1)
  const week = await env.service.week('2026-11-05')
  assert.equal(week.spans.length, 1)
  assert.equal(week.spans[0].startIndex, 3)
  assert.equal(week.spans[0].endIndex, 6)

  const updated = await env.service.update(task.id, { changes: { endDate: '', endTime: '', time: '' } }, userActor())
  assert.equal(updated.task.type, 'single')
  assert.equal(updated.task.endDate, null)
  assert.equal(updated.task.time, null)
})

test('service: 跨周期任务可被完成并保留区间字段', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const { task } = await env.service.create({ title: '跨周期完成', date: '2026-11-03', endDate: '2026-11-08' }, userActor())
  const done = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(done.task.done, true)
  assert.equal(done.task.endDate, '2026-11-08')
  const reopened = await env.service.complete(task.id, false, {}, userActor())
  assert.equal(reopened.task.endDate, '2026-11-08')
})

test('service: 持久化重开（关开组件 / 重启）', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const created = await env.service.create({ title: '重开保留', date: '2026-11-05' }, userActor())
  await env.service.complete(created.task.id, true, {}, userActor())

  const service = env.reopen()
  const boot = await service.bootstrap()
  assert.equal(boot.initialized, true)
  assert.equal(boot.counts.totalDone, 1)
  assert.equal(boot.version, 2)
  const list = await service.list({ includeCompleted: true })
  assert.equal(list.tasks.length, 1)
  assert.equal(list.tasks[0].title, '重开保留')
  const next = await service.create({ title: '重开后新建', date: '2026-11-06' }, userActor())
  assert.equal(next.task.id, 'T-2')
})
