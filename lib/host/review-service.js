// ReviewService：复盘的唯一读写网关（UI 走 /tw/api/reviews*，AI 只有只读工具）。
// 写入统一走 串行队列 → 校验 → 可写窗口 → baseHash → 备份 → 原子写 → 回读 → 审计。
// 权限：复盘内容只能由人写；AI 无写工具，service 层对非 user actor 直接拒绝（兜底）。
import { TaskError, monthOf, todayStr } from '../core/contract.js'
import { REVIEW_KINDS, REVIEW_TITLES } from '../core/review-contract.js'
import {
  appendReviewBlock, findReview, parseReviewFile, removeReviewBlock, replaceReviewBlock,
} from '../core/review-grammar.js'
import {
  deriveReviewBoard, dueReviewPrompts, isReviewWritable, periodOfKey, publicReview,
  reviewsInRange, summarizePeriodTasks, weeklyReviewsOfMonth,
} from '../core/review-window.js'
import {
  assertReviewDate, assertReviewKey, assertReviewKind, normalizeReviewWriteInput,
} from '../core/review-validate.js'
import { WriteGateway, normalizeError } from './gateway.js'

const pad2 = (n) => String(n).padStart(2, '0')

function emptyKindRead() {
  return {
    hash: null,
    model: null,
    entries: [],
    exists: false,
    readOnly: false,
    readOnlyReason: null,
    errors: [],
    warnings: [],
  }
}

