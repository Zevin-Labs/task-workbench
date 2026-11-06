// TaskService：UI（HTTP）与 AI（工具）的唯一读写网关。
// 写入统一走 串行队列 → 校验 → baseHash → 备份 → 原子写 → 回读 → 审计。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_PRIORITY, PRIORITIES, TaskError, asTaskError, errorPayload,
  todayStr, weekStartOf, isPriority,
} from '../core/contract.js'
import { appendTaskLine, findTask, normalizeTask, parseShard, removeTaskLine, replaceTaskLine } from '../core/grammar.js'
import { deriveCounts, deriveList, deriveToday, deriveWeek, publicTask } from '../core/derive.js'
import { normalizeCreateInput, normalizeUpdateChanges, assertTaskId, assertTaskTiming } from '../core/validate.js'
import { WriteGateway, normalizeError } from './gateway.js'

const RECENT_WINDOW_MS = 60_000

export function userActor() {
  return { kind: 'user', id: 'user' }
}

/** 工具侧 actor：从工具执行上下文取 session/agent 身份，不接受请求体自称。 */
export function toolActor(exec) {
  const sessionId = exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? exec?.sessionId ?? null
  return { kind: 'agent', id: sessionId ? `agent:${sessionId}` : 'agent' }
}

function generateTaskId(model, today, reserved = 0) {
  const compact = today.replaceAll('-', '')
  const prefix = `T-${compact}-`
  let max = Number.isInteger(reserved) && reserved > 0 ? reserved : 0
  for (const task of model.tasks) {
    if (!task.id.startsWith(prefix)) continue
    const n = Number(task.id.slice(prefix.length))
    if (Number.isInteger(n)) max = Math.max(max, n)
  }
  const next = max + 1
  if (next > 99) {
    throw new TaskError('id-exhausted', '今天创建的任务已经超过 99 条，请改用其他日期或调整数据格式', 409)
  }
  return `${prefix}${String(next).padStart(2, '0')}`
}

export class TaskService extends WriteGateway {
  constructor({ store, stateDir, now = () => new Date(), logger = null }) {
    super({ stateDir, now, logger })
    this.store = store
    this.recentCreates = []
    this.idStateFile = join(stateDir, 'ids.json')
    this.idState = null
  }

  // ── ID 分配状态：删除后也不复用（当月内） ─────────────────────────────
  async loadIdState() {
    if (this.idState !== null) return this.idState
    try {
      const parsed = JSON.parse(await readFile(this.idStateFile, 'utf8'))
      this.idState = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      this.idState = {}
    }
    return this.idState
  }

