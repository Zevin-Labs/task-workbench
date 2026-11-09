import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assertTaskId, normalizeCreateInput, normalizeUpdateChanges } from '../lib/core/validate.js'
import { assertIdeaId, normalizeIdeaCreateInput, normalizeIdeaUpdateChanges } from '../lib/core/idea-validate.js'
import { createSkillProvider, readSkills } from '../lib/host/skills.js'
import { createTools } from '../lib/host/tools.js'
import { createIdeaTools } from '../lib/host/idea-tools.js'
import { createReviewTools } from '../lib/host/review-tools.js'

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

test('skills: SQLite 真源、空库初始化与稳定 ID 说明保留', () => {
  const skill = readSkills(pluginRoot)[0]
  assert.match(skill.description, /本机 SQLite 数据库/)
  assert.match(skill.body, /workbench\.sqlite 是唯一真源/)
  assert.match(skill.body, /初次初始化是空库，不会导入旧版 Markdown/)
  assert.match(skill.body, /必须经当前领域 Service 操作，不直接写文件或数据库/)

  const taskId = skill.body.match(/任务 ID 形如 (T-\d+)/)?.[1]
  const ideaId = skill.body.match(/想法 ID 形如 (I-\d+)/)?.[1]
  assert.equal(assertTaskId(taskId), 'T-1', '技能给出的任务 ID 应符合当前校验器')
  assert.equal(assertIdeaId(ideaId), 'I-1', '技能给出的想法 ID 应符合当前校验器')
})

test('skills: 说明的工具与实际注册契约一致，人专有动作不出现在写入参数中', () => {
  const body = readSkills(pluginRoot)[0].body
  const tools = [...createTools({}), ...createIdeaTools({}), ...createReviewTools({})]
  const documentedNames = [...new Set(body.match(/\btw_[a-z]+(?:_[a-z]+)*\b/g))].sort()
  assert.deepEqual(documentedNames, tools.map((tool) => tool.name).sort())

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.tw_create.parameters.required, ['title'])
  assert.deepEqual(byName.tw_update.parameters.required, ['taskId'])
  assert.deepEqual(byName.tw_idea_create.parameters.required, ['name'])
  assert.deepEqual(byName.tw_idea_update.parameters.required, ['ideaId'])
  for (const name of ['tw_create', 'tw_update']) {
    const fields = byName[name].parameters.properties
    assert.equal(Object.hasOwn(fields, 'done'), false)
    assert.equal(Object.hasOwn(fields, 'completed'), false)
  }
  for (const name of ['tw_idea_create', 'tw_idea_update']) {
    assert.equal(Object.hasOwn(byName[name].parameters.properties, 'status'), false)
  }
  assert.deepEqual(tools.filter((tool) => tool.name.startsWith('tw_review_')).map((tool) => tool.name), [
    'tw_review_list', 'tw_review_get',
  ])
})

test('skills: 文本说明与实际校验器一致：标题单行、详情多行、长度上限一致', () => {
  const body = readSkills(pluginRoot)[0].body
  const taskSection = body.split('## 任务类型与字段\n')[1].split('\n## ')[0]
  const ideaSection = body.split('## 想法池字段\n')[1].split('\n## ')[0]
  assert.match(taskSection, /标题简洁精炼：一句话说清做什么，不写背景 \/ 过程 \/ 结论/)
  assert.match(taskSection, /细节写进详情（note）/)
  assert.match(taskSection, /标题只能单行，不能含换行；详情（note）可以多行/)
  assert.match(ideaSection, /名称\/分类可以包含全角分隔符 ｜，不能含换行/)
  assert.doesNotMatch(body, /不能含全角分隔符|禁\s*｜/)

  const taskInput = { title: '标题｜后半段', note: '详情第一行\n详情第二行｜' }
  const task = normalizeCreateInput(taskInput, '2026-11-07')
  assert.equal(task.title, taskInput.title)
  assert.equal(task.note, taskInput.note)
  assert.deepEqual(normalizeUpdateChanges(taskInput), taskInput)

  const ideaInput = { name: '名称｜后半段', category: '分类｜后半段' }
  const idea = normalizeIdeaCreateInput(ideaInput, '2026-11-07')
  assert.equal(idea.name, ideaInput.name)
  assert.equal(idea.category, ideaInput.category)
  assert.deepEqual(normalizeIdeaUpdateChanges(ideaInput), ideaInput)

  const titleMax = Number(taskSection.match(/title（必填，单行，≤(\d+) 字）/)[1])
  const noteMax = Number(taskSection.match(/note（详情，可选，多行，≤(\d+) 字）/)[1])
  const nameMax = Number(ideaSection.match(/name（必填，单行，≤(\d+) 字）/)[1])
  const categoryMax = Number(ideaSection.match(/category（可选，单行，≤(\d+) 字）/)[1])
  const invalid = (error) => error.code === 'validation-error'

  // 单行字段：标题 / 名称 / 分类，长度与换行规则和技能声明一致。
  for (const [field, max, normalize] of [
    ['title', titleMax, (value) => normalizeCreateInput({ title: value }, '2026-11-07')],
    ['name', nameMax, (value) => normalizeIdeaCreateInput({ name: value }, '2026-11-07')],
    ['category', categoryMax, (value) => normalizeIdeaCreateInput({ name: 'x', category: value }, '2026-11-07')],
  ]) {
    assert.equal(normalize('x'.repeat(max))[field].length, max, `${field} 应接受技能声明的长度上限`)
    assert.throws(() => normalize('x'.repeat(max + 1)), invalid, `${field} 应拒绝超过技能声明的长度`)
    assert.throws(() => normalize('有\n换行'), invalid, `${field} 应保持单行`)
  }

  // 详情：多行、\r\n 归一化，长度上限与技能声明一致。
  const note = (value) => normalizeCreateInput({ title: 'x', note: value }, '2026-11-07').note
  assert.equal(note('x'.repeat(noteMax)).length, noteMax, 'note 应接受技能声明的长度上限')
  assert.throws(() => note('x'.repeat(noteMax + 1)), invalid, 'note 应拒绝超过技能声明的长度')
  assert.equal(note('第一行\n第二行'), '第一行\n第二行', '详情应允许多行')
  assert.equal(note('第一行\r\n第二行'), '第一行\n第二行', '详情应把 \\r\\n 归一化为 \\n')
  assert.equal(note('第一行\r第二行'), '第一行\n第二行', '详情应把孤立 \\r 归一化为 \\n')
})
