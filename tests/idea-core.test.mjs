import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendIdeaBlock, buildIdeaBlock, buildIdeaLine, findIdea, parseIdeaPool,
  removeIdeaBlock, replaceIdeaBlock, serializePool,
} from '../lib/core/idea-grammar.js'
import { deriveIdeaCounts, deriveIdeaList, publicIdea } from '../lib/core/idea-derive.js'
import { assertIdeaId, normalizeIdeaCreateInput, normalizeIdeaUpdateChanges } from '../lib/core/idea-validate.js'

const POOL_LINES = [
  '---',
  'title: 想法池',
  'type: idea-pool',
  'format: 1',
  'created: 2026-11-01',
  'updated: 2026-11-05',
  '---',
  '',
  '# 想法池',
  '',
  '> 说明',
  '',
  '## 想法',
  '',
  '- `I-20261103-01`｜整理季度复盘｜状态：推进中｜成熟度：高｜分类：工作｜创建：2026-11-03｜更新：2026-11-06',
  '  把本季度复盘材料整理成一份归档文档。',
  '  ',
  '  先列大纲，再补数据。',
  '',
  '- `I-20261105-02`｜工作台加想法池｜状态：待实现｜成熟度：低｜创建：2026-11-05｜更新：2026-11-05',
  '',
]
const POOL = `${POOL_LINES.join('\n')}\n`

const IDEA1 = {
  id: 'I-20261105-09',
  name: '新想法',
  description: '第一段\n\n第二段',
  status: '待实现',
  maturity: '中',
  category: '产品',
  created: '2026-11-05',
  updated: '2026-11-05',
  completed: null,
  unknown: [],
}

test('idea-grammar: 解析规范想法池（含多行描述与内部空行）', () => {
  const model = parseIdeaPool(POOL)
  assert.equal(model.readOnly, false)
  assert.equal(model.ideas.length, 2)
  const [first, second] = model.ideas
  assert.equal(first.id, 'I-20261103-01')
  assert.equal(first.name, '整理季度复盘')
  assert.equal(first.status, '推进中')
  assert.equal(first.maturity, '高')
  assert.equal(first.category, '工作')
  assert.equal(first.description, '把本季度复盘材料整理成一份归档文档。\n\n先列大纲，再补数据。')
  assert.equal(second.description, '')
  assert.deepEqual(first.warnings, [])
  assert.deepEqual(model.warnings, [])
})

test('idea-grammar: 解析 → 序列化 roundtrip 逐字节一致', () => {
  const model = parseIdeaPool(POOL)
  assert.equal(serializePool(model), POOL)
  assert.equal(buildIdeaBlock(model.ideas[0]), [
    '- `I-20261103-01`｜整理季度复盘｜状态：推进中｜成熟度：高｜分类：工作｜创建：2026-11-03｜更新：2026-11-06',
    '  把本季度复盘材料整理成一份归档文档。',
    '  ',
    '  先列大纲，再补数据。',
  ].join('\n'))
})

test('idea-grammar: append 只插入新想法块，其他想法逐字节不变', () => {
  const text = appendIdeaBlock(POOL, IDEA1, '2026-11-05')
  const model = parseIdeaPool(text)
  assert.equal(model.ideas.length, 3)
  assert.equal(model.ideas[2].id, 'I-20261105-09')
  assert.equal(model.ideas[2].description, '第一段\n\n第二段')
  assert.ok(text.includes('- `I-20261103-01`｜整理季度复盘｜状态：推进中｜成熟度：高｜分类：工作｜创建：2026-11-03｜更新：2026-11-06'))
  assert.ok(text.includes('- `I-20261105-02`｜工作台加想法池｜状态：待实现｜成熟度：低｜创建：2026-11-05｜更新：2026-11-05'))
  assert.ok(text.includes('updated: 2026-11-05'))
})

