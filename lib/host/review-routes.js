// 复盘 HTTP 路由：/tw/api/reviews（复盘板）与 /tw/api/reviews/:kind/:key（提交 / 清空）。
// 只转给 ReviewService；可写窗口、权限、队列、备份、审计都在 service 内完成。
import { TaskError } from '../core/contract.js'
import { ok, readJson, requestIdOf } from './http.js'

const REVIEW_PATH_RE = /^\/api\/reviews\/(daily|weekly|monthly)\/([^/]+)$/

export function createReviewHandler({ service }) {
  return async function handleReview(req, res, rest, method, actor) {
    if (rest === '/api/reviews') {
      if (method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        ok(res, await service.board(url.searchParams.get('date') ?? undefined))
        return
      }
      throw new TaskError('validation-error', `不支持的方法 ${method}`, 405)
    }

    const match = REVIEW_PATH_RE.exec(rest)
    if (!match) throw new TaskError('not-found', `未知接口：${method} ${rest}`, 404)
    const kind = match[1]
    const key = decodeURIComponent(match[2])

    if (method === 'PUT' || method === 'PATCH') {
      const body = await readJson(req)
      ok(res, await service.save(kind, key, body, actor, { requestId: requestIdOf(req, body) }))
      return
    }
    if (method === 'DELETE') {
      let body = {}
      if ((req.headers['content-type'] ?? '').startsWith('application/json')) {
        body = await readJson(req).catch(() => ({}))
      }
      ok(res, await service.clear(kind, key, body, actor, { requestId: requestIdOf(req, body) }))
      return
    }
    throw new TaskError('validation-error', `不支持的方法 ${method}`, 405)
  }
}
