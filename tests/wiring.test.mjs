// 插件装配测试：用替身 ctx 跑真实 apply()，确认 host 半边注册了复盘路由 / 只读 AI 工具，
// 且没有复盘写工具；临时 DSH_HOME，不碰真实状态目录与数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function loadPlugin() {
  const home = await mkdtemp(join(tmpdir(), 'ptw-wiring-home-'))
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
  return { ctx, tools, routes, providers }
}

test('wiring: apply() 注册任务/想法/复盘三类工具 + 复盘路由，复盘无写工具', async (t) => {
  const env = await loadPlugin()
  t.after(env.restore)
  assert.equal(env.mod.name, 'task-workbench')
  assert.deepEqual(env.mod.inject, ['tools', 'webServer'])

  const fake = createFakeCtx()
  env.mod.apply(fake.ctx)

  const names = fake.tools.map((tool) => tool.name)
  // 任务 7 + 想法 5 + 复盘只读 2
  assert.equal(names.length, 14, `工具数量：${names.join(', ')}`)
  assert.deepEqual(names.filter((name) => name.startsWith('ptw_review_')), ['ptw_review_list', 'ptw_review_get'])
  for (const forbidden of ['ptw_review_create', 'ptw_review_update', 'ptw_review_delete', 'ptw_review_save']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} 不应注册`)
  }
  // 原有工具面不变
  assert.deepEqual(names.filter((name) => name.startsWith('ptw_idea_')).sort(), [
    'ptw_idea_create', 'ptw_idea_delete', 'ptw_idea_get', 'ptw_idea_list', 'ptw_idea_update',
  ])
  assert.equal(names.includes('ptw_create'), true)
  assert.equal(names.includes('ptw_complete'), false)

  assert.equal(fake.routes.length, 1)
  assert.equal(fake.routes[0].kind, 'prefix')
  assert.equal(fake.routes[0].path, '/ptw')
  assert.equal(typeof fake.routes[0].handler, 'function')

  assert.equal(fake.providers.length, 1)
  const provider = fake.providers[0]()
  const list = await provider.list()
  assert.equal(list[0].name, 'task-workbench')
  const content = await provider.get({ name: list[0].name, locator: list[0].locator })
  assert.match(content.content, /ptw_review_list/)
})
