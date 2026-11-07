// 任务工作台 · Host 半边
// - /tw/* HTTP API：工作台 UI 的唯一入口（任务域 + 想法域 + 复盘域）
// - tw_* / tw_idea_* / tw_review_* AI 工具：分别与 TaskService / IdeaService / ReviewService 共用同一写网关
//   复盘没有 AI 写工具（只能由人写），只有 tw_review_* 只读工具。
// 数据真源：<dataRoot>/workbench.sqlite（node:sqlite，单连接，短事务）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSettings } from './host/settings.js'
import { WorkbenchDatabase } from './host/db.js'
import { TaskService } from './host/service.js'
import { IdeaService } from './host/idea-service.js'
import { ReviewService } from './host/review-service.js'
import { registerRoutes } from './host/routes.js'
import { createTools } from './host/tools.js'
import { createIdeaTools } from './host/idea-tools.js'
import { createReviewTools } from './host/review-tools.js'
import { createSkillProvider } from './host/skills.js'

export const name = 'task-workbench'
export const inject = ['tools', 'webServer']

function readVersion(pluginRoot) {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function apply(ctx) {
  const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
  const settings = loadSettings()
  const now = () => new Date()
  const db = new WorkbenchDatabase({ settings, now, logger: ctx.logger })

  const service = new TaskService({ db, now, logger: ctx.logger })
  const ideaService = new IdeaService({ db, now, logger: ctx.logger })
  const reviewService = new ReviewService({ db, now, logger: ctx.logger })
  const version = readVersion(pluginRoot)

  // 组件关闭 / App 重启时释放共享连接；下次 apply 会重新打开。
  ctx.effect(() => () => db.close(), 'task-workbench: sqlite')

  ctx.effect(
    () => registerRoutes(ctx, { service, ideaService, reviewService, version }),
    'task-workbench: /tw routes',
  )
  for (const tool of createTools(service)) ctx.tools.register(tool)
  for (const tool of createIdeaTools(ideaService)) ctx.tools.register(tool)
  for (const tool of createReviewTools(reviewService)) ctx.tools.register(tool)

  // 统一技能：让 AI 知道该用 tw_* 工具，而不是直接改存储。
  ctx.inject(['skills'], (skillsCtx) => {
    skillsCtx.effect(() => skillsCtx.skills.registerProvider(() => createSkillProvider(pluginRoot)))
  })

  ctx.logger?.info?.(`[task-workbench] v${version} 已加载；数据库 ${db.file}`)
}
