import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdeaStore } from '../lib/host/idea-store.js'
import { IdeaService } from '../lib/host/idea-service.js'
import { createIdeaTools } from '../lib/host/idea-tools.js'
import { toolActor } from '../lib/host/service.js'

async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'ptw-idea-tool-'))
  const now = () => new Date('2026-11-05T10:00:00')
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7, initialized: true }
  const store = new IdeaStore({ settings, persistSettings: () => {}, now, isDataRootReady: () => true })
  const service = new IdeaService({ store, stateDir: join(root, 'state'), now })
  return { root, store, service, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const exec = { agent: { session: { id: 'session-idea-tools' } } }

test('idea-tools: 注册 5 个 ptw_idea_* 工具，没有改状态工具', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const tools = createIdeaTools(env.service)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'ptw_idea_create', 'ptw_idea_delete', 'ptw_idea_get', 'ptw_idea_list', 'ptw_idea_update',
  ])
  const names = tools.map((tool) => tool.name)
  assert.equal(names.some((name) => /status|complete/.test(name)), false)
  const update = tools.find((tool) => tool.name === 'ptw_idea_update')
  assert.equal(Object.prototype.hasOwnProperty.call(update.parameters.properties, 'status'), false)
  const create = tools.find((tool) => tool.name === 'ptw_idea_create')
  assert.equal(Object.prototype.hasOwnProperty.call(create.parameters.properties, 'status'), false)
})

test('idea-tools: AI 新建 / 列表 / 详情 / 编辑 / 删除走同一 service', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const tools = createIdeaTools(env.service)
  const tool = (name) => tools.find((item) => item.name === name)

  const created = await tool('ptw_idea_create').execute({
    name: 'AI 记的想法',
    description: '第一段\n第二段',
    maturity: '高',
    category: '业务',
  }, exec)
  assert.equal(created.ok, true)
  assert.equal(created.actor, 'agent:session-idea-tools')
  assert.equal(created.data.idea.status, '待实现')
  assert.equal(created.data.idea.maturity, '高')

  const text = await readFile(env.store.file, 'utf8')
  assert.ok(text.includes('AI 记的想法'))
  assert.ok(text.includes('  第一段\n  第二段'))

  const list = await tool('ptw_idea_list').execute({ status: '待实现' }, exec)
  assert.equal(list.data.ideas.length, 1)
  assert.match(list.message, /AI 记的想法/)
  const filtered = await tool('ptw_idea_list').execute({ status: '完成' }, exec)
  assert.equal(filtered.data.ideas.length, 0)

  const got = await tool('ptw_idea_get').execute({ ideaId: created.data.idea.id }, exec)
  assert.equal(got.data.idea.name, 'AI 记的想法')
  assert.match(got.message, /第一段/)

  const updated = await tool('ptw_idea_update').execute({
    ideaId: created.data.idea.id,
    name: 'AI 改过的想法',
    maturity: '中',
    category: '',
  }, exec)
  assert.equal(updated.data.idea.name, 'AI 改过的想法')
  assert.equal(updated.data.idea.maturity, '中')
  assert.equal(updated.data.idea.category, '')

  const removed = await tool('ptw_idea_delete').execute({ ideaId: created.data.idea.id }, exec)
  assert.equal(removed.ok, true)
  const empty = await tool('ptw_idea_list').execute({}, exec)
  assert.equal(empty.data.ideas.length, 0)
})

test('idea-tools: AI 直接改状态被拒（permission-denied）', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const created = await env.service.create({ name: '状态边界' }, toolActor(exec))
  await assert.rejects(
    env.service.update(created.idea.id, { changes: { status: '完成' } }, toolActor(exec)),
    (error) => error.code === 'permission-denied',
  )
  const got = await env.service.get(created.idea.id)
  assert.equal(got.idea.status, '待实现')
})
