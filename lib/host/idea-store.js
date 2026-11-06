// 想法池存储：单文件、不按月切；读缓存、首次写入自动建文件、写前备份 + 原子写 + 回读。
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IDEA_FILE_TYPE, TaskError, todayStr } from '../core/contract.js'
import { parseIdeaPool } from '../core/idea-grammar.js'
import { atomicWrite, backupNamed, cleanupBackups, exists, hashOf, verifyWrite } from './writer.js'

/** 空想法池骨架（首次写入时创建）。 */
export function buildIdeaPoolText(today) {
  return [
    '---',
    'title: 想法池',
    `type: ${IDEA_FILE_TYPE}`,
    'format: 1',
    `created: ${today}`,
    `updated: ${today}`,
    '---',
    '',
    '# 想法池',
    '',
    '> 零摩擦捕获；状态与成熟度由人维护，定期整理。',
    '',
    '## 想法',
    '',
  ].join('\n') + '\n'
}

export class IdeaStore {
  constructor({ settings, persistSettings, now = () => new Date(), logger = null, isDataRootReady = null }) {
    this.settings = settings
    this.persistSettings = persistSettings
    this.now = now
    this.logger = logger
    this.isDataRootReady = isDataRootReady
    this.cache = null
  }

  get dataRoot() {
    return this.settings.dataRoot
  }

  get dataDir() {
    return join(this.settings.dataRoot, '想法池')
  }

  get file() {
    return join(this.dataDir, '想法池.md')
  }

  get backupDir() {
    return join(this.settings.dataRoot, '备份')
  }

  async exists() {
    return exists(this.file)
  }

  async status() {
    return {
      dataRoot: this.dataRoot,
      file: this.file,
      exists: await exists(this.file),
    }
  }

  async isReady() {
    if (typeof this.isDataRootReady === 'function') return this.isDataRootReady()
    return this.settings.initialized === true
  }

  /** 读取想法池；文件不存在时抛 file-missing（读取方按空池处理）。 */
  async read() {
    if (!(await exists(this.file))) {
      throw new TaskError('file-missing', '想法池文件还不存在；创建第一条想法时会自动生成', 409, { file: this.file })
    }
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new TaskError('file-missing', '想法池文件在读取时被删除，请重新加载', 409, { file: this.file })
      }
      throw new TaskError('config-invalid', `无法读取想法池：${error instanceof Error ? error.message : String(error)}`, 500, { file: this.file })
    }
    const hash = hashOf(text)
    if (this.cache && this.cache.hash === hash) return { ...this.cache }
    const model = parseIdeaPool(text, { file: this.file })
    this.cache = { file: this.file, text, hash, model }
    return { ...this.cache }
  }

  /** 首次写入前创建空文件；数据根未初始化时拒绝（由任务域先初始化）。 */
  async ensureFile() {
    if (await exists(this.file)) return
    if (!(await this.isReady())) {
      throw new TaskError('file-missing', '数据目录尚未初始化，请先在工作台点「初始化」', 409, { file: this.file })
    }
    await mkdir(this.dataDir, { recursive: true })
    await atomicWrite(this.file, buildIdeaPoolText(todayStr(this.now())))
    this.cache = null
    this.logger?.info?.(`[task-workbench] 已创建想法池：${this.file}`)
  }

  /** 写前备份 → 原子写 → 回读校验 → 更新缓存 → 清理旧备份。 */
  async backupAndWrite(newText, previousText, { backup = true } = {}) {
    let backupPath = null
    if (backup && previousText !== undefined) {
      backupPath = await backupNamed({ backupDir: this.backupDir, name: '想法池', text: previousText, now: this.now() })
    }
    await atomicWrite(this.file, newText)
    await verifyWrite(this.file, newText, backupPath)
    const model = parseIdeaPool(newText, { file: this.file })
    this.cache = { file: this.file, text: newText, hash: hashOf(newText), model }
    await cleanupBackups(this.backupDir, this.settings.backupRetentionDays, this.now())
    return { backupPath, hash: this.cache.hash, model }
  }

  async reload() {
    this.cache = null
    return this.read()
  }
}
