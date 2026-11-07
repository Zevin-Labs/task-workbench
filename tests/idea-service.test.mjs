import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchDatabase } from '../lib/host/db.js'
import { IdeaService } from '../lib/host/idea-service.js'
import { toolActor, userActor } from '../lib/host/service.js'

async function makeEnv({ now = '2026-11-05T10:00:00', initialized = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twb-idea-'))
  let current = new Date(now)
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7 }
  const nowFn = () => current
  const db = new WorkbenchDatabase({ settings, now: nowFn })
  if (initialized) db.init()
  const env = {
    root,
    settings,
    db,
    service: new IdeaService({ db, now: nowFn }),
    setNow: (value) => { current = new Date(value) },
    query(sql, ...params) { return env.db.ensureInitialized().prepare(sql).all(...params) },
    one(sql, ...params) { return env.db.ensureInitialized().prepare(sql).get(...params) },
    reopen() {
      db.close()
      env.db = new WorkbenchDatabase({ settings, now: nowFn })
      env.service = new IdeaService({ db: env.db, now: nowFn })
      return env.service
    },
    async cleanup() {
      env.db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
  return env
}

const agent = () => toolActor({ agent: { session: { id: 'session-idea' } } })

function writeState(env) {
  const db = env.db.ensureInitialized()
  return {
    ideas: db.prepare('SELECT * FROM ideas ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM write_log ORDER BY id').all(),
    versions: db.prepare('SELECT * FROM meta ORDER BY meta_key').all(),
  }
}

test('idea-service: 未初始化拒绝创建；初始化后空池、默认值与计数正确', async (t) => {
  const env = await makeEnv({ initialized: false })
  t.after(env.cleanup)

  const before = await env.service.bootstrap()
  assert.equal(before.initialized, false)
  assert.equal(before.version, 0)
  assert.deepEqual(before.counts, { total: 0, todo: 0, doing: 0, done: 0, dropped: 0, open: 0 })
  assert.equal(Object.prototype.hasOwnProperty.call(before, 'ideas'), false, 'bootstrap 不读取想法正文')
  const empty = await env.service.list()
  assert.deepEqual(empty.ideas, [])
  assert.equal(empty.version, 0)
  await assert.rejects(
    env.service.create({ name: '还没初始化' }, userActor()),
    (error) => error.code === 'file-missing',
  )

  env.db.init()
  const created = await env.service.create({ name: '工作台加想法池' }, userActor())
  assert.equal(created.idea.id, 'I-1')
  assert.equal(created.idea.status, '待实现')
  assert.equal(created.idea.maturity, '低')
  assert.equal(created.idea.created, '2026-11-05')
  assert.equal(created.idea.updated, '2026-11-05')

  const after = await env.service.bootstrap()
  assert.equal(after.initialized, true)
  assert.equal(after.version, 1)
  assert.deepEqual(after.counts, { total: 1, todo: 1, doing: 0, done: 0, dropped: 0, open: 1 })
})

test('idea-service: 多行详细描述按 TEXT 原样保存', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({
    name: '整理季度复盘',
    description: '第一段：验证描述写回。\n\n第二段：预算 500 元跑 3 天。\n第三行',
    maturity: '高',
    category: '工作',
  }, userActor())

  const got = await env.service.get(created.idea.id)
  assert.equal(got.idea.description, '第一段：验证描述写回。\n\n第二段：预算 500 元跑 3 天。\n第三行')
  assert.equal(env.one('SELECT description FROM ideas WHERE id = 1').description, got.idea.description)
})

test('idea-service: 编辑内容、更新日期与审计', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({ name: '旧名称', description: '旧描述' }, userActor())
  env.setNow('2026-11-06T09:00:00')

  const updated = await env.service.update(created.idea.id, {
    changes: { name: '新名称', description: '新描述\n第二行', maturity: '高', category: '产品' },
  }, userActor())
  assert.equal(updated.idea.name, '新名称')
  assert.equal(updated.idea.maturity, '高')
  assert.equal(updated.idea.category, '产品')
  assert.equal(updated.idea.updated, '2026-11-06')
  assert.equal(updated.idea.description, '新描述\n第二行')

  const log = env.query('SELECT actor, actor_kind, op, domain, target FROM write_log ORDER BY id')
  assert.deepEqual(log.map((entry) => entry.op), ['idea-create', 'idea-update'])
  assert.equal(log[1].actor, 'user')
  assert.equal(log[1].target, 'I-1')
})

test('idea-service: 状态仅人改；完成写完成日期，离开完成清除', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({ name: '状态测试' }, userActor())

  const beforeVersion = (await env.service.bootstrap()).version
  await assert.rejects(
    env.service.update(created.idea.id, { changes: { status: '推进中' } }, agent()),
    (error) => error.code === 'permission-denied',
  )
  assert.equal((await env.service.bootstrap()).version, beforeVersion)

  const doing = await env.service.update(created.idea.id, { changes: { status: '推进中' } }, userActor())
  assert.equal(doing.idea.status, '推进中')
  assert.equal(doing.idea.completed, null)

  env.setNow('2026-11-06T09:00:00')
  const done = await env.service.update(created.idea.id, { changes: { status: '完成' } }, userActor())
  assert.equal(done.idea.status, '完成')
  assert.equal(done.idea.completed, '2026-11-06')

  const reopened = await env.service.update(created.idea.id, { changes: { status: '待实现' } }, userActor())
  assert.equal(reopened.idea.completed, null)
  assert.equal(env.one('SELECT completed FROM ideas WHERE id = 1').completed, null)
})

