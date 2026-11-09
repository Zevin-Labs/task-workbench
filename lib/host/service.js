// TaskService：UI（HTTP）与 AI（工具）的唯一任务读写网关。
// 写入走 SQLite 同步短事务：版本校验 → 数据变更 → write_log 审计 → 版本递增。
// 硬删除前额外生成可回读的一致性备份；正常编辑直接提交事务。
import {
  DEFAULT_PRIORITY, PRIORITIES, TaskError, addDays, monthOf, todayStr, weekStartOf,
} from '../core/contract.js'
import { deriveCounts, deriveMonth, deriveToday, deriveWeek, publicTask, sortByPriorityThenDate } from '../core/derive.js'
import {
  assertTaskChangePolicy, assertTaskId, assertTaskTiming, normalizeCreateInput, normalizeUpdateChanges,
} from '../core/validate.js'
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

function loadTasks(db, where = '1 = 1', params = []) {
  return db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY id`).all(...params).map(rowToTask)
}

function monthBounds(month) {
  const [yearText, monthText] = month.split('-')
  const monthNumber = Number(monthText)
  const next = monthNumber === 12
    ? `${String(Number(yearText) + 1).padStart(4, '0')}-01-01`
    : `${yearText}-${String(monthNumber + 1).padStart(2, '0')}-01`
  return { start: `${month}-01`, next }
}

function taskIdOf(taskId) {
  const id = assertTaskId(taskId)
  return Number(id.slice(2))
}

/** 过月已完成的任务保留在库里，但继续只读（与旧「历史分片只读」口径一致）。 */
function assertHistoryWritable(task, today) {
  const completedMonth = monthOf(task.completed)
  if (task.done && completedMonth && completedMonth < monthOf(today)) {
    throw new TaskError('history-readonly', '过月已完成的任务只读，不能再修改或删除', 409, {
      taskId: task.id,
      completed: task.completed,
    })
  }
}

function emptyCounts() {
  return { overdue: 0, open: 0, completedToday: 0, totalOpen: 0, totalDone: 0, badge: 0, rangeOpen: 0 }
}

export class TaskService extends WriteGateway {
  constructor({ db, now = () => new Date(), logger = null }) {
    super({ db, now, logger })
    this.recentCreates = []
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  emptyBootstrap() {
    const today = todayStr(this.now())
    return {
      initialized: false,
      dataRoot: this.db.dataRoot,
      database: this.db.file,
      today,
      weekStart: weekStartOf(today),
      version: 0,
      counts: emptyCounts(),
      priorityOptions: PRIORITIES,
      defaultPriority: DEFAULT_PRIORITY,
    }
  }

  async bootstrap() {
    try {
      if (!this.db.isInitialized()) return this.emptyBootstrap()
      const db = this.db.ensureInitialized()
      const today = todayStr(this.now())
      const month = monthOf(today)
      const { start, next } = monthBounds(month)
      const tasks = loadTasks(db, 'done = 0 OR (done = 1 AND completed >= ? AND completed < ?)', [start, next])
      const counts = deriveCounts({ tasks }, today)
      // 「已完成」保持本月口径（与旧总表一致）；待办覆盖全部未完成。
      counts.totalDone = tasks.filter((task) => task.done && monthOf(task.completed) === month).length
      return {
        initialized: true,
        dataRoot: this.db.dataRoot,
        database: this.db.file,
        today,
        weekStart: weekStartOf(today),
        version: this.db.readVersion('tasks', db),
        counts,
        priorityOptions: PRIORITIES,
        defaultPriority: DEFAULT_PRIORITY,
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async settingsInfo() {
    try {
      const initialized = this.db.isInitialized()
      return {
        dataRoot: this.db.dataRoot,
        database: this.db.file,
        backupDir: this.db.backupDir,
        backupRetentionDays: this.db.settings.backupRetentionDays,
        initialized,
        version: initialized ? this.db.readVersion('tasks') : 0,
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async today() {
    try {
      const db = this.db.ensureInitialized()
      const today = todayStr(this.now())
      const tasks = loadTasks(db,
        '(done = 0 AND date <= ?) OR (done = 1 AND (completed = ? OR (completed IS NULL AND date = ?)))',
        [today, today, today])
      return {
        ...deriveToday({ tasks }, today),
        version: this.db.readVersion('tasks', db),
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async week(anchor) {
    try {
      const db = this.db.ensureInitialized()
      const today = todayStr(this.now())
      const realAnchor = typeof anchor === 'string' && anchor !== '' ? anchor : today
      const start = weekStartOf(realAnchor)
      if (!start) throw new TaskError('validation-error', 'anchor 必须是合法的 YYYY-MM-DD', 400)
      const end = addDays(start, 6)
      const tasks = loadTasks(db,
        '(end_date IS NOT NULL AND date <= ? AND end_date >= ?) OR (end_date IS NULL AND date >= ? AND date <= ?)',
        [end, start, start, end])
      return {
        ...deriveWeek({ tasks }, realAnchor, today),
        version: this.db.readVersion('tasks', db),
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async month(anchor) {
    try {
      const db = this.db.ensureInitialized()
      const today = todayStr(this.now())
      const month = typeof anchor === 'string' && anchor !== '' ? anchor : monthOf(today)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TaskError('validation-error', 'month 必须是 YYYY-MM', 400)
      const { start, next } = monthBounds(month)
      const end = addDays(next, -1)
      const tasks = loadTasks(db,
        '(end_date IS NOT NULL AND date <= ? AND end_date >= ?) OR (end_date IS NULL AND date >= ? AND date <= ?)',
        [end, start, start, end])
      return {
        ...deriveMonth({ tasks }, month, today),
        version: this.db.readVersion('tasks', db),
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async list({ includeCompleted = false } = {}) {
    try {
      const db = this.db.ensureInitialized()
      const today = todayStr(this.now())
      const month = monthOf(today)
      const { start, next } = monthBounds(month)
      const tasks = includeCompleted === true
        ? loadTasks(db, 'done = 0 OR (done = 1 AND completed >= ? AND completed < ?)', [start, next])
        : loadTasks(db, 'done = 0')
      return {
        tasks: sortByPriorityThenDate(tasks).map(publicTask),
        includeCompleted: includeCompleted === true,
        version: this.db.readVersion('tasks', db),
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async getTask(taskId) {
    try {
      const id = taskIdOf(taskId)
      const db = this.db.ensureInitialized()
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
      if (!row) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
      return { task: publicTask(rowToTask(row)), version: this.db.readVersion('tasks', db) }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  async create(input, actor, { requestId } = {}) {
    return this.writeOp(requestId, () => {
      try {
        const today = todayStr(this.now())
        const clean = normalizeCreateInput(input, today)

        const key = `${clean.date}\u0000${clean.title}`
        const nowMs = Date.now()
        this.recentCreates = this.recentCreates.filter((item) => nowMs - item.at < RECENT_WINDOW_MS)
        const duplicate = this.recentCreates.find((item) => item.key === key)
        if (duplicate && input?.confirmDuplicate !== true) {
          throw new TaskError('duplicate-suspected', `60 秒内刚创建过「${clean.title}」（${clean.date}）；确认要再建一条吗？`, 409, {
            taskId: duplicate.id,
          })
        }

        const result = this.db.transaction((db) => {
          this.db.checkVersion(db, 'tasks', input?.baseVersion)
          const inserted = db.prepare(`
            INSERT INTO tasks (title, date, time, end_date, end_time, priority, done, completed, note)
            VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
          `).run(
            clean.title,
            clean.date,
            clean.time || null,
            clean.endDate || null,
            clean.endTime || null,
            clean.priority ?? DEFAULT_PRIORITY,
            clean.note,
          )
          const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(inserted.lastInsertRowid)))
          this.db.audit(db, { actor, op: 'create', domain: 'task', target: task.id, detail: { after: publicTask(task) } })
          const version = this.db.bumpVersion(db, 'tasks')
          return { task: publicTask(task), version }
        })

        this.recentCreates.push({ key, at: nowMs, id: result.task.id })
        return result
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  async update(taskId, input, actor, { requestId } = {}) {
    return this.writeOp(requestId, () => {
      try {
        const id = taskIdOf(taskId)
        const changes = normalizeUpdateChanges(input?.changes ?? input ?? {})
        const today = todayStr(this.now())
        return this.db.transaction((db) => {
          this.db.checkVersion(db, 'tasks', input?.baseVersion)
          const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
          if (!row) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
          const existing = rowToTask(row)
          assertHistoryWritable(existing, today)
          assertTaskChangePolicy(changes, existing, today)

          const merged = { ...existing, ...changes }
          const timing = assertTaskTiming(merged)
          merged.time = timing.time || null
          merged.endDate = timing.endDate || null
          merged.endTime = timing.endTime || null

          db.prepare(`
            UPDATE tasks SET title = ?, date = ?, time = ?, end_date = ?, end_time = ?, priority = ?, note = ?
            WHERE id = ?
          `).run(
            merged.title,
            merged.date,
            merged.time,
            merged.endDate,
            merged.endTime,
            merged.priority,
            merged.note,
            id,
          )
          const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
          this.db.audit(db, {
            actor,
            op: 'update',
            domain: 'task',
            target: task.id,
            detail: { before: publicTask(existing), after: publicTask(task) },
          })
          const version = this.db.bumpVersion(db, 'tasks')
          return { task: publicTask(task), version }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  async remove(taskId, input, actor, { requestId } = {}) {
    return this.writeOp(requestId, () => {
      try {
        const id = taskIdOf(taskId)
        const today = todayStr(this.now())
        const db = this.db.ensureInitialized()
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
        if (!row) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
        const existing = rowToTask(row)
        assertHistoryWritable(existing, today)
        // 先校验版本，避免版本已过期时还生成无用的备份。
        this.db.checkVersion(db, 'tasks', input?.baseVersion)

        const backupPath = this.db.backup({
          reason: 'tasks',
          verify: (backupDb) => Boolean(backupDb.prepare('SELECT 1 AS present FROM tasks WHERE id = ?').get(id)),
        })

        return this.db.transaction((tx) => {
          this.db.checkVersion(tx, 'tasks', input?.baseVersion)
          const current = tx.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
          if (!current) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
          const task = rowToTask(current)
          assertHistoryWritable(task, today)
          tx.prepare('DELETE FROM tasks WHERE id = ?').run(id)
          this.db.audit(tx, {
            actor,
            op: 'delete',
            domain: 'task',
            target: task.id,
            detail: { before: publicTask(task), backupPath },
          })
          const version = this.db.bumpVersion(tx, 'tasks')
          return { deleted: { id: task.id, title: task.title }, version, backupPath }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  async complete(taskId, done, input, actor, { requestId } = {}) {
    // 权限在幂等缓存之前校验，避免用旧 requestId 回放绕过。
    if (actor?.kind !== 'user') {
      throw new TaskError('permission-denied', '完成 / 撤销完成只能由人确认，AI 不能执行', 403)
    }
    return this.writeOp(requestId, () => {
      try {
        const id = taskIdOf(taskId)
        const today = todayStr(this.now())
        return this.db.transaction((db) => {
          this.db.checkVersion(db, 'tasks', input?.baseVersion)
          const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
          if (!row) throw new TaskError('not-found', `任务 ${taskId} 不存在`, 404)
          const existing = rowToTask(row)
          const target = done === true
          if (existing.done === target) {
            return { noop: true, task: publicTask(existing), version: this.db.readVersion('tasks', db) }
          }
          assertHistoryWritable(existing, today)

          db.prepare('UPDATE tasks SET done = ?, completed = ? WHERE id = ?')
            .run(target ? 1 : 0, target ? today : null, id)
          const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
          this.db.audit(db, {
            actor,
            op: target ? 'complete' : 'reopen',
            domain: 'task',
            target: task.id,
            detail: { before: publicTask(existing), after: publicTask(task) },
          })
          const version = this.db.bumpVersion(db, 'tasks')
          return { task: publicTask(task), version, noop: false }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  // ── 管理 ────────────────────────────────────────────────────────────────
  async init(actor) {
    if (actor?.kind !== 'user') throw new TaskError('permission-denied', '只有人可以对数据库执行初始化', 403)
    try {
      this.db.init()
    } catch (error) {
      throw normalizeError(error)
    }
    return this.bootstrap()
  }

  async reload() {
    return this.bootstrap()
  }
}
