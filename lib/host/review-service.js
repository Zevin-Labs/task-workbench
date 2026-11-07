// ReviewService：复盘的唯一读写网关（UI 走 /tw/api/reviews*，AI 只有只读工具）。
// 写入走 SQLite 同步短事务：可写窗口 → 版本校验 → 数据变更 → write_log 审计 → 版本递增。
// 权限：复盘内容只能由人写；AI 无写工具，service 层对非 user actor 直接拒绝（兜底）。
import { TaskError, todayStr, weekStartOf } from '../core/contract.js'
import { REVIEW_KINDS, REVIEW_TITLES } from '../core/review-contract.js'
import {
  deriveReviewBoard, dueReviewPrompts, isReviewWritable, lastDayOfMonth, periodOfKey, publicReview,
  reviewsInRange, summarizePeriodTasks, weeklyReviewsOfMonth,
} from '../core/review-window.js'
import {
  assertReviewDate, assertReviewKey, assertReviewKind, normalizeReviewWriteInput,
} from '../core/review-validate.js'
import { WriteGateway, normalizeError } from './gateway.js'

const pad2 = (n) => String(n).padStart(2, '0')

function rowToReview(row) {
  return {
    kind: row.kind,
    key: row.period_key,
    text: row.text,
    updatedAt: row.updated_at,
  }
}

function rowToTask(row) {
  return {
    id: `T-${Number(row.id)}`,
    title: row.title,
    date: row.date,
    time: row.time ?? null,
    endDate: row.end_date ?? null,
    endTime: row.end_time ?? null,
    priority: row.priority,
    done: Number(row.done) === 1,
    note: row.note ?? '',
    completed: row.completed ?? null,
    order: Number(row.id),
  }
}

function scopeOf(kind) {
  return `review:${kind}`
}

function reviewKeyBounds(kind, from, to) {
  const lower = from
    ? kind === 'weekly' ? weekStartOf(from) : kind === 'monthly' ? from.slice(0, 7) : from
    : null
  const upper = to ? kind === 'monthly' ? to.slice(0, 7) : to : null
  return { lower, upper }
}

