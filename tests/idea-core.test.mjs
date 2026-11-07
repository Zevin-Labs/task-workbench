import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveIdeaCounts, deriveIdeaList, publicIdea } from '../lib/core/idea-derive.js'
import {
  assertIdeaId, normalizeIdeaCreateInput, normalizeIdeaDescription, normalizeIdeaUpdateChanges,
} from '../lib/core/idea-validate.js'

function idea(overrides = {}) {
  return {
    id: 'I-1',
    name: '想法',
    description: '',
    status: '待实现',
    maturity: '低',
    category: '',
    created: '2026-11-05',
    updated: '2026-11-05',
    completed: null,
    order: 1,
    ...overrides,
  }
}

test('idea-derive: 列表排序 / 计数 / 停滞天数', () => {
  const ideas = [
    idea({ id: 'I-1', name: '放弃的', status: '放弃', maturity: '低', created: '2026-10-01', updated: '2026-10-02', order: 1 }),
    idea({ id: 'I-2', name: '完成的', status: '完成', maturity: '高', created: '2026-10-01', updated: '2026-10-03', completed: '2026-10-03', order: 2 }),
    idea({ id: 'I-3', name: '推进中的', status: '推进中', maturity: '中', created: '2026-10-01', updated: '2026-10-01', order: 3 }),
    idea({ id: 'I-4', name: '待实现的', status: '待实现', maturity: '低', created: '2026-11-05', updated: '2026-11-04', order: 4 }),
  ]
  const data = deriveIdeaList({ ideas }, { today: '2026-11-05' })
  assert.deepEqual(data.ideas.map((item) => item.status), ['待实现', '推进中', '完成', '放弃'])
  assert.deepEqual(data.counts, { total: 4, todo: 1, doing: 1, done: 1, dropped: 1, open: 2 })
  assert.equal(data.lastUpdated, '2026-11-04')
  const stale = data.ideas.find((item) => item.status === '推进中')
  assert.equal(stale.staleDays, 35)
  assert.equal(data.ideas.find((item) => item.status === '完成').staleDays, 0)
  assert.deepEqual(deriveIdeaCounts({ ideas }), data.counts)
  assert.equal(publicIdea(ideas[0], '2026-11-05').staleDays, 0)
})

test('idea-validate: 新建默认值、描述规整与长度限制', () => {
  const clean = normalizeIdeaCreateInput({ name: '  新想法  ' }, '2026-11-05')
  assert.deepEqual(clean, { name: '新想法', description: '', maturity: '低', category: '', created: '2026-11-05' })

  const description = normalizeIdeaCreateInput({
    name: 'x', description: '\r\n\r\n第一段：a｜b\r\n\r\n第二段\r\n\r\n',
  }, '2026-11-05')
  assert.equal(description.description, '第一段：a｜b\n\n第二段')

  assert.equal(normalizeIdeaDescription('  第一行  \n\n第二行  '), '  第一行\n\n第二行')

  assert.throws(() => normalizeIdeaCreateInput({}, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: '带\n换行' }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x'.repeat(201) }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x', maturity: '超高' }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x', category: 'x'.repeat(21) }, '2026-11-05'), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaCreateInput({ name: 'x', description: 'x'.repeat(10001) }, '2026-11-05'), (error) => error.code === 'validation-error')

  // 旧 Markdown 分隔符不再是格式限制。
  const allowed = normalizeIdeaCreateInput({ name: '名称｜可以有分隔符', category: '分类｜也行' }, '2026-11-05')
  assert.equal(allowed.name, '名称｜可以有分隔符')
  assert.equal(allowed.category, '分类｜也行')
})

test('idea-validate: 编辑字段白名单、状态与 ID', () => {
  const changes = normalizeIdeaUpdateChanges({ name: '改名', status: '完成', category: '' })
  assert.deepEqual(changes, { name: '改名', status: '完成', category: '' })
  assert.throws(() => normalizeIdeaUpdateChanges({ status: '瞎写' }), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaUpdateChanges({ foo: 1 }), (error) => error.code === 'validation-error')
  assert.throws(() => normalizeIdeaUpdateChanges({}), (error) => error.code === 'validation-error')

  assert.equal(assertIdeaId('I-1'), 'I-1')
  assert.throws(() => assertIdeaId('T-1'), (error) => error.code === 'validation-error')
  assert.throws(() => assertIdeaId('I-0'), (error) => error.code === 'validation-error')
})
