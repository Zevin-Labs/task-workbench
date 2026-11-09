// 任务工作台 · 浏览器半边
// Dock 图标 + 主面板（原生 React，不用 iframe）。所有数据通过同源 /tw/api/* 读写本地 SQLite。
window.__ModuleLoader__.load({
  id: 'dsh-task-workbench',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const PANEL_ID = 'task-workbench'
    const API = '/tw/api'
    const PRIORITIES = ['重要紧急', '重要不紧急', '不重要紧急', '不重要不紧急']
    const DEFAULT_PRIORITY = '重要不紧急'
    const PRIORITY_HINT = {
      重要紧急: 'error',
      重要不紧急: 'warn',
      不重要紧急: 'brand',
      不重要不紧急: 'idle',
    }

    // 想法池（V2.0）：状态/成熟度用中文枚举，与 host 契约同名；tone 名与 counts 键一致（todo/doing/done/dropped）。
    const IDEA_STATUSES = ['待实现', '推进中', '完成', '放弃']
    const IDEA_MATURITIES = ['低', '中', '高']
    const IDEA_MATURITY_FILTERS = ['高', '中', '低']
    const IDEA_STATUS_TONE = { 待实现: 'todo', 推进中: 'doing', 完成: 'done', 放弃: 'dropped' }
    const IDEA_STATUS_RANK = { 待实现: 0, 推进中: 1, 完成: 2, 放弃: 3 }
    const IDEA_MATURITY_RANK = { 高: 0, 中: 1, 低: 2 }
    const IDEA_MATURITY_LEVEL = { 低: 1, 中: 2, 高: 3 }
    const IDEA_DEFAULT_MATURITY = '低'
    const IDEA_STALE_DAYS = 14
    const IDEA_MATURITY_HINT = '低=念头 · 中=方向清楚 · 高=可直接排期'

    // ── 请求层 ────────────────────────────────────────────────────────────
    async function request(method, path, body) {
      const init = { method, cache: 'no-store', headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch (error) {
        const failure = new Error('连不上任务工作台服务，请确认插件已加载')
        failure.code = 'network-error'
        throw failure
      }
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (!response.ok || !payload || payload.ok !== true) {
        const info = payload && payload.error ? payload.error : { code: `http-${response.status}`, message: `请求失败（HTTP ${response.status}）` }
        const failure = new Error(info.message || '请求失败')
        failure.code = info.code || `http-${response.status}`
        failure.details = info.details
        failure.status = response.status
        throw failure
      }
      return payload.data
    }

    function newRequestId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
      } catch { /* ignore */ }
      return `twb-${Date.now()}-${Math.random().toString(16).slice(2)}`
    }

    // ── 通用工具 ──────────────────────────────────────────────────────────
    const pad2 = (n) => String(n).padStart(2, '0')
    const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    function parseDate(value) {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
      const [y, m, d] = value.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      return Number.isNaN(date.getTime()) ? null : date
    }
    function formatDate(date) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }
    function todayString() {
      return formatDate(new Date())
    }
    function diffDays(a, b) {
      const da = parseDate(a); const db = parseDate(b)
      if (!da || !db) return null
      return Math.round((da.getTime() - db.getTime()) / 86400000)
    }
    function friendlyDate(dateString, today) {
      if (!dateString) return '无日期'
      const diff = diffDays(dateString, today)
      if (diff === 0) return '今天'
      if (diff === -1) return '昨天'
      if (diff === 1) return '明天'
      const date = parseDate(dateString)
      if (!date) return dateString
      if (date.getFullYear() === new Date().getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    }
    function shortDate(dateString) {
      const date = parseDate(dateString)
      return date ? `${date.getMonth() + 1}/${date.getDate()}` : dateString
    }
    function weekdayOf(dateString) {
      const date = parseDate(dateString)
      return date ? WEEKDAY[date.getDay()] : ''
    }
    function addDays(dateString, days) {
      const date = parseDate(dateString)
      if (!date) return dateString
      date.setDate(date.getDate() + days)
      return formatDate(date)
    }
    const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
    function taskEndDate(task) {
      return task.type === 'range' ? task.endDate : task.date
    }
    function rangeLabel(task) {
      return `${shortDate(task.date)} → ${shortDate(task.endDate)}`
    }
    function rangeProgress(task, today) {
      if (task.type !== 'range' || !task.endDate) return ''
      const total = diffDays(task.endDate, task.date) + 1
      const passed = diffDays(today, task.date) + 1
      if (passed < 1 || passed > total) return ''
      return `第 ${passed}/${total} 天`
    }
    /** 跨周期剩余：截止日距今天几天（今天截止 = 0）；非跨周期或已过截止返回 null。 */
    function rangeRemaining(task, today) {
      if (task.type !== 'range' || !task.endDate) return null
      const days = diffDays(task.endDate, today)
      if (days === null || days < 0) return null
      const tone = days <= 1 ? 'error' : days <= 3 ? 'warn' : 'brand'
      const text = days === 0 ? '今天截止' : days === 1 ? '明天截止' : `剩 ${days} 天`
      return { days, tone, text }
    }
    function taskDateText(task, today) {
      if (task.type === 'range') {
        const start = `${shortDate(task.date)}${task.time ? ` ${task.time}` : ''}`
        const end = `${shortDate(task.endDate)}${task.endTime ? ` ${task.endTime}` : ''}`
        return `${start} → ${end}`
      }
      return `${friendlyDate(task.date, today)}${task.time ? ` ${task.time}` : ''}`
    }
    function cx(...names) {
      return names.filter(Boolean).join(' ')
    }

    // ── 想法池工具（计数/排序/放置天数；与 host 的 ideas 契约字段对齐）──────
    function ideaIsClosed(idea) {
      return idea.status === '完成' || idea.status === '放弃'
    }
    /** 由列表现算统计，保证卡片与数字永远一致；键同 bootstrap.ideas.counts。 */
    function ideaCountsOf(list) {
      const counts = { total: list.length, todo: 0, doing: 0, done: 0, dropped: 0, open: 0 }
      for (const idea of list) {
        const key = IDEA_STATUS_TONE[idea.status]
        if (key) counts[key] += 1
      }
      counts.open = counts.todo + counts.doing
      return counts
    }
    function ideaCountsFromBoot(raw) {
      const counts = { total: 0, todo: 0, doing: 0, done: 0, dropped: 0, open: 0 }
      if (!raw || typeof raw !== 'object') return counts
      for (const key of Object.keys(counts)) counts[key] = Number(raw[key]) || 0
      return counts
    }
    /** 未关闭想法的放置天数：优先用 host 的 staleDays，缺失时按 updated 现算。 */
    function ideaStaleDays(idea, today) {
      if (ideaIsClosed(idea)) return 0
      if (typeof idea.staleDays === 'number' && Number.isFinite(idea.staleDays)) return Math.max(0, idea.staleDays)
      const diff = diffDays(today, idea.updated)
      return diff === null ? 0 : Math.max(0, diff)
    }
    function ideaDateText(value) {
      return value ? shortDate(value) : '—'
    }
    function sortIdeas(list, mode) {
      const byUpdated = (a, b) => String(b.updated || '').localeCompare(String(a.updated || ''))
      const copy = list.slice()
      if (mode === 'updated') copy.sort(byUpdated)
      else if (mode === 'created') copy.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
      else if (mode === 'maturity') {
        copy.sort((a, b) => (IDEA_MATURITY_RANK[a.maturity] ?? 9) - (IDEA_MATURITY_RANK[b.maturity] ?? 9) || byUpdated(a, b))
      } else {
        copy.sort((a, b) => (IDEA_STATUS_RANK[a.status] ?? 9) - (IDEA_STATUS_RANK[b.status] ?? 9) || byUpdated(a, b))
      }
      return copy
    }

    // ── 复盘（日 / 周 / 月；正文只能由人写，AI 只读）──────────────────────
    const REVIEW_KIND_LABEL = { daily: '日复盘', weekly: '周复盘', monthly: '月复盘' }
    const REVIEW_MATERIAL_LIMIT = 8

    /** 周期的相对文案：今天 / 上周 10/26 – 11/1 / 本月 2026 年 11 月。 */
    function reviewPeriodText(prompt, today) {
      if (prompt.kind === 'daily') return `${friendlyDate(prompt.key, today)} · ${weekdayOf(prompt.key)}`
      if (prompt.kind === 'weekly') {
        return `${prompt.label || '上周'} · ${shortDate(prompt.periodStart)} – ${shortDate(prompt.periodEnd)}`
      }
      return `${prompt.label || '本月'} · ${prompt.key.slice(0, 4)} 年 ${Number(prompt.key.slice(5, 7))} 月`
    }

    function reviewTimeText(updatedAt) {
      if (!updatedAt) return ''
      const [date, time] = String(updatedAt).split(' ')
      return time ? `${shortDate(date)} ${time} 更新` : `${shortDate(date)} 更新`
    }

    function reviewPlaceholder(kind) {
      if (kind === 'daily') return '今天做了什么、卡在哪、明天怎么改…'
      if (kind === 'weekly') return '上周整体怎么样：推进了什么、卡在哪、下周怎么调（下周计划直接建任务即可）…'
      return '这个月整体回顾：关键进展、反复出现的卡点、下个月的重点…'
    }

    function reviewMaterialStats(prompt) {
      const materials = prompt.materials || {}
      const parts = [`完成 ${materials.completedCount || 0}`, `未完成 ${materials.pendingCount || 0}`]
      if (prompt.kind === 'weekly') parts.push(`日复盘 ${(materials.dailyReviews || []).length} 条`)
      else parts.push(`周复盘 ${(materials.weeklyReviews || []).length} 条`)
      return parts.join(' · ')
    }

    // ── 图标 ──────────────────────────────────────────────────────────────
    function svg(props, children) {
      return h('svg', {
        viewBox: '0 0 24 24', width: props.size || 16, height: props.size || 16,
        fill: 'none', stroke: 'currentColor', strokeWidth: props.strokeWidth || 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: props.style,
      }, children)
    }
    const IconCheck = (p) => svg(p || {}, h('path', { d: 'M4 12.5l5 5L20 6.5' }))
    const IconPlus = (p) => svg(p || {}, [h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })])
    const IconRefresh = (p) => svg(p || {}, [
      h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.34 5.66' }),
      h('path', { key: 'b', d: 'M20 5v6h-6' }),
    ])
    const IconClose = (p) => svg(p || {}, [h('path', { key: 'a', d: 'M6 6l12 12' }), h('path', { key: 'b', d: 'M18 6L6 18' })])
    const IconTrash = (p) => svg(p || {}, [
      h('path', { key: 'a', d: 'M4 7h16' }),
      h('path', { key: 'b', d: 'M9 7V4h6v3' }),
      h('path', { key: 'c', d: 'M6 7l1 13h10l1-13' }),
      h('path', { key: 'd', d: 'M10 11v6M14 11v6' }),
    ])
    const IconEdit = (p) => svg(p || {}, [
      h('path', { key: 'a', d: 'M4 20h4l11-11-4-4L4 16z' }),
      h('path', { key: 'b', d: 'M13.5 6.5l4 4' }),
    ])
    const IconSettings = (p) => svg(p || {}, [
      h('circle', { key: 'a', cx: 12, cy: 12, r: 3 }),
      h('path', { key: 'b', d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z' }),
    ])
    const IconCalendar = (p) => svg(p || {}, [
      h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 16, rx: 3 }),
      h('path', { key: 'b', d: 'M8 3v4M16 3v4M3 10h18' }),
    ])
    const IconInbox = (p) => svg(p || {}, [
      h('path', { key: 'a', d: 'M4 5h16v14H4z' }),
      h('path', { key: 'b', d: 'M4 13h4l2 3h4l2-3h4' }),
    ])
    const IconAlert = (p) => svg(p || {}, [
      h('path', { key: 'a', d: 'M12 4l9 16H3z' }),
      h('path', { key: 'b', d: 'M12 10v4M12 17.5v.5' }),
    ])
    const IconClock = (p) => svg(p || {}, [
      h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
      h('path', { key: 'b', d: 'M12 7.5V12l3 2' }),
    ])

    function Checkbox({ checked, busy, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        className: cx('twb-check', checked && 'is-checked', disabled && 'is-readonly'),
        'aria-label': label,
        'aria-checked': checked,
        role: 'checkbox',
        disabled: busy || disabled,
        onClick: onChange,
      }, checked ? h(IconCheck, { size: 12, strokeWidth: 2.6 }) : null)
    }

    function PriorityBadge({ priority }) {
      const tone = PRIORITY_HINT[priority] || 'idle'
      return h('span', { className: `twb-priority twb-tone-${tone}` }, priority)
    }

    function IconButton({ title, onClick, disabled, children, danger }) {
      return h('button', {
        type: 'button', className: cx('twb-icon-btn', danger && 'is-danger'),
        title, 'aria-label': title, onClick, disabled,
      }, children)
    }

    function isHistoricalTaskReadOnly(task, today) {
      return Boolean(task.done && task.completed && today && task.completed.slice(0, 7) < today.slice(0, 7))
    }

    function TaskRow({ task, today, version, busy, onToggle, onEdit, onDelete, showDate, compact, showRemaining, priorityInHead, hidePriority, onRowClick }) {
      const range = task.type === 'range'
      const historyReadOnly = isHistoricalTaskReadOnly(task, today)
      const end = taskEndDate(task)
      const overdue = !task.done && end && end < today
      const remaining = showRemaining && !task.done ? rangeRemaining(task, today) : null
      const meta = []
      if (remaining) {
        meta.push(h('span', { key: 'remaining', className: `twb-due twb-tone-${remaining.tone}` },
          h(IconClock, { size: 12 }),
          remaining.text,
        ))
      }
      if (range) {
        const progress = rangeProgress(task, today)
        meta.push(h('span', { key: 'range', className: 'twb-meta-range' },
          h(IconCalendar, { size: 12 }),
          `跨周期 ${rangeLabel(task)}${progress ? ` · ${progress}` : ''}`,
        ))
        if (task.time) meta.push(h('span', { key: 'start-time', className: 'twb-meta-time' }, h(IconClock, { size: 12 }), `${task.time} 起`))
        if (task.endTime) meta.push(h('span', { key: 'end-time', className: 'twb-meta-time' }, h(IconClock, { size: 12 }), `截止 ${task.endTime}`))
      } else {
        if (showDate) {
          meta.push(h('span', { key: 'date', className: cx('twb-meta-date', overdue && 'is-overdue') },
            h(IconCalendar, { size: 12 }),
            friendlyDate(task.date, today),
          ))
        }
        if (task.time) meta.push(h('span', { key: 'time', className: 'twb-meta-time' }, h(IconClock, { size: 12 }), task.time))
      }
      if (overdue) {
        meta.push(h('span', { key: 'overdue', className: 'twb-meta-overdue' }, `逾期 ${Math.abs(diffDays(today, end))} 天`))
      }
      if (!priorityInHead && !hidePriority) meta.push(h(PriorityBadge, { key: 'priority', priority: task.priority }))
      if (task.done && task.completed) meta.push(h('span', { key: 'done', className: 'twb-meta-done' }, `完成于 ${shortDate(task.completed)}`))
      if (task.note) meta.push(h('span', { key: 'note', className: 'twb-meta-note', title: task.note }, task.note))
      if (historyReadOnly) meta.push(h('span', { key: 'history-readonly', className: 'twb-meta-done' }, '过月已完成 · 只读'))
      return h('div', { className: cx('twb-row', task.done && 'is-done', compact && 'is-compact') },
        h(Checkbox, {
          checked: task.done,
          busy,
          disabled: historyReadOnly,
          label: task.done ? `撤销完成：${task.title}` : `完成：${task.title}`,
          onChange: () => onToggle(task, version),
        }),
        h('div', {
          className: cx('twb-row-main', onRowClick && 'is-clickable'),
          onClick: onRowClick ? () => onRowClick(task) : undefined,
        },
          h('div', { className: 'twb-row-head' },
            h('button', {
              type: 'button', className: 'twb-row-title', disabled: historyReadOnly,
              title: historyReadOnly ? '过月已完成的任务只读' : undefined,
              onClick: (event) => { if (onRowClick) event.stopPropagation(); onEdit(task, version) },
            }, task.title),
            priorityInHead ? h(PriorityBadge, { key: 'priority', priority: task.priority }) : null,
          ),
          h('div', { className: 'twb-row-meta' }, meta),
        ),
        h('div', { className: 'twb-row-actions' },
          h(IconButton, { title: historyReadOnly ? '过月已完成的任务只读' : '编辑任务', disabled: historyReadOnly, onClick: () => onEdit(task, version) }, h(IconEdit, { size: 15 })),
          h(IconButton, { title: historyReadOnly ? '过月已完成的任务只读' : '删除任务', danger: true, disabled: historyReadOnly, onClick: () => onDelete(task, version) }, h(IconTrash, { size: 15 })),
        ),
      )
    }

    function EmptyState({ icon, title, hint, action }) {
      return h('div', { className: 'twb-empty' },
        h('div', { className: 'twb-empty-icon' }, icon || h(IconInbox, { size: 22 })),
        h('div', { className: 'twb-empty-title' }, title),
        hint ? h('div', { className: 'twb-empty-hint' }, hint) : null,
        action || null,
      )
    }

    function SectionTitle({ children, count }) {
      return h('div', { className: 'twb-section-title' },
        h('span', null, children),
        typeof count === 'number' ? h('span', { className: 'twb-count' }, count) : null,
      )
    }

    // ── 表单与弹窗 ────────────────────────────────────────────────────────
    function Modal({ title, subtitle, children, footer, onClose, wide }) {
      React.useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'twb-overlay', role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: cx('twb-modal', wide && 'is-wide'), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'twb-modal-head' },
            h('div', null,
              h('div', { className: 'twb-modal-title' }, title),
              subtitle ? h('div', { className: 'twb-modal-subtitle' }, subtitle) : null,
            ),
            h(IconButton, { title: '关闭', onClick: onClose }, h(IconClose, { size: 16 })),
          ),
          h('div', { className: 'twb-modal-body' }, children),
          footer ? h('div', { className: 'twb-modal-foot' }, footer) : null,
        ),
      )
    }

    function TimeInput({ value, onChange, label }) {
      return h('div', { className: 'twb-time' },
        h('input', {
          className: 'twb-input', type: 'time', value,
          onChange: (event) => onChange(event.target.value),
        }),
        value ? h('button', {
          type: 'button', className: 'twb-time-clear', title: '清除时间', 'aria-label': `清除${label}`,
          onClick: () => onChange(''),
        }, h(IconClose, { size: 12 })) : null,
      )
    }

    function TaskForm({ mode, initial, today, busy, onSubmit, onBack }) {
      const [type, setType] = React.useState(initial?.type === 'range' ? 'range' : 'single')
      const [title, setTitle] = React.useState(initial?.title || '')
      const [date, setDate] = React.useState(initial?.date || today)
      const [time, setTime] = React.useState(initial?.time || '')
      const [endDate, setEndDate] = React.useState(initial?.endDate || '')
      const [endTime, setEndTime] = React.useState(initial?.endTime || '')
      const [priority, setPriority] = React.useState(initial?.priority || DEFAULT_PRIORITY)
      const [note, setNote] = React.useState(initial?.note || '')
      const [error, setError] = React.useState(null)
      const titleRef = React.useRef(null)
      React.useEffect(() => { if (titleRef.current) titleRef.current.focus() }, [])

      function switchType(next) {
        if (next === type) return
        if (next === 'range') {
          setEndDate((prev) => prev || addDays(date, 1))
        } else {
          setEndDate('')
          setEndTime('')
        }
        setType(next)
      }

      function changeStartDate(nextDate) {
        setDate(nextDate)
        if (type === 'range' && (!endDate || endDate <= nextDate)) setEndDate(addDays(nextDate, 1))
      }

      function submit(event) {
        event.preventDefault()
        const cleanTitle = title.trim()
        if (!cleanTitle) { setError('标题不能为空'); return }
        if (!parseDate(date)) { setError('请选择合法的开始日期'); return }
        if (time && !TIME_RE.test(time)) { setError('时间格式应为 HH:mm'); return }
        if (type === 'range') {
          if (!parseDate(endDate)) { setError('跨周期任务需要选择结束日期'); return }
          if (endDate <= date) { setError('结束日期必须晚于开始日期；同一天的任务请选「当天」'); return }
          if (endTime && !TIME_RE.test(endTime)) { setError('结束时间格式应为 HH:mm'); return }
        }
        setError(null)
        onSubmit({
          title: cleanTitle,
          date,
          time: time || '',
          endDate: type === 'range' ? endDate : '',
          endTime: type === 'range' ? (endTime || '') : '',
          priority,
          note: note.trim(),
        })
      }

      return h('form', { className: 'twb-form', onSubmit: submit },
        h('label', { className: 'twb-field' },
          h('span', { className: 'twb-field-label' }, '标题'),
          h('input', {
            ref: titleRef, className: 'twb-input', value: title, maxLength: 200,
            placeholder: '要做什么？', onChange: (event) => setTitle(event.target.value),
          }),
        ),
        h('div', { className: 'twb-field' },
          h('span', { className: 'twb-field-label' }, '任务类型'),
          h('div', { className: 'twb-type-switch', role: 'group', 'aria-label': '任务类型' },
            h('button', {
              type: 'button', className: cx('twb-type-btn', type === 'single' && 'is-active'),
              'aria-pressed': type === 'single', onClick: () => switchType('single'),
            }, '当天'),
            h('button', {
              type: 'button', className: cx('twb-type-btn', type === 'range' && 'is-active'),
              'aria-pressed': type === 'range', onClick: () => switchType('range'),
            }, '跨周期'),
          ),
        ),
        h('div', { className: 'twb-field-row' },
          h('label', { className: 'twb-field' },
            h('span', { className: 'twb-field-label' }, type === 'range' ? '开始日期' : '日期'),
            h('input', { className: 'twb-input', type: 'date', value: date, onChange: (event) => changeStartDate(event.target.value) }),
          ),
          h('label', { className: 'twb-field' },
            h('span', { className: 'twb-field-label' }, type === 'range' ? '开始时间（可选）' : '时间（可选）'),
            h(TimeInput, { value: time, onChange: setTime, label: '开始时间' }),
          ),
        ),
        type === 'range' ? h('div', { className: 'twb-field-row' },
          h('label', { className: 'twb-field' },
            h('span', { className: 'twb-field-label' }, '结束日期'),
            h('input', { className: 'twb-input', type: 'date', value: endDate, onChange: (event) => setEndDate(event.target.value) }),
          ),
          h('label', { className: 'twb-field' },
            h('span', { className: 'twb-field-label' }, '结束时间（可选）'),
            h(TimeInput, { value: endTime, onChange: setEndTime, label: '结束时间' }),
          ),
        ) : null,
        h('div', { className: 'twb-hint' }, type === 'range'
          ? '跨周期任务从开始日期持续到结束日期；时间留空 = 全天。'
          : '时间留空 = 全天任务。'),
        h('div', { className: 'twb-field-row' },
          h('label', { className: 'twb-field' },
            h('span', { className: 'twb-field-label' }, '优先级'),
            h('select', { className: 'twb-input', value: priority, onChange: (event) => setPriority(event.target.value) },
              PRIORITIES.map((value) => h('option', { key: value, value }, value)),
            ),
          ),
          h('label', { className: 'twb-field' },
            h('span', { className: 'twb-field-label' }, '备注'),
            h('input', {
              className: 'twb-input', value: note, maxLength: 500, placeholder: '可选，单行',
              onChange: (event) => setNote(event.target.value),
            }),
          ),
        ),
        error ? h('div', { className: 'twb-form-error' }, error) : null,
        h('div', { className: 'twb-form-actions' },
          h('button', { type: 'button', className: 'twb-btn', onClick: onBack, disabled: busy }, '取消'),
          h('button', { type: 'submit', className: 'twb-btn is-primary', disabled: busy },
            busy ? '保存中…' : (mode === 'edit' ? '保存修改' : '创建任务'),
          ),
        ),
      )
    }

    function ConfirmDelete({ task, busy, onConfirm, onBack }) {
      return h('div', { className: 'twb-confirm' },
        h('div', { className: 'twb-confirm-icon' }, h(IconTrash, { size: 20 })),
        h('div', { className: 'twb-confirm-title' }, `删除「${task.title}」？`),
        h('div', { className: 'twb-confirm-text' }, '这是硬删除，会立即从工作台移除；删除前会备份数据库快照，可在数据根目录的「备份」中手工找回，但工作台内不可撤销。'),
        h('div', { className: 'twb-form-actions' },
          h('button', { type: 'button', className: 'twb-btn', onClick: onBack, disabled: busy }, '取消'),
          h('button', { type: 'button', className: 'twb-btn is-danger', onClick: onConfirm, disabled: busy }, busy ? '删除中…' : '确认删除'),
        ),
      )
    }

    function DuplicateConfirm({ task, busy, onConfirm, onBack }) {
      return h('div', { className: 'twb-confirm' },
        h('div', { className: 'twb-confirm-icon is-warn' }, h(IconAlert, { size: 20 })),
        h('div', { className: 'twb-confirm-title' }, '疑似重复任务'),
        h('div', { className: 'twb-confirm-text' }, `60 秒内已经创建过「${task.title}」（${task.type === 'range' ? rangeLabel(task) : task.date}）。确认要再建一条吗？`),
        h('div', { className: 'twb-form-actions' },
          h('button', { type: 'button', className: 'twb-btn', onClick: onBack, disabled: busy }, '取消'),
          h('button', { type: 'button', className: 'twb-btn is-primary', onClick: onConfirm, disabled: busy }, busy ? '创建中…' : '仍然创建'),
        ),
      )
    }

    // ── 复盘视图组件 ────────────────────────────────────────────────────────
    function ReviewLineList({ title, items, empty }) {
      if (!items || items.length === 0) {
        return h('div', { className: 'twb-review-material' },
          h('div', { className: 'twb-review-material-title' }, title),
          h('div', { className: 'twb-review-material-empty' }, empty),
        )
      }
      const shown = items.slice(0, REVIEW_MATERIAL_LIMIT)
      return h('div', { className: 'twb-review-material' },
        h('div', { className: 'twb-review-material-title' }, `${title}（${items.length}）`),
        shown.map((item, index) => h('div', { key: `line-${index}`, className: 'twb-review-material-line' }, item)),
        items.length > shown.length ? h('div', { className: 'twb-review-material-empty' }, `…还有 ${items.length - shown.length} 条`) : null,
      )
    }

    function ReviewMaterials({ prompt }) {
      const materials = prompt.materials || {}
      const isWeekly = prompt.kind === 'weekly'
      const completed = (materials.completed || []).map((task) => `${task.title}（${shortDate(task.completed || task.date)} 完成）`)
      const pending = (materials.pending || []).map((task) => `${task.title}（截止 ${shortDate(task.endDate || task.date)}）`)
      const notes = isWeekly ? (materials.dailyReviews || []) : (materials.weeklyReviews || [])
      return h('details', { className: 'twb-review-materials' },
        h('summary', null, `${isWeekly ? '上周材料' : '本月材料'} · ${reviewMaterialStats(prompt)}`),
        h('div', { className: 'twb-review-materials-body' },
          h(ReviewLineList, { title: '已完成任务', items: completed, empty: '没有完成记录' }),
          h(ReviewLineList, { title: '到期未完成', items: pending, empty: '没有到期未完成的任务' }),
          h('div', { className: 'twb-review-material' },
            h('div', { className: 'twb-review-material-title' }, isWeekly ? `上周日复盘（${notes.length}）` : `本月周复盘（${notes.length}）`),
            notes.length === 0
              ? h('div', { className: 'twb-review-material-empty' }, isWeekly ? '上周没有日复盘记录' : '本月没有周复盘记录')
              : notes.slice(0, REVIEW_MATERIAL_LIMIT).map((note) => h('div', { key: `note-${note.key}`, className: 'twb-review-material-note' },
                h('div', { className: 'twb-review-material-note-head' }, isWeekly
                  ? `${shortDate(note.key)} ${weekdayOf(note.key)}`
                  : `${shortDate(note.key)} – ${shortDate(addDays(note.key, 6))}`),
                h('div', { className: 'twb-review-material-note-text' }, note.text),
              )),
          ),
        ),
      )
    }

    function ReviewBlock({ prompt, today, busy, onSave, onClear }) {
      const done = prompt.state === 'done'
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(prompt.review?.text ?? '')
      const [draftVersion, setDraftVersion] = React.useState(prompt.version)
      React.useEffect(() => {
        if (!editing) {
          setDraft(prompt.review?.text ?? '')
          setDraftVersion(prompt.version)
        }
      }, [prompt.key, prompt.kind, prompt.review?.updatedAt, prompt.version, editing])
      const disabled = busy
      const canSubmit = !disabled && draft.trim() !== ''
      const showInput = !done || editing

      async function submit() {
        const result = await onSave(prompt, draft, draftVersion)
        if (!result) return
        setDraft(result.review?.text ?? draft)
        setDraftVersion(result.version)
        setEditing(false)
      }

      function cancelEdit() {
        setEditing(false)
        setDraft(prompt.review?.text ?? '')
        setDraftVersion(prompt.version)
      }

      return h('div', { className: cx('twb-review-card', done && !editing && 'is-done') },
        h('div', { className: 'twb-review-head' },
          h('span', { className: cx('twb-review-kind', `is-${prompt.kind}`) }, REVIEW_KIND_LABEL[prompt.kind] || prompt.kind),
          h('span', { className: 'twb-review-period' }, reviewPeriodText(prompt, today)),
          h('span', { className: 'twb-review-state' }, done ? `已写 · ${reviewTimeText(prompt.review?.updatedAt)}` : '待写'),
        ),
        prompt.materials ? h(ReviewMaterials, { prompt }) : null,
        showInput
          ? h('div', null,
            h('textarea', {
              className: 'twb-input twb-review-textarea',
              rows: prompt.kind === 'daily' ? 4 : 6,
              value: draft,
              placeholder: reviewPlaceholder(prompt.kind),
              disabled,
              onChange: (event) => {
                if (!editing) {
                  setDraftVersion(prompt.version)
                  setEditing(true)
                }
                setDraft(event.target.value)
              },
            }),
            h('div', { className: 'twb-review-actions' },
              h('span', { className: 'twb-review-hint' }, '内容由你写，AI 只读'),
              editing ? h('button', {
                type: 'button', className: 'twb-btn is-subtle', disabled,
                onClick: cancelEdit,
              }, '取消') : null,
              h('button', {
                type: 'button', className: 'twb-btn is-primary', disabled: !canSubmit,
                onClick: submit,
              }, busy ? '保存中…' : done ? '保存修改' : '提交复盘'),
            ),
          )
          : h('div', null,
            h('div', { className: 'twb-review-text' }, prompt.review?.text ?? ''),
            h('div', { className: 'twb-review-actions' },
              h('span', { className: 'twb-review-hint' }, '内容由你写，AI 只读'),
              h('button', { type: 'button', className: 'twb-btn is-subtle', disabled, onClick: () => { setDraftVersion(prompt.version); setEditing(true) } }, '编辑'),
              h('button', { type: 'button', className: 'twb-btn is-subtle', disabled, onClick: () => onClear(prompt, prompt.version) }, '清空'),
            ),
          ),
      )
    }

    function weekStartKey(dateString) {
      const date = parseDate(dateString)
      if (!date) return dateString
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
      return formatDate(date)
    }

    function ReviewHistory({ today }) {
      const [kind, setKind] = React.useState('daily')
      const [key, setKey] = React.useState(today)
      const [loading, setLoading] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState('')

      function changeKind(nextKind) {
        setKind(nextKind)
        setKey(nextKind === 'weekly' ? weekStartKey(today) : nextKind === 'monthly' ? today.slice(0, 7) : today)
        setResult(null)
        setError('')
      }

      async function lookup(event) {
        event.preventDefault()
        const periodKey = key.trim()
        const valid = kind === 'monthly'
          ? /^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)
          : /^\d{4}-\d{2}-\d{2}$/.test(periodKey)
            && Boolean(parseDate(periodKey))
            && formatDate(parseDate(periodKey)) === periodKey
            && (kind !== 'weekly' || weekStartKey(periodKey) === periodKey)
        if (!valid) {
          setResult(null)
          setError(kind === 'monthly'
            ? '月份格式应为 YYYY-MM。'
            : kind === 'weekly' ? '周复盘键应为该自然周周一的 YYYY-MM-DD。' : '日期格式应为 YYYY-MM-DD。')
          return
        }
        setLoading(true)
        setResult(null)
        setError('')
        try {
          const data = await request('GET', `/reviews/${kind}/${encodeURIComponent(periodKey)}`)
          setResult(data.review)
        } catch (failure) {
          setError(failure?.code === 'not-found' ? '该周期还没有复盘记录。' : failure?.message || '查询失败。')
        } finally {
          setLoading(false)
        }
      }

      return h('details', { className: 'twb-review-materials twb-review-history' },
        h('summary', null, '历史复盘'),
        h('div', { className: 'twb-review-materials-body' },
          h('form', { className: 'twb-review-history-form', onSubmit: lookup },
            h('select', { className: 'twb-input', value: kind, disabled: loading, onChange: (event) => changeKind(event.target.value), 'aria-label': '复盘类型' },
              Object.entries(REVIEW_KIND_LABEL).map(([value, label]) => h('option', { key: value, value }, label)),
            ),
            h('input', {
              className: 'twb-input', value: key, disabled: loading,
              placeholder: kind === 'monthly' ? 'YYYY-MM' : kind === 'weekly' ? '周一日期 YYYY-MM-DD' : 'YYYY-MM-DD',
              'aria-label': '日期或周期键',
              onChange: (event) => { setKey(event.target.value); setResult(null); setError('') },
            }),
            h('button', { type: 'submit', className: 'twb-btn', disabled: loading }, loading ? '查询中…' : '查询'),
          ),
          error ? h('div', { className: 'twb-review-material-empty', role: 'status' }, error) : null,
          result ? h('div', { className: 'twb-review-material' },
            h('div', { className: 'twb-review-material-title' }, `${REVIEW_KIND_LABEL[result.kind]} · ${result.key} · ${reviewTimeText(result.updatedAt)}`),
            h('div', { className: 'twb-review-text' }, result.text),
          ) : null,
        ),
      )
    }

    function ReviewSection({ board, today, busy, onSave, onClear }) {
      const prompts = board?.prompts ?? []
      if (prompts.length === 0) return null
      return h('section', { className: 'twb-section twb-review-section' },
        h(SectionTitle, null, '复盘'),
        prompts.map((prompt) => h(ReviewBlock, {
          key: `${prompt.kind}-${prompt.key}`,
          prompt, today, busy, onSave, onClear,
        })),
        h(ReviewHistory, { today }),
      )
    }

    function ConfirmReviewClear({ prompt, today, busy, onConfirm, onBack }) {
      return h('div', { className: 'twb-confirm' },
        h('div', { className: 'twb-confirm-icon' }, h(IconTrash, { size: 20 })),
        h('div', { className: 'twb-confirm-title' }, `清空「${REVIEW_KIND_LABEL[prompt.kind] || prompt.kind} · ${reviewPeriodText(prompt, today)}」？`),
        h('div', { className: 'twb-confirm-text' }, '正文会被移除，这条复盘回到「待写」；清空前会备份数据库快照，可在数据根目录的「备份」中手工找回。'),
        h('div', { className: 'twb-form-actions' },
          h('button', { type: 'button', className: 'twb-btn', onClick: onBack, disabled: busy }, '取消'),
          h('button', { type: 'button', className: 'twb-btn is-danger', onClick: onConfirm, disabled: busy }, busy ? '清空中…' : '确认清空'),
        ),
      )
    }

    // ── 视图 ──────────────────────────────────────────────────────────────
    function TodayView({ data, today, busy, reviews, onToggle, onEdit, onDelete, onCreate, onSaveReview, onClearReview }) {
      if (!data) return h(LoadingBlock)
      const total = data.overdue.length + data.open.length
      return h('div', { className: 'twb-view' },
        h('div', { className: 'twb-today-summary' },
          h('div', { className: 'twb-summary-main' },
            h('div', { className: 'twb-summary-date' }, friendlyDate(data.date, today)),
            h('div', { className: 'twb-summary-sub' }, `${weekdayOf(data.date)} · ${data.date}`),
          ),
          h('div', { className: 'twb-summary-stats' },
            h('div', { className: 'twb-stat' }, h('span', { className: 'twb-stat-num' }, total), h('span', { className: 'twb-stat-label' }, '待办')),
            h('div', { className: 'twb-stat' }, h('span', { className: 'twb-stat-num is-warn' }, data.overdue.length), h('span', { className: 'twb-stat-label' }, '逾期')),
            h('div', { className: 'twb-stat' }, h('span', { className: 'twb-stat-num is-ok' }, data.completed.length), h('span', { className: 'twb-stat-label' }, '今日完成')),
          ),
        ),
        data.overdue.length > 0 ? h('section', { className: 'twb-section is-overdue' },
          h(SectionTitle, { count: data.overdue.length }, '逾期未完成'),
          h('div', { className: 'twb-list' }, data.overdue.map((task) => h(TaskRow, {
            key: task.id, task, today, version: data.version, busy, showDate: true, priorityInHead: true, onToggle, onEdit, onDelete,
          }))),
        ) : null,
        h('section', { className: 'twb-section' },
          h(SectionTitle, { count: data.open.length }, '今天要做'),
          data.open.length === 0
            ? h(EmptyState, {
              icon: h(IconCheck, { size: 22 }),
              title: '今天没有待办了',
              hint: '可以新建一条，或者去本周看看。',
              action: h('button', { type: 'button', className: 'twb-btn is-primary', onClick: () => onCreate(data.date, data.version) }, h(IconPlus, { size: 15 }), '新建任务'),
            })
            : h('div', { className: 'twb-list' }, data.open.map((task) => h(TaskRow, {
              key: task.id, task, today, version: data.version, busy, showDate: false, showRemaining: true, priorityInHead: true, onToggle, onEdit, onDelete,
            }))),
        ),
        h('section', { className: 'twb-section is-muted' },
          h(SectionTitle, { count: data.completed.length }, '今天已完成'),
          data.completed.length === 0
            ? h('div', { className: 'twb-section-empty' }, '还没有完成记录。')
            : h('div', { className: 'twb-list' }, data.completed.map((task) => h(TaskRow, {
              key: task.id, task, today, version: data.version, busy, showDate: false, compact: true, priorityInHead: true, onToggle, onEdit, onDelete,
            }))),
        ),
        reviews && reviews.error
          ? h('section', { className: 'twb-section' },
            h('div', { className: 'twb-review-error' }, `复盘加载失败：${reviews.error.message || String(reviews.error)}`))
          : reviews ? h(ReviewSection, {
            board: reviews, today, busy, onSave: onSaveReview, onClear: onClearReview,
          }) : null,
      )
    }

    // ── 本周 / 本月概览 + 月历（本周页底部；只读翻月、点日期看当天任务）──
    const MONTH_WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

    function monthDayTitle(day) {
      const head = `${day.date}${day.isToday ? '（今天）' : ''}`
      if (!day.inMonth) return `${head}\n点击查看所在月份`
      if (!day.items.length) return `${head}\n没有任务\n点击查看当天任务`
      const lines = day.items.map((item) => `${item.type === 'range' ? '▸' : item.done ? '✓' : '·'} ${item.title}${item.deadline ? '（截止）' : ''}`)
      return [head, ...lines, '点击查看当天任务'].join('\n')
    }

    function CompletionRing({ stats }) {
      const size = 184
      const radius = 76
      const strokeWidth = 16
      const circumference = 2 * Math.PI * radius
      const gap = 3
      const total = Math.max(0, stats.total || 0)
      const done = Math.max(0, stats.done || 0)
      const segments = [
        { key: 'done', value: done, color: 'var(--dsw-alias-state-success-primary)' },
        { key: 'doing', value: Math.max(0, stats.doing || 0), color: 'var(--dsw-alias-state-warn-primary)' },
        { key: 'overdue', value: Math.max(0, stats.overdue || 0), color: 'var(--dsw-alias-state-error-primary)' },
      ]
      let cursor = 0
      const arcs = []
      for (const segment of segments) {
        if (total <= 0 || segment.value <= 0) continue
        const length = (segment.value / total) * circumference
        const dash = Math.max(length - gap, 0.5)
        arcs.push(h('circle', {
          key: segment.key,
          cx: size / 2, cy: size / 2, r: radius, fill: 'none',
          strokeWidth, strokeLinecap: 'butt',
          strokeDasharray: `${dash} ${circumference - dash}`,
          strokeDashoffset: -(cursor + gap / 2),
          style: { stroke: segment.color },
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        }))
        cursor += length
      }
      const center = total === 0
        ? { big: '—', cap: '暂无任务', small: false }
        : done === 0
          ? { big: `${done} / ${total}`, cap: '已完成', small: true }
          : { big: `${Math.round((done / total) * 100)}%`, cap: `${done} / ${total} 已完成`, small: false }
      return h('div', {
        className: 'twb-ring',
        style: { width: `${size}px`, height: `${size}px` },
        role: 'img',
        'aria-label': `完成情况：${center.cap}`,
      },
        h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
          h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', strokeWidth, className: 'twb-ring-track' }),
          arcs,
        ),
        h('div', { className: 'twb-ring-center' },
          h('div', { className: cx('twb-ring-num', center.small && 'is-sm') }, center.big),
          h('div', { className: 'twb-ring-cap' }, center.cap),
        ),
      )
    }

    function OverviewCard({ kind, week, month, today }) {
      const stats = kind === 'week' ? week.stats : month.stats
      const rows = [
        { key: 'total', label: '总任务', value: stats.total, tone: 'idle' },
        { key: 'done', label: '已完成', value: stats.done, tone: 'ok' },
        { key: 'doing', label: '进行中', value: stats.doing, tone: 'warn' },
        { key: 'overdue', label: '逾期', value: stats.overdue, tone: 'bad' },
      ]
      const sub = kind === 'week' ? `${shortDate(week.start)} – ${shortDate(week.end)}` : month.label
      const isCurrentMonth = kind === 'month' && month.month === String(today || '').slice(0, 7)
      const title = kind === 'week' ? '本周概览' : isCurrentMonth ? '本月概览' : '月度概览'
      const note = kind === 'week'
        ? (stats.overdue > 0 ? `其中 ${stats.overdue} 条已逾期` : (stats.total > 0 && stats.done === 0 ? '本周还没有完成记录' : null))
        : (stats.overdue > 0 ? `其中 ${stats.overdue} 条逾期需要处理` : (stats.total === 0 ? '本月还没有任务' : null))
      const foot = kind === 'week'
        ? [
          h('span', { key: 'days' }, '有任务 ', h('b', null, stats.daysWithTasks), ' 天'),
          h('span', { key: 'span' }, '跨周期 ', h('b', null, week.counts.rangeOpen), ' 条'),
        ]
        : [
          h('span', { key: 'days' }, '有任务 ', h('b', null, stats.daysWithTasks), ' 天'),
          h('span', { key: 'busy' }, stats.busiest && stats.busiest.date ? `最忙 ${shortDate(stats.busiest.date)}` : '暂无排期'),
        ]
      return h('section', { className: 'twb-ov' },
        h('div', { className: 'twb-ov-head' },
          h('span', { className: 'twb-ov-title' }, title),
          h('span', { className: 'twb-ov-sub' }, sub),
        ),
        h(CompletionRing, { stats }),
        h('div', { className: 'twb-ov-stats' }, rows.map((row) => h('div', { key: row.key, className: 'twb-ov-stat' },
          h('div', { className: 'twb-ov-stat-label' },
            h('span', { className: `twb-ov-dot is-${row.tone}` }),
            row.label,
          ),
          h('div', { className: `twb-ov-stat-num is-${row.tone}` }, row.value, h('span', { className: 'twb-ov-unit' }, '条')),
        ))),
        note ? h('div', { className: 'twb-ov-note' }, note) : null,
        h('div', { className: 'twb-ov-foot' }, foot),
      )
    }

    function MonthCalendar({ month, busy, onOpenDay, onMonthChange }) {
      return h('section', { className: 'twb-cal' },
        h('div', { className: 'twb-cal-head' },
          h('button', { type: 'button', className: 'twb-cal-nav', title: '上个月', 'aria-label': '上个月', disabled: busy, onClick: () => onMonthChange(-1) }, '‹'),
          h('div', { className: 'twb-cal-title' }, month.label),
          h('button', { type: 'button', className: 'twb-cal-nav', title: '下个月', 'aria-label': '下个月', disabled: busy, onClick: () => onMonthChange(1) }, '›'),
          h('button', { type: 'button', className: 'twb-cal-today', disabled: busy, onClick: () => onMonthChange(0) }, '今天'),
        ),
        h('div', { className: 'twb-cal-week' }, MONTH_WEEKDAYS.map((label) => h('span', { key: label }, label))),
        h('div', { className: 'twb-cal-grid' },
          month.rows.map((row, rowIndex) => {
            const rowDays = month.days.slice(rowIndex * 7, rowIndex * 7 + 7)
            return h('div', { key: row.start, className: 'twb-cal-row' },
              rowDays.map((day) => h('button', {
                key: day.date,
                type: 'button',
                className: cx('twb-cal-cell', !day.inMonth && 'is-adj', day.isWeekend && 'is-weekend', day.isToday && 'is-today'),
                disabled: busy,
                title: monthDayTitle(day),
                'aria-label': `${day.date}${day.isToday ? ' 今天' : ''}${day.inMonth ? `，${day.total} 条任务` : ''}，点击查看当天任务`,
                onClick: () => onOpenDay(day.date),
              },
                h('span', { className: 'twb-cal-num' }, day.day),
                // 不画跨周期区间：单日任务与跨周期截止日各落一个任务点（open=红，done=灰）。
                day.inMonth && day.point
                  ? h('span', { className: cx('twb-cal-dot', day.point === 'done' && 'is-done') })
                  : null,
              )),
            )
          }),
        ),
        h('div', { className: 'twb-cal-legend' },
          h('span', null, h('i', { className: 'twb-legend-dot' }), '有待办'),
          h('span', null, h('i', { className: 'twb-legend-dot is-done' }), '全部完成'),
          h('span', { className: 'twb-cal-hint' }, '点日期查看当天任务 · 翻月只读'),
        ),
      )
    }

    function MonthBand({ week, month, today, busy, onOpenDay, onMonthChange }) {
      if (!week || !week.stats || !month) return null
      return h('div', { className: 'twb-month-band' },
        h(OverviewCard, { kind: 'week', week, month, today }),
        h(OverviewCard, { kind: 'month', week, month, today }),
        h(MonthCalendar, { month, busy, onOpenDay, onMonthChange }),
      )
    }

    // ── 当天任务详情（月历点日期进入；任务可勾选完成，点标题/行进入编辑）────
    function DayDetail({ date, month, today, busy, onToggle, onEdit, onDelete, onCreate, onClose }) {
      const day = (month?.days || []).find((item) => item.date === date)
      const items = day ? day.items : []
      const version = month?.version ?? 0
      const open = items.filter((item) => !item.done).length
      const finished = items.length - open
      const subtitle = [
        date,
        day && day.isToday ? '今天' : null,
        items.length > 0 ? `共 ${items.length} 条 · 待办 ${open} · 已完成 ${finished}` : null,
      ].filter(Boolean).join(' · ')
      return h(Modal, {
        title: '当天任务',
        subtitle,
        onClose,
        footer: [
          h('span', { key: 'spacer' }),
          h('div', { key: 'actions', className: 'twb-day-detail-actions' },
            h('button', { key: 'close', type: 'button', className: 'twb-btn', onClick: onClose }, '关闭'),
            h('button', {
              key: 'create', type: 'button', className: 'twb-btn is-primary', disabled: busy,
              onClick: () => onCreate(date, version),
            }, h(IconPlus, { size: 15 }), '在这一天新建任务'),
          ),
        ],
      },
        items.length === 0
          ? h(EmptyState, { title: '没有任务', hint: '这一天还没有安排任务，可用右下角按钮新建。' })
          : h('div', { className: 'twb-day-detail' }, items.map((task) => h(TaskRow, {
            key: task.id,
            task,
            today,
            version,
            busy,
            showDate: false,
            showRemaining: true,
            onToggle,
            onRowClick: (item) => onEdit(item, version, date),
            onEdit: (item) => onEdit(item, version, date),
            onDelete: (item) => onDelete(item, version, date),
          }))),
      )
    }

    // ── 本周页：日卡 + 跨周期轨道 ──────────────────────────────────────────
    // 跨周期任务按轨道贯穿 7 个日卡：线在最上层，线尾被「截止卡」盖住。
    // WEEK_HEAD 依赖日卡头的固定高度（1px 边框 + 34px），改样式时必须同步这两个常量。
    const WEEK_HEAD = 35
    const WEEK_LANE = 44
    const WEEK_CARD = 40
    const WEEK_SERIES = 6
    const WEEK_COL_W = '(100% - 48px) / 7'   // 7 列 + 6 个 8px 间隔
    const weekSeriesColor = (lane) => `var(--twb-series-${(lane % WEEK_SERIES) + 1})`
    const weekColCenter = (index) => `calc(${WEEK_COL_W} * ${index} + ${8 * index}px + ${WEEK_COL_W} / 2)`
    const weekColSpan = (count) => `calc(${WEEK_COL_W} * ${count} + ${8 * count}px)`

    /** 截止卡：跨周期任务在本周的落点（本周截止 = 截止日；延续到下周 = 周日）。 */
    function WeekSpanCard({ span, today, version, busy, onToggle, onEdit }) {
      const readOnly = isHistoricalTaskReadOnly(span, today)
      const remaining = span.done ? null : rangeRemaining(span, today)
      const overdue = !span.done && String(span.endDate) < today
      const flag = overdue || (remaining && remaining.days <= 1) ? 'error' : (remaining && remaining.days <= 2 ? 'warn' : null)
      const tip = [
        span.title,
        rangeLabel(span),
        remaining ? remaining.text : (overdue ? '已逾期' : ''),
      ].filter(Boolean).join(' · ')
      return h('div', {
        className: cx('twb-span-card', span.done && 'is-done'),
        style: {
          top: `${span.lane * WEEK_LANE + 2}px`,
          height: `${WEEK_CARD}px`,
          '--twb-series': weekSeriesColor(span.lane),
        },
        title: tip,
      },
        h(Checkbox, {
          checked: span.done,
          busy,
          disabled: readOnly,
          label: span.done ? `撤销完成：${span.title}` : `完成：${span.title}`,
          onChange: () => onToggle(span, version),
        }),
        h('button', {
          type: 'button',
          className: 'twb-span-card-title',
          disabled: readOnly,
          title: readOnly ? '过月已完成的任务只读' : tip,
          onClick: () => onEdit(span, version),
        }, span.title),
        flag ? h('span', { className: `twb-span-card-flag is-${flag}`, 'aria-hidden': true }) : null,
      )
    }

    function WeekView({ data, today, busy, onToggle, onEdit, onDelete, onCreate, onOpenDay, onMonthChange }) {
      if (!data) return h(LoadingBlock)
      const spans = data.spans || []
      const spanById = new Map(spans.map((span) => [span.id, span]))

      const dayNodes = data.days.map((day, index) => {
        const endCards = (day.spanEnds || []).map((id) => spanById.get(id)).filter(Boolean)
        const tasks = [...day.open, ...day.completed]
        const isEmpty = tasks.length === 0 && endCards.length === 0
        return h('div', {
          key: day.date,
          className: cx('twb-day', day.isToday && 'is-today', day.isPast && 'is-past', day.isFuture && 'is-future'),
          style: { gridColumn: index + 1 },
        },
          h('div', { className: 'twb-day-head' },
            h('div', { className: 'twb-day-name' }, day.label, day.isToday ? h('span', { className: 'twb-today-pill' }, '今天') : null),
            h('div', { className: 'twb-day-date' }, shortDate(day.date)),
            h(IconButton, { title: `在 ${day.date} 新建任务`, onClick: () => onCreate(day.date, data.version) }, h(IconPlus, { size: 14 })),
          ),
          day.spanLanes > 0
            ? h('div', { className: 'twb-day-band', style: { height: `${day.spanLanes * WEEK_LANE}px` } },
              endCards.map((span) => h(WeekSpanCard, {
                key: `span-${span.id}`, span, today, version: data.version, busy, onToggle, onEdit,
              })))
            : null,
          h('div', { className: 'twb-day-body' },
            isEmpty
              ? h('div', { className: 'twb-day-empty' }, '—')
              : tasks.map((task) => h('div', {
                key: task.id,
                className: cx('twb-day-task', `is-${PRIORITY_HINT[task.priority] || 'idle'}`, task.done && 'is-done'),
              }, h(TaskRow, {
                task, today, version: data.version, busy, showDate: false, compact: true, hidePriority: true, onToggle, onEdit, onDelete,
              }))),
          ),
        )
      })

      const lineNodes = []
      for (const span of spans) {
        // 线中心 = 卡片的垂直正中：日卡头 + 轨道偏移 + 卡在轨道里的 2px 缩进 + 半卡高
        const top = `${WEEK_HEAD + span.lane * WEEK_LANE + 2 + WEEK_CARD / 2 - 1.5}px`
        if (span.startsBefore) {
          // 上一周就开始：从日卡左边界外拉一小段虚线进来
          lineNodes.push(h('span', {
            key: `line-${span.id}`,
            className: 'twb-week-line is-clip',
            style: { left: '0px', width: weekColCenter(span.endIndex), top, background: weekSeriesColor(span.lane) },
          }))
          lineNodes.push(h('i', {
            key: `stub-${span.id}`,
            className: 'twb-week-stub',
            style: { left: '-20px', top, color: weekSeriesColor(span.lane) },
          }))
        } else {
          // 本周内开始：从那天日卡的水平中线起头
          lineNodes.push(h('span', {
            key: `line-${span.id}`,
            className: 'twb-week-line',
            style: {
              left: weekColCenter(span.startIndex),
              width: weekColSpan(Math.max(1, span.endIndex - span.startIndex)),
              top,
              background: weekSeriesColor(span.lane),
            },
          }, h('i', { className: 'twb-week-line-dot' })))
        }
      }

      return h('div', { className: 'twb-view twb-week-view' },
        h('div', { className: 'twb-week-head' },
          h('div', null,
            h('div', { className: 'twb-week-range' }, `${shortDate(data.start)} – ${shortDate(data.end)}`),
            h('div', { className: 'twb-week-sub' }, `自然周 · 周一至周日 · 待办 ${data.counts.open} 条${data.counts.rangeOpen ? ` · 跨周期 ${data.counts.rangeOpen} 条` : ''}`),
          ),
        ),
        h('div', { className: 'twb-week' },
          h('div', { className: 'twb-week-grid' }, dayNodes),
          spans.length > 0 ? h('div', { className: 'twb-week-lines' }, lineNodes) : null,
        ),
        h('div', { className: 'twb-week-foot' },
          spans.length > 0 ? h('span', null, h('i', { className: 'twb-week-legend-line' }), '跨周期（截止晚的在上）') : null,
          spans.length > 0 ? h('span', null, h('i', { className: 'twb-week-legend-flag' }), '今天/明天截止') : null,
          h('span', { className: 'twb-week-legend-label' }, '当日任务底色'),
          PRIORITIES.map((priority) => h('span', { key: priority },
            h('i', { className: cx('twb-week-legend-swatch', `is-${PRIORITY_HINT[priority] || 'idle'}`) }),
            priority,
          )),
          h('span', { className: 'twb-week-foot-hint' }, '点卡片编辑 · 勾选=完成 · 点＋按该日期新建'),
        ),
        h(MonthBand, {
          week: data,
          month: data.monthData,
          today,
          busy,
          onOpenDay,
          onMonthChange,
        }),
      )
    }

    function TasksView({ data, today, busy, onToggle, onEdit, onDelete, onCreate, reload }) {
      const [keyword, setKeyword] = React.useState('')
      const [status, setStatus] = React.useState('open')
      const [priority, setPriority] = React.useState('all')
      if (!data) return h(LoadingBlock)
      const filtered = data.tasks.filter((task) => {
        if (status === 'open' && task.done) return false
        if (status === 'done' && !task.done) return false
        if (priority !== 'all' && task.priority !== priority) return false
        if (keyword && !task.title.toLowerCase().includes(keyword.trim().toLowerCase())) return false
        return true
      })
      return h('div', { className: 'twb-view' },
        h('div', { className: 'twb-toolbar' },
          h('input', {
            className: 'twb-input twb-search', value: keyword, placeholder: '搜索标题…',
            onChange: (event) => setKeyword(event.target.value),
          }),
          h('select', { className: 'twb-input', value: status, onChange: (event) => setStatus(event.target.value) },
            h('option', { value: 'open' }, '未完成'),
            h('option', { value: 'done' }, '已完成'),
            h('option', { value: 'all' }, '全部'),
          ),
          h('select', { className: 'twb-input', value: priority, onChange: (event) => setPriority(event.target.value) },
            h('option', { value: 'all' }, '全部优先级'),
            PRIORITIES.map((value) => h('option', { key: value, value }, value)),
          ),
          h('button', { type: 'button', className: 'twb-btn', onClick: reload }, h(IconRefresh, { size: 15 }), '刷新'),
        ),
        h('div', { className: 'twb-table-head' },
          h('span', null, '任务'),
          h('span', null, '日期 / 时间'),
          h('span', null, '优先级'),
          h('span', null, '状态'),
          h('span', null, '操作'),
        ),
        filtered.length === 0
          ? h(EmptyState, {
            icon: h(IconInbox, { size: 22 }),
            title: '没有符合条件的任务',
            hint: keyword || status !== 'all' || priority !== 'all' ? '换个筛选条件试试。' : '新建一条任务开始记录。',
            action: h('button', { type: 'button', className: 'twb-btn is-primary', onClick: () => onCreate(today, data.version) }, h(IconPlus, { size: 15 }), '新建任务'),
          })
          : h('div', { className: 'twb-table' }, filtered.map((task) => h('div', {
            key: task.id, className: cx('twb-table-row', task.done && 'is-done'),
          },
            h('div', { className: 'twb-table-task' },
              h(Checkbox, { checked: task.done, busy, disabled: isHistoricalTaskReadOnly(task, today), label: task.done ? `撤销完成：${task.title}` : `完成：${task.title}`, onChange: () => onToggle(task, data.version) }),
              h('div', { className: 'twb-table-tasktext' },
                h('button', { type: 'button', className: 'twb-row-title', disabled: isHistoricalTaskReadOnly(task, today), title: isHistoricalTaskReadOnly(task, today) ? '过月已完成的任务只读' : undefined, onClick: () => onEdit(task, data.version) }, task.title),
                h('div', { className: 'twb-table-sub' },
                  h('span', { className: 'twb-id' }, task.id),
                  task.note ? h('span', { className: 'twb-meta-note' }, task.note) : null,
                ),
              ),
            ),
            h('span', { className: 'twb-table-date' }, taskDateText(task, today)),
            h('span', null, h(PriorityBadge, { priority: task.priority })),
            h('span', { className: 'twb-table-status' },
              task.done
                ? h('span', { className: 'twb-status is-done' }, `已完成 ${task.completed ? shortDate(task.completed) : ''}`)
                : h('span', { className: 'twb-status' }, '待办'),
            ),
            h('span', { className: 'twb-table-actions' },
              h(IconButton, { title: isHistoricalTaskReadOnly(task, today) ? '过月已完成的任务只读' : '编辑任务', disabled: isHistoricalTaskReadOnly(task, today), onClick: () => onEdit(task, data.version) }, h(IconEdit, { size: 15 })),
              h(IconButton, { title: isHistoricalTaskReadOnly(task, today) ? '过月已完成的任务只读' : '删除任务', danger: true, disabled: isHistoricalTaskReadOnly(task, today), onClick: () => onDelete(task, data.version) }, h(IconTrash, { size: 15 })),
            ),
          ))),
        h('div', { className: 'twb-table-foot' }, `当前筛选共 ${filtered.length} 条`),
      )
    }

    // ── 想法池（V2.0）────────────────────────────────────────────────────
    const IDEA_FORM_ID = { create: 'twb-idea-form-create', edit: 'twb-idea-form-edit' }

    function IdeaStatusMenu({ idea, busy, onSelect }) {
      const [open, setOpen] = React.useState(false)
      const wrapRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        function onDocDown(event) {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        function onKey(event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDocDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      const tone = IDEA_STATUS_TONE[idea.status] || 'todo'
      return h('div', { className: 'twb-idea-status', ref: wrapRef },
        h('button', {
          type: 'button',
          className: cx('twb-idea-pill', `is-${tone}`),
          title: '修改状态',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: busy,
          onClick: () => setOpen((value) => !value),
        },
          h('span', { className: 'twb-idea-pill-dot', 'aria-hidden': true }),
          idea.status,
          h('span', { className: 'twb-idea-pill-caret', 'aria-hidden': true }, '▾'),
        ),
        open ? h('div', { className: 'twb-idea-menu', role: 'menu', 'aria-label': '修改状态' },
          IDEA_STATUSES.map((status) => h('button', {
            key: status,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': idea.status === status,
            className: cx(
              'twb-idea-menu-item',
              `is-${IDEA_STATUS_TONE[status]}`,
              idea.status === status && 'is-current',
            ),
            disabled: busy,
            onClick: () => {
              setOpen(false)
              if (status !== idea.status) onSelect(idea, status)
            },
          }, h('span', { className: 'twb-idea-menu-dot', 'aria-hidden': true }), status)),
        ) : null,
      )
    }

    function IdeaCard({ idea, today, version, busy, onEdit, onDelete, onSetStatus }) {
      const closed = ideaIsClosed(idea)
      const stale = ideaStaleDays(idea, today)
      const level = IDEA_MATURITY_LEVEL[idea.maturity] || 0
      const maturityDots = [1, 2, 3].map((step) => h('i', {
        key: `mat-${step}`,
        className: cx('twb-idea-mat-dot', level >= step && 'is-on'),
      }))
      return h('article', { className: cx('twb-idea-card', closed && 'is-closed') },
        h('div', { className: 'twb-idea-body' },
          h('div', { className: 'twb-idea-top' },
            h(IdeaStatusMenu, { idea, busy, onSelect: (selectedIdea, status) => onSetStatus(selectedIdea, status, version) }),
            h('button', { type: 'button', className: 'twb-idea-title', onClick: () => onEdit(idea, version) }, idea.name),
            idea.category ? h('span', { className: 'twb-idea-cat' }, idea.category) : null,
          ),
          idea.description ? h('p', { className: 'twb-idea-desc' }, idea.description) : null,
          h('div', { className: 'twb-idea-meta' },
            h('span', { className: 'twb-idea-id' }, idea.id),
            h('span', { className: 'twb-idea-maturity', title: `成熟度 ${idea.maturity}` },
              maturityDots,
              h('span', { className: 'twb-idea-mat-label' }, `成熟度 ${idea.maturity}`),
            ),
            h('span', null, `更新 ${ideaDateText(idea.updated)}`),
            stale >= IDEA_STALE_DAYS ? h('span', { className: 'twb-idea-stale' }, `已放置 ${stale} 天`) : null,
            idea.completed ? h('span', { className: 'twb-idea-done-date' }, `完成 ${ideaDateText(idea.completed)}`) : null,
          ),
        ),
        h('div', { className: 'twb-idea-actions' },
          h(IconButton, {
            title: '编辑想法',
            onClick: () => onEdit(idea, version),
          }, h(IconEdit, { size: 15 })),
          h(IconButton, {
            title: '删除想法',
            danger: true,
            onClick: () => onDelete(idea, version),
          }, h(IconTrash, { size: 15 })),
        ),
      )
    }

    function IdeaSegment({ label, value, options, disabled, hint, onChange }) {
      return h('div', { className: 'twb-field' },
        h('span', { className: 'twb-field-label' }, label),
        h('div', { className: 'twb-type-switch', role: 'group', 'aria-label': label },
          options.map((option) => h('button', {
            key: option,
            type: 'button',
            className: cx(
              'twb-type-btn',
              value === option && 'is-active',
              value === option && option === '推进中' && 'is-tone-doing',
              value === option && option === '完成' && 'is-tone-done',
            ),
            'aria-pressed': value === option,
            disabled,
            onClick: () => onChange(option),
          }, option)),
        ),
        hint ? h('div', { className: 'twb-hint' }, hint) : null,
      )
    }

    function IdeaForm({ mode, initial, busy, onSubmit }) {
      const edit = mode === 'edit'
      const [name, setName] = React.useState(initial?.name || '')
      const [description, setDescription] = React.useState(initial?.description || '')
      const [maturity, setMaturity] = React.useState(initial?.maturity || IDEA_DEFAULT_MATURITY)
      const [category, setCategory] = React.useState(initial?.category || '')
      const [status, setStatus] = React.useState(initial?.status || IDEA_STATUSES[0])
      const [error, setError] = React.useState(null)
      const nameRef = React.useRef(null)
      React.useEffect(() => { if (nameRef.current) nameRef.current.focus() }, [])
      const locked = busy

      function submit(event) {
        event.preventDefault()
        const cleanName = name.trim()
        const cleanCategory = category.trim()
        if (!cleanName) { setError('名称不能为空'); return }
        setError(null)
        onSubmit({
          name: cleanName,
          description: description.trim(),
          maturity,
          category: cleanCategory,
          status,
        })
      }

      return h('form', { className: 'twb-form', id: IDEA_FORM_ID[mode], onSubmit: submit },
        h('label', { className: 'twb-field' },
          h('span', { className: 'twb-field-label' }, '名称'),
          h('input', {
            ref: nameRef,
            className: 'twb-input',
            value: name,
            maxLength: 200,
            placeholder: '这个想法叫什么？',
            disabled: locked,
            onChange: (event) => setName(event.target.value),
          }),
        ),
        h('label', { className: 'twb-field' },
          h('span', { className: 'twb-field-label' }, edit ? '详细描述' : '详细描述（可选）'),
          h('textarea', {
            className: 'twb-input twb-idea-textarea',
            value: description,
            rows: edit ? 7 : 5,
            maxLength: 10000,
            placeholder: '想解决什么问题？为什么觉得值得做？' + (edit ? '' : '可以多写几段。'),
            disabled: locked,
            onChange: (event) => setDescription(event.target.value),
          }),
        ),
        edit
          ? h('div', { className: 'twb-field-row' },
            h(IdeaSegment, {
              label: '状态',
              value: status,
              options: IDEA_STATUSES,
              disabled: locked,
              hint: '状态只能由人修改',
              onChange: setStatus,
            }),
            h(IdeaSegment, {
              label: '成熟度',
              value: maturity,
              options: IDEA_MATURITIES,
              disabled: locked,
              onChange: setMaturity,
            }),
          )
          : h('div', { className: 'twb-field-row' },
            h(IdeaSegment, {
              label: '成熟度',
              value: maturity,
              options: IDEA_MATURITIES,
              disabled: locked,
              hint: IDEA_MATURITY_HINT,
              onChange: setMaturity,
            }),
            h('label', { className: 'twb-field' },
              h('span', { className: 'twb-field-label' }, '分类（可选）'),
              h('input', {
                className: 'twb-input',
                value: category,
                maxLength: 20,
                placeholder: '如 业务 / 产品 / 学习',
                disabled: locked,
                onChange: (event) => setCategory(event.target.value),
              }),
            ),
          ),
        edit
          ? h('div', { className: 'twb-field-row' },
            h('label', { className: 'twb-field' },
              h('span', { className: 'twb-field-label' }, '分类'),
              h('input', {
                className: 'twb-input',
                value: category,
                maxLength: 20,
                placeholder: '如 业务 / 产品 / 学习',
                disabled: locked,
                onChange: (event) => setCategory(event.target.value),
              }),
            ),
            h('div', { className: 'twb-field' },
              h('span', { className: 'twb-field-label' }, '时间'),
              h('div', { className: 'twb-idea-meta-box' },
                h('div', null, `创建 ${initial?.created || '—'}`),
                h('div', null, `更新 ${initial?.updated || '—'}`),
                initial?.completed ? h('div', null, `完成 ${initial.completed}`) : null,
              ),
            ),
          )
          : null,
        error ? h('div', { className: 'twb-form-error' }, error) : null,
      )
    }

    function ConfirmIdeaDelete({ idea, busy, onConfirm, onBack }) {
      return h('div', { className: 'twb-confirm' },
        h('div', { className: 'twb-confirm-icon' }, h(IconTrash, { size: 20 })),
        h('div', { className: 'twb-confirm-title' }, `删除「${idea.name}」？`),
        h('div', { className: 'twb-confirm-text' }, '这是硬删除，会立即从想法池移除；写前会自动备份，可在 data/备份/ 里手工找回，但面板内不可撤销。'),
        h('div', { className: 'twb-form-actions' },
          h('button', { type: 'button', className: 'twb-btn', onClick: onBack, disabled: busy }, '取消'),
          h('button', { type: 'button', className: 'twb-btn is-danger', onClick: onConfirm, disabled: busy }, busy ? '删除中…' : '确认删除'),
        ),
      )
    }

    function IdeasView({ data, loadError, today, busy, notInitialized, onCreate, onEdit, onDelete, onSetStatus, reload }) {
      const [status, setStatus] = React.useState('全部')
      const [maturity, setMaturity] = React.useState('全部')
      const [category, setCategory] = React.useState('全部')
      const [keyword, setKeyword] = React.useState('')
      const [sortMode, setSortMode] = React.useState('status')

      if (!data) {
        if (loadError) {
          return h('div', { className: 'twb-view' }, h(EmptyState, {
            icon: h(IconAlert, { size: 22 }),
            title: '想法池加载失败',
            hint: loadError.message || '请稍后重试。',
            action: h('button', { type: 'button', className: 'twb-btn', onClick: reload }, h(IconRefresh, { size: 15 }), '重新加载'),
          }))
        }
        return h('div', { className: 'twb-view' }, h(LoadingBlock))
      }

      const ideas = Array.isArray(data.ideas) ? data.ideas : []
      const counts = ideaCountsOf(ideas)
      const categories = [...new Set(ideas.map((idea) => idea.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))
      const activeCategory = categories.includes(category) ? category : '全部'
      const latest = ideas.reduce((newest, idea) => (
        !newest || String(idea.updated || '') > String(newest.updated || '') ? idea : newest
      ), null)
      const closedCount = counts.done + counts.dropped
      const hasFilter = status !== '全部' || maturity !== '全部' || activeCategory !== '全部' || keyword.trim() !== ''

      const filtered = ideas.filter((idea) => {
        if (status !== '全部' && idea.status !== status) return false
        if (maturity !== '全部' && idea.maturity !== maturity) return false
        if (activeCategory !== '全部' && idea.category !== activeCategory) return false
        const query = keyword.trim().toLowerCase()
        if (query) {
          const name = String(idea.name || '').toLowerCase()
          const description = String(idea.description || '').toLowerCase()
          if (!name.includes(query) && !description.includes(query)) return false
        }
        return true
      })
      const sorted = sortIdeas(filtered, sortMode)

      function clearFilters() {
        setStatus('全部')
        setMaturity('全部')
        setCategory('全部')
        setKeyword('')
      }

      return h('div', { className: 'twb-view' },
        h('section', { className: 'twb-ideas-summary' },
          h('div', null,
            h('div', { className: 'twb-ideas-title' }, '想法池'),
            h('div', { className: 'twb-ideas-sub' }, `共 ${counts.total} 条 · 最近更新 ${latest ? ideaDateText(latest.updated) : '—'} · 已关闭 ${closedCount} 条`),
          ),
          h('div', { className: 'twb-ideas-stats', role: 'group', 'aria-label': '按状态筛选' },
            ['全部', ...IDEA_STATUSES].map((value) => h('button', {
              key: value,
              type: 'button',
              className: cx('twb-ideas-stat', status === value && 'is-active'),
              'data-status': value,
              'aria-pressed': status === value,
              onClick: () => setStatus(value),
            },
              h('span', { className: 'twb-ideas-stat-num' }, value === '全部' ? counts.total : counts[IDEA_STATUS_TONE[value]]),
              h('span', { className: 'twb-ideas-stat-label' }, value),
            )),
          ),
        ),
        h('div', { className: 'twb-ideas-toolbar' },
          h('input', {
            className: 'twb-input twb-idea-search',
            value: keyword,
            placeholder: '搜索名称或描述…',
            'aria-label': '搜索想法',
            onChange: (event) => setKeyword(event.target.value),
          }),
          h('select', {
            className: 'twb-input', value: maturity, 'aria-label': '成熟度筛选',
            onChange: (event) => setMaturity(event.target.value),
          },
            h('option', { value: '全部' }, '全部成熟度'),
            IDEA_MATURITY_FILTERS.map((value) => h('option', { key: value, value }, value)),
          ),
          h('select', {
            className: 'twb-input', value: activeCategory, 'aria-label': '分类筛选',
            onChange: (event) => setCategory(event.target.value),
          },
            h('option', { value: '全部' }, '全部分类'),
            categories.map((value) => h('option', { key: value, value }, value)),
          ),
          h('select', {
            className: 'twb-input', value: sortMode, 'aria-label': '排序',
            onChange: (event) => setSortMode(event.target.value),
          },
            h('option', { value: 'status' }, '状态优先'),
            h('option', { value: 'updated' }, '最近更新'),
            h('option', { value: 'created' }, '最新创建'),
            h('option', { value: 'maturity' }, '成熟度优先'),
          ),
          h('button', { type: 'button', className: 'twb-btn', onClick: reload }, h(IconRefresh, { size: 15 }), '刷新'),
        ),
        sorted.length > 0
          ? h('div', { className: 'twb-ideas-list' }, sorted.map((idea) => h(IdeaCard, {
            key: idea.id, idea, today, version: data.version, busy, onEdit, onDelete, onSetStatus,
          })))
          : (ideas.length === 0
            ? h(EmptyState, {
              icon: h(IconInbox, { size: 22 }),
              title: '还没有想法',
              hint: notInitialized
                ? '想法池还没初始化；新建第一条想法即可开始记录。'
                : '把冒出来的念头先记下来，之后慢慢打磨。',
              action: h('button', {
                type: 'button', className: 'twb-btn is-primary',
                onClick: () => onCreate(data.version), disabled: busy,
              }, h(IconPlus, { size: 15 }), '新建想法'),
            })
            : h(EmptyState, {
              icon: h(IconInbox, { size: 22 }),
              title: '没有符合条件的想法',
              hint: '换个筛选条件，或直接新建一个。',
              action: h('div', { className: 'twb-empty-actions' },
                hasFilter ? h('button', { type: 'button', className: 'twb-btn', onClick: clearFilters }, '清除筛选') : null,
                h('button', {
                  type: 'button', className: 'twb-btn is-primary',
                  onClick: () => onCreate(data.version), disabled: busy,
                }, h(IconPlus, { size: 15 }), '新建想法'),
              ),
            })),
        h('div', { className: 'twb-ideas-foot' }, `显示 ${sorted.length} 条 / 共 ${counts.total} 条${closedCount ? ` · 其中已关闭 ${closedCount} 条` : ''}`),
      )
    }

    function LoadingBlock() {
      return h('div', { className: 'twb-loading' }, h('span', { className: 'twb-spinner' }), '加载中…')
    }

    function InitScreen({ boot, onInit, busy }) {
      return h('div', { className: 'twb-init' },
        h('div', { className: 'twb-init-icon' }, h(IconInbox, { size: 28 })),
        h('div', { className: 'twb-init-title' }, '初始化任务工作台'),
        h('div', { className: 'twb-init-text' }, '会在下面这个目录创建任务工作台本地数据库 workbench.sqlite，任务、想法和复盘都由工作台读写。'),
        h('code', { className: 'twb-init-path' }, boot?.dataRoot || ''),
        h('button', { type: 'button', className: 'twb-btn is-primary', onClick: onInit, disabled: busy }, busy ? '创建中…' : '初始化'),
        h('div', { className: 'twb-init-hint' }, '数据存在本机固定目录，不随插件包升级或重装丢失。删除或清空记录前会先保存数据库备份。'),
      )
    }

    function FatalScreen({ error, onRetry }) {
      return h('div', { className: 'twb-init' },
        h('div', { className: 'twb-init-icon is-error' }, h(IconAlert, { size: 26 })),
        h('div', { className: 'twb-init-title' }, '任务工作台加载失败'),
        h('div', { className: 'twb-init-text' }, error?.message || '未知错误'),
        h('button', { type: 'button', className: 'twb-btn', onClick: onRetry }, h(IconRefresh, { size: 15 }), '重试'),
      )
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    function WorkbenchPanel() {
      const [boot, setBoot] = React.useState(null)
      const [tab, setTab] = React.useState('today')
      const [views, setViews] = React.useState({ today: null, week: null, tasks: null, ideas: null, reviews: null })
      const [ideasError, setIdeasError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [fatal, setFatal] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [modal, setModal] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const tabRef = React.useRef(tab)
      const busyRef = React.useRef(false)
      const modalRef = React.useRef(null)
      const monthRef = React.useRef(null)

      React.useEffect(() => { tabRef.current = tab }, [tab])
      React.useEffect(() => { busyRef.current = busy }, [busy])
      React.useEffect(() => { modalRef.current = modal }, [modal])

      function notify(kind, message) {
        setToast({ kind, message, id: Date.now() })
      }
      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 3200)
        return () => clearTimeout(timer)
      }, [toast])

      function handleError(error) {
        if (error?.code === 'external-change') {
          notify('warn', error?.message || '数据已被其他操作修改，正在重新加载…')
          refreshCurrent().catch(() => {})
          return
        }
        if (error?.code === 'permission-denied') {
          notify('warn', error?.message || '状态只能由人修改')
          return
        }
        if (error?.code === 'history-readonly') {
          notify('warn', error?.message || '过月已完成的任务只读')
          return
        }
        if (error?.code === 'file-missing') {
          refreshCurrent().catch(() => {})
          return
        }
        notify('error', error?.message || '操作失败')
      }

      async function loadView(which, monthOverride) {
        if (which === 'week') {
          const month = monthOverride === undefined ? monthRef.current : monthOverride
          monthRef.current = month
          // 月历是独立只读接口；失败只降级为不显示底部区块，不影响周看板。
          const [week, monthData] = await Promise.all([
            request('GET', '/week'),
            request('GET', `/month${month ? `?month=${encodeURIComponent(month)}` : ''}`).catch(() => null),
          ])
          return { ...week, monthData }
        }
        if (which === 'ideas') return request('GET', '/ideas')
        return request('GET', '/tasks?includeCompleted=true')
      }

      async function loadBootstrap() {
        const data = await request('GET', '/bootstrap')
        setBoot(data)
        return data
      }

      async function loadTab(which, monthOverride) {
        try {
          if (which === 'today') {
            // 复盘板单独容错：复盘加载失败也不影响今日任务视图。
            const [todayData, reviewBoard] = await Promise.all([
              request('GET', '/today'),
              request('GET', '/reviews').catch((error) => ({ error })),
            ])
            setViews((prev) => ({ ...prev, today: todayData, reviews: reviewBoard }))
            return todayData
          }
          const data = await loadView(which, monthOverride)
          if (which === 'ideas') setIdeasError(null)
          setViews((prev) => ({ ...prev, [which]: data }))
          return data
        } catch (error) {
          if (which === 'ideas') setIdeasError(error)
          throw error
        }
      }

      function changeMonth(delta) {
        const current = views.week && views.week.monthData ? views.week.monthData.month : (boot && boot.today ? boot.today.slice(0, 7) : null)
        if (!current) return
        if (delta === 0) {
          loadTab('week', null).catch(handleError)
          return
        }
        const year = Number(current.slice(0, 4))
        const month = Number(current.slice(5, 7))
        const next = new Date(year, month - 1 + delta, 1)
        const key = `${next.getFullYear()}-${pad2(next.getMonth() + 1)}`
        loadTab('week', key).catch(handleError)
      }

      async function refreshCurrent() {
        const data = await loadBootstrap()
        if (data.initialized) await loadTab(tabRef.current)
        return data
      }

      async function bootstrapOnce() {
        try {
          const data = await loadBootstrap()
          if (data.initialized) await loadTab(tabRef.current)
          setLoading(false)
        } catch (error) {
          if (error?.code === 'file-missing') {
            setLoading(false)
          } else {
            setFatal(error)
            setLoading(false)
          }
        }
      }

      React.useEffect(() => { bootstrapOnce() }, [])
      React.useEffect(() => {
        if (boot?.initialized) loadTab(tab).catch(handleError)
      }, [tab])

      // 轻量轮询：页面可见、没有弹窗或写入时刷新当前视图。
      React.useEffect(() => {
        const timer = setInterval(async () => {
          if (document.hidden || busyRef.current || modalRef.current) return
          try {
            const data = await request('GET', '/bootstrap')
            setBoot(data)
            if (data.initialized) await loadTab(tabRef.current)
          } catch { /* 静默：下一轮再试 */ }
        }, 5000)
        return () => clearInterval(timer)
      }, [])

      async function withMutation(fn, successMessage) {
        setBusy(true); busyRef.current = true
        try {
          const result = await fn()
          notify('ok', typeof successMessage === 'function' ? successMessage(result) : successMessage)
          try {
            await refreshCurrent()
          } catch (refreshError) {
            notify('warn', `操作已保存，但刷新失败：${refreshError?.message || '请稍后刷新'}`)
          }
          return result
        } catch (error) {
          handleError(error)
          return null
        } finally {
          setBusy(false); busyRef.current = false
        }
      }

      function versionedWriteBody(extra, version) {
        const body = { ...extra, requestId: newRequestId() }
        if (version !== undefined && version !== null) body.baseVersion = version
        return body
      }

      async function toggleTask(task, version) {
        const done = !task.done
        await withMutation(
          () => request('POST', `/tasks/${task.id}/complete`, versionedWriteBody({ done }, version)),
          done ? '已完成（人确认）' : '已撤销完成',
        )
      }

      async function createTask(payload, version) {
        setBusy(true); busyRef.current = true
        try {
          const result = await request('POST', '/tasks', versionedWriteBody(payload, version))
          setModal(null)
          notify('ok', `已创建：${result.task.title}`)
          await refreshCurrent()
        } catch (error) {
          if (error?.code === 'duplicate-suspected') {
            setModal({ type: 'duplicate', payload, version })
            return
          }
          handleError(error)
        } finally {
          setBusy(false); busyRef.current = false
        }
      }

      async function updateTask(taskId, payload, version, fromDay) {
        const result = await withMutation(
          () => request('PATCH', `/tasks/${taskId}`, versionedWriteBody({ changes: payload }, version)),
          '已保存修改',
        )
        if (result) setModal(fromDay ? { type: 'day', date: fromDay } : null)
      }

      async function deleteTask(task, version, fromDay) {
        const result = await withMutation(
          () => request('DELETE', `/tasks/${task.id}`, versionedWriteBody({}, version)),
          (result) => `已删除：${result.deleted.title}`,
        )
        if (result) setModal(fromDay ? { type: 'day', date: fromDay } : null)
      }

      // ── 想法池写入（人是唯一能改状态的入口；host 侧仍会兜底校验）────────
      async function setIdeaStatus(idea, status, version) {
        if (status === idea.status) return
        await withMutation(
          () => request('PATCH', `/ideas/${idea.id}`, versionedWriteBody({ changes: { status } }, version)),
          `已改为「${status}」`,
        )
      }

      async function createIdea(payload, version) {
        setBusy(true); busyRef.current = true
        try {
          const result = await request('POST', '/ideas', versionedWriteBody({
            name: payload.name,
            description: payload.description || '',
            maturity: payload.maturity || IDEA_DEFAULT_MATURITY,
            category: payload.category || '',
          }, version))
          setModal(null)
          notify('ok', `已创建：${result.idea.name}`)
          await refreshCurrent()
        } catch (error) {
          handleError(error)
        } finally {
          setBusy(false); busyRef.current = false
        }
      }

      async function updateIdea(idea, payload, version) {
        const current = {
          name: idea.name || '',
          description: idea.description || '',
          maturity: idea.maturity || '',
          category: idea.category || '',
          status: idea.status || '',
        }
        const changes = {}
        for (const key of Object.keys(current)) {
          if (payload[key] !== undefined && payload[key] !== current[key]) changes[key] = payload[key]
        }
        if (Object.keys(changes).length === 0) {
          setModal(null)
          notify('ok', '没有需要保存的修改')
          return
        }
        const result = await withMutation(
          () => request('PATCH', `/ideas/${idea.id}`, versionedWriteBody({ changes }, version)),
          '已保存修改',
        )
        if (result) setModal(null)
      }

      async function deleteIdea(idea, version) {
        const result = await withMutation(
          () => request('DELETE', `/ideas/${idea.id}`, versionedWriteBody({}, version)),
          (result) => `已删除：${result.deleted.name}`,
        )
        if (result) setModal(null)
      }

      // ── 复盘写入（正文只能由人写；host 侧对非 user actor 兜底拒绝）────────
      async function saveReview(prompt, text, version) {
        return withMutation(
          () => request('PUT', `/reviews/${prompt.kind}/${prompt.key}`, versionedWriteBody({
            text,
          }, version)),
          (result) => (result.created ? '复盘已提交' : '复盘已更新'),
        )
      }

      async function clearReview(prompt, version) {
        const result = await withMutation(
          () => request('DELETE', `/reviews/${prompt.kind}/${prompt.key}`, versionedWriteBody({}, version)),
          '复盘已清空',
        )
        if (result) setModal(null)
      }

      function openReviewClear(prompt, version) { setModal({ type: 'review-clear', prompt, version }) }

      async function initStore() {
        setBusy(true); busyRef.current = true
        try {
          const data = await request('POST', '/init', { requestId: newRequestId() })
          setBoot(data)
          await loadTab(tabRef.current)
          notify('ok', '初始化完成，可以开始创建任务了')
        } catch (error) {
          handleError(error)
        } finally {
          setBusy(false); busyRef.current = false
        }
      }

      async function doReload() {
        try {
          const data = await request('POST', '/reload', { requestId: newRequestId() })
          setBoot(data)
          if (data.initialized) await loadTab(tabRef.current)
          notify('ok', '已重新加载')
        } catch (error) {
          handleError(error)
        }
      }

      function openCreate(date, version) {
        setModal({ type: 'create', date: date || boot?.today || todayString(), version })
      }

      /** 月历点日期：先确保该日期所在月份已加载（相邻月补位日期会切月），再打开当天详情。 */
      function openDay(date) {
        const current = views.week && views.week.monthData
        if (current && current.month === date.slice(0, 7)) {
          setModal({ type: 'day', date })
          return
        }
        loadTab('week', date.slice(0, 7)).then(() => setModal({ type: 'day', date })).catch(handleError)
      }

      function openEdit(task, version, fromDay) { setModal({ type: 'edit', task, version, fromDay }) }
      function openDelete(task, version, fromDay) { setModal({ type: 'delete', task, version, fromDay }) }
      function openSettings() { setModal({ type: 'settings' }) }
      function openIdeaCreate(version) { setModal({ type: 'idea-create', version }) }
      function openIdeaEdit(idea, version) { setModal({ type: 'idea-edit', idea, version }) }
      function openIdeaDelete(idea, version) { setModal({ type: 'idea-delete', idea, version }) }
      function reloadIdeas() { refreshCurrent().catch((error) => handleError(error)) }

      function renderModal() {
        if (!modal) return null
        if (modal.type === 'create') {
          return h(Modal, {
            title: '新建任务', subtitle: `默认日期 ${modal.date}`, onClose: () => setModal(null),
          }, h(TaskForm, {
            mode: 'create',
            initial: { date: modal.date, type: 'single', priority: DEFAULT_PRIORITY },
            today: boot?.today || todayString(),
            busy,
            onSubmit: (payload) => createTask(payload, modal.version),
            onBack: () => setModal(null),
          }))
        }
        if (modal.type === 'day') {
          return h(DayDetail, {
            date: modal.date,
            month: views.week && views.week.monthData,
            today: boot?.today || todayString(),
            busy,
            onToggle: toggleTask,
            onEdit: openEdit,
            onDelete: openDelete,
            onCreate: openCreate,
            onClose: () => setModal(null),
          })
        }
        if (modal.type === 'edit') {
          const back = () => setModal(modal.fromDay ? { type: 'day', date: modal.fromDay } : null)
          return h(Modal, {
            title: '编辑任务', subtitle: modal.task.id, onClose: back,
          }, h(TaskForm, {
            mode: 'edit',
            initial: modal.task,
            today: boot?.today || todayString(),
            busy,
            onSubmit: (payload) => updateTask(modal.task.id, payload, modal.version, modal.fromDay),
            onBack: back,
          }))
        }
        if (modal.type === 'delete') {
          const back = () => setModal(modal.fromDay ? { type: 'day', date: modal.fromDay } : null)
          return h(Modal, { title: '删除任务', subtitle: '硬删除，删除前备份数据库快照', onClose: back },
            h(ConfirmDelete, {
              task: modal.task, busy,
              onConfirm: () => deleteTask(modal.task, modal.version, modal.fromDay),
              onBack: back,
            }),
          )
        }
        if (modal.type === 'duplicate') {
          return h(Modal, { title: '疑似重复', onClose: () => setModal(null) },
            h(DuplicateConfirm, {
              task: modal.payload, busy,
              onConfirm: () => createTask({ ...modal.payload, confirmDuplicate: true }, modal.version),
              onBack: () => setModal(null),
            }),
          )
        }
        if (modal.type === 'idea-create') {
          return h(Modal, {
            title: '新建想法',
            subtitle: '状态默认「待实现」，之后在列表里改',
            onClose: () => setModal(null),
            footer: [
              h('span', { key: 'spacer' }),
              h('div', { key: 'actions', className: 'twb-idea-foot-right' },
                h('button', { type: 'button', className: 'twb-btn', onClick: () => setModal(null), disabled: busy }, '取消'),
                h('button', {
                  type: 'submit',
                  form: IDEA_FORM_ID.create,
                  className: 'twb-btn is-primary',
                  disabled: busy,
                }, busy ? '创建中…' : '创建想法'),
              ),
            ],
          }, h(IdeaForm, {
            mode: 'create',
            busy,
            onSubmit: (payload) => createIdea(payload, modal.version),
          }))
        }
        if (modal.type === 'idea-edit') {
          return h(Modal, {
            title: '编辑想法',
            subtitle: modal.idea.id,
            wide: true,
            onClose: () => setModal(null),
            footer: [
              h('button', {
                key: 'delete',
                type: 'button',
                className: 'twb-btn is-danger',
                disabled: busy,
                onClick: () => setModal({ type: 'idea-delete', idea: modal.idea, version: modal.version }),
              }, '删除'),
              h('div', { key: 'actions', className: 'twb-idea-foot-right' },
                h('button', { type: 'button', className: 'twb-btn', onClick: () => setModal(null), disabled: busy }, '取消'),
                h('button', {
                  type: 'submit',
                  form: IDEA_FORM_ID.edit,
                  className: 'twb-btn is-primary',
                  disabled: busy,
                }, busy ? '保存中…' : '保存修改'),
              ),
            ],
          }, h(IdeaForm, {
            mode: 'edit',
            initial: modal.idea,
            busy,
            onSubmit: (payload) => updateIdea(modal.idea, payload, modal.version),
          }))
        }
        if (modal.type === 'idea-delete') {
          return h(Modal, {
            title: '删除想法',
            subtitle: '硬删除，删除前备份数据库快照',
            onClose: () => setModal(null),
          }, h(ConfirmIdeaDelete, {
            idea: modal.idea,
            busy,
            onConfirm: () => deleteIdea(modal.idea, modal.version),
            onBack: () => setModal(null),
          }))
        }
        if (modal.type === 'review-clear') {
          return h(Modal, {
            title: '清空复盘',
            subtitle: '清空前备份数据库快照',
            onClose: () => setModal(null),
          }, h(ConfirmReviewClear, {
            prompt: modal.prompt,
            today: boot?.today || todayString(),
            busy,
            onConfirm: () => clearReview(modal.prompt, modal.version),
            onBack: () => setModal(null),
          }))
        }
        if (modal.type === 'settings') {
          return h(Modal, { title: '任务工作台设置', subtitle: '数据与备份', onClose: () => setModal(null) },
            h('div', { className: 'twb-settings' },
              h('div', { className: 'twb-setting-row' }, h('span', null, '数据根'), h('code', null, boot?.dataRoot || '—')),
              h('div', { className: 'twb-setting-row' }, h('span', null, '数据库'), h('code', null, boot?.database || '—')),
              h('div', { className: 'twb-setting-row' }, h('span', null, '任务统计'), h('span', null, `待办 ${boot?.counts?.totalOpen ?? 0} · 本月已完成 ${boot?.counts?.totalDone ?? 0}`)),
              h('div', { className: 'twb-setting-row' }, h('span', null, '今日'), h('span', null, `${boot?.today || ''}（待办 ${boot?.counts?.badge ?? 0}）`)),
              h('div', { className: 'twb-setting-note' }, '任务、想法和复盘共用上面的 workbench.sqlite。删除任务或想法、清空复盘前会备份数据库快照，保存在数据根目录的「备份」中。'),
              h('div', { className: 'twb-form-actions' },
                h('button', { type: 'button', className: 'twb-btn', onClick: doReload }, h(IconRefresh, { size: 15 }), '重新加载'),
                h('button', { type: 'button', className: 'twb-btn is-primary', onClick: () => setModal(null) }, '完成'),
              ),
            ),
          )
        }
        return null
      }

      if (loading) {
        return h('div', { className: 'twb-root' }, h('div', { className: 'twb-center' }, h(LoadingBlock)))
      }
      if (fatal) {
        return h('div', { className: 'twb-root' }, h('div', { className: 'twb-center' }, h(FatalScreen, { error: fatal, onRetry: () => { setFatal(null); setLoading(true); bootstrapOnce() } })))
      }
      if (!boot?.initialized) {
        return h('div', { className: 'twb-root' }, h('div', { className: 'twb-center' }, h(InitScreen, { boot, onInit: initStore, busy })))
      }

      const counts = boot.counts || {}
      const ideasBoot = boot.ideas && typeof boot.ideas === 'object' ? boot.ideas : null
      const ideasCounts = views.ideas && Array.isArray(views.ideas.ideas)
        ? ideaCountsOf(views.ideas.ideas)
        : ideaCountsFromBoot(ideasBoot?.counts)
      const activeTaskView = tab === 'today' ? views.today : tab === 'week' ? views.week : tab === 'tasks' ? views.tasks : null
      return h('div', { className: 'twb-root' },
        h('style', null, CSS),
        h('header', { className: 'twb-header' },
          h('div', { className: 'twb-brand' },
            h('div', { className: 'twb-brand-icon' }, h(IconCheck, { size: 16, strokeWidth: 2.4 })),
            h('div', null,
              h('div', { className: 'twb-brand-title' }, '任务工作台'),
              h('div', { className: 'twb-brand-sub' }, tab === 'ideas'
                ? `${boot.today} · 待实现 ${ideasCounts.todo} · 推进中 ${ideasCounts.doing}`
                : `${boot.today} · 待办 ${counts.badge ?? 0}${counts.overdue ? ` · 逾期 ${counts.overdue}` : ''}${counts.completedToday ? ` · 今日完成 ${counts.completedToday}` : ''}`),
            ),
          ),
          h('nav', { className: 'twb-nav', 'aria-label': '视图切换' },
            [['today', '今日'], ['week', '本周'], ['tasks', '任务'], ['ideas', '想法']].map(([key, label]) =>
              h('button', {
                key, type: 'button', className: cx('twb-nav-btn', tab === key && 'is-active'),
                'aria-current': tab === key ? 'page' : undefined,
                onClick: () => setTab(key),
              }, label),
            ),
          ),
          h('div', { className: 'twb-header-actions' },
            h(IconButton, { title: '刷新', onClick: refreshCurrent, disabled: busy }, h(IconRefresh, { size: 16 })),
            h(IconButton, { title: '设置', onClick: openSettings }, h(IconSettings, { size: 16 })),
            tab === 'ideas'
              ? h('button', { type: 'button', className: 'twb-btn is-primary', onClick: () => openIdeaCreate(views.ideas?.version ?? ideasBoot?.version ?? 0), disabled: busy },
                h(IconPlus, { size: 15 }), '新建想法')
              : h('button', { type: 'button', className: 'twb-btn is-primary', onClick: () => openCreate(boot.today, activeTaskView?.version ?? boot.version), disabled: busy },
                h(IconPlus, { size: 15 }), '新建任务'),
          ),
        ),
        h('main', { className: 'twb-body' },
          tab === 'today' ? h(TodayView, {
            data: views.today, today: boot.today, busy,
            reviews: views.reviews,
            onToggle: toggleTask, onEdit: openEdit, onDelete: openDelete, onCreate: openCreate,
            onSaveReview: saveReview, onClearReview: openReviewClear,
          }) : null,
          tab === 'week' ? h(WeekView, {
            data: views.week, today: boot.today, busy,
            onToggle: toggleTask, onEdit: openEdit, onDelete: openDelete, onCreate: openCreate,
            onOpenDay: openDay, onMonthChange: changeMonth,
          }) : null,
          tab === 'tasks' ? h(TasksView, {
            data: views.tasks, today: boot.today, busy,
            onToggle: toggleTask, onEdit: openEdit, onDelete: openDelete, onCreate: openCreate,
            reload: () => loadTab('tasks').catch(handleError),
          }) : null,
          tab === 'ideas' ? h(IdeasView, {
            data: views.ideas,
            loadError: ideasError,
            today: boot.today,
            busy,
            notInitialized: ideasBoot ? ideasBoot.initialized === false : false,
            onCreate: openIdeaCreate,
            onEdit: openIdeaEdit,
            onDelete: openIdeaDelete,
            onSetStatus: setIdeaStatus,
            reload: reloadIdeas,
          }) : null,
        ),
        toast ? h('div', { className: cx('twb-toast', toast.kind === 'error' && 'is-error', toast.kind === 'warn' && 'is-warn') }, toast.message) : null,
        renderModal(),
      )
    }

    function WorkbenchIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 4, y: 3.5, width: 16, height: 17, rx: 3 }),
        h('path', { d: 'M8.5 9.5l1.6 1.6L13 8.3' }),
        h('path', { d: 'M8.5 15.5l1.6 1.6L13 14.3' }),
        h('path', { d: 'M15.5 10h2M15.5 16h2' }),
      )
    }

    // ── 样式（只依赖 --dsw-alias-* / --dsw-elevation-* / --dsw-font-* token）──
    const CSS = `
/* 整体等比放大：12px → 18px（+6），排版/美观阶段再收敛成字号体系 */
.twb-root { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: var(--dsw-font-base-16-font-size, 14px); font-family: inherit; zoom: var(--twb-zoom);
  --twb-zoom: 1.5;
  /* 三层材质：canvas 页面底色 → raised 浮起卡片/面板 → 完成/关闭态回沉到 canvas */
  --twb-canvas: color-mix(in srgb, var(--dsw-alias-bg-mask-1) 16%, var(--dsw-alias-bg-base));
  --twb-raised: var(--dsw-alias-bg-layer-1);
  --twb-line: var(--dsw-alias-border-l2);
  --twb-line-strong: var(--dsw-alias-border-l3);
  --twb-head-tint: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, var(--twb-raised));
  --twb-shadow-panel: var(--dsw-elevation-panel);
  /* 跨周期任务分类色：每条任务一个颜色，白/暗底都要可辨，按轨道号循环 */
  --twb-series-1: #4f6bed;
  --twb-series-2: #12a594;
  --twb-series-3: #8b5cf6;
  --twb-series-4: #d6409f;
  --twb-series-5: #e0872b;
  --twb-series-6: #3f8f4f;
  --twb-shadow-card: 0 1px 2px color-mix(in srgb, var(--dsw-alias-bg-mask-1) 20%, transparent);
}
.twb-root *, .twb-root *::before, .twb-root *::after { box-sizing: border-box; }
.twb-root button, .twb-root input, .twb-root select, .twb-root textarea { font: inherit; color: inherit; }
.twb-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 32px; }
/* 顶部留白只让开窗口 chrome 的真实占位（macOS 48px）；该值按真实像素给出，而 .twb-root 被 zoom 放大，所以要换算回 zoom 前的 px，否则会被放大成 zoom 倍空白 */
.twb-header { flex: none; display: flex; align-items: center; gap: 16px; padding: calc(var(--dsh-frame-top-clearance, 0px) / var(--twb-zoom) + 8px) 22px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--twb-canvas); }
.twb-brand { display: flex; align-items: center; gap: 10px; min-width: 180px; }
.twb-brand-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); }
.twb-brand-title { font-size: 15px; font-weight: 650; letter-spacing: .01em; }
.twb-brand-sub { margin-top: 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.twb-nav { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.twb-nav-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 5px 14px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.twb-nav-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.twb-nav-btn.is-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-elevation-soft); font-weight: 600; }
.twb-header-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.twb-body { flex: 1; min-height: 0; overflow: auto; padding: 0 22px 28px; background: var(--twb-canvas); }
.twb-view { max-width: 980px; margin: 0 auto; padding-top: 18px; }
.twb-week-view { max-width: none; }
.twb-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; line-height: 1.3; white-space: nowrap; }
.twb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.twb-btn:disabled { opacity: .55; cursor: not-allowed; }
.twb-btn.is-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-inverted); font-weight: 600; }
.twb-btn.is-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.twb-btn.is-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: var(--dsw-alias-label-primary-inverted); }
.twb-icon-btn { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 0; }
.twb-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.twb-icon-btn.is-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.twb-icon-btn:disabled { opacity: .4; cursor: not-allowed; }
.twb-today-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; border-radius: 12px; background: var(--twb-raised); border: 1px solid var(--twb-line); box-shadow: var(--twb-shadow-panel); }
.twb-summary-date { font-size: 19px; font-weight: 650; }
.twb-summary-sub { margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.twb-summary-stats { display: flex; gap: 26px; }
.twb-stat { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.twb-stat-num { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
.twb-stat-num.is-warn { color: var(--dsw-alias-state-warn-primary); }
.twb-stat-num.is-ok { color: var(--dsw-alias-state-success-primary); }
.twb-stat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.twb-section { margin-top: 24px; }
.twb-section.is-muted { opacity: .92; }
.twb-section-title { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; margin-bottom: 10px; }
.twb-section-title::before { content: ""; flex: none; width: 3px; height: 12px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent); }
.twb-section.is-muted .twb-section-title::before { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.twb-section.is-overdue .twb-section-title::before { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.twb-count { min-width: 18px; height: 18px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary); font-size: 11px; font-weight: 500; }
.twb-list { display: flex; flex-direction: column; gap: 7px; }
.twb-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 10px; background: var(--twb-raised); border: 1px solid var(--twb-line); box-shadow: var(--twb-shadow-card); transition: background .12s ease, border-color .12s ease; }
.twb-row:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--twb-line-strong); }
.twb-row.is-compact { padding: 7px 10px; }
.twb-row.is-done { opacity: .62; background: transparent; border-color: transparent; box-shadow: none; }
.twb-row.is-done .twb-row-title { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
.twb-row-main { flex: 1; min-width: 0; }
.twb-row-main.is-clickable { cursor: pointer; }
.twb-row-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.twb-row-head .twb-row-title { min-width: 0; }
.twb-row-title { border: 0; background: none; padding: 0; text-align: left; cursor: pointer; font-size: 13.5px; line-height: 1.35; color: var(--dsw-alias-label-primary); word-break: break-word; }
.twb-row-title:hover:not(:disabled) { color: var(--dsw-alias-brand-primary); }
.twb-row-title:disabled, .twb-span-card-title:disabled { cursor: not-allowed; opacity: .58; }
.twb-row-meta { margin-top: 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.twb-meta-date { display: inline-flex; align-items: center; gap: 3px; }
.twb-meta-date.is-overdue { color: var(--dsw-alias-state-error-primary); }
.twb-meta-time { display: inline-flex; align-items: center; gap: 3px; }
.twb-meta-range { display: inline-flex; align-items: center; gap: 3px; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.twb-due { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; border: 1px solid currentColor; font-size: 11.5px; line-height: 1.5; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.twb-meta-overdue { color: var(--dsw-alias-state-error-primary); }
.twb-meta-done { color: var(--dsw-alias-state-success-primary); }
.twb-meta-note { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.twb-row-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.twb-row:hover .twb-row-actions, .twb-row:focus-within .twb-row-actions { opacity: 1; }
.twb-check { flex: none; width: 18px; height: 18px; margin-top: 1px; padding: 0; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary-inverted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.twb-check:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.twb-check.is-checked { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.twb-check:disabled { cursor: progress; }
.twb-check.is-readonly:disabled { cursor: not-allowed; }
.twb-priority { font-size: 10.5px; line-height: 1.6; padding: 0 6px; border-radius: 999px; border: 1px solid currentColor; color: var(--dsw-alias-label-tertiary); }
.twb-tone-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.twb-tone-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.twb-tone-brand { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.twb-tone-idle { color: var(--dsw-alias-label-tertiary); background: transparent; }
.twb-section-empty { font-size: 12px; color: var(--dsw-alias-label-tertiary); padding: 8px 2px; }
.twb-empty { display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 34px 16px; border-radius: 12px; border: 1px dashed var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); text-align: center; }
.twb-empty-icon { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.twb-empty-title { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.twb-empty-hint { font-size: 12px; max-width: 360px; line-height: 1.5; }
.twb-loading { display: flex; align-items: center; gap: 9px; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.twb-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: twb-spin .8s linear infinite; }
@keyframes twb-spin { to { transform: rotate(360deg); } }
.twb-week-head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 12px; }
.twb-week-range { font-size: 17px; font-weight: 650; }
.twb-week-sub { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.twb-week { position: relative; }
.twb-week-grid { display: grid; grid-template-columns: repeat(7, minmax(148px, 1fr)); gap: 8px; align-items: stretch; }
/* 走线层：压在日卡之上，线尾由日卡里的截止卡（z-index 2）盖住 */
.twb-week-lines { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.twb-week-line { position: absolute; height: 3px; border-radius: 2px; }
.twb-week-line.is-clip { border-radius: 0 2px 2px 0; }
.twb-week-line-dot { position: absolute; left: -4.5px; top: -3px; width: 9px; height: 9px; border-radius: 50%; background: inherit; }
.twb-week-stub { position: absolute; width: 20px; height: 3px; border-radius: 2px 0 0 2px; background-image: repeating-linear-gradient(to right, currentColor 0 4px, transparent 4px 8px); }
.twb-day-band { position: relative; }
.twb-span-card { position: absolute; left: 6px; right: 6px; z-index: 2; display: flex; align-items: center; gap: 6px; padding: 0 8px 0 6px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--twb-series) 34%, var(--twb-line)); border-left: 3px solid var(--twb-series); background: var(--twb-raised); box-shadow: var(--twb-shadow-card); overflow: hidden; }
.twb-span-card .twb-check { width: 15px; height: 15px; border-color: color-mix(in srgb, var(--twb-series) 45%, var(--twb-line-strong)); }
.twb-span-card-title { flex: 1; min-width: 0; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; font-size: 12.5px; line-height: 1.35; font-weight: 500; color: var(--dsw-alias-label-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.twb-span-card-title:hover:not(:disabled) { color: var(--twb-series); }
.twb-span-card-flag { position: absolute; right: -1px; top: -1px; width: 0; height: 0; border-left: 9px solid transparent; border-radius: 0 7px 0 0; }
.twb-span-card-flag.is-error { border-top: 9px solid var(--dsw-alias-state-error-primary); }
.twb-span-card-flag.is-warn { border-top: 9px solid var(--dsw-alias-state-warn-primary); }
.twb-span-card.is-done { opacity: .55; }
.twb-span-card.is-done .twb-span-card-title { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
/* 当日任务：用底色表达优先级，不再写优先级文字 */
.twb-day-task { --twb-prio: var(--dsw-alias-label-tertiary); margin: 3px 6px 5px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--twb-prio) 32%, var(--twb-line)); background: color-mix(in srgb, var(--twb-prio) 14%, var(--twb-raised)); }
.twb-day-task.is-error { --twb-prio: var(--dsw-alias-state-error-primary); }
.twb-day-task.is-warn { --twb-prio: var(--dsw-alias-state-warn-primary); }
.twb-day-task.is-brand { --twb-prio: var(--dsw-alias-brand-primary); }
.twb-day-task.is-idle { --twb-prio: var(--dsw-alias-label-tertiary); }
.twb-day-task.is-done { opacity: .6; }
.twb-week-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 9px; font-size: 9.5px; color: var(--dsw-alias-label-tertiary); }
.twb-week-foot > span { display: inline-flex; align-items: center; gap: 4px; }
.twb-week-legend-line { width: 16px; height: 3px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.twb-week-legend-flag { width: 0; height: 0; border-left: 5px solid transparent; border-top: 6px solid var(--dsw-alias-state-error-primary); }
.twb-week-legend-swatch { width: 11px; height: 11px; border-radius: 3px; border: 1px solid; background: color-mix(in srgb, var(--twb-prio) 12%, var(--twb-raised)); border-color: color-mix(in srgb, var(--twb-prio) 26%, var(--twb-line)); }
.twb-week-legend-swatch.is-error { --twb-prio: var(--dsw-alias-state-error-primary); }
.twb-week-legend-swatch.is-warn { --twb-prio: var(--dsw-alias-state-warn-primary); }
.twb-week-legend-swatch.is-brand { --twb-prio: var(--dsw-alias-brand-primary); }
.twb-week-legend-swatch.is-idle { --twb-prio: var(--dsw-alias-label-tertiary); }
.twb-week-legend-label { margin-left: 4px; }
.twb-week-foot-hint { margin-left: auto; }
.twb-day { display: flex; flex-direction: column; min-height: 240px; border-radius: 12px; border: 1px solid var(--twb-line); background: color-mix(in srgb, var(--dsw-alias-bg-mask-1) 8%, var(--twb-raised)); box-shadow: var(--twb-shadow-panel); overflow: hidden; }
.twb-day.is-past { background: color-mix(in srgb, var(--dsw-alias-bg-mask-1) 24%, var(--twb-canvas)); border-color: var(--dsw-alias-border-l1); box-shadow: none; }
.twb-day.is-past .twb-day-name, .twb-day.is-past .twb-day-date { color: var(--dsw-alias-label-tertiary); }
.twb-day.is-today { background: var(--twb-raised); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 32%, transparent); box-shadow: 0 6px 16px color-mix(in srgb, var(--dsw-alias-bg-mask-1) 16%, transparent), var(--twb-shadow-panel); }
.twb-day.is-today .twb-day-head { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, var(--twb-raised)); border-bottom-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
.twb-day-head { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--twb-head-tint); }
.twb-day-name { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
.twb-day.is-today .twb-day-name { color: var(--dsw-alias-brand-primary); }
.twb-today-pill { font-size: 9.5px; padding: 0 4px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); font-weight: 500; }
.twb-day-date { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.twb-day-head .twb-icon-btn { margin-left: auto; width: 22px; height: 22px; }
.twb-day-body { flex: 1; min-height: 0; padding: 3px 0 5px; display: flex; flex-direction: column; overflow: auto; }
.twb-day-empty { color: var(--dsw-alias-label-tertiary); font-size: 11px; text-align: center; padding-top: 14px; }
.twb-day .twb-row { border: 0; border-radius: 7px; background: transparent; box-shadow: none; padding: 6px 8px; }
.twb-day .twb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.twb-day .twb-row-actions { display: none; }
.twb-day .twb-row-meta { gap: 5px; }
.twb-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.twb-input { width: 100%; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); outline: none; font-size: 13px; }
.twb-input:focus { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.twb-toolbar .twb-input { width: auto; }
.twb-search { width: 220px !important; }
.twb-table-head { display: grid; grid-template-columns: minmax(220px, 1fr) 148px 110px 92px 70px; gap: 10px; padding: 10px 12px 9px; font-size: 11px; color: var(--dsw-alias-label-tertiary); background: var(--twb-head-tint); border-bottom: 1px solid var(--twb-line); }
.twb-table-head span:nth-child(4) { text-align: left; }
.twb-table { display: flex; flex-direction: column; border-radius: 12px; border: 1px solid var(--twb-line); background: var(--twb-raised); box-shadow: var(--twb-shadow-panel); overflow: hidden; }
.twb-table-row { display: grid; grid-template-columns: minmax(220px, 1fr) 148px 110px 92px 70px; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--twb-line); }
.twb-table-row:last-child { border-bottom: 0; }
.twb-table-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.twb-table-row.is-done { opacity: .6; }
.twb-table-row.is-done .twb-row-title { text-decoration: line-through; }
.twb-table-task { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.twb-table-tasktext { min-width: 0; }
.twb-table-sub { display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); min-width: 0; }
.twb-id { font-family: var(--dsw-font-code-font-family, ui-monospace, monospace); font-size: 10px; opacity: .8; }
.twb-table-date { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.twb-status { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.twb-status.is-done { color: var(--dsw-alias-state-success-primary); }
.twb-table-actions { display: flex; gap: 2px; opacity: 0; }
.twb-table-row:hover .twb-table-actions, .twb-table-row:focus-within .twb-table-actions { opacity: 1; }
.twb-table-foot { padding: 12px 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.twb-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding: calc(var(--dsh-frame-overlay-top, 48px) + 24px) 20px 24px; background: var(--dsw-alias-bg-mask-1); overflow: auto; }
.twb-modal { width: 460px; max-width: 100%; border-radius: 14px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent); }
.twb-modal.is-wide { width: 640px; }
.twb-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.twb-modal-title { font-size: 15px; font-weight: 650; }
.twb-modal-subtitle { margin-top: 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.twb-modal-body { padding: 14px 16px 16px; }
.twb-modal-foot { padding: 12px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.twb-form { display: flex; flex-direction: column; gap: 12px; }
.twb-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.twb-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.twb-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.twb-type-switch { display: inline-flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); align-self: flex-start; }
.twb-type-btn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 4px 14px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.twb-type-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.twb-type-btn.is-active { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-elevation-soft); font-weight: 600; }
.twb-time { position: relative; }
.twb-time .twb-input { padding-right: 28px; }
.twb-time-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; padding: 0; }
.twb-time-clear:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.twb-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); margin-top: -4px; }
.twb-form-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.twb-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.twb-confirm { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 4px 0 2px; }
.twb-confirm-icon { width: 42px; height: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.twb-confirm-icon.is-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.twb-confirm-title { font-size: 14px; font-weight: 650; }
.twb-confirm-text { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); max-width: 360px; }
.twb-confirm .twb-form-actions { width: 100%; margin-top: 8px; }
.twb-settings { display: flex; flex-direction: column; gap: 8px; }
.twb-setting-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; }
.twb-setting-row span:first-child { color: var(--dsw-alias-label-secondary); flex: none; }
.twb-setting-row code { font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; text-align: right; }
.twb-setting-note { margin-top: 4px; font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }
.twb-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 70; padding: 8px 14px; border-radius: 9px; font-size: 12.5px; background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label); box-shadow: var(--dsw-elevation-prominent); }
.twb-toast.is-error { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-inverted); }
.twb-toast.is-warn { background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary-inverted); }
.twb-init { max-width: 520px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
.twb-init-icon { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.twb-init-icon.is-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.twb-init-title { font-size: 18px; font-weight: 650; }
.twb-init-text { font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.twb-init-path { padding: 6px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.twb-init-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
@media (max-width: 900px) {
  .twb-header { flex-wrap: wrap; gap: 10px; }
  .twb-header-actions { margin-left: 0; }
  .twb-week-grid { grid-template-columns: repeat(7, 148px); overflow-x: auto; }
  .twb-week-lines { display: none; }
  .twb-table-head { display: none; }
  .twb-table-row { grid-template-columns: minmax(160px, 1fr) 110px 60px; }
  .twb-table-row > :nth-child(3), .twb-table-row > :nth-child(4) { display: none; }
}

/* ── 想法池（V2.0）：只依赖 --dsw-alias-* / --dsw-elevation-* token ─────── */
.twb-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.twb-idea-foot-right { display: flex; align-items: center; gap: 8px; }
.twb-empty-actions { display: flex; align-items: center; gap: 8px; }
.twb-ideas-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 18px; border-radius: 12px; background: var(--twb-raised); border: 1px solid var(--twb-line); box-shadow: var(--twb-shadow-panel); }
.twb-ideas-title { font-size: 19px; font-weight: 650; }
.twb-ideas-sub { margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.twb-ideas-stats { display: flex; gap: 6px; }
.twb-ideas-stat { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; min-width: 56px; padding: 5px 9px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: inherit; cursor: pointer; }
.twb-ideas-stat:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.twb-ideas-stat.is-active { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); border-color: var(--twb-line); box-shadow: none; }
.twb-ideas-stat-num { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
.twb-ideas-stat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.twb-ideas-stat[data-status="推进中"] .twb-ideas-stat-num { color: var(--dsw-alias-state-warn-primary); }
.twb-ideas-stat[data-status="完成"] .twb-ideas-stat-num { color: var(--dsw-alias-state-success-primary); }
.twb-ideas-stat[data-status="放弃"] .twb-ideas-stat-num { color: var(--dsw-alias-label-tertiary); }
.twb-ideas-toolbar { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px; flex-wrap: wrap; }
.twb-ideas-toolbar .twb-input { width: auto; }
.twb-ideas-toolbar .twb-idea-search { width: 230px; }
.twb-ideas-list { display: flex; flex-direction: column; gap: 8px; }
.twb-ideas-foot { padding: 14px 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.twb-idea-card { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px 11px; border-radius: 12px; background: var(--twb-raised); border: 1px solid var(--twb-line); box-shadow: var(--twb-shadow-card); transition: background .12s ease, border-color .12s ease; }
.twb-idea-card:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--twb-line-strong); }
.twb-idea-card.is-closed { opacity: .7; background: transparent; border-color: var(--dsw-alias-border-l1); box-shadow: none; }
.twb-idea-body { flex: 1; min-width: 0; }
.twb-idea-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.twb-idea-title { border: 0; background: none; padding: 0; text-align: left; cursor: pointer; font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--dsw-alias-label-primary); word-break: break-word; }
.twb-idea-title:hover { text-decoration: underline; text-underline-offset: 3px; }
.twb-idea-cat { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.twb-idea-desc { margin: 6px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.twb-idea-meta { margin-top: 7px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.twb-idea-id { font-family: var(--dsw-font-code-font-family, ui-monospace, monospace); font-size: 10px; opacity: .85; }
.twb-idea-maturity { display: inline-flex; align-items: center; gap: 3px; }
.twb-idea-mat-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-border-l3); }
.twb-idea-mat-dot.is-on { background: var(--dsw-alias-label-secondary); }
.twb-idea-mat-label { margin-left: 2px; }
.twb-idea-stale { color: var(--dsw-alias-state-warn-primary); }
.twb-idea-done-date { color: var(--dsw-alias-state-success-primary); }
.twb-idea-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.twb-idea-card:hover .twb-idea-actions, .twb-idea-card:focus-within .twb-idea-actions { opacity: 1; }
.twb-idea-status { position: relative; flex: none; }
.twb-idea-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 1.7; cursor: pointer; }
.twb-idea-pill:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); }
.twb-idea-pill:disabled { cursor: default; }
.twb-idea-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.twb-idea-pill-caret { font-size: 8px; opacity: .55; margin-left: 1px; }
.twb-idea-pill.is-doing { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
.twb-idea-pill.is-done { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent); }
.twb-idea-pill.is-dropped { color: var(--dsw-alias-label-tertiary); background: transparent; border-style: dashed; }
.twb-idea-menu { position: absolute; left: 0; top: calc(100% + 5px); z-index: 25; min-width: 132px; padding: 4px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); box-shadow: var(--dsw-elevation-prominent); }
.twb-idea-menu-item { display: flex; align-items: center; gap: 7px; width: 100%; border: 0; background: transparent; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; text-align: left; color: var(--dsw-alias-label-secondary); }
.twb-idea-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.twb-idea-menu-item.is-current { font-weight: 600; }
.twb-idea-menu-item.is-doing { color: var(--dsw-alias-state-warn-primary); }
.twb-idea-menu-item.is-done { color: var(--dsw-alias-state-success-primary); }
.twb-idea-menu-item.is-dropped { color: var(--dsw-alias-label-tertiary); }
.twb-idea-menu-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.twb-idea-textarea { resize: vertical; min-height: 72px; line-height: 1.55; }
.twb-idea-meta-box { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.9; }
/* 复盘（日 / 周 / 月） */
.twb-review-section { margin-top: 2px; }
.twb-review-card { border: 1px solid var(--twb-line); border-radius: 12px; background: var(--twb-raised); box-shadow: var(--twb-shadow-card); padding: 12px 13px 11px; margin-bottom: 10px; }
.twb-review-card.is-done { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 5%, var(--twb-raised)); }
.twb-review-head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.twb-review-kind { font-size: 11px; font-weight: 650; padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.twb-review-kind.is-weekly { color: var(--dsw-alias-brand-primary); }
.twb-review-kind.is-monthly { color: var(--dsw-alias-state-warn-primary); }
.twb-review-period { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.twb-review-state { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.twb-review-text { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.75; color: var(--dsw-alias-label-primary); }
.twb-review-textarea { resize: vertical; min-height: 88px; line-height: 1.7; }
.twb-review-actions { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.twb-review-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-right: auto; }
.twb-review-error { padding: 10px 12px; border-radius: 10px; font-size: 12px; color: var(--dsw-alias-state-warn-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
.twb-review-materials { margin: 0 0 10px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-2); }
.twb-review-materials > summary { cursor: pointer; padding: 7px 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.twb-review-materials-body { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.twb-review-material-title { font-size: 10.5px; font-weight: 650; color: var(--dsw-alias-label-tertiary); margin-bottom: 3px; }
.twb-review-material-line { font-size: 11.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.twb-review-material-empty { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.twb-review-material-note { padding: 5px 0; border-top: 1px dashed var(--dsw-alias-border-l1); }
.twb-review-material-note:first-of-type { border-top: 0; }
.twb-review-material-note-head { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); margin-bottom: 2px; }
.twb-review-material-note-text { white-space: pre-wrap; word-break: break-word; font-size: 11.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.twb-review-history-form { display: grid; grid-template-columns: minmax(95px, 120px) minmax(120px, 1fr) auto; gap: 8px; }
.twb-btn.is-subtle { background: transparent; border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.twb-type-btn.is-active.is-tone-doing { color: var(--dsw-alias-state-warn-primary); }
.twb-type-btn.is-active.is-tone-done { color: var(--dsw-alias-state-success-primary); }
@media (max-width: 900px) {
  .twb-ideas-summary { flex-direction: column; align-items: flex-start; }
  .twb-ideas-stats { flex-wrap: wrap; }
  .twb-ideas-toolbar .twb-idea-search { width: 100%; }
  .twb-idea-top { flex-wrap: wrap; }
}
/* ── 本周 / 本月概览 + 月历（本周页底部） ─────────────────────────── */
.twb-month-band { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; margin-top: 14px; align-items: stretch; }
.twb-ov { grid-column: span 2; display: flex; flex-direction: column; min-width: 0; padding: 13px 15px 11px; border-radius: 12px; border: 1px solid var(--twb-line); background: var(--twb-raised); box-shadow: var(--twb-shadow-panel); }
.twb-ov-head { display: flex; align-items: baseline; gap: 7px; }
.twb-ov-title { font-size: 13.5px; font-weight: 650; }
.twb-ov-sub { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.twb-ring { position: relative; flex: none; margin: 12px auto 14px; }
.twb-ring-track { stroke: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.twb-ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.twb-ring-num { font-size: 34px; line-height: 1.05; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.twb-ring-num.is-sm { font-size: 27px; }
.twb-ring-cap { margin-top: 3px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.twb-ov-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.twb-ov-stat { padding: 7px 9px 6px; border-radius: 9px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.twb-ov-stat-label { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.twb-ov-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.twb-ov-dot.is-ok { background: var(--dsw-alias-state-success-primary); }
.twb-ov-dot.is-warn { background: var(--dsw-alias-state-warn-primary); }
.twb-ov-dot.is-bad { background: var(--dsw-alias-state-error-primary); }
.twb-ov-stat-num { margin-top: 1px; font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; }
.twb-ov-stat-num.is-ok { color: var(--dsw-alias-state-success-primary); }
.twb-ov-stat-num.is-warn { color: var(--dsw-alias-state-warn-primary); }
.twb-ov-stat-num.is-bad { color: var(--dsw-alias-state-error-primary); }
.twb-ov-unit { margin-left: 2px; font-size: 10px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.twb-ov-note { margin: 7px 0 0; font-size: 9.5px; color: var(--dsw-alias-label-tertiary); }
.twb-ov-foot { display: flex; gap: 7px; margin-top: auto; padding-top: 9px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.twb-ov-foot b { color: var(--dsw-alias-label-secondary); font-weight: 600; }
.twb-cal { grid-column: span 3; display: flex; flex-direction: column; min-width: 0; padding: 12px 13px 10px; border-radius: 12px; border: 1px solid var(--twb-line); background: var(--twb-raised); box-shadow: var(--twb-shadow-panel); }
.twb-cal-head { display: flex; align-items: center; gap: 3px; }
.twb-cal-nav { width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font-size: 12px; }
.twb-cal-nav:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.twb-cal-nav:disabled { opacity: .45; cursor: not-allowed; }
.twb-cal-title { margin: 0 2px; font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
.twb-cal-today { margin-left: auto; padding: 2px 7px; border: 1px solid var(--twb-line); border-radius: 6px; background: var(--twb-raised); color: var(--dsw-alias-label-secondary); font-size: 10px; cursor: pointer; }
.twb-cal-today:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.twb-cal-today:disabled { opacity: .45; cursor: not-allowed; }
.twb-cal-week { display: grid; grid-template-columns: repeat(7, 1fr); margin-top: 9px; padding-bottom: 5px; }
.twb-cal-week span { text-align: center; font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-tertiary); letter-spacing: .03em; }
.twb-cal-grid { display: flex; flex-direction: column; gap: 1px; background: var(--dsw-alias-border-l1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; overflow: hidden; }
.twb-cal-row { position: relative; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; background: var(--dsw-alias-border-l1); }
.twb-cal-cell { position: relative; height: 54px; padding: 6px 0 0; display: flex; flex-direction: column; align-items: center; border: 0; background: var(--twb-raised); color: inherit; font: inherit; cursor: pointer; }
.twb-cal-cell:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.twb-cal-cell:disabled { cursor: progress; }
.twb-cal-cell.is-weekend { background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--twb-raised)); }
.twb-cal-cell.is-adj { background: color-mix(in srgb, var(--dsw-alias-label-primary) 1.5%, var(--twb-raised)); }
.twb-cal-cell.is-adj .twb-cal-num { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.twb-cal-num { width: 25px; height: 25px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.twb-cal-cell.is-today .twb-cal-num { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-label-primary-inverted); font-weight: 600; }
.twb-cal-dot { width: 5px; height: 5px; margin-top: 3px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); }
.twb-cal-dot.is-done { background: var(--dsw-alias-label-tertiary); }
.twb-cal-legend { display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 8px; font-size: 9.5px; color: var(--dsw-alias-label-tertiary); }
.twb-cal-legend > span { display: inline-flex; align-items: center; gap: 4px; }
.twb-legend-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-error-primary); }
.twb-legend-dot.is-done { background: var(--dsw-alias-label-tertiary); }
.twb-cal-hint { margin-left: auto; }
/* 当天任务详情弹窗：行式任务卡，点标题/行进编辑 */
.twb-day-detail { display: flex; flex-direction: column; gap: 8px; }
.twb-day-detail .twb-row { padding: 8px 10px; }
.twb-day-detail-actions { display: flex; align-items: center; gap: 8px; }
@media (max-width: 900px) {
  .twb-month-band { grid-template-columns: 1fr 1fr; }
  .twb-cal { grid-column: 1 / -1; }
}
`

    // ── 注册 ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 6,
        label: () => '任务工作台',
      }, WorkbenchIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, WorkbenchPanel))
    }

    exports.isPlugin = true
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
