import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createSkillProvider, readSkills } from '../lib/host/skills.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))

test('skills: 随包提供 task-workbench 技能', async () => {
  const skills = readSkills(pluginRoot)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'task-workbench')
  assert.match(skills[0].description, /tw_\* 工具/)
  assert.match(skills[0].description, /完成\/撤销完成只能由人/)
  assert.match(skills[0].description, /tw_review_\* 只读工具/)
  assert.match(skills[0].description, /复盘内容只能由人写，AI 只读/)

  const provider = createSkillProvider(pluginRoot)
  assert.equal(provider.name, 'task-workbench')
  const list = await provider.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].source, 'bundled')
  assert.equal(list[0].invocation.modelInvocable, true)
  assert.equal(list[0].resourceBase.kind, 'directory')

  const content = await provider.get({ name: list[0].name, locator: list[0].locator })
  assert.match(content.content, /tw_create/)
  assert.match(content.content, /没有工具/)
  assert.match(content.content, /跨周期/)
  assert.match(content.content, /tw_review_list/)
  assert.match(content.content, /tw_review_get/)
  assert.match(content.content, /没有创建 \/ 修改 \/ 删除工具/)
  assert.equal(await provider.get({ name: 'nope', locator: '/tmp' }), undefined)
})