test('idea-grammar: replace 原地替换目标块，其他想法与位置不变', () => {
  const model = parseIdeaPool(POOL)
  const target = model.ideas[1]
  const next = { ...target, name: '工作台加想法池（改）', status: '完成', completed: '2026-11-05', updated: '2026-11-05' }
  const text = replaceIdeaBlock(POOL, target.id, next, '2026-11-05')
  const after = parseIdeaPool(text)
  assert.equal(after.ideas.length, 2)
  assert.equal(after.ideas[1].name, '工作台加想法池（改）')
  assert.equal(after.ideas[1].status, '完成')
  assert.equal(after.ideas[1].completed, '2026-11-05')
  assert.equal(after.ideas[0].lineIndex, model.ideas[0].lineIndex)
  assert.ok(text.includes('- `I-20261103-01`｜整理季度复盘｜状态：推进中｜成熟度：高｜分类：工作｜创建：2026-11-03｜更新：2026-11-06'))
})

test('idea-grammar: remove 精确移除目标块并合并空行', () => {
  const text = removeIdeaBlock(POOL, 'I-20261103-01', '2026-11-05')
  const model = parseIdeaPool(text)
  assert.equal(model.ideas.length, 1)
  assert.equal(model.ideas[0].id, 'I-20261105-02')
  assert.equal(text.includes('I-20261103-01'), false)
  assert.equal(text.includes('\n\n\n'), false)
})

test('idea-grammar: 未知字段与无法识别的行原样保留', () => {
  const text = POOL.replace(
    '- `I-20261105-02`｜工作台加想法池｜状态：待实现｜成熟度：低｜创建：2026-11-05｜更新：2026-11-05',
    '- `I-20261105-02`｜工作台加想法池｜状态：待实现｜成熟度：低｜创建：2026-11-05｜更新：2026-11-05｜其他：保留我',
  ).replace('## 想法\n', '## 想法\n\n- 这不是合法想法行\n')
  const model = parseIdeaPool(text)
  assert.equal(model.ideas.length, 2)
  assert.equal(model.ideas[1].unknown.length, 1)
  assert.ok(model.ideas[1].unknown[0].startsWith('其他'))
  assert.ok(model.warnings.some((warning) => warning.includes('不是合法的想法行')))
  const roundtrip = serializePool(model)
  assert.ok(roundtrip.includes('｜其他：保留我'))
  assert.ok(roundtrip.includes('- 这不是合法想法行'))
})

test('idea-grammar: 非法字段值给 warning，按缺省投影但不阻断读取', () => {
  const text = [
    '---', 'title: 想法池', 'type: idea-pool', 'format: 1', 'created: 2026-11-01', 'updated: 2026-11-01', '---', '',
    '# 想法池', '', '## 想法', '',
    '- `I-20261101-01`｜坏字段｜状态：瞎写｜成熟度：超高｜创建：2026-13-01｜更新：2026-02-30｜完成：2026-11-01',
    '',
  ].join('\n') + '\n'
  const model = parseIdeaPool(text)
  const idea = model.ideas[0]
  assert.equal(idea.status, '待实现')
  assert.equal(idea.maturity, '低')
  assert.equal(idea.created, '2026-11-01')
  assert.equal(idea.completed, null)
  assert.ok(idea.warnings.some((warning) => warning.includes('状态')))
  assert.ok(idea.warnings.some((warning) => warning.includes('成熟度')))
  assert.ok(idea.warnings.some((warning) => warning.includes('创建日期')))
  assert.ok(idea.warnings.some((warning) => warning.includes('完成日期')))
})

test('idea-grammar: 区块缺失 / 重复 / frontmatter 异常 → 只读', () => {
  const missing = parseIdeaPool(POOL.replace('## 想法', '## 别的'))
  assert.equal(missing.readOnly, true)
  assert.equal(missing.readOnlyReason, 'parse-error')

  const duplicated = parseIdeaPool(`${POOL}\n## 想法\n`)
  assert.equal(duplicated.readOnly, true)
  assert.equal(duplicated.readOnlyReason, 'parse-error')

  const noFrontmatter = parseIdeaPool('# 想法池\n\n## 想法\n')
  assert.equal(noFrontmatter.readOnly, true)
  assert.equal(noFrontmatter.readOnlyReason, 'format-version-unsupported')

  const wrongType = parseIdeaPool(POOL.replace('type: idea-pool', 'type: task-list'))
  assert.equal(wrongType.readOnly, true)
  assert.equal(wrongType.readOnlyReason, 'parse-error')

  const badFormat = parseIdeaPool(POOL.replace('format: 1', 'format: 2'))
  assert.equal(badFormat.readOnly, true)
  assert.equal(badFormat.readOnlyReason, 'format-version-unsupported')
})

