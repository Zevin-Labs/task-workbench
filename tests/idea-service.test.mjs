import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdeaStore } from '../lib/host/idea-store.js'
import { IdeaService } from '../lib/host/idea-service.js'
import { toolActor, userActor } from '../lib/host/service.js'
import { parseIdeaPool } from '../lib/core/idea-grammar.js'

async function makeEnv({ now = '2026-11-05T10:00:00', initialized = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twb-idea-'))
  let current = new Date(now)
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized }
  const store = new IdeaStore({
    settings,
    persistSettings: (next) => { settings.initialized = next.initialized === true },
    now: () => current,
    isDataRootReady: () => settings.initialized === true,
  })
  const service = new IdeaService({ store, stateDir: join(root, 'state'), now: () => current })
  return {
    root,
    settings,
    store,
    service,
    setNow: (value) => { current = new Date(value) },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const agent = () => toolActor({ agent: { session: { id: 'session-idea' } } })

test('idea-service: 空池 → 首次创建自动建文件，默认值与计数正确', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)

  const before = await env.service.bootstrap()
  assert.equal(before.initialized, false)
  assert.equal(before.hash, null)
  assert.deepEqual(before.counts, { total: 0, todo: 0, doing: 0, done: 0, dropped: 0, open: 0 })

  const empty = await env.service.list()
  assert.deepEqual(empty.ideas, [])
  assert.equal(empty.hash, null)

  const created = await env.service.create({ name: '工作台加想法池' }, userActor())
  assert.equal(created.idea.id, 'I-20261105-01')
  assert.equal(created.idea.status, '待实现')
  assert.equal(created.idea.maturity, '低')
  assert.equal(created.idea.created, '2026-11-05')
  assert.equal(created.idea.updated, '2026-11-05')

  const text = await readFile(env.store.file, 'utf8')
  assert.ok(text.includes('type: idea-pool'))
  assert.ok(text.includes('## 想法'))
  assert.ok(text.includes('- `I-20261105-01`｜工作台加想法池｜状态：待实现｜成熟度：低｜创建：2026-11-05｜更新：2026-11-05'))

  const after = await env.service.bootstrap()
  assert.equal(after.initialized, true)
  assert.equal(after.hash.length, 64)
  assert.deepEqual(after.counts, { total: 1, todo: 1, doing: 0, done: 0, dropped: 0, open: 1 })
})

test('idea-service: 多行详细描述写回 Markdown 缩进续行', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({
    name: '整理季度复盘',
    description: '第一段：验证描述写回。\n\n第二段：预算 500 元跑 3 天。',
    maturity: '高',
    category: '工作',
  }, userActor())

  const text = await readFile(env.store.file, 'utf8')
  assert.ok(text.includes('  第一段：验证描述写回。'))
  assert.ok(text.includes('\n  \n'))
  assert.ok(text.includes('  第二段：预算 500 元跑 3 天。'))

  const model = parseIdeaPool(text)
  assert.equal(model.ideas[0].description, '第一段：验证描述写回。\n\n第二段：预算 500 元跑 3 天。')
  const got = await env.service.get(created.idea.id)
  assert.equal(got.idea.description, model.ideas[0].description)
})

test('idea-service: 编辑内容写回、更新日期与备份', async (t) => {
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
  assert.ok(updated.backupPath)

  const text = await readFile(env.store.file, 'utf8')
  assert.ok(text.includes('｜新名称｜状态：待实现｜成熟度：高｜分类：产品｜创建：2026-11-05｜更新：2026-11-06'))
  assert.ok(text.includes('  新描述\n  第二行'))
  assert.equal(text.includes('旧描述'), false)
})

test('idea-service: 状态仅人改；完成写完成日期，离开完成清除', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({ name: '状态测试' }, userActor())

  const beforeHash = (await env.service.bootstrap()).hash
  await assert.rejects(
    env.service.update(created.idea.id, { changes: { status: '推进中' } }, agent()),
    (error) => error.code === 'permission-denied',
  )
  assert.equal((await env.service.bootstrap()).hash, beforeHash)

  const doing = await env.service.update(created.idea.id, { changes: { status: '推进中' } }, userActor())
  assert.equal(doing.idea.status, '推进中')
  assert.equal(doing.idea.completed, null)

  env.setNow('2026-11-06T09:00:00')
  const done = await env.service.update(created.idea.id, { changes: { status: '完成' } }, userActor())
  assert.equal(done.idea.status, '完成')
  assert.equal(done.idea.completed, '2026-11-06')
  let text = await readFile(env.store.file, 'utf8')
  assert.ok(text.includes('状态：完成'))
  assert.ok(text.includes('完成：2026-11-06'))

  const reopened = await env.service.update(created.idea.id, { changes: { status: '待实现' } }, userActor())
  assert.equal(reopened.idea.completed, null)
  text = await readFile(env.store.file, 'utf8')
  assert.equal(text.includes('完成：'), false)
})

