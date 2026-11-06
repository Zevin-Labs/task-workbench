// 分片存储：定位当月分片、按月只读、月切结转、读缓存、写前备份 + 原子写 + 回读。
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentMonth, formatDate, TaskError, todayStr } from '../core/contract.js'
import { parseShard } from '../core/grammar.js'
import { atomicWrite, backupShard, cleanupBackups, exists, hashOf, verifyWrite } from './writer.js'

/** 生成一份空月分片（或带结转任务行的月分片）。 */
export function buildShardText(month, today, todoLines = []) {
  const lines = todoLines.filter((line) => typeof line === 'string' && line.trim() !== '')
  const header = [
    '---',
    `title: 任务清单 ${month}`,
    'type: task-list',
    'format: 1',
    `month: ${month}`,
    `created: ${month}-01`,
    `updated: ${today}`,
    '---',
    '',
    `# 任务清单 · ${month}`,
    '',
    '## 任务',
    '',
  ]
  const body = lines.length > 0 ? [...lines, ''] : []
  const tail = ['## 已完成', '']
  return `${[...header, ...body, ...tail].join('\n')}\n`
}

export class TaskStore {
  constructor({ settings, persistSettings, now = () => new Date(), logger = null }) {
    this.settings = settings
    this.persistSettings = persistSettings
    this.now = now
    this.logger = logger
    this.cache = null
    this.lastRollover = null
  }

  get dataRoot() {
    return this.settings.dataRoot
  }

  get dataDir() {
    return join(this.settings.dataRoot, '任务清单')
  }

  get backupDir() {
    return join(this.settings.dataRoot, '备份')
  }

  fileFor(month) {
    return join(this.dataDir, `${month}.md`)
  }

  async listMonths() {
    let entries
    try {
      entries = await readdir(this.dataDir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}\.md$/.test(entry.name))
      .map((entry) => entry.name.slice(0, 7))
      .sort()
  }

  async isInitialized() {
    if (this.settings.initialized === true) return true
    return (await this.listMonths()).length > 0
  }

  async status() {
    const month = currentMonth(this.now())
    const file = this.fileFor(month)
    return {
      dataRoot: this.dataRoot,
      dataDir: this.dataDir,
      backupDir: this.backupDir,
      initialized: await this.isInitialized(),
      month,
      file,
      exists: await exists(file),
      months: await this.listMonths(),
    }
  }

  /** 确保当月分片存在；不存在时按规则月切，未初始化则 file-missing。 */
  async ready() {
    const month = currentMonth(this.now())
    const file = this.fileFor(month)
    if (await exists(file)) return { month, file }
    if (!(await this.isInitialized())) {
      throw new TaskError('file-missing', '任务数据目录尚未初始化，请先在工作台点「初始化」', 409, {
        dataRoot: this.dataRoot,
        month,
      })
    }
    await this.rollover(month)
    return { month, file }
  }

  /** 读取当月分片；内容不变时复用解析结果。 */
  async read() {
    const { month, file } = await this.ready()
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new TaskError('file-missing', '当月分片在读取时被删除，请重新加载', 409, { file })
      }
      throw new TaskError('config-invalid', `无法读取当月分片：${error instanceof Error ? error.message : String(error)}`, 500, { file })
    }
    const hash = hashOf(text)
    if (this.cache && this.cache.hash === hash && this.cache.month === month) {
      return { ...this.cache, file }
    }
    const model = parseShard(text, { file })
    this.cache = { month, file, text, hash, model }
    return { ...this.cache }
  }

  /**
   * 只读读取指定月份分片（复盘材料用）：不触发月切、不写、不动当月缓存。
   * 分片不存在返回 null；无法解析时由调用方按 readOnly 处理。
   */
  async readMonth(month) {
    const file = this.fileFor(month)
    if (!(await exists(file))) return null
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      throw new TaskError('config-invalid', `无法读取 ${month} 分片：${error instanceof Error ? error.message : String(error)}`, 500, { file })
    }
    return { month, file, text, hash: hashOf(text), model: parseShard(text, { file }) }
  }

  /** 月切：把上一个分片未完成的待办行逐字节带到当月，历史分片保持只读。 */
  async rollover(month) {
    const file = this.fileFor(month)
    const months = await this.listMonths()
    const sourceMonth = months.filter((value) => value < month).sort().at(-1) ?? null
    let todoLines = []
    if (sourceMonth) {
      const sourceFile = this.fileFor(sourceMonth)
      let sourceText
      try {
        sourceText = await readFile(sourceFile, 'utf8')
      } catch (error) {
        throw new TaskError('rollover-failed', `月切读取来源分片失败：${error instanceof Error ? error.message : String(error)}`, 500, { sourceFile })
      }
      const sourceModel = parseShard(sourceText, { file: sourceFile })
      if (sourceModel.readOnly) {
        throw new TaskError('rollover-failed', `月切来源分片无法解析（${sourceModel.readOnlyReason}），已停止；请先修复`, 500, { sourceFile })
      }
      todoLines = sourceModel.tasks
        .filter((task) => !task.done && task.section === 'todo')
        .map((task) => sourceModel.lines[task.lineIndex])
    }
    const text = buildShardText(month, todayStr(this.now()), todoLines)
    await mkdir(this.dataDir, { recursive: true })
    await atomicWrite(file, text)
    if (this.settings.initialized !== true) {
      this.settings.initialized = true
      this.persistSettings(this.settings)
    }
    this.lastRollover = { month, sourceMonth, carried: todoLines.length }
    this.cache = null
    this.logger?.info?.(`[task-workbench] 月切：${sourceMonth ?? '无来源'} → ${month}，结转 ${todoLines.length} 条未完成`)
    return this.lastRollover
  }

  /** 仅数据目录未初始化时可用：创建目录与当月空分片。 */
  async init() {
    if (await this.isInitialized()) {
      throw new TaskError('already-initialized', '任务数据目录已经初始化过了', 409, { dataRoot: this.dataRoot })
    }
    await mkdir(this.dataDir, { recursive: true })
    await mkdir(this.backupDir, { recursive: true })
    const month = currentMonth(this.now())
    const file = this.fileFor(month)
    if (!(await exists(file))) await atomicWrite(file, buildShardText(month, todayStr(this.now())))
    this.settings.initialized = true
    this.persistSettings(this.settings)
    this.cache = null
    this.logger?.info?.(`[task-workbench] 已初始化：${file}`)
  }

  /** 写前备份 → 原子写 → 回读校验 → 更新缓存 → 清理旧备份。 */
  async backupAndWrite(newText, previousText, { backup = true } = {}) {
    const month = currentMonth(this.now())
    const file = this.fileFor(month)
    let backupPath = null
    if (backup && previousText !== undefined) {
      backupPath = await backupShard({ backupDir: this.backupDir, month, text: previousText, now: this.now() })
    }
    await atomicWrite(file, newText)
    await verifyWrite(file, newText, backupPath)
    const model = parseShard(newText, { file })
    this.cache = { month, file, text: newText, hash: hashOf(newText), model }
    await cleanupBackups(this.backupDir, this.settings.backupRetentionDays, this.now())
    return { backupPath, hash: this.cache.hash, model }
  }

  async reload() {
    this.cache = null
    return this.read()
  }
}
