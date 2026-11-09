// AI 工具面：只调用 TaskService，不直接读写数据库；没有「完成」工具（完成只能由人）。
import { PRIORITIES } from '../core/contract.js'
import { toolActor } from './service.js'

/** 'YYYY-MM-DD HH:mm' → 'M/D HH:mm'；只有日期时保留日期。 */
function shortAt(value) {
  const [date, time] = String(value).split(' ')
  const [, month, day] = date.split('-')
  const label = `${Number(month)}/${Number(day)}`
  return time ? `${label} ${time}` : label
}

/** 展示有效时间区间：当天 = '11/9 08:00–22:00'；跨天 = '11/8 08:00 → 11/10 22:00'。 */
function whenText(task) {
  const startAt = task?.startAt ?? (task?.date ? `${task.date}${task.time ? ` ${task.time}` : ''}` : '')
  if (!startAt) return '无日期'
  const endAt = task?.endAt ?? startAt
  if (String(startAt).slice(0, 10) === String(endAt).slice(0, 10)) {
    const endTime = String(endAt).slice(11)
    return `${shortAt(startAt)}${endTime ? `–${endTime}` : ''}`
  }
  return `${shortAt(startAt)} → ${shortAt(endAt)}`
}

const taskSummary = (task) => `- ${task.id}｜${task.title}｜${whenText(task)}｜${task.priority}${task.done ? `｜已完成 ${task.completed ?? ''}` : ''}`

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

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const bool = (description) => ({ type: 'boolean', description })

const priorityParam = str(`优先级，四选一：${PRIORITIES.join(' / ')}`, { enum: PRIORITIES })
const timeParam = str('开始整点 HH:00，可选；不传或空字符串 = 默认 08:00（只支持整点）')
const endDateParam = str('截止日期 YYYY-MM-DD，可选；不填 = 与开始日期同一天；填写时不能早于今天')
const endTimeParam = str('截止整点 HH:00，可选；不传或空字符串 = 默认 22:00（只支持整点）')

