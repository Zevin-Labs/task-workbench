import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/host/store.js'
import { TaskService, userActor } from '../lib/host/service.js'
import { createRoutes } from '../lib/host/routes.js'
import { createTools } from '../lib/host/tools.js'

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), 'twb-route-'))
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized: false }
  const store = new TaskStore({ settings, persistSettings: (next) => { settings.initialized = next.initialized === true } })
  const service = new TaskService({ store, stateDir: join(root, 'state') })
  const server = http.createServer(createRoutes({ service, version: '0.1.0-test' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}/tw/api`,
    service,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function call(base, method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  return { status: response.status, payload }
}

test('routes: health / init / 增删改查 / 完成', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())

  const health = await call(env.base, 'GET', '/health')
  assert.equal(health.status, 200)
  assert.equal(health.payload.data.name, 'dsh-task-workbench')

  const before = await call(env.base, 'GET', '/bootstrap')
  assert.equal(before.payload.data.initialized, false)

  const init = await call(env.base, 'POST', '/init', {})
  assert.equal(init.payload.data.initialized, true)

  const created = await call(env.base, 'POST', '/tasks', { title: '路由测试', date: '2026-11-05', time: '09:30', endDate: '2026-11-08', priority: '重要紧急', requestId: 'r1' })
  assert.equal(created.status, 200)
  const task = created.payload.data.task
  assert.match(task.id, /^T-\d{8}-01$/)
  assert.equal(task.type, 'range')
  assert.equal(task.time, '09:30')
  assert.equal(task.endDate, '2026-11-08')

  const patched = await call(env.base, 'PATCH', `/tasks/${task.id}`, { changes: { note: '改过备注', endDate: '2026-11-09' }, baseHash: created.payload.data.hash })
  assert.equal(patched.payload.data.task.note, '改过备注')
  assert.equal(patched.payload.data.task.endDate, '2026-11-09')

  const completed = await call(env.base, 'POST', `/tasks/${task.id}/complete`, { done: true, baseHash: patched.payload.data.hash })
  assert.equal(completed.payload.data.task.done, true)

  const fetched = await call(env.base, 'GET', `/tasks/${task.id}`)
  assert.equal(fetched.payload.data.task.done, true)

  const list = await call(env.base, 'GET', '/tasks?includeCompleted=true')
  assert.equal(list.payload.data.tasks.length, 1)

  const removed = await call(env.base, 'DELETE', `/tasks/${task.id}`, { baseHash: completed.payload.data.hash })
  assert.equal(removed.payload.data.deleted.id, task.id)

  const empty = await call(env.base, 'GET', '/tasks')
  assert.equal(empty.payload.data.tasks.length, 0)
})

test('routes: 结构化错误与同源校验', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())
  await call(env.base, 'POST', '/init', {})
  const invalid = await call(env.base, 'POST', '/tasks', { title: '', date: '2026-11-05' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.payload.error.code, 'validation-error')

  const missing = await call(env.base, 'GET', '/tasks/T-20261105-99')
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.error.code, 'not-found')

  const unknown = await call(env.base, 'GET', '/nope')
  assert.equal(unknown.status, 404)

  const cross = await call(env.base, 'GET', '/bootstrap', undefined, { origin: 'https://evil.example' })
  assert.equal(cross.status, 403)
})

test('tools: 注册 7 个 tw_* 工具，无完成工具；工具写入走同一 service', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())
  await call(env.base, 'POST', '/init', {})
  const tools = createTools(env.service)
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['tw_create', 'tw_delete', 'tw_get_task', 'tw_list', 'tw_today', 'tw_update', 'tw_week'])
  assert.equal(names.some((name) => /complete|reopen/.test(name)), false)

  const exec = { agent: { session: { id: 'session-tools' } } }
  const create = tools.find((tool) => tool.name === 'tw_create')
  const created = await create.execute({ title: 'AI 建任务', date: '2026-11-05', time: '14:00', endDate: '2026-11-07', priority: '重要紧急' }, exec)
  assert.equal(created.ok, true)
  assert.match(created.message, /已创建任务/)
  assert.equal(created.actor, 'agent:session-tools')
  assert.equal(created.data.task.type, 'range')
  assert.equal(created.data.task.time, '14:00')
  assert.equal(created.data.task.endDate, '2026-11-07')

  const today = tools.find((tool) => tool.name === 'tw_today')
  const view = await today.execute({}, exec)
  assert.equal(view.ok, true)
  assert.match(view.message, /AI 建任务/)
  assert.equal(view.data.open.length, 1)
  assert.equal(view.data.overdue.length, 0)

  const week = tools.find((tool) => tool.name === 'tw_week')
  const weekView = await week.execute({ anchor: '2026-11-06' }, exec)
  assert.equal(weekView.ok, true)
  assert.ok(weekView.data.spans.some((span) => span.title === 'AI 建任务'))

  const update = tools.find((tool) => tool.name === 'tw_update')
  const updated = await update.execute({ taskId: created.data.task.id, note: 'AI 改的', endDate: '', endTime: '', time: '' }, exec)
  assert.equal(updated.data.task.note, 'AI 改的')
  assert.equal(updated.data.task.type, 'single')

  const remove = tools.find((tool) => tool.name === 'tw_delete')
  const removed = await remove.execute({ taskId: created.data.task.id }, exec)
  assert.equal(removed.ok, true)
  const list = tools.find((tool) => tool.name === 'tw_list')
  const listed = await list.execute({ includeCompleted: true }, exec)
  assert.equal(listed.data.tasks.length, 0)
})
