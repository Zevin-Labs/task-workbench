// 插件装配测试：用替身 ctx 跑真实 apply()，确认 host 半边注册了复盘路由 / 只读 AI 工具，
// 且没有复盘写工具；临时 DSH_HOME，不碰真实状态目录与数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function loadPlugin() {
  const home = await mkdtemp(join(tmpdir(), 'twb-wiring-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const mod = await import('../lib/index.js')
  return {
    home,
    mod,
    async restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    },
  }
}

function createFakeCtx() {
  const tools = []
  const routes = []
  const providers = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    tools: { register: (tool) => tools.push(tool) },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => { disposers.push(fn()) },
    inject: (deps, cb) => {
      cb({
        effect: (fn) => { disposers.push(fn()) },
        skills: { registerProvider: (provider) => providers.push(provider) },
      })
    },
  }
  return {
    ctx, tools, routes, providers,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

test('wiring: apply() 注册任务/想法/复盘三类工具 + 复盘路由，复盘无写工具', async (t) => {
  const env = await loadPlugin()
  const fake = createFakeCtx()
  t.after(async () => {
    fake.dispose()
    await env.restore()
  })
  assert.equal(env.mod.name, 'task-workbench')
  assert.deepEqual(env.mod.inject, ['tools', 'webServer'])

  env.mod.apply(fake.ctx)

  const names = fake.tools.map((tool) => tool.name)
  // 任务 7 + 想法 5 + 复盘只读 2
  assert.equal(names.length, 14, `工具数量：${names.join(', ')}`)
  assert.deepEqual(names.filter((name) => name.startsWith('tw_review_')), ['tw_review_list', 'tw_review_get'])
  for (const forbidden of ['tw_review_create', 'tw_review_update', 'tw_review_delete', 'tw_review_save']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} 不应注册`)
  }
  // 原有工具面不变
  assert.deepEqual(names.filter((name) => name.startsWith('tw_idea_')).sort(), [
    'tw_idea_create', 'tw_idea_delete', 'tw_idea_get', 'tw_idea_list', 'tw_idea_update',
  ])
  assert.equal(names.includes('tw_create'), true)
  assert.equal(names.includes('tw_complete'), false)

  assert.equal(fake.routes.length, 1)
  assert.equal(fake.routes[0].kind, 'prefix')
  assert.equal(fake.routes[0].path, '/tw')
  assert.equal(typeof fake.routes[0].handler, 'function')

  assert.equal(fake.providers.length, 1)
  const provider = fake.providers[0]()
  const list = await provider.list()
  assert.equal(list[0].name, 'task-workbench')
  const content = await provider.get({ name: list[0].name, locator: list[0].locator })
  assert.match(content.content, /tw_review_list/)
})

test('wiring: UI 路由与 AI 工具共用 SQLite，Host 重新加载后数据仍在', async (t) => {
  const env = await loadPlugin()
  let active = createFakeCtx()
  const server = createServer((req, res) => active.routes[0].handler(req, res))
  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve) => server.close(resolve))
    } finally {
      active.dispose()
      await env.restore()
    }
  })
  env.mod.apply(active.ctx)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/tw/api`
  async function call(method, path, body) {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json()
    assert.equal(response.status, 200, JSON.stringify(payload))
    assert.equal(payload.ok, true)
    return payload.data
  }
  const execute = (name, args) => active.tools.find((tool) => tool.name === name)
    .execute(args, { agent: { session: { id: 'wiring-reload' } } })

  assert.equal((await call('GET', '/bootstrap')).initialized, false)
  const boot = await call('POST', '/init', {})
  const created = await execute('tw_create', { title: '装配重载回归' })
  const task = created.data.task
  assert.equal((await call('GET', `/tasks/${task.id}`)).task.title, task.title)
  const idea = (await call('POST', '/ideas', { name: 'UI 创建的想法' })).idea
  assert.equal((await execute('tw_idea_get', { ideaId: idea.id })).data.idea.name, idea.name)
  await call('PUT', `/reviews/daily/${boot.today}`, { text: 'UI 写入的复盘' })
  assert.equal((await execute('tw_review_get', { kind: 'daily', key: boot.today })).data.review.text, 'UI 写入的复盘')

  active.dispose()
  active = createFakeCtx()
  env.mod.apply(active.ctx)
  const reloaded = await call('GET', '/bootstrap')
  assert.equal(reloaded.initialized, true)
  assert.equal(reloaded.version, created.data.version)
  assert.equal(reloaded.ideas.counts.total, 1)
  assert.equal((await execute('tw_get_task', { taskId: task.id })).data.task.title, task.title)
  assert.equal((await call('GET', `/ideas/${idea.id}`)).idea.name, idea.name)
  assert.equal((await call('GET', `/reviews/daily/${boot.today}`)).review.text, 'UI 写入的复盘')
})