export class ReviewService extends WriteGateway {
  constructor({ db, now = () => new Date(), logger = null }) {
    super({ db, now, logger })
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  /**
   * 周期内任务概况：直接按 SQLite 日期范围查询同一任务真源。
   * completed = 完成日期落在周期内；pending = 结束日期落在周期内且仍未完成。
   * 跨月周/月由日期范围自然覆盖，不需要合并分片，也不会重计。
   */
  tasksInPeriod(db, period) {
    if (!period) return []
    return db.prepare(`
      SELECT * FROM tasks
      WHERE (done = 1 AND completed IS NOT NULL AND completed >= ? AND completed <= ?)
         OR (done = 0 AND COALESCE(end_date, date) >= ? AND COALESCE(end_date, date) <= ?)
      ORDER BY id
    `).all(period.start, period.end, period.start, period.end).map(rowToTask)
  }

  /** 复盘板：只读取当前窗口需要的复盘正文与任务材料。 */
  async board(dateOverride) {
    try {
      const today = todayStr(this.now())
      const date = assertReviewDate(dateOverride) ?? today
      const prompts = dueReviewPrompts(date)
      const initialized = this.db.isInitialized()
      const db = initialized ? this.db.ensureInitialized() : null

      const versions = {}
      for (const kind of REVIEW_KINDS) {
        versions[kind] = db ? this.db.readVersion(scopeOf(kind), db) : 0
      }

      // 只读当前提示对应的几条复盘（不是整张表）。
      const entriesByKind = {}
      for (const kind of REVIEW_KINDS) {
        const keys = prompts.filter((prompt) => prompt.kind === kind).map((prompt) => prompt.key)
        entriesByKind[kind] = db && keys.length > 0
          ? db.prepare(`SELECT * FROM reviews WHERE kind = ? AND period_key IN (${keys.map(() => '?').join(', ')})`)
            .all(kind, ...keys)
            .map(rowToReview)
          : []
      }

      const materialsByKind = {}
      for (const prompt of prompts) {
        if (prompt.kind === 'daily') continue
        const period = periodOfKey(prompt.kind, prompt.key)
        const materials = summarizePeriodTasks(db ? this.tasksInPeriod(db, period) : [], period.start, period.end)
        if (prompt.kind === 'weekly') {
          const dailyRows = db
            ? db.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key >= ? AND period_key <= ? ORDER BY period_key')
              .all('daily', period.start, period.end)
              .map(rowToReview)
            : []
          materials.dailyReviews = reviewsInRange(dailyRows, period.start, period.end)
        } else {
          const monthStart = `${prompt.key}-01`
          const monthEnd = lastDayOfMonth(monthStart)
          const lower = weekStartOf(monthStart)
          const weeklyRows = db && monthEnd && lower
            ? db.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key >= ? AND period_key <= ? ORDER BY period_key')
              .all('weekly', lower, monthEnd)
              .map(rowToReview)
            : []
          materials.weeklyReviews = weeklyReviewsOfMonth(weeklyRows, prompt.key)
        }
        materialsByKind[prompt.kind] = materials
      }

      const board = deriveReviewBoard({ today: date, entriesByKind, materialsByKind })
      board.prompts = board.prompts.map((prompt) => ({
        ...prompt,
        version: versions[prompt.kind] ?? 0,
      }))
      board.versions = versions
      return board
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** AI 只读：列出复盘（正文只给摘要，完整正文用 get）。 */
  async list(query = {}) {
    try {
      const kindFilter = query?.kind ? assertReviewKind(query.kind) : null
      const from = assertReviewDate(query?.from)
      const to = assertReviewDate(query?.to)
      const filters = { kind: kindFilter, from, to }
      if (!this.db.isInitialized()) return { reviews: [], total: 0, filters }

      const db = this.db.ensureInitialized()
      const kinds = kindFilter ? [kindFilter] : REVIEW_KINDS
      const reviews = []
      for (const kind of kinds) {
        const { lower, upper } = reviewKeyBounds(kind, from, to)
        const clauses = ['kind = ?']
        const params = [kind]
        if (lower) {
          clauses.push('period_key >= ?')
          params.push(lower)
        }
        if (upper) {
          clauses.push('period_key <= ?')
          params.push(upper)
        }
        // 返回摘要与 UTF-16 长度即可，不把历史正文整段读入 Host。
        db.function('twb_utf16_length', { deterministic: true }, (text) => String(text ?? '').length)
        const rows = db.prepare(`
          SELECT kind, period_key, substr(text, 1, 120) AS preview_text,
                 twb_utf16_length(text) AS text_length, updated_at
          FROM reviews WHERE ${clauses.join(' AND ')}
        `).all(...params)
        for (const row of rows) {
          const pub = publicReview({
            kind: row.kind,
            key: row.period_key,
            text: row.preview_text,
            updatedAt: row.updated_at,
          })
          const { text, ...rest } = pub
          reviews.push({
            ...rest,
            preview: row.text_length > 120 ? `${text.slice(0, 120)}…` : text,
            textLength: row.text_length,
          })
        }
      }
      reviews.sort((a, b) => b.key.localeCompare(a.key) || REVIEW_KINDS.indexOf(a.kind) - REVIEW_KINDS.indexOf(b.kind))
      return { reviews, total: reviews.length, filters }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** AI 只读 / W2 历史回看：单条复盘完整正文（不受可写窗口限制）。 */
  async get(kind, key) {
    try {
      assertReviewKind(kind)
      assertReviewKey(kind, key)
      if (!this.db.isInitialized()) throw new TaskError('not-found', `${REVIEW_TITLES[kind]} ${key} 不存在`, 404)
      const db = this.db.ensureInitialized()
      const row = db.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get(kind, key)
      if (!row) throw new TaskError('not-found', `${REVIEW_TITLES[kind]} ${key} 不存在`, 404)
      return { review: publicReview(rowToReview(row)), version: this.db.readVersion(scopeOf(kind), db) }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  assertWindow(kind, key, today) {
    if (isReviewWritable(kind, key, today)) return
    throw new TaskError(
      'validation-error',
      `${REVIEW_TITLES[kind]} ${key} 不在可写窗口内（日复盘只能写今天；周复盘只能写上一个自然周；月复盘只能在月末最后一天至次月 3 日写）。历史复盘只读。`,
      400,
      { kind, key, today },
    )
  }

  /** 新建 / 更新一条复盘（同一周期唯一，重复提交 = 更新）。仅人可写。 */
  async save(kind, key, input, actor, { requestId } = {}) {
    assertReviewKind(kind)
    assertReviewKey(kind, key)
    // 权限在幂等缓存之前校验，避免用旧 requestId 回放绕过。
    if (actor?.kind !== 'user') {
      throw new TaskError('permission-denied', '复盘内容只能由人写，AI 不能写入', 403)
    }
    return this.writeOp(requestId, () => {
      try {
        const now = this.now()
        const today = todayStr(now)
        this.assertWindow(kind, key, today)
        const { text } = normalizeReviewWriteInput(input ?? {})
        const updatedAt = `${today} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`

        return this.db.transaction((db) => {
          this.db.checkVersion(db, scopeOf(kind), input?.baseVersion)
          const existingRow = db.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get(kind, key)
          db.prepare(`
            INSERT INTO reviews (kind, period_key, text, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, period_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
          `).run(kind, key, text, updatedAt)
          const row = db.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get(kind, key)
          const review = rowToReview(row)
          this.db.audit(db, {
            actor,
            op: existingRow ? 'review-update' : 'review-create',
            domain: 'review',
            target: `${kind}:${key}`,
            detail: {
              before: existingRow ? { updatedAt: existingRow.updated_at, textLength: existingRow.text.length } : null,
              after: { updatedAt: review.updatedAt, textLength: text.length },
            },
          })
          const version = this.db.bumpVersion(db, scopeOf(kind))
          return { review: publicReview(review), version, created: !existingRow }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  /** 清空一条复盘（硬删除；写前一致性备份）。仅人可写，且只在可写窗口内。 */
  async clear(kind, key, input, actor, { requestId } = {}) {
    assertReviewKind(kind)
    assertReviewKey(kind, key)
    // 权限在幂等缓存之前校验，避免用旧 requestId 回放绕过。
    if (actor?.kind !== 'user') {
      throw new TaskError('permission-denied', '复盘内容只能由人写，AI 不能删除', 403)
    }
    return this.writeOp(requestId, () => {
      try {
        const today = todayStr(this.now())
        this.assertWindow(kind, key, today)

        const db = this.db.ensureInitialized()
        const row = db.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get(kind, key)
        if (!row) throw new TaskError('not-found', `${REVIEW_TITLES[kind]} ${key} 不存在`, 404)
        this.db.checkVersion(db, scopeOf(kind), input?.baseVersion)

        const backupPath = this.db.backup({
          reason: 'reviews',
          verify: (backupDb) => Boolean(
            backupDb.prepare('SELECT 1 AS present FROM reviews WHERE kind = ? AND period_key = ?').get(kind, key),
          ),
        })

        return this.db.transaction((tx) => {
          this.db.checkVersion(tx, scopeOf(kind), input?.baseVersion)
          const current = tx.prepare('SELECT * FROM reviews WHERE kind = ? AND period_key = ?').get(kind, key)
          if (!current) throw new TaskError('not-found', `${REVIEW_TITLES[kind]} ${key} 不存在`, 404)
          tx.prepare('DELETE FROM reviews WHERE kind = ? AND period_key = ?').run(kind, key)
          this.db.audit(tx, {
            actor,
            op: 'review-delete',
            domain: 'review',
            target: `${kind}:${key}`,
            detail: { before: { updatedAt: current.updated_at, textLength: current.text.length }, backupPath },
          })
          const version = this.db.bumpVersion(tx, scopeOf(kind))
          return { deleted: { kind, key, updatedAt: current.updated_at }, version, backupPath }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }
}