test('idea-service: 硬删除 + 写前备份可读回记录 + ID 不复用', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const first = await env.service.create({ name: '第一条' }, userActor())
  const second = await env.service.create({ name: '第二条' }, userActor())
  assert.equal(first.idea.id, 'I-1')
  assert.equal(second.idea.id, 'I-2')

  const removed = await env.service.remove(first.idea.id, {}, userActor())
  assert.equal(removed.deleted.name, '第一条')
  assert.equal(env.one('SELECT COUNT(*) AS n FROM ideas').n, 1)

  const backup = new DatabaseSync(removed.backupPath, { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    const row = backup.prepare('SELECT * FROM ideas WHERE id = 1').get()
    assert.equal(row.name, '第一条')
  } finally {
    backup.close()
  }

  const third = await env.service.create({ name: '删除后新建' }, userActor())
  assert.equal(third.idea.id, 'I-3')
})

test('idea-service: baseVersion 不匹配拒绝覆盖', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const first = await env.service.create({ name: '已有想法' }, userActor())
  await assert.rejects(
    env.service.create({ name: '冲突想法', baseVersion: 0 }, userActor()),
    (error) => error.code === 'external-change',
  )
  const second = await env.service.create({ name: '第二条', baseVersion: first.version }, userActor())
  assert.equal(second.version, 2)
  await assert.rejects(
    env.service.update(first.idea.id, { changes: { name: '覆盖' }, baseVersion: 1 }, userActor()),
    (error) => error.code === 'external-change',
  )
  assert.equal((await env.service.get(first.idea.id)).idea.name, '已有想法')
})

test('idea-service: requestId 幂等，重复提交只创建一次', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const payload = { name: '幂等想法' }
  const first = await env.service.create(payload, userActor(), { requestId: 'idea-req-1' })
  const second = await env.service.create(payload, userActor(), { requestId: 'idea-req-1' })
  assert.equal(first.idea.id, second.idea.id)
  assert.equal((await env.service.list()).ideas.length, 1)
  assert.equal(env.one('SELECT COUNT(*) AS n FROM write_log').n, 1)
})

for (const stage of ['audit', 'bumpVersion']) {
  test(`idea-service: ${stage} 已写入后失败，想法、审计和版本整体回滚`, async (t) => {
    const env = await makeEnv()
    t.after(env.cleanup)
    const { idea } = await env.service.create({ name: '原想法' }, userActor())
    const before = writeState(env)
    const original = env.db[stage]
    env.db[stage] = function (...args) {
      original.apply(this, args)
      throw new Error(`injected ${stage} failure`)
    }
    const update = () => env.service.update(idea.id, { changes: { name: '应回滚' } }, userActor(), { requestId: 'failed-write' })
    try {
      await assert.rejects(update(), new RegExp(`injected ${stage} failure`))
      assert.deepEqual(writeState(env), before)
    } finally {
      env.db[stage] = original
    }
    assert.equal((await update()).idea.name, '应回滚', '失败结果不能进入幂等缓存')
  })
}

for (const failure of ['generation', 'verification']) {
  test(`idea-service: 备份 ${failure} 失败时保留想法、审计和版本`, async (t) => {
    const env = await makeEnv()
    t.after(env.cleanup)
    const { idea } = await env.service.create({ name: '不能删除' }, userActor())
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
    await assert.rejects(env.service.remove(idea.id, {}, userActor()),
      (error) => error.code === 'backup-failed' && (failure !== 'verification' || /校验失败/.test(error.message)))
    if (failure === 'verification') assert.equal(verifiedRecord, true, '真实快照必须已通过待删记录检查')
    assert.deepEqual(writeState(env), before)
  })
}

test('idea-service: 人的状态修改不能通过幂等缓存被 AI 回放', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const { idea } = await env.service.create({ name: '权限回放检查' }, userActor())
  const input = { changes: { status: '推进中' } }
  const requestId = 'human-status'
  await env.service.update(idea.id, input, userActor(), { requestId })
  const before = writeState(env)
  await assert.rejects(env.service.update(idea.id, input, agent(), { requestId }),
    (error) => error.code === 'permission-denied')
  assert.deepEqual(writeState(env), before)
})

test('idea-service: AI 可新建/编辑内容/删除，审计 actor', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({ name: 'AI 记的想法' }, agent())
  await env.service.update(created.idea.id, { changes: { maturity: '高' } }, agent())
  await env.service.remove(created.idea.id, {}, userActor())

  const log = env.query('SELECT actor, actor_kind, op FROM write_log ORDER BY id')
  assert.deepEqual(log.map((entry) => entry.op), ['idea-create', 'idea-update', 'idea-delete'])
  assert.equal(log[0].actor, 'agent:session-idea')
  assert.equal(log[0].actor_kind, 'agent')
})

test('idea-service: 持久化重开', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.create({ name: '重开保留', description: '描述也保留' }, userActor())
  const service = env.reopen()
  const boot = await service.bootstrap()
  assert.equal(boot.initialized, true)
  assert.equal(boot.counts.total, 1)
  assert.equal(boot.version, 1)
  const list = await service.list()
  assert.equal(list.ideas[0].name, '重开保留')
  assert.equal(list.ideas[0].description, '描述也保留')
})
