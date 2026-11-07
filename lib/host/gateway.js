// 写入网关公共部分：requestId 幂等与异常规整。
// 数据一致性由 WorkbenchDatabase 的同步短事务负责；这里不再有异步队列/超时。
import { TaskError } from '../core/contract.js'

const IDEMPOTENT_TTL_MS = 3_600_000
const IDEMPOTENT_MAX = 500

/** 把未知异常转成带错误码的 TaskError（避免把内部堆栈暴露给 UI/模型）。 */
export function normalizeError(error) {
  if (error instanceof TaskError) return error
  return new TaskError('internal-error', error instanceof Error ? error.message : String(error), 500)
}

export class WriteGateway {
  constructor({ db, now = () => new Date(), logger = null }) {
    this.db = db
    this.now = now
    this.logger = logger
    this.idempotent = new Map()
  }

  cached(requestId) {
    if (typeof requestId !== 'string' || requestId === '') return undefined
    const entry = this.idempotent.get(requestId)
    if (!entry) return undefined
    if (Date.now() - entry.at > IDEMPOTENT_TTL_MS) {
      this.idempotent.delete(requestId)
      return undefined
    }
    return entry
  }

  remember(requestId, result) {
    if (typeof requestId !== 'string' || requestId === '') return
    this.idempotent.set(requestId, { at: Date.now(), result })
    if (this.idempotent.size > IDEMPOTENT_MAX) {
      const cutoff = Date.now() - IDEMPOTENT_TTL_MS
      for (const [key, entry] of this.idempotent) {
        if (entry.at < cutoff || this.idempotent.size > IDEMPOTENT_MAX) this.idempotent.delete(key)
      }
    }
  }

  /** 同一 requestId 只执行一次；命中缓存直接返回上次结果。 */
  writeOp(requestId, fn) {
    const hit = this.cached(requestId)
    if (hit) return hit.result
    const result = fn()
    this.remember(requestId, result)
    return result
  }
}
