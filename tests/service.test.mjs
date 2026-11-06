import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/host/store.js'
import { TaskService, toolActor, userActor } from '../lib/host/service.js'
import { parseShard } from '../lib/core/grammar.js'

async function makeEnv({ now = '2026-11-05T10:00:00' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twb-test-'))
  let current = new Date(now)
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized: false }
  const store = new TaskStore({
    settings,
    persistSettings: (next) => { settings.initialized = next.initialized === true },
    now: () => current,
  })
  const service = new TaskService({ store, stateDir: join(root, 'state'), now: () => current })
  return {
    root,
    settings,
    store,
    service,
    setNow: (value) => { current = new Date(value) },
    currentMonthFile: () => store.fileFor(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('service: 未初始化 → init → 空清单', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const before = await env.service.bootstrap()
  assert.equal(before.initialized, false)
  assert.equal(before.month, '2026-11')

  const after = await env.service.init(userActor())
  assert.equal(after.initialized, true)
  assert.equal(after.hash.length, 64)
  assert.equal(after.counts.totalOpen, 0)
  const text = await readFile(env.currentMonthFile(), 'utf8')
  assert.ok(text.includes('## 任务'))
  assert.ok(text.includes('## 已完成'))
  assert.ok(text.includes('format: 1'))
  await assert.rejects(env.service.init(userActor()), (error) => error.code === 'already-initialized')
  await assert.rejects(env.service.init(toolActor({ agent: { session: { id: 's1' } } })), (error) => error.code === 'permission-denied')
})

test('service: 创建、默认值、疑似重复与 AI 创建审计', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())

  const first = await env.service.create({ title: '写周报', date: '2026-11-05' }, userActor())
  assert.equal(first.task.id, 'T-20261105-01')
  assert.equal(first.task.priority, '重要不紧急')
  assert.equal(first.task.done, false)

  await assert.rejects(
    env.service.create({ title: '写周报', date: '2026-11-05' }, userActor()),
    (error) => error.code === 'duplicate-suspected',
  )
  const second = await env.service.create({ title: '写周报', date: '2026-11-05', confirmDuplicate: true }, userActor())
  assert.equal(second.task.id, 'T-20261105-02')

  const agent = toolActor({ agent: { session: { id: 'session-42' } } })
  const byAgent = await env.service.create({ title: 'AI 建的任务', date: '2026-11-06', priority: '重要紧急' }, agent)
  assert.equal(byAgent.task.priority, '重要紧急')

  const text = await readFile(env.currentMonthFile(), 'utf8')
  assert.ok(text.includes('`T-20261105-01`｜写周报'))
  assert.ok(text.includes('`T-20261105-03`｜AI 建的任务｜日期：2026-11-06｜优先级：重要紧急'))

  const audit = await readFile(join(env.root, 'state', 'writes.log'), 'utf8')
  assert.ok(audit.includes('"actor":"agent:session-42"'))
  assert.ok(audit.includes('"op":"create"'))
})

test('service: 完成/撤销仅人，完成日期与移块正确', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const { task } = await env.service.create({ title: '约客户', date: '2026-11-05', priority: '重要紧急' }, userActor())

  const done = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(done.task.done, true)
  assert.equal(done.task.completed, '2026-11-05')
  let text = await readFile(env.currentMonthFile(), 'utf8')
  assert.ok(text.includes(`- [x] \`${task.id}\`｜约客户｜日期：2026-11-05｜优先级：重要紧急｜完成：2026-11-05`))
  let model = parseShard(text)
  assert.equal(model.tasks[0].section, 'done')

  const again = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(again.noop, true)

  const reopened = await env.service.complete(task.id, false, {}, userActor())
  assert.equal(reopened.task.done, false)
  assert.equal(reopened.task.completed, null)
  text = await readFile(env.currentMonthFile(), 'utf8')
  model = parseShard(text)
  assert.equal(model.tasks[0].section, 'todo')
  assert.equal(text.includes('完成：'), false)

  const beforeHash = (await env.service.bootstrap()).hash
  await assert.rejects(
    env.service.complete(task.id, true, {}, toolActor({ agent: { session: { id: 's1' } } })),
    (error) => error.code === 'permission-denied',
  )
  const afterHash = (await env.service.bootstrap()).hash
  assert.equal(beforeHash, afterHash)
})

test('service: 编辑与硬删除，写前备份存在', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const { task } = await env.service.create({ title: '原标题', date: '2026-11-05', note: '旧备注' }, userActor())

  const updated = await env.service.update(task.id, { changes: { title: '新标题', date: '2026-11-06', priority: '不重要紧急', note: '' } }, userActor())
  assert.equal(updated.task.title, '新标题')
  assert.equal(updated.task.date, '2026-11-06')
  assert.equal(updated.task.priority, '不重要紧急')
  assert.equal(updated.task.note, '')
  assert.ok(updated.backupPath)

  const removed = await env.service.remove(task.id, {}, userActor())
  assert.equal(removed.deleted.title, '新标题')
  const text = await readFile(env.currentMonthFile(), 'utf8')
  assert.equal(text.includes(task.id), false)

  // 删除后 ID 不复用：状态里记到 -01，下一条应为 -02
  const next = await env.service.create({ title: '删除后新建', date: '2026-11-05' }, userActor())
  assert.equal(next.task.id, 'T-20261105-02')

  const backupDir = join(env.settings.dataRoot, '备份')
  const days = await readdir(backupDir)
  assert.equal(days.length, 1)
  const files = await readdir(join(backupDir, days[0]))
  assert.ok(files.length >= 1)
  assert.ok(files[0].endsWith('.md'))
})

