// 校验 npm 包白名单：从 `npm pack --dry-run --json` 的标准输入读 JSON，
// 断言运行所需文件（lib 下全部 JS + 技能 / 图标 / locale / 入口配置）都在包里，
// 并确认 data/、tests/、docs/ 不会被误打进包。CI 与发版前都跑这个。
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

const raw = readFileSync(0, 'utf8')
let report
try {
  report = JSON.parse(raw)
} catch {
  console.error('verify-pack: expected JSON from `npm pack --dry-run --json` on stdin')
  process.exit(1)
}

const packed = new Set((report[0]?.files ?? []).map((file) => file.path))
const required = [
  ...walk('lib').filter((file) => file.endsWith('.js')),
  'cordis.patch.yml',
  'icon.svg',
  'locale/en.json',
  'locale/zh.json',
  'skills/task-workbench/SKILL.md',
]
const missing = required.filter((file) => !packed.has(file))
const forbidden = [...packed].filter(
  (file) => file.startsWith('data/') || file.startsWith('tests/') || file.startsWith('docs/'),
)

if (missing.length || forbidden.length) {
  if (missing.length) console.error(`verify-pack: missing from package: ${missing.join(', ')}`)
  if (forbidden.length) console.error(`verify-pack: should not be packaged: ${forbidden.join(', ')}`)
  process.exit(1)
}

console.log(`verify-pack: OK (${packed.size} files)`)
