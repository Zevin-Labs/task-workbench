// IdeaService：想法池的唯一读写网关（UI 走 /tw/api/ideas*，AI 走 tw_idea_*）。
// 写入走 SQLite 同步短事务：版本校验 → 数据变更 → write_log 审计 → 版本递增。
// 权限：AI 可读 / 新建 / 编辑内容 / 删除；状态流转（待实现/推进中/完成/放弃）仅人。
import {
  DEFAULT_IDEA_STATUS, IDEA_MATURITIES, IDEA_STATUSES, TaskError, todayStr,
} from '../core/contract.js'
import { deriveIdeaList, emptyIdeaCounts, publicIdea } from '../core/idea-derive.js'
import { assertIdeaId, normalizeIdeaCreateInput, normalizeIdeaUpdateChanges } from '../core/idea-validate.js'
import { WriteGateway, normalizeError } from './gateway.js'

function rowToIdea(row) {
  return {
    id: `I-${Number(row.id)}`,
    name: row.name,
    description: row.description ?? '',
    status: row.status,
    maturity: row.maturity,
    category: row.category ?? '',
    created: row.created,
    updated: row.updated,
    completed: row.completed ?? null,
    order: Number(row.id),
  }
}

function loadIdeas(db) {
  return db.prepare('SELECT * FROM ideas ORDER BY id').all().map(rowToIdea)
}

function ideaIdOf(ideaId) {
  const id = assertIdeaId(ideaId)
  return Number(id.slice(2))
}

function ideaAudit(idea) {
  return {
    id: idea.id,
    name: idea.name,
    status: idea.status,
    maturity: idea.maturity,
    category: idea.category,
    updated: idea.updated,
    descriptionLength: String(idea.description ?? '').length,
  }
}

function countsFromRows(rows) {
  const counts = emptyIdeaCounts()
  for (const row of rows) {
    const n = Number(row.n)
    counts.total += n
    if (row.status === '待实现') counts.todo += n
    else if (row.status === '推进中') counts.doing += n
    else if (row.status === '完成') counts.done += n
    else if (row.status === '放弃') counts.dropped += n
  }
  counts.open = counts.todo + counts.doing
  return counts
}