export class ReviewService extends WriteGateway {
  constructor({ store, taskStore, stateDir, now = () => new Date(), logger = null }) {
    super({ stateDir, now, logger })
    this.store = store
    this.taskStore = taskStore
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  /** 读一类复盘；文件不存在按空记录处理，文件损坏返回只读标记（不抛，避免影响复盘板其他类型）。 */
  async readKind(kind) {
    try {
      const shard = await this.store.read(kind)
      return {
        hash: shard.hash,
        model: shard.model,
        entries: shard.model.reviews,
        exists: true,
        readOnly: shard.model.readOnly,
        readOnlyReason: shard.model.readOnlyReason,
        errors: shard.model.errors,
        warnings: shard.model.warnings,
      }
    } catch (error) {
      if (error instanceof TaskError && error.code === 'file-missing') return emptyKindRead()
      throw normalizeError(error)
    }
  }

  /**
   * 周期内任务概况：按周期起止所在月份读取任务分片（跨月周/月最多合并 2 个分片）。
   * 历史分片只读；某个月分片无法解析时保留已读到的那部分并在 warnings 里如实说明，不静默降级。
   */
  async tasksInPeriod(period) {
    const warnings = []
    if (!period) return { tasks: [], warnings }
    const months = new Set()
    for (const date of [period.start, period.end]) {
      const month = monthOf(date)
      if (month) months.add(month)
    }
    const tasks = []
    for (const month of [...months].sort()) {
      if (typeof this.taskStore?.readMonth !== 'function') continue
      const shard = await this.taskStore.readMonth(month)
      if (!shard) continue
      if (shard.model.readOnly) {
        warnings.push(`${month} 任务分片无法解析，材料可能不完整`)
        continue
      }
      tasks.push(...shard.model.tasks)
    }
    return { tasks, warnings }
  }

  /** 复盘板：今天的提示 + 已写状态 + 材料 + 各文件 hash / 只读信息。 */
  board(dateOverride) {
    return this.enqueue(async () => {
      const today = todayStr(this.now())
      const date = assertReviewDate(dateOverride) ?? today
      const prompts = dueReviewPrompts(date)
      const reads = {}
      for (const kind of REVIEW_KINDS) reads[kind] = await this.readKind(kind)

      const materialsByKind = {}
      for (const prompt of prompts) {
        if (prompt.kind === 'daily') continue
        const period = periodOfKey(prompt.kind, prompt.key)
        const summary = await this.tasksInPeriod(period)
        const tasks = summarizePeriodTasks(summary.tasks, period.start, period.end)
        const materials = { ...tasks, warnings: summary.warnings }
        if (prompt.kind === 'weekly') {
          materials.dailyReviews = reviewsInRange(reads.daily.entries ?? [], period.start, period.end)
        } else {
          materials.weeklyReviews = weeklyReviewsOfMonth(reads.weekly.entries ?? [], prompt.key)
        }
        materialsByKind[prompt.kind] = materials
      }

      const entriesByKind = {}
      for (const kind of REVIEW_KINDS) entriesByKind[kind] = reads[kind].entries ?? []

      const board = deriveReviewBoard({ today: date, entriesByKind, materialsByKind })
      board.prompts = board.prompts.map((prompt) => {
        const read = reads[prompt.kind]
        return {
          ...prompt,
          hash: read.hash,
          fileExists: read.exists,
          readOnly: read.readOnly,
          readOnlyReason: read.readOnlyReason,
          errors: read.errors,
          warnings: read.warnings,
        }
      })
      return board
    })
  }

  /** AI 只读：列出复盘（正文只给摘要，完整正文用 get）。 */
  list(query = {}) {
    return this.enqueue(async () => {
      const kindFilter = query?.kind ? assertReviewKind(query.kind) : null
      const from = assertReviewDate(query?.from)
      const to = assertReviewDate(query?.to)
      const kinds = kindFilter ? [kindFilter] : REVIEW_KINDS
      const reviews = []
      for (const kind of kinds) {
        const read = await this.readKind(kind)
        if (read.readOnly) {
          throw new TaskError('read-only', `${REVIEW_TITLES[kind]}文件只读：${read.errors[0]?.message ?? '格式不受支持'}`, 409, { errors: read.errors })
        }
        for (const entry of read.entries) {
          const pub = publicReview(entry)
          if (from && (pub.periodEnd ?? '') < from) continue
          if (to && (pub.periodStart ?? '') > to) continue
          const { text, ...rest } = pub
          reviews.push({
            ...rest,
            preview: text.length > 120 ? `${text.slice(0, 120)}…` : text,
            textLength: text.length,
          })
        }
      }
      reviews.sort((a, b) => b.key.localeCompare(a.key) || REVIEW_KINDS.indexOf(a.kind) - REVIEW_KINDS.indexOf(b.kind))
      return { reviews, total: reviews.length, filters: { kind: kindFilter, from, to } }
    })
  }

  /** AI 只读：单条复盘完整正文。 */
  get(kind, key) {
    return this.enqueue(async () => {
      assertReviewKind(kind)
      assertReviewKey(kind, key)
      const read = await this.readKind(kind)
      if (read.readOnly) {
        throw new TaskError('read-only', `${REVIEW_TITLES[kind]}文件只读：${read.errors[0]?.message ?? '格式不受支持'}`, 409, { errors: read.errors })
      }
      const entry = read.entries.find((item) => item.key === key)
      if (!entry) throw new TaskError('not-found', `${REVIEW_TITLES[kind]} ${key} 不存在`, 404)
      return { review: publicReview(entry), hash: read.hash }
    })
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  ensureWritable(shard) {
    if (shard.model.readOnly) {
      throw new TaskError('read-only', `${REVIEW_TITLES[shard.kind]}文件只读：${shard.model.errors[0]?.message ?? '格式不受支持'}`, 409, {
        errors: shard.model.errors,
      })
    }
  }

  checkHash(shard, baseHash) {
    if (typeof baseHash === 'string' && baseHash !== '' && baseHash !== shard.hash) {
      throw new TaskError('external-change', `${REVIEW_TITLES[shard.kind]}文件已被外部修改，已阻止覆盖；请重新加载后再操作`, 409, {
        currentHash: shard.hash,
      })
    }
  }

  assertWindow(kind, key, today) {
    if (isReviewWritable(kind, key, today)) return
    throw new TaskError(
      'validation-error',
      `${REVIEW_TITLES[kind]} ${key} 不在可写窗口内（日复盘只能写今天；周复盘只能写上一个自然周；月复盘只能在月末最后一天至次月 3 日写）。历史复盘只读，修改请直接编辑 Markdown 文件`,
      400,
      { kind, key, today },
    )
  }

  async commit(kind, shard, newText, { actor, op, reviewKey, before = null, after = null }) {
    let parsed
    try {
      parsed = parseReviewFile(newText, { kind, file: shard.file })
    } catch (error) {
      throw new TaskError('write-failed', `写入内容无法解析：${error instanceof Error ? error.message : String(error)}`, 500)
    }
    if (parsed.readOnly) {
      throw new TaskError('write-failed', `写入内容解析失败：${parsed.errors[0]?.message ?? '未知结构错误'}`, 500)
    }
    const keys = parsed.reviews.map((review) => review.key)
    if (new Set(keys).size !== keys.length) {
      throw new TaskError('validation-error', '写入会产生重复复盘周期，已中止', 400)
    }
    try {
      const { backupPath, hash } = await this.store.backupAndWrite(kind, newText, shard.text)
      await this.audit({
        ok: true,
        actor: actor.id,
        actorKind: actor.kind,
        op,
        reviewKind: kind,
        reviewKey,
        before,
        after,
        oldHash: shard.hash,
        newHash: hash,
        backupPath,
      })
      return { hash, backupPath, model: parsed }
    } catch (error) {
      const normalized = normalizeError(error)
      await this.audit({
        ok: false,
        actor: actor.id,
        actorKind: actor.kind,
        op,
        reviewKind: kind,
        reviewKey,
        oldHash: shard.hash,
        error: { code: normalized.code, message: normalized.message },
      })
      throw normalized
    }
  }

  /** 新建 / 更新一条复盘（同一周期唯一，重复提交 = 更新）。仅人可写。 */
  save(kind, key, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertReviewKind(kind)
      assertReviewKey(kind, key)
      if (actor?.kind !== 'user') {
        throw new TaskError('permission-denied', '复盘内容只能由人写，AI 不能写入', 403)
      }
      const now = this.now()
      const today = todayStr(now)
      this.assertWindow(kind, key, today)
      const { text } = normalizeReviewWriteInput(input ?? {})

      await this.store.ensureFile(kind)
      const shard = await this.store.read(kind)
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)

      const existing = findReview(shard.model, key)
      const updatedAt = `${today} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`
      const review = { key, text, updatedAt, unknown: existing?.unknown ?? [] }
      const newText = existing
        ? replaceReviewBlock(shard.text, kind, key, review, today)
        : appendReviewBlock(shard.text, kind, review, today)
      const { hash, backupPath, model } = await this.commit(kind, shard, newText, {
        actor,
        op: existing ? 'review-update' : 'review-create',
        reviewKey: key,
        before: existing ? publicReview(existing) : null,
        after: publicReview({ ...review, kind }),
      })
      const saved = findReview(model, key)
      return {
        review: publicReview(saved ?? { ...review, kind }),
        hash,
        backupPath,
        created: !existing,
      }
    }))
  }

  /** 清空一条复盘（硬删除；写前备份）。仅人可写，且只在可写窗口内。 */
  clear(kind, key, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertReviewKind(kind)
      assertReviewKey(kind, key)
      if (actor?.kind !== 'user') {
        throw new TaskError('permission-denied', '复盘内容只能由人写，AI 不能删除', 403)
      }
      const today = todayStr(this.now())
      this.assertWindow(kind, key, today)

      const shard = await this.store.read(kind)
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)
      const existing = findReview(shard.model, key)
      if (!existing) throw new TaskError('not-found', `${REVIEW_TITLES[kind]} ${key} 不存在`, 404)

      const newText = removeReviewBlock(shard.text, kind, key, today)
      const { hash, backupPath } = await this.commit(kind, shard, newText, {
        actor,
        op: 'review-delete',
        reviewKey: key,
        before: publicReview(existing),
        after: null,
      })
      return { deleted: { kind, key, updatedAt: existing.updatedAt }, hash, backupPath }
    }))
  }
}
