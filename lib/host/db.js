// SQLite 数据层：单个数据根下的 workbench.sqlite，唯一数据真源。
// 使用 Node 内置 node:sqlite 同步驱动；没有队列、没有后台进程、没有 ORM。
// 写事务由 SQLite 保证原子性：业务表变更 + write_log 审计 + 域版本号在同一事务内提交。
import { DatabaseSync } from 'node:sqlite'
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, rmdirSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { TaskError, addDays, formatDate } from '../core/contract.js'

const SCHEMA_VERSION = '1'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  meta_key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  end_date TEXT,
  end_time TEXT,
  priority TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  completed TEXT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_tasks_open_date ON tasks (done, date);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks (done, completed);

CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  maturity TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  completed TEXT
);

CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas (status);

CREATE TABLE IF NOT EXISTS reviews (
  kind TEXT NOT NULL,
  period_key TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, period_key)
);

CREATE TABLE IF NOT EXISTS write_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  op TEXT NOT NULL,
  domain TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
`

// 就绪检查只读现有结构，不能把版本标记当作业务表完整的证明。
const REQUIRED_TABLES = {
  meta: { columns: 'meta_key value', primaryKey: 'meta_key' },
  tasks: { columns: 'id title date time end_date end_time priority done completed note', primaryKey: 'id', autoIncrement: true },
  ideas: { columns: 'id name description status maturity category created updated completed', primaryKey: 'id', autoIncrement: true },
  reviews: { columns: 'kind period_key text updated_at', primaryKey: 'kind,period_key' },
  write_log: { columns: 'id at actor actor_kind op domain target detail', primaryKey: 'id', autoIncrement: true },
}

function assertTableSchema(conn, table, file) {
  const invalid = (message) => { throw new TaskError('config-invalid', message, 500, { file, table }) }
  const definition = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  if (!definition) invalid(`数据库缺少 ${table} 表，文件不是可用的任务工作台数据库`)
  const columns = conn.prepare(`PRAGMA table_info('${table}')`).all()
  const expected = REQUIRED_TABLES[table]
  for (const name of expected.columns.split(' ')) {
    const column = columns.find((item) => item.name === name)
    if (!column) invalid(`数据库 ${table} 表缺少 ${name} 列`)
    const type = name === 'id' || (table === 'tasks' && name === 'done') ? 'INTEGER' : 'TEXT'
    if (column.type.toUpperCase() !== type) invalid(`数据库 ${table}.${name} 类型必须是 ${type}`)
  }
  const primaryKey = columns.filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk).map((column) => column.name).join(',')
  if (primaryKey !== expected.primaryKey) invalid(`数据库 ${table} 表主键必须是 ${expected.primaryKey}`)
  if (expected.autoIncrement && !/\bAUTOINCREMENT\b/i.test(definition.sql)) {
    invalid(`数据库 ${table}.id 必须使用 AUTOINCREMENT，保证删除后编号不复用`)
  }
}

const pad2 = (n) => String(n).padStart(2, '0')
const stamp = (now) => `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export class WorkbenchDatabase {
  constructor({ settings, now = () => new Date(), logger = null }) {
    this.settings = settings
    this.now = now
    this.logger = logger
    this.handle = null
  }

  get dataRoot() {
    return this.settings.dataRoot
  }

  get file() {
    return join(this.settings.dataRoot, 'workbench.sqlite')
  }

  get backupDir() {
    return join(this.settings.dataRoot, '备份')
  }

  get hasFile() {
    return existsSync(this.file)
  }

  /** 打开共享连接；数据库文件不存在时视为未初始化。 */
  connect() {
    if (this.handle) return this.handle
    if (!this.hasFile) {
      throw new TaskError('file-missing', '数据库尚未初始化，请先在工作台点「初始化」', 409, { file: this.file })
    }
    try {
      this.handle = new DatabaseSync(this.file)
    } catch (error) {
      throw new TaskError('config-invalid', `无法打开数据库：${messageOf(error)}`, 500, { file: this.file })
    }
    return this.handle
  }

  schemaReady(db = null) {
    const conn = db ?? this.handle
    if (!conn) return false
    try {
      assertTableSchema(conn, 'meta', this.file)
      const row = conn.prepare("SELECT value FROM meta WHERE meta_key = 'schema_version'").get()
      if (!row) {
        throw new TaskError('config-invalid', '数据库缺少 schema_version，不能安全初始化或读取', 500, { file: this.file })
      }
      if (row.value !== SCHEMA_VERSION) {
        throw new TaskError('config-invalid', `数据库 schema_version ${row.value} 不受支持（当前支持 ${SCHEMA_VERSION}）`, 500, {
          file: this.file,
          schemaVersion: row.value,
        })
      }
      for (const table of Object.keys(REQUIRED_TABLES)) {
        if (table !== 'meta') assertTableSchema(conn, table, this.file)
      }
      return true
    } catch (error) {
      if (error instanceof TaskError) throw error
      throw new TaskError('config-invalid', `数据库结构无效：${messageOf(error)}`, 500, { file: this.file })
    }
  }

  /** 初始化状态真源 = 数据库文件存在且 schema 已就绪。 */
  isInitialized() {
    if (!this.hasFile) return false
    return this.schemaReady(this.connect())
  }

  ensureInitialized() {
    const db = this.connect()
    if (!this.schemaReady(db)) {
      throw new TaskError('file-missing', '数据库尚未初始化，请先在工作台点「初始化」', 409, { file: this.file })
    }
    return db
  }

  /** 创建空库（正常初始化入口）。已初始化则拒绝。 */
  init() {
    if (this.isInitialized()) {
      throw new TaskError('already-initialized', '数据库已经初始化过了', 409, { file: this.file })
    }
    let created = false
    let committed = false
    let db = null
    try {
      mkdirSync(this.dataRoot, { recursive: true })
      // 只在文件不存在时创建；O_EXCL 可避免并发初始化覆盖另一个进程已建成的库。
      try {
        const fd = openSync(this.file, 'wx', 0o600)
        closeSync(fd)
        created = true
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        if (this.isInitialized()) {
          throw new TaskError('already-initialized', '数据库已经初始化过了', 409, { file: this.file })
        }
        throw new TaskError('config-invalid', '数据库文件已存在但未初始化；为避免覆盖，不能自动初始化', 500, { file: this.file })
      }

      if (!this.handle) this.handle = new DatabaseSync(this.file)
      db = this.handle
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(SCHEMA)
        db.prepare("INSERT INTO meta (meta_key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
        chmodSync(this.file, 0o600)
        db.exec('COMMIT')
        committed = true
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
        throw error
      }
      this.logger?.info?.(`[task-workbench] 已初始化 SQLite：${this.file}`)
      return { file: this.file }
    } catch (error) {
      if (created && !committed) {
        this.close()
        try { rmSync(this.file, { force: true }) } catch { /* 初始化失败时尽力清理新建空库 */ }
      }
      if (error instanceof TaskError) throw error
      throw new TaskError('write-failed', `初始化数据库失败：${messageOf(error)}`, 500, { file: this.file })
    }
  }

  close() {
    if (!this.handle) return
    try {
      this.handle.close()
    } catch (error) {
      this.logger?.warn?.(`[task-workbench] 关闭数据库失败：${messageOf(error)}`)
    } finally {
      this.handle = null
    }
  }

  /** 短事务：BEGIN IMMEDIATE → fn(db) → COMMIT；任何异常都回滚。 */
  transaction(fn) {
    const db = this.ensureInitialized()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 回滚失败时保留原始异常 */ }
      throw error
    }
  }

  // ── 域版本（baseVersion 冲突检测） ────────────────────────────────────────
  readVersion(scope, db = null) {
    const conn = db ?? this.ensureInitialized()
    const row = conn.prepare('SELECT value FROM meta WHERE meta_key = ?').get(`version:${scope}`)
    return row ? Number(row.value) : 0
  }

  bumpVersion(db, scope) {
    const next = this.readVersion(scope, db) + 1
    db.prepare('INSERT INTO meta (meta_key, value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET value = excluded.value')
      .run(`version:${scope}`, String(next))
    return next
  }

  /** 写入前校验调用方版本；不传则跳过（AI 工具不需要）。 */
  checkVersion(db, scope, baseVersion) {
    const current = this.readVersion(scope, db)
    if (baseVersion === undefined || baseVersion === null || baseVersion === '') return current
    const expected = Number(baseVersion)
    if (!Number.isInteger(expected) || expected < 0) {
      throw new TaskError('validation-error', 'baseVersion 必须是非负整数', 400)
    }
    if (expected !== current) {
      throw new TaskError('external-change', '数据已被其他操作修改，已阻止覆盖；请重新加载后再操作', 409, {
        currentVersion: current,
      })
    }
    return current
  }

  // ── 审计（必须在写事务内调用） ────────────────────────────────────────────
  audit(db, { actor, op, domain, target = null, detail = null }) {
    db.prepare('INSERT INTO write_log (at, actor, actor_kind, op, domain, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        this.now().toISOString(),
        actor?.id ?? 'unknown',
        actor?.kind ?? 'unknown',
        op,
        domain,
        target,
        detail === null || detail === undefined ? null : JSON.stringify(detail),
      )
  }

  // ── 一致性备份（硬删除 / 清空复盘前） ────────────────────────────────────
  /**
   * VACUUM INTO 生成一致性快照，并用只读连接校验 integrity + 目标记录仍在。
   * @param {{ reason: string, verify?: (backupDb: DatabaseSync) => boolean }} options
   */
  backup({ reason, verify = null }) {
    const db = this.ensureInitialized()
    const now = this.now()
    const dir = join(this.backupDir, formatDate(now))
    let target
    try {
      mkdirSync(dir, { recursive: true })
      const base = `${reason}-${stamp(now)}`
      target = join(dir, `${base}.sqlite`)
      let suffix = 1
      while (existsSync(target)) {
        suffix += 1
        target = join(dir, `${base}-${suffix}.sqlite`)
      }
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
      chmodSync(target, 0o600)
    } catch (error) {
      if (target) {
        try { rmSync(target, { force: true }) } catch { /* ignore */ }
      }
      throw new TaskError('backup-failed', `写前备份失败：${messageOf(error)}`, 500, { file: target ?? null })
    }

    try {
      const backupDb = new DatabaseSync(target, { readOnly: true })
      try {
        const check = backupDb.prepare('PRAGMA integrity_check').get()
        if (!check || Object.values(check)[0] !== 'ok') throw new Error('integrity_check 未通过')
        if (typeof verify === 'function' && verify(backupDb) !== true) {
          throw new Error('备份中找不到待删除记录')
        }
      } finally {
        backupDb.close()
      }
    } catch (error) {
      try { rmSync(target, { force: true }) } catch { /* ignore */ }
      throw new TaskError('backup-failed', `写前备份校验失败：${messageOf(error)}`, 500, { file: target })
    }

    this.cleanupBackups(now)
    return target
  }

  /** 按 backupRetentionDays 清理旧日期目录中的本版本 SQLite 快照。 */
  cleanupBackups(now = this.now()) {
    const retention = Number(this.settings.backupRetentionDays)
    if (!Number.isFinite(retention) || retention <= 0) return
    const cutoff = addDays(formatDate(now), -retention)
    if (!cutoff) return
    let entries
    try {
      entries = readdirSync(this.backupDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
      if (entry.name >= cutoff) continue
      const dir = join(this.backupDir, entry.name)
      let files
      try { files = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const file of files) {
        if (!file.isFile() || !/^(tasks|ideas|reviews)-\d{6}(?:-\d+)?\.sqlite$/.test(file.name)) continue
        try { unlinkSync(join(dir, file.name)) } catch { /* ignore */ }
      }
      // Leave old Markdown backups and any unrelated contents untouched.
      try { rmdirSync(dir) } catch { /* not empty or already removed */ }
    }
  }
}
