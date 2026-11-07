import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchDatabase } from '../lib/host/db.js'
import { IdeaService } from '../lib/host/idea-service.js'
import { createIdeaTools } from '../lib/host/idea-tools.js'
import { toolActor } from '../lib/host/service.js'

async function makeEnv() {
  const root = await mkdtemp(join(tmpdir(), 'twb-idea-tool-'))
  const now = () => new Date('2026-11-05T10:00:00')
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7 }
  const db = new WorkbenchDatabase({ settings, now })
  db.init()
  const service = new IdeaService({ db, now })
  return {
    root,
    service,
    async cleanup() {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

const exec = { agent: { session: { id: 'session-idea-tools' } } }

test('idea-tools: 注册 5 个 tw_idea_* 工具，没有改状态工具', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const tools = createIdeaTools(env.service)
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'tw_idea_create', 'tw_idea_delete', 'tw_idea_get', 'tw_idea_list', 'tw_idea_update',
  ])
  const names = tools.map((tool) => tool.name)
  assert.equal(names.some((name) => /status|complete/.test(name)), false)
  const update = tools.find((tool) => tool.name === 'tw_idea_update')
  assert.equal(Object.prototype.hasOwnProperty.call(update.parameters.properties, 'status'), false)
  const create = tools.find((tool) => tool.name === 'tw_idea_create')
  assert.equal(Object.prototype.hasOwnProperty.call(create.parameters.properties, 'status'), false)
})

test('idea-tools: AI 新建 / 列表 / 详情 / 编辑 / 删除走同一 service', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const tools = createIdeaTools(env.service)
  const tool = (name) => tools.find((item) => item.name === name)

  const created = await tool('tw_idea_create').execute({
    name: 'AI 记的想法',
    description: '第一段\n第二段',
    maturity: '高',
    category: '业务',
  }, exec)
  assert.equal(created.ok, true)
  assert.equal(created.actor, 'agent:session-idea-tools')
  assert.equal(created.data.idea.status, '待实现')
  assert.equal(created.data.idea.maturity, '高')

  const stored = await env.service.get(created.data.idea.id)
  assert.equal(stored.idea.description, '第一段\n第二段')

  const list = await tool('tw_idea_list').execute({ status: '待实现' }, exec)
  assert.equal(list.data.ideas.length, 1)
  assert.match(list.message, /AI 记的想法/)
  const filtered = await tool('tw_idea_list').execute({ status: '完成' }, exec)
  assert.equal(filtered.data.ideas.length, 0)

  const got = await tool('tw_idea_get').execute({ ideaId: created.data.idea.id }, exec)
  assert.equal(got.data.idea.name, 'AI 记的想法')
  assert.match(got.message, /第一段/)

  const updated = await tool('tw_idea_update').execute({
    ideaId: created.data.idea.id,
    name: 'AI 改过的想法',
    maturity: '中',
    category: '',
  }, exec)
  assert.equal(updated.data.idea.name, 'AI 改过的想法')
  assert.equal(updated.data.idea.maturity, '中')
  assert.equal(updated.data.idea.category, '')

  const removed = await tool('tw_idea_delete').execute({ ideaId: created.data.idea.id }, exec)
  assert.equal(removed.ok, true)
  const empty = await tool('tw_idea_list').execute({}, exec)
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
