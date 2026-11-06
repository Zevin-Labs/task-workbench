// HTTP 路由：UI 唯一入口（同源、仅本机）。所有读写都转给各自 service，不绕过权限/队列/备份。
// 任务域：/tw/api/tasks*；想法域：/tw/api/ideas*。
import { TaskError } from '../core/contract.js'
import { fail, isLoopback, ok, readJson, requestIdOf, sameOrigin } from './http.js'
import { userActor } from './service.js'
import { createIdeaHandler } from './idea-routes.js'
import { createReviewHandler } from './review-routes.js'

const PREFIX = '/tw'

export function createRoutes({ service, ideaService = null, reviewService = null, version = '0.0.0' }) {
  const handleIdeas = ideaService ? createIdeaHandler({ service: ideaService }) : null
  const handleReviews = reviewService ? createReviewHandler({ service: reviewService }) : null

  return async function handler(req, res) {
    if (!isLoopback(req)) {
      fail(res, new TaskError('forbidden-path', '仅接受本机请求', 403))
      return
    }
    if (!sameOrigin(req)) {
      fail(res, new TaskError('forbidden-path', '仅接受同源请求', 403))
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const rest = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname
    const method = req.method ?? 'GET'
    const actor = userActor()

    try {
      if (rest === '/api/health' && method === 'GET') {
        ok(res, { name: 'dsh-task-workbench', version, time: new Date().toISOString() })
        return
      }
      if (rest === '/api/bootstrap' && method === 'GET') {
        const data = await service.bootstrap()
        if (ideaService) data.ideas = await ideaService.bootstrap()
        ok(res, data)
        return
      }
      if (rest === '/api/ideas' || rest.startsWith('/api/ideas/')) {
        if (!handleIdeas) {
          fail(res, new TaskError('not-found', '想法池未启用', 404))
          return
        }
        await handleIdeas(req, res, rest, method, actor)
        return
      }
      if (rest === '/api/reviews' || rest.startsWith('/api/reviews/')) {
        if (!handleReviews) {
          fail(res, new TaskError('not-found', '复盘未启用', 404))
          return
        }
        await handleReviews(req, res, rest, method, actor)
        return
      }
      if (rest === '/api/today' && method === 'GET') {
        ok(res, await service.today())
        return
      }
      if (rest === '/api/week' && method === 'GET') {
        ok(res, await service.week(url.searchParams.get('anchor') ?? undefined))
        return
      }
      if (rest === '/api/tasks' && method === 'GET') {
        ok(res, await service.list({ includeCompleted: url.searchParams.get('includeCompleted') === 'true' || url.searchParams.get('includeCompleted') === '1' }))
        return
      }
      if (rest === '/api/tasks' && method === 'POST') {
        const body = await readJson(req)
        ok(res, await service.create(body, actor, { requestId: requestIdOf(req, body) }))
        return
      }
      const match = /^\/api\/tasks\/(T-\d{8}-\d{2})(\/complete)?$/.exec(rest)
      if (match) {
        const taskId = match[1]
        if (match[2] === '/complete') {
          if (method !== 'POST') {
            fail(res, new TaskError('validation-error', '完成操作只支持 POST', 405))
            return
          }
          const body = await readJson(req)
          ok(res, await service.complete(taskId, body.done === true, body, actor, { requestId: requestIdOf(req, body) }))
          return
        }
        if (method === 'GET') {
          ok(res, await service.getTask(taskId))
          return
        }
        if (method === 'PATCH' || method === 'PUT') {
          const body = await readJson(req)
          ok(res, await service.update(taskId, body, actor, { requestId: requestIdOf(req, body) }))
          return
        }
        if (method === 'DELETE') {
          let body = {}
          if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
            body = await readJson(req).catch(() => ({}))
          }
          ok(res, await service.remove(taskId, body, actor, { requestId: requestIdOf(req, body) }))
          return
        }
        fail(res, new TaskError('validation-error', `不支持的方法 ${method}`, 405))
        return
      }
      if (rest === '/api/init' && method === 'POST') {
        await readJson(req).catch(() => ({}))
        ok(res, await service.init(actor))
        return
      }
      if (rest === '/api/reload' && method === 'POST') {
        await readJson(req).catch(() => ({}))
        const data = await service.reload()
        if (ideaService) data.ideas = await ideaService.reload()
        ok(res, data)
        return
      }
      if (rest === '/api/settings' && method === 'GET') {
        ok(res, await service.settingsInfo())
        return
      }
      fail(res, new TaskError('not-found', `未知接口：${method} ${rest}`, 404))
    } catch (error) {
      fail(res, error)
    }
  }
}

export function registerRoutes(ctx, { service, ideaService = null, reviewService = null, version }) {
  const handler = createRoutes({ service, ideaService, reviewService, version })
  return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
}
