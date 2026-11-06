// 任务工作台 · Host 半边
// - /ptw/* HTTP API：工作台 UI 的唯一入口（任务域 + 想法域 + 复盘域）
// - ptw_* / ptw_idea_* / ptw_review_* AI 工具：分别与 TaskService / IdeaService / ReviewService 共用同一写网关
//   复盘没有 AI 写工具（只能由人写），只有 ptw_review_* 只读工具。
// 数据用 node:fs 直接读写（Host 进程内，不走工具沙箱）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSettings, pluginStateDir, saveSettings } from './host/settings.js'
import { TaskStore } from './host/store.js'
import { TaskService } from './host/service.js'
import { IdeaStore } from './host/idea-store.js'
import { IdeaService } from './host/idea-service.js'
import { ReviewStore } from './host/review-store.js'
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
  const store = new TaskStore({
    settings,
    persistSettings: saveSettings,
    logger: ctx.logger,
  })
  const service = new TaskService({
    store,
    stateDir: pluginStateDir(),
    logger: ctx.logger,
  })
  const ideaStore = new IdeaStore({
    settings,
    persistSettings: saveSettings,
    logger: ctx.logger,
    isDataRootReady: () => store.isInitialized(),
  })
  const ideaService = new IdeaService({
    store: ideaStore,
    stateDir: pluginStateDir(),
    logger: ctx.logger,
  })
  const reviewStore = new ReviewStore({
    settings,
    persistSettings: saveSettings,
    logger: ctx.logger,
    isDataRootReady: () => store.isInitialized(),
  })
  const reviewService = new ReviewService({
    store: reviewStore,
    taskStore: store,
    stateDir: pluginStateDir(),
    logger: ctx.logger,
  })
  const version = readVersion(pluginRoot)

  ctx.effect(
    () => registerRoutes(ctx, { service, ideaService, reviewService, version }),
    'task-workbench: /ptw routes',
  )
  for (const tool of createTools(service)) ctx.tools.register(tool)
  for (const tool of createIdeaTools(ideaService)) ctx.tools.register(tool)
  for (const tool of createReviewTools(reviewService)) ctx.tools.register(tool)

  // 统一技能：让 AI 知道该用 ptw_* 工具，而不是直接编辑 Markdown。
  ctx.inject(['skills'], (skillsCtx) => {
    skillsCtx.effect(() => skillsCtx.skills.registerProvider(() => createSkillProvider(pluginRoot)))
  })

  ctx.logger?.info?.(`[task-workbench] v${version} 已加载；数据根 ${settings.dataRoot}`)
}
