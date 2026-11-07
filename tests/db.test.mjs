import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchDatabase } from '../lib/host/db.js'
import { TaskService, userActor } from '../lib/host/service.js'

async function makeEnv({ initialized = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'twb-db-'))
  const settings = { dataRoot: join(root, 'data'), backupRetentionDays: 7 }
  const db = new WorkbenchDatabase({ settings, now: () => new Date('2026-11-05T10:00:00') })
  if (initialized) db.init()
  return {
    root, settings, db,
    async cleanup() {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('db: 初始化创建空库，完整 schema 可在重开后识别', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  assert.equal(env.db.isInitialized(), false)
  env.db.init()
  assert.equal((await stat(env.db.file)).mode & 0o777, 0o600)
  for (const table of ['tasks', 'ideas', 'reviews', 'write_log']) {
    assert.equal(env.db.handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
  }
  env.db.close()
  assert.equal(env.db.isInitialized(), true)
  assert.throws(() => env.db.init(), (error) => error.code === 'already-initialized')
})

test('db: 已存在但版本未知的数据库不会被初始化覆盖', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  await mkdir(env.settings.dataRoot, { recursive: true })
  const existing = new DatabaseSync(env.db.file)
  existing.exec("CREATE TABLE meta (meta_key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '99')")
  existing.close()
  const before = await readFile(env.db.file)

  assert.throws(() => env.db.isInitialized(), (error) => error.code === 'config-invalid' && /schema_version 99/.test(error.message))
  assert.throws(() => env.db.init(), (error) => error.code === 'config-invalid')
  assert.deepEqual(await readFile(env.db.file), before)
})

test('db: 无工作台结构或只有版本标记的库明确报错，读取与初始化不改库', async (t) => {
  for (const ddl of [
    'CREATE TABLE unrelated (value TEXT)',
    "CREATE TABLE meta (meta_key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '1')",
  ]) {
    const env = await makeEnv()
    t.after(env.cleanup)
    await mkdir(env.settings.dataRoot, { recursive: true })
    const existing = new DatabaseSync(env.db.file)
    existing.exec(ddl)
    existing.close()
    const before = await readFile(env.db.file)
    const service = new TaskService({ db: env.db })

    for (const read of [() => service.bootstrap(), () => service.settingsInfo()]) {
      await assert.rejects(read(), (error) => error.code === 'config-invalid' && /缺少 .* 表/.test(error.message))
    }
    assert.throws(() => env.db.init(), (error) => error.code === 'config-invalid')
    assert.deepEqual(await readFile(env.db.file), before)
  }
})

test('db: 缺少任一必需表或列时，不能误报已初始化', async (t) => {
  for (const [table, column] of [
    ['meta', 'value'], ['tasks', 'note'], ['ideas', 'description'], ['reviews', 'text'], ['write_log', 'detail'],
  ]) {
    for (const defect of ['table', 'column']) {
      const env = await makeEnv({ initialized: true })
      t.after(env.cleanup)
      env.db.handle.exec(defect === 'table' ? `DROP TABLE ${table}` : `ALTER TABLE ${table} DROP COLUMN ${column}`)
      const before = await readFile(env.db.file)

      assert.throws(() => env.db.isInitialized(), (error) => error.code === 'config-invalid'
        && error.message.includes(table) && (defect === 'table' || error.message.includes(column)))
      assert.throws(() => env.db.init(), (error) => error.code === 'config-invalid')
      assert.deepEqual(await readFile(env.db.file), before)
    }
  }
})

test('db: 拒绝列类型、主键或自增约束不符的库', async (t) => {
  for (const [table, replacement, message] of [
    ['tasks', (sql) => sql.replace('title TEXT', 'title INTEGER'), /tasks\.title.*TEXT/],
    ['reviews', (sql) => sql.replace('PRIMARY KEY (kind, period_key)', 'PRIMARY KEY (period_key, kind)'), /reviews.*主键/],
    ['ideas', (sql) => sql.replace(' AUTOINCREMENT', ''), /ideas\.id.*AUTOINCREMENT/],
  ]) {
    const env = await makeEnv({ initialized: true })
    t.after(env.cleanup)
    const original = env.db.handle.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql
    env.db.handle.exec(`DROP TABLE ${table}`)
    env.db.handle.exec(replacement(original))
    assert.throws(() => env.db.isInitialized(), (error) => error.code === 'config-invalid' && message.test(error.message))
  }
})

test('db: 底层事务失败时，业务行、审计、域版本整体回滚', async (t) => {
  const env = await makeEnv({ initialized: true })
  t.after(env.cleanup)
  assert.throws(() => env.db.transaction((db) => {
    db.prepare("INSERT INTO tasks (title, date, priority) VALUES ('回滚', '2026-11-05', '重要不紧急')").run()
    env.db.audit(db, { actor: userActor(), op: 'create', domain: 'task', target: 'T-1' })
    env.db.bumpVersion(db, 'tasks')
    throw new Error('failure after version update')
  }), /failure after version update/)

  assert.equal(env.db.handle.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0)
  assert.equal(env.db.handle.prepare('SELECT COUNT(*) AS n FROM write_log').get().n, 0)
  assert.equal(env.db.readVersion('tasks'), 0)
  assert.equal(env.db.handle.isTransaction, false)
})

test('db: 快照保存删除前数据、同秒不覆盖，校验失败清理未通过快照', async (t) => {
  const env = await makeEnv({ initialized: true })
  t.after(env.cleanup)
  const service = new TaskService({ db: env.db, now: () => new Date('2026-11-05T10:00:00') })
  const { task } = await service.create({ title: '保存在快照' }, userActor())
  const verify = (backup) => Boolean(backup.prepare('SELECT 1 FROM tasks WHERE id = 1').get())
  const first = env.db.backup({ reason: 'tasks', verify })
  const second = env.db.backup({ reason: 'tasks', verify })
  assert.notEqual(first, second)
  assert.equal((await stat(first)).mode & 0o777, 0o600)
  const backup = new DatabaseSync(first, { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(backup.prepare('SELECT title FROM tasks WHERE id = 1').get().title, task.title)
  } finally {
    backup.close()
  }
  const dir = join(env.db.backupDir, '2026-11-05')
  const before = await readdir(dir)
  assert.throws(() => env.db.backup({ reason: 'tasks', verify: () => false }),
    (error) => error.code === 'backup-failed' && /校验失败/.test(error.message))
  assert.deepEqual(await readdir(dir), before)
  assert.equal((await service.getTask(task.id)).task.title, task.title)
})

test('db: 备份清理只删除本版本 SQLite 快照并保留旧文档', async (t) => {
  const env = await makeEnv()
  t.after(env.cleanup)
  const oldDir = join(env.settings.dataRoot, '备份', '2026-11-01')
  await mkdir(oldDir, { recursive: true })
  const oldSnapshot = join(oldDir, 'tasks-120000.sqlite')
  const oldMarkdown = join(oldDir, '任务清单-2026-11.md')
  const unrelated = join(oldDir, 'notes.sqlite')
  await writeFile(oldSnapshot, 'old sqlite snapshot')
  await writeFile(oldMarkdown, 'keep')
  await writeFile(unrelated, 'keep')

  env.db.cleanupBackups(new Date('2026-11-15T12:00:00'))

  await assert.rejects(stat(oldSnapshot), (error) => error.code === 'ENOENT')
  assert.equal(await readFile(oldMarkdown, 'utf8'), 'keep')
  assert.equal(await readFile(unrelated, 'utf8'), 'keep')
})
