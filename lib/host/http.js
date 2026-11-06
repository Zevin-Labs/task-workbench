// HTTP 公共 helper：JSON 响应、错误信封、请求体解析、同源/本机校验。
// 任务域与想法域的路由共用；所有读写仍转给各自的 service。
import { TaskError, errorPayload, statusForCode } from '../core/contract.js'

export const MAX_BODY = 64 * 1024

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function ok(res, data) {
  sendJson(res, 200, { ok: true, data })
}

export function fail(res, error) {
  let normalized = error
  if (!(error instanceof TaskError)) {
    const code = typeof error?.code === 'string' ? error.code : 'internal-error'
    normalized = new TaskError(code, error instanceof Error ? error.message : String(error), statusForCode(code))
  }
  sendJson(res, normalized.status ?? statusForCode(normalized.code), { ok: false, error: errorPayload(normalized) })
}

/** 同源校验：浏览器请求必须 Origin 与 Host 一致；无 Origin 的本地调用放行。 */
export function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (origin === 'null') return false
  try {
    const parsed = new URL(origin)
    return parsed.host === req.headers.host
  } catch {
    return false
  }
}

/** 只接受本机回环连接（插件路由不走 DSH admission，自己兜底）。 */
export function isLoopback(req) {
  const address = req.socket?.remoteAddress
  if (!address) return true
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      reject(new TaskError('validation-error', '请求体必须是 application/json', 415))
      return
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new TaskError('validation-error', '请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new TaskError('validation-error', '请求体不是合法 JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

export function requestIdOf(req, body) {
  const header = req.headers['x-request-id']
  if (typeof header === 'string' && header !== '') return header
  return typeof body?.requestId === 'string' && body.requestId !== '' ? body.requestId : undefined
}
