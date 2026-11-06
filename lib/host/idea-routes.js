// 想法池 HTTP 路由：/tw/api/ideas 与 /tw/api/ideas/:id。
// 只转给 IdeaService；权限、队列、备份、审计都在 service 内完成。
import { TaskError } from '../core/contract.js'
import { ok, readJson, requestIdOf } from './http.js'

const IDEA_PATH_RE = /^\/api\/ideas\/(I-\d{8}-\d{2})$/

export function createIdeaHandler({ service }) {
  return async function handleIdea(req, res, rest, method, actor) {
    if (rest === '/api/ideas') {
      if (method === 'GET') {
        ok(res, await service.list())
        return
      }
      if (method === 'POST') {
        const body = await readJson(req)
        ok(res, await service.create(body, actor, { requestId: requestIdOf(req, body) }))
        return
      }
      throw new TaskError('validation-error', `不支持的方法 ${method}`, 405)
    }

    const match = IDEA_PATH_RE.exec(rest)
    if (!match) throw new TaskError('not-found', `未知接口：${method} ${rest}`, 404)
    const ideaId = match[1]

    if (method === 'GET') {
      ok(res, await service.get(ideaId))
      return
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req)
      ok(res, await service.update(ideaId, body, actor, { requestId: requestIdOf(req, body) }))
      return
    }
    if (method === 'DELETE') {
      let body = {}
      if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
        body = await readJson(req).catch(() => ({}))
      }
      ok(res, await service.remove(ideaId, body, actor, { requestId: requestIdOf(req, body) }))
      return
    }
    throw new TaskError('validation-error', `不支持的方法 ${method}`, 405)
  }
}