test('idea-service: 硬删除 + 写前备份 + ID 不复用', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const first = await env.service.create({ name: '第一条' }, userActor())
  const second = await env.service.create({ name: '第二条' }, userActor())
  assert.equal(second.idea.id, 'I-20261105-02')

  const removed = await env.service.remove(first.idea.id, {}, userActor())
  assert.equal(removed.deleted.name, '第一条')
  const text = await readFile(env.store.file, 'utf8')
  assert.equal(text.includes(first.idea.id), false)
  assert.ok(text.includes(second.idea.id))

  const third = await env.service.create({ name: '删除后新建' }, userActor())
  assert.equal(third.idea.id, 'I-20261105-03')

  const backupDir = join(env.settings.dataRoot, '备份')
  const days = await readdir(backupDir)
  assert.equal(days.length, 1)
  const files = await readdir(join(backupDir, days[0]))
  assert.ok(files.some((file) => file.startsWith('想法池-')))
  assert.ok(files.every((file) => file.endsWith('.md')))
})

test('idea-service: baseHash 不匹配拒绝覆盖', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.create({ name: '已有想法' }, userActor())
  const boot = await env.service.bootstrap()
  const text = await readFile(env.store.file, 'utf8')
  await writeFile(env.store.file, text.replace('updated: 2026-11-05', 'updated: 2026-11-04'), 'utf8')

  await assert.rejects(
    env.service.create({ name: '冲突想法', baseHash: boot.hash }, userActor()),
    (error) => error.code === 'external-change',
  )
  const current = await readFile(env.store.file, 'utf8')
  assert.equal(current.includes('冲突想法'), false)
})

test('idea-service: requestId 幂等，重复提交只创建一次', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const payload = { name: '幂等想法' }
  const first = await env.service.create(payload, userActor(), { requestId: 'idea-req-1' })
  const second = await env.service.create(payload, userActor(), { requestId: 'idea-req-1' })
  assert.equal(first.idea.id, second.idea.id)
  const list = await env.service.list()
  assert.equal(list.ideas.length, 1)
})

test('idea-service: 文件损坏 → 只读，写入被拒', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.create({ name: '正常想法' }, userActor())
  const text = await readFile(env.store.file, 'utf8')
  await writeFile(env.store.file, text.replace('## 想法', '## 别的'), 'utf8')

  const boot = await env.service.bootstrap()
  assert.equal(boot.readOnly, true)
  assert.equal(boot.readOnlyReason, 'parse-error')
  await assert.rejects(env.service.list(), (error) => error.code === 'read-only')
  await assert.rejects(env.service.create({ name: '只读时不能建' }, userActor()), (error) => error.code === 'read-only')
})

test('idea-service: 审计记录 actor 与 op', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({ name: 'AI 记的想法' }, agent())
  await env.service.update(created.idea.id, { changes: { maturity: '高' } }, agent())
  await env.service.remove(created.idea.id, {}, userActor())

  const audit = await readFile(join(env.root, 'state', 'writes.log'), 'utf8')
  assert.ok(audit.includes('"actor":"agent:session-idea"'))
  assert.ok(audit.includes('"op":"idea-create"'))
  assert.ok(audit.includes('"op":"idea-update"'))
  assert.ok(audit.includes('"op":"idea-delete"'))
  assert.ok(audit.includes('"ideaId":"I-20261105-01"'))
})

test('idea-service: 数据根未初始化时拒绝创建', async (t) => {
  const env = await makeEnv({ initialized: false })
  t.after(env.cleanup)
  await assert.rejects(
    env.service.create({ name: '还没初始化' }, userActor()),
    (error) => error.code === 'file-missing',
  )
  assert.equal((await env.service.bootstrap()).initialized, false)
})
