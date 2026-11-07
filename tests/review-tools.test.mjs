import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchDatabase } from '../lib/host/db.js'
import { ReviewService } from '../lib/host/review-service.js'
import { createReviewTools } from '../lib/host/review-tools.js'
import { userActor } from '../lib/host/service.js'

async function makeService() {
  const root = await mkdtemp(join(tmpdir(), 'twb-review-tool-'))
  const now = () => new Date('2026-11-05T10:00:00')
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7 }
  const db = new WorkbenchDatabase({ settings, now })
  db.init()
  const service = new ReviewService({ db, now })
  await service.save('daily', '2026-11-05', {
    text: '今天把复盘功能的数据层写完了。\n明天接 UI。',
  }, userActor())
  return {
    root,
    service,
    async cleanup() {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('review-tools: 只有只读工具（list / get），没有写工具', async (t) => {
  const env = await makeService()
  t.after(env.cleanup)
  const tools = createReviewTools(env.service)
  assert.deepEqual(tools.map((tool) => tool.name), ['tw_review_list', 'tw_review_get'])
  for (const name of ['tw_review_create', 'tw_review_update', 'tw_review_delete', 'tw_review_save']) {
    assert.equal(tools.some((tool) => tool.name === name), false, `${name} 不应存在`)
  }
  for (const tool of tools) {
    assert.match(tool.description, /只读/)
  }
  const listProps = Object.keys(tools[0].parameters.properties)
  assert.deepEqual(listProps, ['kind', 'from', 'to'])
  assert.deepEqual(tools[1].parameters.required, ['kind', 'key'])
})

test('review-tools: AI 能读复盘列表与完整正文', async (t) => {
  const env = await makeService()
  t.after(env.cleanup)
  const [listTool, getTool] = createReviewTools(env.service)

  const listed = await listTool.execute({ kind: 'daily' })
  assert.equal(listed.ok, true)
  assert.match(listed.message, /复盘共 1 条/)
  assert.match(listed.message, /2026-11-05/)
  assert.equal(listed.data.reviews.length, 1)
  assert.equal(listed.data.reviews[0].preview, '今天把复盘功能的数据层写完了。\n明天接 UI。')
  assert.equal(listed.data.reviews[0].text, undefined)

  const got = await getTool.execute({ kind: 'daily', key: '2026-11-05' })
  assert.equal(got.ok, true)
  assert.match(got.message, /今天把复盘功能的数据层写完了。\n明天接 UI。/)
  assert.equal(got.data.review.kind, 'daily')

  // AI 侧没有写入入口：service 层对 agent actor 兜底拒绝
  await assert.rejects(
    env.service.save('daily', '2026-11-05', { text: 'AI 想写' }, { kind: 'agent', id: 'agent:test' }),
    (error) => error.code === 'permission-denied',
  )
})

test('review-tools: 键格式错误返回结构化错误；已有记录是更新', async (t) => {
  const env = await makeService()
  t.after(env.cleanup)
  const [, getTool] = createReviewTools(env.service)
  await assert.rejects(getTool.execute({ kind: 'weekly', key: '2026-11-05' }), (error) => error.code === 'validation-error')
  const updated = await env.service.save('daily', '2026-11-05', { text: '人写的' }, userActor())
  assert.equal(updated.created, false, '已有记录时是更新')
})
