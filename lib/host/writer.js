// 文件层：哈希、原子写、备份、备份清理、回读校验。
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { addDays, formatDate, TaskError } from '../core/contract.js'

export function hashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

const pad2 = (n) => String(n).padStart(2, '0')

export async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** tmp → fsync → rename → fsync(dir)。 */
export async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, file)
  // 目录 fsync 失败不影响文件内容（部分文件系统不支持），忽略。
  try {
    const dir = await open(dirname(file), 'r')
    try { await dir.sync() } finally { await dir.close() }
  } catch {
    // ignore
  }
}

function stamp(now) {
  return `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

/** 写前备份（通用）：文件名前缀 + 时间戳；返回备份文件绝对路径。失败抛 backup-failed。 */
export async function backupNamed({ backupDir, name, text, now }) {
  const day = formatDate(now)
  const dir = join(backupDir, day)
  try {
    await mkdir(dir, { recursive: true })
    const base = `${name}-${stamp(now)}`
    let file = join(dir, `${base}.md`)
    let suffix = 1
    while (await exists(file)) {
      suffix += 1
      file = join(dir, `${base}-${suffix}.md`)
    }
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600 })
    const readback = await readFile(file, 'utf8')
    if (readback !== text) throw new Error('备份回读不一致')
    return file
  } catch (error) {
    throw new TaskError('backup-failed', `写前备份失败：${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/** 写前备份；返回备份文件绝对路径。失败抛 backup-failed。 */
export async function backupShard({ backupDir, month, text, now }) {
  return backupNamed({ backupDir, name: `任务清单-${month}`, text, now })
}

/** 清理超过保留天数的备份目录。 */
export async function cleanupBackups(backupDir, retentionDays, now) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return
  let entries
  try {
    entries = await readdir(backupDir, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = addDays(formatDate(now), -retentionDays)
  if (!cutoff) return
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
    if (entry.name < cutoff) {
      try { await rm(join(backupDir, entry.name), { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

/** 写入后回读校验；不一致抛 write-failed（带备份路径）。 */
export async function verifyWrite(file, expected, backupPath) {
  const actual = await readFile(file, 'utf8')
  if (actual !== expected) {
    throw new TaskError('write-failed', '写入后回读与预期不一致，已中止；可从备份恢复', 500, { backupPath, file })
  }
}
