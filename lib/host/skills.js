// 随插件提供的统一技能：告诉 AI 如何用 ptw_* 工具读写任务清单。
// 注册进 ctx.skills 后，模型和 /skill 命令都能看到；与工具共享同一份数据契约。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parseSkill(dir, entry) {
  const file = join(dir, entry, 'SKILL.md')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!match) return null
  const field = (key) => {
    const hit = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return hit ? hit[1].trim().replace(/^(["'])(.*)\1$/, '$2') : ''
  }
  const name = field('name')
  const description = field('description')
  if (!name || !description) return null
  return { name, description, body: text.slice(match[0].length), dir: join(dir, entry), file }
}

export function readSkills(pluginRoot) {
  const dir = join(pluginRoot, 'skills')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseSkill(dir, entry.name))
    .filter(Boolean)
}

function candidate(skill) {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'task-workbench',
    rank: RANK,
    locator: skill.dir,
    resourceBase: { kind: 'directory', path: skill.dir },
  }
}

export function createSkillProvider(pluginRoot) {
  return {
    name: 'task-workbench',
    async list() {
      return readSkills(pluginRoot).map(candidate)
    },
    async get(context) {
      const skill = readSkills(pluginRoot).find((item) => item.name === context.name && item.dir === context.locator)
      if (!skill) return undefined
      const { rank, locator, ...summary } = candidate(skill)
      return { ...summary, content: skill.body }
    },
  }
}