export class IdeaService extends WriteGateway {
  constructor({ db, now = () => new Date(), logger = null }) {
    super({ db, now, logger })
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  emptyBootstrap() {
    return {
      initialized: false,
      dataRoot: this.db.dataRoot,
      database: this.db.file,
      version: 0,
      counts: emptyIdeaCounts(),
      lastUpdated: null,
      statuses: IDEA_STATUSES,
      maturities: IDEA_MATURITIES,
    }
  }

  /** bootstrap 只做 SQL 聚合，不读取想法正文。 */
  async bootstrap() {
    try {
      if (!this.db.isInitialized()) return this.emptyBootstrap()
      const db = this.db.ensureInitialized()
      const rows = db.prepare('SELECT status, COUNT(*) AS n FROM ideas GROUP BY status').all()
      const last = db.prepare('SELECT MAX(updated) AS last FROM ideas').get()
      return {
        initialized: true,
        dataRoot: this.db.dataRoot,
        database: this.db.file,
        version: this.db.readVersion('ideas', db),
        counts: countsFromRows(rows),
        lastUpdated: last?.last ?? null,
        statuses: IDEA_STATUSES,
        maturities: IDEA_MATURITIES,
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  /** 想法页一次读取当前列表（含描述），与现有交互一致。未初始化时返回空列表。 */
  async list() {
    try {
      if (!this.db.isInitialized()) {
        return { ideas: [], counts: emptyIdeaCounts(), lastUpdated: null, version: 0 }
      }
      const db = this.db.ensureInitialized()
      const today = todayStr(this.now())
      return {
        ...deriveIdeaList({ ideas: loadIdeas(db) }, { today }),
        version: this.db.readVersion('ideas', db),
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async get(ideaId) {
    try {
      const id = ideaIdOf(ideaId)
      if (!this.db.isInitialized()) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
      const db = this.db.ensureInitialized()
      const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id)
      if (!row) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
      return { idea: publicIdea(rowToIdea(row), todayStr(this.now())), version: this.db.readVersion('ideas', db) }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  async create(input, actor, { requestId } = {}) {
    return this.writeOp(requestId, () => {
      try {
        const today = todayStr(this.now())
        const clean = normalizeIdeaCreateInput(input, today)
        return this.db.transaction((db) => {
          this.db.checkVersion(db, 'ideas', input?.baseVersion)
          const inserted = db.prepare(`
            INSERT INTO ideas (name, description, status, maturity, category, created, updated, completed)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          `).run(
            clean.name,
            clean.description,
            DEFAULT_IDEA_STATUS,
            clean.maturity,
            clean.category,
            today,
            today,
          )
          const idea = rowToIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(Number(inserted.lastInsertRowid)))
          this.db.audit(db, { actor, op: 'idea-create', domain: 'idea', target: idea.id, detail: { after: ideaAudit(idea) } })
          const version = this.db.bumpVersion(db, 'ideas')
          return { idea: publicIdea(idea, today), version }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  async update(ideaId, input, actor, { requestId } = {}) {
    const changes = normalizeIdeaUpdateChanges(input?.changes ?? input ?? {})
    // 权限在幂等缓存之前校验，避免用旧 requestId 回放绕过。
    if (changes.status !== undefined && actor?.kind !== 'user') {
      throw new TaskError('permission-denied', '想法状态只能由人修改，AI 不能执行', 403)
    }
    return this.writeOp(requestId, () => {
      try {
        const id = ideaIdOf(ideaId)
        const today = todayStr(this.now())
        return this.db.transaction((db) => {
          this.db.checkVersion(db, 'ideas', input?.baseVersion)
          const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id)
          if (!row) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
          const existing = rowToIdea(row)

          const merged = { ...existing, ...changes, updated: today }
          if (changes.status !== undefined) {
            merged.completed = changes.status === '完成' ? (existing.completed || today) : null
          }

          db.prepare(`
            UPDATE ideas SET name = ?, description = ?, status = ?, maturity = ?, category = ?, updated = ?, completed = ?
            WHERE id = ?
          `).run(
            merged.name,
            merged.description,
            merged.status,
            merged.maturity,
            merged.category,
            merged.updated,
            merged.completed,
            id,
          )
          const idea = rowToIdea(db.prepare('SELECT * FROM ideas WHERE id = ?').get(id))
          this.db.audit(db, {
            actor,
            op: 'idea-update',
            domain: 'idea',
            target: idea.id,
            detail: { before: ideaAudit(existing), after: ideaAudit(idea) },
          })
          const version = this.db.bumpVersion(db, 'ideas')
          return { idea: publicIdea(idea, today), version }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  async remove(ideaId, input, actor, { requestId } = {}) {
    return this.writeOp(requestId, () => {
      try {
        const id = ideaIdOf(ideaId)
        const db = this.db.ensureInitialized()
        const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id)
        if (!row) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
        const existing = rowToIdea(row)
        this.db.checkVersion(db, 'ideas', input?.baseVersion)

        const backupPath = this.db.backup({
          reason: 'ideas',
          verify: (backupDb) => Boolean(backupDb.prepare('SELECT 1 AS present FROM ideas WHERE id = ?').get(id)),
        })

        return this.db.transaction((tx) => {
          this.db.checkVersion(tx, 'ideas', input?.baseVersion)
          const current = tx.prepare('SELECT * FROM ideas WHERE id = ?').get(id)
          if (!current) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
          const idea = rowToIdea(current)
          tx.prepare('DELETE FROM ideas WHERE id = ?').run(id)
          this.db.audit(tx, {
            actor,
            op: 'idea-delete',
            domain: 'idea',
            target: idea.id,
            detail: { before: ideaAudit(idea), backupPath },
          })
          const version = this.db.bumpVersion(tx, 'ideas')
          return { deleted: { id: idea.id, name: idea.name }, version, backupPath }
        })
      } catch (error) {
        throw normalizeError(error)
      }
    })
  }

  // ── 管理 ────────────────────────────────────────────────────────────────
  async reload() {
    return this.bootstrap()
  }
}
