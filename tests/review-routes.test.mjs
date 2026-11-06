import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../lib/host/store.js'
import { TaskService } from '../lib/host/service.js'
import { ReviewStore } from '../lib/host/review-store.js'
import { ReviewService } from '../lib/host/review-service.js'
import { createRoutes } from '../lib/host/routes.js'

async function makeServer() {
  const root = await mkdtemp(join(tmpdir(), 'ptw-review-route-'))
  const now = () => new Date('2026-11-05T10:00:00')
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized: true }
  const store = new TaskStore({ settings, persistSettings: () => {}, now })
  const service = new TaskService({ store, stateDir: join(root, 'state'), now })
  const reviewStore = new ReviewStore({ settings, persistSettings: () => {}, now, isDataRootReady: () => true })
  const reviewService = new ReviewService({ store: reviewStore, taskStore: store, stateDir: join(root, 'state'), now })
  const server = http.createServer(createRoutes({ service, ideaService: null, reviewService, version: '0.3.0-test' }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}/ptw/api`,
    reviewService,
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

test('review-routes: 复盘板 / 提交 / 更新 / 清空 / 窗口外拒绝', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())

  const board = await call(env.base, 'GET', '/reviews')
  assert.equal(board.status, 200)
  assert.deepEqual(board.payload.data.prompts.map((p) => [p.kind, p.key]), [['daily', '2026-11-05'], ['weekly', '2026-10-26']])
  assert.equal(board.payload.data.prompts[0].state, 'pending')

  const created = await call(env.base, 'PUT', '/reviews/daily/2026-11-05', { text: '今天做了 A。' })
  assert.equal(created.status, 200)
  assert.equal(created.payload.data.created, true)
  assert.equal(created.payload.data.review.text, '今天做了 A。')
  const hash = created.payload.data.hash
  assert.equal(hash.length, 64)

  const done = await call(env.base, 'GET', '/reviews')
  assert.equal(done.payload.data.prompts[0].state, 'done')
  assert.equal(done.payload.data.prompts[0].review.text, '今天做了 A。')
  assert.equal(done.payload.data.prompts[0].hash, hash)

  const updated = await call(env.base, 'PUT', '/reviews/daily/2026-11-05', {
    text: '改过的内容', baseHash: hash, requestId: 'req-review-1',
  })
  assert.equal(updated.payload.data.created, false)
  assert.equal(updated.payload.data.review.text, '改过的内容')

  const outOfWindow = await call(env.base, 'PUT', '/reviews/daily/2026-11-04', { text: '补写昨天' })
  assert.equal(outOfWindow.status, 400)
  assert.equal(outOfWindow.payload.error.code, 'validation-error')
  assert.match(outOfWindow.payload.error.message, /可写窗口/)

  const wrongKind = await call(env.base, 'PUT', '/reviews/nope/2026-11-05', { text: 'x' })
  assert.equal(wrongKind.status, 404)

  const emptyText = await call(env.base, 'PUT', '/reviews/weekly/2026-10-26', { text: '   ' })
  assert.equal(emptyText.status, 400)
  assert.match(emptyText.payload.error.message, /不能为空/)

  const monthlyBoard = await call(env.base, 'GET', '/reviews?date=2026-11-30')
  assert.equal(monthlyBoard.payload.data.prompts.some((p) => p.kind === 'monthly' && p.key === '2026-11'), true)

  const badDate = await call(env.base, 'GET', '/reviews?date=2026-13-01')
  assert.equal(badDate.status, 400)
  assert.equal(badDate.payload.error.code, 'validation-error')

  const removed = await call(env.base, 'DELETE', '/reviews/daily/2026-11-05', {})
  assert.equal(removed.status, 200)
  assert.equal(removed.payload.data.deleted.key, '2026-11-05')
  const afterClear = await call(env.base, 'GET', '/reviews')
  assert.equal(afterClear.payload.data.prompts[0].state, 'pending')
})

test('review-routes: 同源校验、未知方法/路径的结构化错误', async (t) => {
  const env = await makeServer()
  t.after(() => env.close())

  const evil = await call(env.base, 'GET', '/reviews', undefined, { origin: 'http://evil.example' })
  assert.equal(evil.status, 403)
  assert.equal(evil.payload.error.code, 'forbidden-path')

  const post = await call(env.base, 'POST', '/reviews', {})
  assert.equal(post.status, 405)
  assert.equal(post.payload.error.code, 'validation-error')

  const unknown = await call(env.base, 'GET', '/reviews/whatever')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.payload.error.code, 'not-found')
})