export function createTools(service) {
  return [
    {
      name: 'tw_today',
      description: '读取任务工作台的「今日」视图：今天要做的任务、逾期未完成任务、今天已完成的任务。跨周期任务只要今天在起止日期内就会出现在今天。只读。',
      parameters: objectParams({}),
      output: textOutput(),
      async execute(_args, exec) {
        const data = await service.today()
        const lines = [
          data.overdue.length > 0 ? `逾期（${data.overdue.length}）：` : '',
          ...data.overdue.map(taskSummary),
          data.open.length > 0 ? `今天（${data.open.length}）：` : '',
          ...data.open.map(taskSummary),
          data.completed.length > 0 ? `今天已完成（${data.completed.length}）：` : '',
          ...data.completed.map(taskSummary),
        ].filter(Boolean)
        return {
          ok: true,
          message: `今天 ${data.date}：待办 ${data.counts.totalOpen} 条（逾期 ${data.counts.overdue}），今天已完成 ${data.counts.completed} 条。${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_week',
      description: '读取任务工作台的「本周」视图：自然周（周一至周日）7 列；单日任务按日期落列，跨天任务（截止日期晚于开始日期）在区间内横跨。只读。',
      parameters: objectParams({
        anchor: str('周内任意一天 YYYY-MM-DD，默认今天'),
      }),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.week(args?.anchor)
        const lines = []
        for (const span of data.spans ?? []) {
          lines.push(`跨周期：${taskSummary(span)}（${span.clipStart} → ${span.clipEnd}）`)
        }
        for (const day of data.days) {
          const tasks = [...day.open, ...day.completed]
          if (tasks.length === 0) continue
          lines.push(`${day.label} ${day.date}${day.isToday ? '（今天）' : ''}：`)
          for (const task of tasks) lines.push(`  ${taskSummary(task)}`)
        }
        return {
          ok: true,
          message: `本周 ${data.start} → ${data.end}：待办 ${data.counts.open} 条，共 ${data.counts.total} 条。${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_list',
      description: '列出任务总表（默认只列全部未完成；includeCompleted=true 时含本月已完成）。按优先级、日期、时间排序。只读。',
      parameters: objectParams({
        includeCompleted: bool('是否包含已完成任务，默认 false'),
      }),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.list({ includeCompleted: args?.includeCompleted === true })
        const lines = data.tasks.map(taskSummary)
        return {
          ok: true,
          message: `任务 ${data.tasks.length} 条${data.includeCompleted ? '（含本月已完成）' : '（只看未完成）'}。${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_get_task',
      description: '读取单条任务详情（含开始/截止时间区间、优先级、状态、详情）。只读。',
      parameters: objectParams({
        taskId: str('任务 ID，形如 T-1'),
      }, ['taskId']),
      output: textOutput(),
      async execute(args) {
        const data = await service.getTask(args?.taskId)
        const task = data.task
        return {
          ok: true,
          message: `任务 ${task.id}：${task.title}｜${whenText(task)}｜${task.priority}｜${task.done ? `已完成 ${task.completed ?? ''}` : '未完成'}${task.note ? `｜详情：${task.note}` : ''}`,
          data,
        }
      },
    },
    {
      name: 'tw_create',
      description: '在任务工作台里创建一条任务并立即写入数据库。任务统一为连续时间区间：开始日期+开始整点 → 截止日期+截止整点。任务类型由日期跨度派生，没有类型参数：截止日期与开始日期同日 = 当天任务，晚于开始日期 = 跨天任务（连续区间，可跨午夜）。未填的时间按默认值派生且不落库：开始 08:00、截止 22:00；开始日期默认今天，截止日期默认跟随开始日期。时间只支持整点 HH:00；截止必须晚于开始。标题要简洁精炼，一句话说清要做什么；背景、过程或需要沟通的细节写进详情。默认优先级为「重要不紧急」。AI 可以创建；失败会返回明确错误，不会假装成功。',
      parameters: objectParams({
        title: str('任务标题（必填，单行；简洁精炼，一句话说清要做什么，细节写详情）'),
        date: str('开始日期 YYYY-MM-DD，可选；不填 = 今天'),
        time: timeParam,
        endDate: endDateParam,
        endTime: endTimeParam,
        priority: priorityParam,
        note: str('详情（可选，多行文本，最多 500 字）'),
        confirmDuplicate: bool('如果 60 秒内已有同标题同日期任务，确认后传 true 再建'),
      }, ['title']),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.create(args ?? {}, toolActor(exec))
        return {
          ok: true,
          message: `已创建任务 ${data.task.id}：${data.task.title}｜${whenText(data.task)}｜${data.task.priority}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_update',
      description: '编辑一条任务（标题 / 开始日期 / 开始时间 / 截止日期 / 截止时间 / 优先级 / 详情，字段白名单）。任务类型由日期跨度派生，没有类型参数；跨天即连续区间。时间只支持整点 HH:00（历史分钟值不改动时可原样保留）；截止日期不填 = 与开始日期同日，填写时不能早于今天。标题要简洁精炼，一句话说清要做什么；背景、过程或需要沟通的细节写进详情（多行）。立即写入数据库；清除时间或截止日期用空字符串。',
      parameters: objectParams({
        taskId: str('任务 ID，形如 T-1'),
        title: str('新标题（单行；简洁精炼，一句话说清要做什么，细节写详情）'),
        date: str('新的开始日期 YYYY-MM-DD'),
        time: str('新的开始整点 HH:00；传空字符串表示使用默认 08:00'),
        endDate: str('新的截止日期 YYYY-MM-DD；传空字符串表示与开始日期同日'),
        endTime: str('新的截止整点 HH:00；传空字符串表示使用默认 22:00'),
        priority: priorityParam,
        note: str('新详情（可选，多行文本，最多 500 字；传空字符串表示清空）'),
      }, ['taskId']),
      output: textOutput(),
      async execute(args, exec) {
        const { taskId, ...changes } = args ?? {}
        if (Object.keys(changes).length === 0) throw new Error('至少提供一个要修改的字段：title / date / time / endDate / endTime / priority / note')
        const data = await service.update(taskId, { changes }, toolActor(exec))
        return {
          ok: true,
          message: `已更新任务 ${data.task.id}：${data.task.title}｜${whenText(data.task)}｜${data.task.priority}${data.task.note ? `｜详情：${data.task.note}` : ''}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_delete',
      description: '硬删除一条任务（写前自动备份 SQLite 快照，任务工作台内不可恢复）。立即写入数据库。',
      parameters: objectParams({
        taskId: str('任务 ID，形如 T-1'),
      }, ['taskId']),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.remove(args?.taskId, {}, toolActor(exec))
        return {
          ok: true,
          message: `已删除任务 ${data.deleted.id}：${data.deleted.title}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
  ]
}
