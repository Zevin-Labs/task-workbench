// 设置与路径：任务数据放 <dataRoot>，插件私有状态放 $DSH_HOME/personal-task-workbench/。
// 默认数据根放在 $DSH_HOME 下（而不是插件包目录）：无论插件以 link、本地目录、
// tarball 还是 npm 包安装，数据都落在同一处，升级/重装不会把数据写进 node_modules 副本。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

export function pluginStateDir() {
  return join(dshHome(), 'personal-task-workbench')
}

export function settingsFile() {
  return join(pluginStateDir(), 'settings.json')
}

export function auditLogFile() {
  return join(pluginStateDir(), 'writes.log')
}

export function defaultDataRoot() {
  return join(pluginStateDir(), 'data')
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 原子写 JSON（设置很小，tmp + rename 足够）。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

/** 读取（必要时创建）插件设置。 */
export function loadSettings() {
  mkdirSync(pluginStateDir(), { recursive: true })
  let stored = {}
  try {
    stored = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    stored = {}
  }
  const dataRoot = typeof stored.dataRoot === 'string' && stored.dataRoot.trim() !== ''
    ? resolve(stored.dataRoot)
    : defaultDataRoot()
  const settings = {
    dataRoot,
    backupRetentionDays: clamp(stored.backupRetentionDays ?? 7, 1, 90),
    initialized: stored.initialized === true,
  }
  saveSettings(settings)
  return settings
}

export function saveSettings(settings) {
  writeJsonAtomic(settingsFile(), {
    dataRoot: settings.dataRoot,
    backupRetentionDays: settings.backupRetentionDays,
    initialized: settings.initialized === true,
  })
  return settings
}

export function dataRootExists(dataRoot) {
  return existsSync(dataRoot)
}
