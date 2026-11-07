// AI 工具面（想法池）：只调用 IdeaService，不直接读写数据库。
// 没有「改状态」工具：状态流转（待实现/推进中/完成/放弃）只能由人在面板里改。
import { IDEA_MATURITIES, IDEA_STATUSES } from '../core/contract.js'
import { toolActor } from './service.js'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value) }],
  }
}

const objectParams = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
})

function ideaSummary(idea) {
  const parts = [`- ${idea.id}｜${idea.name}｜${idea.status}｜成熟度 ${idea.maturity}`]
  if (idea.category) parts.push(`｜${idea.category}`)
  if (idea.staleDays >= 14) parts.push(`｜已放置 ${idea.staleDays} 天`)
  return parts.join('')
}

const statusParam = str(`状态筛选，四选一：${IDEA_STATUSES.join(' / ')}`, { enum: IDEA_STATUSES })
const maturityParam = str(`成熟度筛选，三选一：${IDEA_MATURITIES.join(' / ')}`, { enum: IDEA_MATURITIES })
const ideaIdParam = str('想法 ID，形如 I-1')

export function createIdeaTools(service) {
  return [
    {
      name: 'tw_idea_list',
      description: '列出想法池里的想法（默认全部；可按状态 / 成熟度 / 关键词筛选）。只读。',
      parameters: objectParams({
        status: statusParam,
        maturity: maturityParam,
        keyword: str('关键词，匹配名称或详细描述'),
      }),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.list()
        let ideas = data.ideas
        if (args?.status) ideas = ideas.filter((idea) => idea.status === args.status)
        if (args?.maturity) ideas = ideas.filter((idea) => idea.maturity === args.maturity)
        if (args?.keyword) {
          const q = String(args.keyword).toLowerCase()
          ideas = ideas.filter((idea) => idea.name.toLowerCase().includes(q) || idea.description.toLowerCase().includes(q))
        }
        const lines = ideas.map(ideaSummary)
        return {
          ok: true,
          message: `想法池共 ${data.ideas.length} 条${ideas.length !== data.ideas.length ? `，符合筛选 ${ideas.length} 条` : ''}（待实现 ${data.counts.todo} · 推进中 ${data.counts.doing} · 完成 ${data.counts.done} · 放弃 ${data.counts.dropped}）。${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`,
          data: { ...data, ideas },
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_idea_get',
      description: '读取单条想法详情（名称、详细描述、状态、成熟度、分类、创建/更新/完成日期）。只读。',
      parameters: objectParams({ ideaId: ideaIdParam }, ['ideaId']),
      output: textOutput(),
      async execute(args) {
        const data = await service.get(args?.ideaId)
        const idea = data.idea
        return {
          ok: true,
          message: `想法 ${idea.id}：${idea.name}｜${idea.status}｜成熟度 ${idea.maturity}${idea.category ? `｜${idea.category}` : ''}｜创建 ${idea.created ?? '—'}｜更新 ${idea.updated ?? '—'}${idea.completed ? `｜完成 ${idea.completed}` : ''}${idea.description ? `\n详细描述：\n${idea.description}` : ''}`,
          data,
        }
      },
    },
    {
      name: 'tw_idea_create',
      description: '在想法池里新建一条想法并立即写入数据库。状态默认「待实现」，成熟度默认「低」；详细描述可多行。AI 可以新建；失败会返回明确错误，不会假装成功。',
      parameters: objectParams({
        name: str('想法名称（必填，不能含换行，≤200 字）'),
        description: str('详细描述（可选，多行文本；想解决什么问题、为什么值得做）'),
        maturity: str('成熟度：低 / 中 / 高，默认低', { enum: IDEA_MATURITIES }),
        category: str('分类（可选，单行，≤20 字，如 业务 / 产品 / 学习）'),
      }, ['name']),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.create(args ?? {}, toolActor(exec))
        return {
          ok: true,
          message: `已创建想法 ${data.idea.id}：${data.idea.name}｜待实现｜成熟度 ${data.idea.maturity}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_idea_update',
      description: '编辑一条想法的名称 / 详细描述 / 成熟度 / 分类（字段白名单）。立即写入数据库。注意：状态（待实现/推进中/完成/放弃）只能由人在面板里修改，AI 没有改状态工具。',
      parameters: objectParams({
        ideaId: ideaIdParam,
        name: str('新名称'),
        description: str('新详细描述；传空字符串表示清空'),
        maturity: str('新成熟度：低 / 中 / 高', { enum: IDEA_MATURITIES }),
        category: str('新分类；传空字符串表示清空'),
      }, ['ideaId']),
      output: textOutput(),
      async execute(args, exec) {
        const { ideaId, ...changes } = args ?? {}
        if (Object.keys(changes).length === 0) throw new Error('至少提供一个要修改的字段：name / description / maturity / category')
        const data = await service.update(ideaId, { changes }, toolActor(exec))
        return {
          ok: true,
          message: `已更新想法 ${data.idea.id}：${data.idea.name}｜${data.idea.status}｜成熟度 ${data.idea.maturity}${data.idea.category ? `｜${data.idea.category}` : ''}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_idea_delete',
      description: '硬删除一条想法（写前自动备份 SQLite 快照，面板内不可恢复）。立即写入数据库。删除前应先把想法名称说清楚。',
      parameters: objectParams({ ideaId: ideaIdParam }, ['ideaId']),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.remove(args?.ideaId, {}, toolActor(exec))
        return {
          ok: true,
          message: `已删除想法 ${data.deleted.id}：${data.deleted.name}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
  ]
}

