// 写入网关公共部分：串行队列、requestId 幂等、审计日志。
// TaskService 与 IdeaService 共用；两者仍是各自域的「唯一写网关」。
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskError, statusForCode } from '../core/contract.js'

const AUDIT_MAX_BYTES = 5 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 5000
const QUEUE_LIMIT = 50
const IDEMPOTENT_TTL_MS = 3_600_000
const IDEMPOTENT_MAX = 500

/** 把未知异常转成带错误码的 TaskError（避免把内部堆栈暴露给 UI/模型）。 */
export function normalizeError(error) {
  if (error instanceof TaskError) return error
  const code = typeof error?.code === 'string' ? error.code : 'internal-error'
  const message = error instanceof Error ? error.message : String(error)
  return new TaskError(code, message, statusForCode(code))
}

export class WriteGateway {
  constructor({ stateDir, now = () => new Date(), logger = null }) {
    this.stateDir = stateDir
    this.now = now
    this.logger = logger
    this.queue = Promise.resolve()
    this.queueDepth = 0
    this.idempotent = new Map()
  }

  // ── 队列 ────────────────────────────────────────────────────────────────
  enqueue(fn) {
    if (this.queueDepth >= QUEUE_LIMIT) {
      return Promise.reject(new TaskError('queue-busy', '写入队列已满，请稍后重试', 429))
    }
    this.queueDepth += 1
    const run = this.queue.then(() => this.withTimeout(fn).catch((error) => { throw normalizeError(error) }))
    this.queue = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.queueDepth -= 1 })
  }

  withTimeout(fn) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TaskError('timeout', '操作超时（5 秒），请重试', 504)), REQUEST_TIMEOUT_MS)
    })
    return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => clearTimeout(timer))
  }

  async writeOp(requestId, fn) {
    if (typeof requestId === 'string' && requestId !== '') {
      const hit = this.idempotent.get(requestId)
      if (hit && Date.now() - hit.at < IDEMPOTENT_TTL_MS) return hit.result
    }
    const result = await fn()
    if (typeof requestId === 'string' && requestId !== '') {
      this.idempotent.set(requestId, { at: Date.now(), result })
      if (this.idempotent.size > IDEMPOTENT_MAX) {
        const cutoff = Date.now() - IDEMPOTENT_TTL_MS
        for (const [key, value] of this.idempotent) {
          if (value.at < cutoff || this.idempotent.size > IDEMPOTENT_MAX) this.idempotent.delete(key)
        }
      }
    }
    return result
  }

  // ── 审计 ────────────────────────────────────────────────────────────────
  async audit(entry) {
    try {
      await mkdir(this.stateDir, { recursive: true })
      const file = join(this.stateDir, 'writes.log')
      try {
        const info = await stat(file)
        if (info.size > AUDIT_MAX_BYTES) await rename(file, `${file}.1`)
      } catch { /* 首次写入 */ }
      const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`
      await appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.logger?.warn?.(`[task-workbench] 审计写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
