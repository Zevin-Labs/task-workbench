import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/host/store.js'
import { TaskService } from '../lib/host/service.js'
import { IdeaStore } from '../lib/host/idea-store.js'
import { IdeaService } from '../lib/host/idea-service.js'
import { createRoutes } from '../lib/host/routes.js'

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), 'ptw-idea-route-'))
  const now = () => new Date('2026-11-05T10:00:00')
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized: true }
  const store = new TaskStore({ settings, persistSettings: () => {}, now })
  const service = new TaskService({ store, stateDir: join(root, 'state'), now })
  const ideaStore = new IdeaStore({
    settings,
    persistSettings: () => {},
    now,
    isDataRootReady: () => true,
  })
  const ideaService = new IdeaService({ store: ideaStore, stateDir: join(root, 'state'), now })
  const server = http.createServer(createRoutes({ service, ideaService, version: '0.2.0-test' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}/ptw/api`,
    ideaService,
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

test('idea-routes: bootstrap 带 ideas，增删改查全链路', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())

  const health = await call(env.base, 'GET', '/health')
  assert.equal(health.status, 200)

  const before = await call(env.base, 'GET', '/bootstrap')
  assert.equal(before.payload.data.ideas.initialized, false)
  assert.deepEqual(before.payload.data.ideas.counts, { total: 0, todo: 0, doing: 0, done: 0, dropped: 0, open: 0 })

  const created = await call(env.base, 'POST', '/ideas', {
    name: '工作台加想法池',
    description: '第一段\n第二段',
    maturity: '中',
    category: '产品',
    requestId: 'idea-route-1',
  })
  assert.equal(created.status, 200)
  const idea = created.payload.data.idea
  assert.match(idea.id, /^I-\d{8}-01$/)
  assert.equal(idea.status, '待实现')
  assert.equal(idea.maturity, '中')

  const list = await call(env.base, 'GET', '/ideas')
  assert.equal(list.payload.data.ideas.length, 1)
  assert.equal(list.payload.data.counts.todo, 1)
  assert.equal(list.payload.data.hash, created.payload.data.hash)

  const fetched = await call(env.base, 'GET', `/ideas/${idea.id}`)
  assert.equal(fetched.payload.data.idea.name, '工作台加想法池')

  const patched = await call(env.base, 'PATCH', `/ideas/${idea.id}`, {
    changes: { name: '工作台加想法池（改）', status: '推进中' },
    baseHash: list.payload.data.hash,
  })
  assert.equal(patched.payload.data.idea.name, '工作台加想法池（改）')
  assert.equal(patched.payload.data.idea.status, '推进中')

  const removed = await call(env.base, 'DELETE', `/ideas/${idea.id}`, { baseHash: patched.payload.data.hash })
  assert.equal(removed.payload.data.deleted.id, idea.id)

  const empty = await call(env.base, 'GET', '/ideas')
  assert.equal(empty.payload.data.ideas.length, 0)

  const after = await call(env.base, 'GET', '/bootstrap')
  assert.equal(after.payload.data.ideas.initialized, true)
  assert.equal(after.payload.data.ideas.counts.total, 0)
})

test('idea-routes: 结构化错误、未知方法、同源校验', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())

  const invalid = await call(env.base, 'POST', '/ideas', { name: '' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.payload.error.code, 'validation-error')

  const missing = await call(env.base, 'GET', '/ideas/I-20261105-99')
  assert.equal(missing.status, 404)
  assert.equal(missing.payload.error.code, 'not-found')

  const badMethod = await call(env.base, 'PUT', '/ideas')
  assert.equal(badMethod.status, 405)

  const unknown = await call(env.base, 'GET', '/ideas/nope')
  assert.equal(unknown.status, 404)

  const cross = await call(env.base, 'GET', '/bootstrap', undefined, { origin: 'https://evil.example' })
  assert.equal(cross.status, 403)
})
