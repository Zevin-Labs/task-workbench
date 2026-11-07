// AI 工具面：只调用 TaskService，不直接读写数据库；没有「完成」工具（完成只能由人）。
import { PRIORITIES } from '../core/contract.js'
import { toolActor } from './service.js'

function whenText(task) {
  if (task.type === 'range') {
    const start = `${task.date ?? '无日期'}${task.time ? ` ${task.time}` : ''}`
    const end = `${task.endDate ?? ''}${task.endTime ? ` ${task.endTime}` : ''}`
    return `${start} → ${end}`
  }
  return `${task.date ?? '无日期'}${task.time ? ` ${task.time}` : ''}`
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
const timeParam = str('时间 HH:mm（24 小时制），可选；不传或空字符串 = 全天')
const endDateParam = str('跨周期结束日期 YYYY-MM-DD，必须晚于 date；不传 = 当天任务')
const endTimeParam = str('跨周期结束时间 HH:mm，可选；需要同时提供 endDate')

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
      description: '读取任务工作台的「本周」视图：自然周（周一至周日）7 列；单日任务按日期落列，跨周期任务在区间内横跨。只读。',
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
      description: '读取单条任务详情（含任务类型、日期/时间、结束日期/时间）。只读。',
      parameters: objectParams({
        taskId: str('任务 ID，形如 T-1'),
      }, ['taskId']),
      output: textOutput(),
      async execute(args) {
        const data = await service.getTask(args?.taskId)
        const task = data.task
        return {
          ok: true,
          message: `任务 ${task.id}：${task.title}｜${whenText(task)}｜${task.type === 'range' ? '跨周期' : '当天'}｜${task.priority}｜${task.done ? `已完成 ${task.completed ?? ''}` : '未完成'}${task.note ? `｜备注：${task.note}` : ''}`,
          data,
        }
      },
    },
    {
      name: 'tw_create',
      description: '在任务工作台里创建一条任务并立即写入数据库。任务类型：不传 endDate = 当天任务；传 endDate = 跨周期任务（date 开始，endDate 结束）。时间可选，不传 = 全天。默认日期为今天，默认优先级为「重要不紧急」。AI 可以创建；失败会返回明确错误，不会假装成功。',
      parameters: objectParams({
        title: str('任务标题（必填，不能含换行）'),
        date: str('开始日期 YYYY-MM-DD；当天任务就是任务日期，默认今天'),
        time: timeParam,
        endDate: endDateParam,
        endTime: endTimeParam,
        priority: priorityParam,
        note: str('备注（单行，可选）'),
        confirmDuplicate: bool('如果 60 秒内已有同标题同日期任务，确认后传 true 再建'),
      }, ['title']),
      output: textOutput(),
      async execute(args, exec) {
        const data = await service.create(args ?? {}, toolActor(exec))
        return {
          ok: true,
          message: `已创建任务 ${data.task.id}：${data.task.title}｜${whenText(data.task)}｜${data.task.type === 'range' ? '跨周期' : '当天'}｜${data.task.priority}`,
          data,
          actor: toolActor(exec).id,
        }
      },
    },
    {
      name: 'tw_update',
      description: '编辑一条任务（标题 / 日期 / 时间 / 结束日期 / 结束时间 / 优先级 / 备注，字段白名单）。立即写入数据库。改成当天任务时把 endDate / endTime 传空字符串；改成跨周期任务时传 endDate（晚于 date）。',
      parameters: objectParams({
        taskId: str('任务 ID，形如 T-1'),
        title: str('新标题'),
        date: str('新的开始日期 YYYY-MM-DD'),
        time: str('新的时间 HH:mm；传空字符串表示全天'),
        endDate: str('新的结束日期 YYYY-MM-DD；传空字符串表示改回当天任务'),
        endTime: str('新的结束时间 HH:mm；传空字符串表示不设置'),
        priority: priorityParam,
        note: str('新备注；传空字符串表示清空'),
      }, ['taskId']),
      output: textOutput(),
      async execute(args, exec) {
        const { taskId, ...changes } = args ?? {}
        if (Object.keys(changes).length === 0) throw new Error('至少提供一个要修改的字段：title / date / time / endDate / endTime / priority / note')
        const data = await service.update(taskId, { changes }, toolActor(exec))
        return {
          ok: true,
          message: `已更新任务 ${data.task.id}：${data.task.title}｜${whenText(data.task)}｜${data.task.type === 'range' ? '跨周期' : '当天'}｜${data.task.priority}${data.task.note ? `｜备注：${data.task.note}` : ''}`,
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