test('idea-grammar: 重复 ID 给 warning', () => {
  const text = POOL.replace('I-20261105-02', 'I-20261103-01')
  const model = parseIdeaPool(text)
  assert.ok(model.warnings.some((warning) => warning.includes('想法 ID 重复')))
})

test('idea-derive: 列表排序 / 计数 / 停滞天数', () => {
  const text = [
    '---', 'title: 想法池', 'type: idea-pool', 'format: 1', 'created: 2026-11-01', 'updated: 2026-11-05', '---', '',
    '# 想法池', '', '## 想法', '',
    '- `I-20261001-01`｜放弃的｜状态：放弃｜成熟度：低｜创建：2026-10-01｜更新：2026-10-02',
    '- `I-20261001-02`｜完成的｜状态：完成｜成熟度：高｜创建：2026-10-01｜更新：2026-10-03｜完成：2026-10-03',
    '- `I-20261001-03`｜推进中的｜状态：推进中｜成熟度：中｜创建：2026-10-01｜更新：2026-10-01',
    '- `I-20261105-01`｜待实现的｜状态：待实现｜成熟度：低｜创建：2026-11-05｜更新：2026-11-04',
    '',
  ].join('\n') + '\n'
  const model = parseIdeaPool(text)
  const data = deriveIdeaList(model, { today: '2026-11-05' })
  assert.deepEqual(data.ideas.map((idea) => idea.status), ['待实现', '推进中', '完成', '放弃'])
  assert.deepEqual(data.counts, { total: 4, todo: 1, doing: 1, done: 1, dropped: 1, open: 2 })
  assert.equal(data.lastUpdated, '2026-11-04')
  const stale = data.ideas.find((idea) => idea.status === '推进中')
  assert.equal(stale.staleDays, 35)
  assert.equal(data.ideas.find((idea) => idea.status === '完成').staleDays, 0)
  assert.deepEqual(deriveIdeaCounts(model), data.counts)
  assert.equal(publicIdea(model.ideas[0], '2026-11-05').staleDays, 0)
})

test('idea-validate: 新建 / 编辑 / ID 校验', () => {
  const clean = normalizeIdeaCreateInput({ name: '  新想法  ' }, '2026-11-05')
  assert.deepEqual(clean, { name: '新想法', description: '', maturity: '低', category: '', created: '2026-11-05' })

  assert.throws(() => normalizeIdeaCreateInput({}, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: '含｜分隔符' }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x'.repeat(201) }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x', maturity: '超高' }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x', category: 'x'.repeat(21) }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x', description: 'x'.repeat(10001) }, '2026-11-05'), (error) => error.code === 'validation-error')

  const description = normalizeIdeaCreateInput({ name: 'x', description: '第一段\r\n\r\n第二段' }, '2026-11-05')
  assert.equal(description.description, '第一段\n\n第二段')

  const changes = normalizeIdeaUpdateChanges({ name: '改名', status: '完成', category: '' })
  assert.deepEqual(changes, { name: '改名', status: '完成', category: '' })
  assert.throws(() => normalizeIdeaUpdateChanges({ status: '瞎写' }), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaUpdateChanges({ foo: 1 }), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaUpdateChanges({}), (error) => error.code === 'validation-error')

  assert.equal(assertIdeaId('I-20261105-01'), 'I-20261105-01')
  assert.throws(() => assertIdeaId('T-20261105-01'), (error) => error.code === 'validation-error')
})

test('idea-grammar: buildIdeaLine 只写非空可选字段', () => {
  assert.equal(
    buildIdeaLine({ ...IDEA1, category: '', created: '2026-11-05', updated: '2026-11-05' }),
    '- `I-20261105-09`｜新想法｜状态：待实现｜成熟度：中｜创建：2026-11-05｜更新：2026-11-05',
  )
  assert.equal(findIdea(parseIdeaPool(POOL), 'I-20261105-02').name, '工作台加想法池')
})