  async saveIdState() {
    if (this.idState === null) return
    try {
      await mkdir(this.stateDir, { recursive: true })
      const tmp = `${this.idStateFile}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, `${JSON.stringify(this.idState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.idStateFile)
    } catch (error) {
      this.logger?.warn?.(`[task-workbench] ID 状态写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  emptyBootstrap(month) {
    const today = todayStr(this.now())
    return {
      initialized: false,
      dataRoot: this.store.dataRoot,
      month,
      file: this.store.fileFor(month),
      today,
      weekStart: weekStartOf(today),
      hash: null,
      readOnly: false,
      readOnlyReason: null,
      counts: { overdue: 0, open: 0, completedToday: 0, totalOpen: 0, totalDone: 0, badge: 0 },
      warnings: [],
      errors: [],
      priorityOptions: PRIORITIES,
      defaultPriority: DEFAULT_PRIORITY,
    }
  }

  async buildBootstrap() {
    try {
      const shard = await this.store.read()
      const status = await this.store.status()
      const today = todayStr(this.now())
      const model = shard.model
      return {
        ...status,
        initialized: true,
        hash: shard.hash,
        today,
        weekStart: weekStartOf(today),
        readOnly: model.readOnly,
        readOnlyReason: model.readOnlyReason,
        counts: deriveCounts(model, today),
        warnings: model.warnings,
        errors: model.errors,
        priorityOptions: PRIORITIES,
        defaultPriority: DEFAULT_PRIORITY,
      }
    } catch (error) {
      if (error instanceof TaskError && error.code === 'file-missing') {
        const status = await this.store.status().catch(() => null)
        return { ...this.emptyBootstrap(status?.month ?? todayStr(this.now()).slice(0, 7)), dataRoot: this.store.dataRoot }
      }
      throw error
    }
  }

  bootstrap() {
    return this.enqueue(() => this.buildBootstrap())
  }

  settingsInfo() {
    return this.enqueue(async () => ({
      dataRoot: this.store.dataRoot,
      dataDir: this.store.dataDir,
      backupDir: this.store.backupDir,
      backupRetentionDays: this.store.settings.backupRetentionDays,
      month: (await this.store.status()).month,
    }))
  }

  async readView(build) {
    const shard = await this.store.read()
    if (shard.model.readOnly) {
      throw new TaskError('read-only', `当月分片只读：${shard.model.errors[0]?.message ?? '格式不受支持'}`, 409, {
        errors: shard.model.errors,
      })
    }
    return { ...build(shard.model), hash: shard.hash, warnings: shard.model.warnings }
  }

  today() {
    return this.enqueue(() => {
      const today = todayStr(this.now())
      return this.readView((model) => deriveToday(model, today))
    })
  }

  week(anchor) {
    return this.enqueue(() => {
      const today = todayStr(this.now())
      const realAnchor = typeof anchor === 'string' && anchor !== '' ? anchor : today
      if (!weekStartOf(realAnchor)) throw new TaskError('validation-error', 'anchor 必须是合法的 YYYY-MM-DD', 400)
      return this.readView((model) => deriveWeek(model, realAnchor, today))
    })
  }

  list({ includeCompleted = false } = {}) {
    return this.enqueue(() => this.readView((model) => ({
      tasks: deriveList(model, { includeCompleted: includeCompleted === true }),
      includeCompleted: includeCompleted === true,
    })))
  }

  getTask(taskId) {
    return this.enqueue(async () => {
      assertTaskId(taskId)
      const shard = await this.store.read()
      const task = findTask(shard.model, taskId)
      if (!task) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
      return { task: publicTask(task), hash: shard.hash }
    })
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  ensureWritable(shard) {
    if (shard.model.readOnly) {
      throw new TaskError('read-only', `当月分片只读：${shard.model.errors[0]?.message ?? '格式不受支持'}`, 409, {
        errors: shard.model.errors,
      })
    }
  }

  checkHash(shard, baseHash) {
    if (typeof baseHash === 'string' && baseHash !== '' && baseHash !== shard.hash) {
      throw new TaskError('external-change', '任务文件已被外部修改，已阻止覆盖；请重新加载后再操作', 409, {
        currentHash: shard.hash,
      })
    }
  }

  async commit(shard, newText, { actor, op, taskId, before = null, after = null }) {
    let parsed
    try {
      parsed = parseShard(newText, { file: shard.file })
    } catch (error) {
      throw new TaskError('write-failed', `写入内容无法解析：${error instanceof Error ? error.message : String(error)}`, 500)
    }
    if (parsed.readOnly) {
      throw new TaskError('write-failed', `写入内容解析失败：${parsed.errors[0]?.message ?? '未知结构错误'}`, 500)
    }
    const ids = parsed.tasks.map((task) => task.id)
    if (new Set(ids).size !== ids.length) {
      throw new TaskError('validation-error', '写入会产生重复任务 ID，已中止', 400)
    }
    try {
      const { backupPath, hash } = await this.store.backupAndWrite(newText, shard.text)
      await this.audit({
        ok: true,
        actor: actor.id,
        actorKind: actor.kind,
        op,
        taskId,
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
        taskId,
        oldHash: shard.hash,
        error: errorPayload(normalized),
      })
      throw normalized
    }
  }

  create(input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      const today = todayStr(this.now())
      const clean = normalizeCreateInput(input, today)
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)

      const key = `${clean.date}\u0000${clean.title}`
      const nowMs = Date.now()
      this.recentCreates = this.recentCreates.filter((item) => nowMs - item.at < RECENT_WINDOW_MS)
      const duplicate = this.recentCreates.find((item) => item.key === key)
      if (duplicate && input?.confirmDuplicate !== true) {
        throw new TaskError('duplicate-suspected', `60 秒内刚创建过「${clean.title}」（${clean.date}）；确认要再建一条吗？`, 409, {
          taskId: duplicate.id,
        })
      }

      const idState = await this.loadIdState()
      const task = {
        id: generateTaskId(shard.model, today, Number(idState[today]) || 0),
        title: clean.title,
        date: clean.date,
        time: clean.time || null,
        endDate: clean.endDate || null,
        endTime: clean.endTime || null,
        priority: clean.priority ?? DEFAULT_PRIORITY,
        done: false,
        note: clean.note,
        completed: null,
        unknown: [],
      }
      const newText = appendTaskLine(shard.text, 'todo', task, today)
      const { hash, backupPath, model } = await this.commit(shard, newText, {
        actor,
        op: 'create',
        taskId: task.id,
        after: publicTask(task),
      })
      const created = findTask(model, task.id)
      this.recentCreates.push({ key, at: nowMs, id: task.id })
      idState[today] = Number(task.id.slice(-2))
      await this.saveIdState()
      return { task: created ? publicTask(created) : publicTask(task), hash, backupPath }
    }))
  }

  update(taskId, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertTaskId(taskId)
      const changes = normalizeUpdateChanges(input?.changes ?? input ?? {})
      const today = todayStr(this.now())
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)
      const existing = findTask(shard.model, taskId)
      if (!existing) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
      const merged = { ...normalizeTask(existing), ...changes }
      const timing = assertTaskTiming(merged)
      merged.time = timing.time || null
      merged.endDate = timing.endDate || null
      merged.endTime = timing.endTime || null
      const newText = replaceTaskLine(shard.text, taskId, merged, today)
      const { hash, backupPath, model } = await this.commit(shard, newText, {
        actor,
        op: 'update',
        taskId,
        before: publicTask(existing),
        after: publicTask(merged),
      })
      const updated = findTask(model, taskId)
      return { task: updated ? publicTask(updated) : publicTask(merged), hash, backupPath }
    }))
  }

  remove(taskId, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertTaskId(taskId)
      const today = todayStr(this.now())
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)
      const existing = findTask(shard.model, taskId)
      if (!existing) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
      const newText = removeTaskLine(shard.text, taskId, today)
      const { hash, backupPath } = await this.commit(shard, newText, {
        actor,
        op: 'delete',
        taskId,
        before: publicTask(existing),
        after: null,
      })
      return { deleted: { id: existing.id, title: existing.title }, hash, backupPath }
    }))
  }

  complete(taskId, done, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertTaskId(taskId)
      if (actor?.kind !== 'user') {
        throw new TaskError('permission-denied', '完成 / 撤销完成只能由人确认，AI 不能执行', 403)
      }
      const today = todayStr(this.now())
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)
      const existing = findTask(shard.model, taskId)
      if (!existing) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
      const target = done === true
      if (existing.done === target) {
        return { noop: true, task: publicTask(existing), hash: shard.hash }
      }
      const task = { ...existing, done: target, completed: target ? today : null }
      let newText = removeTaskLine(shard.text, taskId, today)
      newText = appendTaskLine(newText, target ? 'done' : 'todo', task, today)
      const { hash, backupPath, model } = await this.commit(shard, newText, {
        actor,
        op: target ? 'complete' : 'reopen',
        taskId,
        before: publicTask(existing),
        after: publicTask(task),
      })
      const updated = findTask(model, taskId)
      return { task: updated ? publicTask(updated) : publicTask(task), hash, backupPath, noop: false }
    }))
  }

  // ── 管理 ────────────────────────────────────────────────────────────────
  init(actor) {
    return this.enqueue(async () => {
      if (actor?.kind !== 'user') throw new TaskError('permission-denied', '只有人可以对数据目录执行初始化', 403)
      try {
        await this.store.init()
      } catch (error) {
        throw normalizeError(error)
      }
      return this.buildBootstrap()
    })
  }

  reload() {
    return this.enqueue(async () => {
      try {
        await this.store.reload()
      } catch (error) {
        if (error instanceof TaskError) throw error
        throw normalizeError(error)
      }
      return this.buildBootstrap()
    })
  }
}

export { asTaskError, isPriority }