test('service: baseHash 不匹配拒绝覆盖', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const boot = await env.service.bootstrap()
  const file = env.currentMonthFile()
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('updated: 2026-11-05', 'updated: 2026-11-04'), 'utf8')
  await assert.rejects(
    env.service.create({ title: '冲突任务', date: '2026-11-05', baseHash: boot.hash }, userActor()),
    (error) => error.code === 'external-change',
  )
  const current = await readFile(file, 'utf8')
  assert.equal(current.includes('冲突任务'), false)
})

test('service: requestId 幂等，重复提交只创建一次', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const payload = { title: '幂等任务', date: '2026-11-05', requestId: 'req-1' }
  const first = await env.service.create(payload, userActor(), { requestId: 'req-1' })
  const second = await env.service.create(payload, userActor(), { requestId: 'req-1' })
  assert.equal(first.task.id, second.task.id)
  const list = await env.service.list({ includeCompleted: true })
  assert.equal(list.tasks.length, 1)
})

test('service: 月切结转未完成，已完成不结转，旧分片不变', async (t) => {
  const env = await makeEnv({ now: '2026-11-30T10:00:00' })
  t.after(env.cleanup)
  await env.service.init(userActor())
  const keep = await env.service.create({ title: '跨月保留', date: '2026-11-30' }, userActor())
  const done = await env.service.create({ title: '十一月完成', date: '2026-11-29' }, userActor())
  await env.service.complete(done.task.id, true, {}, userActor())

  const novFile = env.currentMonthFile()
  const novBefore = await readFile(novFile, 'utf8')

  env.setNow('2026-12-01T09:00:00')
  const boot = await env.service.bootstrap()
  assert.equal(boot.month, '2026-12')
  assert.equal(boot.initialized, true)

  const decFile = env.currentMonthFile()
  const decText = await readFile(decFile, 'utf8')
  assert.ok(decText.includes('`' + keep.task.id + '`｜跨月保留'))
  assert.equal(decText.includes(done.task.id), false)
  assert.equal(await readFile(novFile, 'utf8'), novBefore)

  const decModel = parseShard(decText)
  assert.equal(decModel.tasks.length, 1)
  assert.equal(decModel.frontmatter.fields.month, '2026-12')
})

test('service: 分片结构损坏 → 只读，写入被拒', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const file = env.currentMonthFile()
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('## 已完成', '## 别的'), 'utf8')

  const boot = await env.service.bootstrap()
  assert.equal(boot.readOnly, true)
  assert.equal(boot.readOnlyReason, 'parse-error')
  await assert.rejects(
    env.service.create({ title: '只读时不能建', date: '2026-11-05' }, userActor()),
    (error) => error.code === 'read-only',
  )
})

test('service: 校验错误不写文件', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const before = await env.service.bootstrap()
  for (const bad of [
    { title: '', date: '2026-11-05' },
    { title: '含｜分隔符', date: '2026-11-05' },
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
  assert.equal(before.hash, after.hash)
  assert.equal(after.counts.totalOpen, 0)
})


test('service: 创建跨周期/带时间任务，可改回当天', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())

  const { task } = await env.service.create({
    title: '工作台开发', date: '2026-11-05', time: '09:30', endDate: '2026-11-12', endTime: '18:00', priority: '重要紧急',
  }, userActor())
  assert.equal(task.type, 'range')
  assert.equal(task.time, '09:30')
  assert.equal(task.endDate, '2026-11-12')
  assert.equal(task.endTime, '18:00')

  const text = await readFile(env.currentMonthFile(), 'utf8')
  assert.ok(text.includes(`\`${task.id}\`｜工作台开发｜日期：2026-11-05｜时间：09:30｜结束日期：2026-11-12｜结束时间：18:00｜优先级：重要紧急`))

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
  const afterText = await readFile(env.currentMonthFile(), 'utf8')
  assert.equal(afterText.includes('结束日期'), false)
  assert.equal(afterText.includes('时间：'), false)
  assert.ok(afterText.includes(`\`${task.id}\`｜工作台开发｜日期：2026-11-05｜优先级：重要紧急`))
})

test('service: 跨周期任务可被完成并保留区间字段', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await env.service.init(userActor())
  const { task } = await env.service.create({ title: '跨周期完成', date: '2026-11-03', endDate: '2026-11-08' }, userActor())
  const done = await env.service.complete(task.id, true, {}, userActor())
  assert.equal(done.task.done, true)
  assert.equal(done.task.endDate, '2026-11-08')
  const text = await readFile(env.currentMonthFile(), 'utf8')
  assert.ok(text.includes('结束日期：2026-11-08'))
  const reopened = await env.service.complete(task.id, false, {}, userActor())
  assert.equal(reopened.task.endDate, '2026-11-08')
})
