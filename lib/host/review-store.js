// 复盘存储：三类各一个单文件（日 / 周 / 月），不按月切；读缓存、首次写入自动建文件、
// 写前备份 + 原子写 + 回读校验。三个文件互相独立：某个文件损坏只影响该类型。
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TaskError, todayStr } from '../core/contract.js'
import {
  REVIEW_DIR, REVIEW_FILE_NAMES, REVIEW_FILE_TYPES, REVIEW_TITLES,
} from '../core/review-contract.js'
import { parseReviewFile } from '../core/review-grammar.js'
import { atomicWrite, backupNamed, cleanupBackups, exists, hashOf, verifyWrite } from './writer.js'

const PREFACE = {
  daily: '每天一条，由人写；AI 只读，不改。',
  weekly: '每周一条（周一 → 周日），由人写；AI 只读，不改。',
  monthly: '每月一条（当月最后一天写），由人写；AI 只读，不改。',
}

/** 空复盘文件骨架（首次写入时创建）。 */
export function buildReviewFileText(kind, today) {
  return [
    '---',
    `title: ${REVIEW_TITLES[kind]}`,
    `type: ${REVIEW_FILE_TYPES[kind]}`,
    'format: 1',
    `created: ${today}`,
    `updated: ${today}`,
    '---',
    '',
    `# ${REVIEW_TITLES[kind]}`,
    '',
    `> ${PREFACE[kind]}`,
    '',
    '## 记录',
    '',
  ].join('\n') + '\n'
}

export class ReviewStore {
  constructor({ settings, persistSettings, now = () => new Date(), logger = null, isDataRootReady = null }) {
    this.settings = settings
    this.persistSettings = persistSettings
    this.now = now
    this.logger = logger
    this.isDataRootReady = isDataRootReady
    this.cache = new Map()
  }

  get dataRoot() {
    return this.settings.dataRoot
  }

  get dataDir() {
    return join(this.settings.dataRoot, REVIEW_DIR)
  }

  get backupDir() {
    return join(this.settings.dataRoot, '备份')
  }

  fileFor(kind) {
    return join(this.dataDir, REVIEW_FILE_NAMES[kind])
  }

  async exists(kind) {
    return exists(this.fileFor(kind))
  }

  async isReady() {
    if (typeof this.isDataRootReady === 'function') return this.isDataRootReady()
    return this.settings.initialized === true
  }

  /** 读取某类复盘；文件不存在时抛 file-missing（读取方按空记录处理）。 */
  async read(kind) {
    const file = this.fileFor(kind)
    if (!(await exists(file))) {
      throw new TaskError('file-missing', `${REVIEW_TITLES[kind]}文件还不存在；第一次提交复盘时会自动生成`, 409, { file, kind })
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw new TaskError('file-missing', `${REVIEW_TITLES[kind]}文件在读取时被删除，请重新加载`, 409, { file })
      }
      throw new TaskError('config-invalid', `无法读取${REVIEW_TITLES[kind]}：${error instanceof Error ? error.message : String(error)}`, 500, { file })
    }
    const hash = hashOf(text)
    const cached = this.cache.get(kind)
    if (cached && cached.hash === hash) return { ...cached }
    const model = parseReviewFile(text, { kind, file })
    const next = { kind, file, text, hash, model }
    this.cache.set(kind, next)
    return { ...next }
  }

  /** 首次写入前创建空文件；数据根未初始化时拒绝（由任务域先初始化）。 */
  async ensureFile(kind) {
    const file = this.fileFor(kind)
    if (await exists(file)) return
    if (!(await this.isReady())) {
      throw new TaskError('file-missing', '数据目录尚未初始化，请先在工作台点「初始化」', 409, { file, kind })
    }
    await mkdir(this.dataDir, { recursive: true })
    await atomicWrite(file, buildReviewFileText(kind, todayStr(this.now())))
    this.cache.delete(kind)
    this.logger?.info?.(`[personal-task-workbench] 已创建${REVIEW_TITLES[kind]}文件：${file}`)
  }

  /** 写前备份 → 原子写 → 回读校验 → 更新缓存 → 清理旧备份。 */
  async backupAndWrite(kind, newText, previousText, { backup = true } = {}) {
    const file = this.fileFor(kind)
    let backupPath = null
    if (backup && previousText !== undefined) {
      backupPath = await backupNamed({
        backupDir: this.backupDir,
        name: REVIEW_TITLES[kind],
        text: previousText,
        now: this.now(),
      })
    }
    await atomicWrite(file, newText)
    await verifyWrite(file, newText, backupPath)
    const model = parseReviewFile(newText, { kind, file })
    this.cache.set(kind, { kind, file, text: newText, hash: hashOf(newText), model })
    await cleanupBackups(this.backupDir, this.settings.backupRetentionDays, this.now())
    return { backupPath, hash: hashOf(newText), model }
  }
}
