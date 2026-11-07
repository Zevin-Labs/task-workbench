import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// settings.js 在每次调用时读 process.env.DSH_HOME，所以测试必须先设好环境再调用。
async function withDshHome(fn) {
  const root = await mkdtemp(join(tmpdir(), 'twb-settings-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    return await fn(root)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
}

test('默认数据根落在 $DSH_HOME/task-workbench/data', async () => {
  await withDshHome(async (root) => {
    const { defaultDataRoot, loadSettings, pluginStateDir } = await import('../lib/host/settings.js')
    const expected = join(root, 'task-workbench', 'data')
    assert.equal(pluginStateDir(), join(root, 'task-workbench'))
    assert.equal(defaultDataRoot(), expected)

    const settings = loadSettings()
    assert.equal(settings.dataRoot, expected)
    assert.equal(settings.backupRetentionDays, 7)
    assert.equal(Object.prototype.hasOwnProperty.call(settings, 'initialized'), false)

    // 读取时落一份 settings.json，后续启动复用同一路径；初始化状态不再写进设置。
    const stored = JSON.parse(await readFile(join(root, 'task-workbench', 'settings.json'), 'utf8'))
    assert.equal(stored.dataRoot, expected)
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'initialized'), false)
  })
})

test('已有 settings.json 的 dataRoot 优先，不会被新默认值覆盖', async () => {
  await withDshHome(async (root) => {
    const stateDir = join(root, 'task-workbench')
    const customRoot = join(root, 'custom-tasks')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, 'settings.json'),
      JSON.stringify({ dataRoot: customRoot, backupRetentionDays: 3, initialized: true }),
    )

    const { loadSettings } = await import('../lib/host/settings.js')
    const settings = loadSettings()
    assert.equal(settings.dataRoot, customRoot)
    assert.equal(settings.backupRetentionDays, 3)
    assert.equal(Object.prototype.hasOwnProperty.call(settings, 'initialized'), false)
  })
})

test('settings.json 里的相对 dataRoot 解析为绝对路径', async () => {
  await withDshHome(async (root) => {
    const stateDir = join(root, 'task-workbench')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'settings.json'), JSON.stringify({ dataRoot: 'relative-data' }))

    const { loadSettings } = await import('../lib/host/settings.js')
    assert.equal(loadSettings().dataRoot, resolve('relative-data'))
  })
})
