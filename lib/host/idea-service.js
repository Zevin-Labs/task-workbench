// IdeaService：想法池的唯一读写网关（UI 走 /ptw/api/ideas*，AI 走 ptw_idea_*）。
// 写入统一走 串行队列 → 校验 → baseHash → 备份 → 原子写 → 回读 → 审计。
// 权限：AI 可读 / 新建 / 编辑内容 / 删除；状态流转（待实现/推进中/完成/放弃）仅人。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_IDEA_STATUS, IDEA_MATURITIES, IDEA_STATUSES, TaskError, todayStr,
} from '../core/contract.js'
import {
  appendIdeaBlock, findIdea, normalizeIdea, removeIdeaBlock, replaceIdeaBlock, parseIdeaPool,
} from '../core/idea-grammar.js'
import { deriveIdeaCounts, deriveIdeaList, emptyIdeaCounts, publicIdea } from '../core/idea-derive.js'
import { assertIdeaId, normalizeIdeaCreateInput, normalizeIdeaUpdateChanges } from '../core/idea-validate.js'
import { WriteGateway, normalizeError } from './gateway.js'

function generateIdeaId(model, today, reserved = 0) {
  const compact = today.replaceAll('-', '')
  const prefix = `I-${compact}-`
  let max = Number.isInteger(reserved) && reserved > 0 ? reserved : 0
  for (const idea of model.ideas) {
    if (!idea.id.startsWith(prefix)) continue
    const n = Number(idea.id.slice(prefix.length))
    if (Number.isInteger(n)) max = Math.max(max, n)
  }
  const next = max + 1
  if (next > 99) {
    throw new TaskError('id-exhausted', '今天创建的想法已经超过 99 条，请调整数据格式', 409)
  }
  return `${prefix}${String(next).padStart(2, '0')}`
}

function emptyIdeaList() {
  return {
    ideas: [],
    counts: emptyIdeaCounts(),
    lastUpdated: null,
    hash: null,
    readOnly: false,
    warnings: [],
  }
}

export class IdeaService extends WriteGateway {
  constructor({ store, stateDir, now = () => new Date(), logger = null }) {
    super({ stateDir, now, logger })
    this.store = store
    this.idStateFile = join(stateDir, 'idea-ids.json')
    this.idState = null
  }

  // ── ID 分配状态：删除后也不复用（按天） ────────────────────────────────
  async loadIdState() {
    if (this.idState !== null) return this.idState
    try {
      const parsed = JSON.parse(await readFile(this.idStateFile, 'utf8'))
      this.idState = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      this.idState = {}
    }
    return this.idState
  }

  async saveIdState() {
    if (this.idState === null) return
    try {
      await mkdir(this.stateDir, { recursive: true })
      const tmp = `${this.idStateFile}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, `${JSON.stringify(this.idState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, this.idStateFile)
    } catch (error) {
      this.logger?.warn?.(`[task-workbench] 想法 ID 状态写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 读取 ────────────────────────────────────────────────────────────────
  emptyBootstrap() {
    return {
      dataRoot: this.store.dataRoot,
      file: this.store.file,
      initialized: false,
      hash: null,
      readOnly: false,
      readOnlyReason: null,
      counts: emptyIdeaCounts(),
      warnings: [],
      errors: [],
      statuses: IDEA_STATUSES,
      maturities: IDEA_MATURITIES,
    }
  }

  async buildBootstrap() {
    try {
      const shard = await this.store.read()
      const status = await this.store.status()
      return {
        ...status,
        initialized: true,
        hash: shard.hash,
        readOnly: shard.model.readOnly,
        readOnlyReason: shard.model.readOnlyReason,
        counts: deriveIdeaCounts(shard.model),
        warnings: shard.model.warnings,
        errors: shard.model.errors,
        statuses: IDEA_STATUSES,
        maturities: IDEA_MATURITIES,
      }
    } catch (error) {
      if (error instanceof TaskError && error.code === 'file-missing') {
        const status = await this.store.status().catch(() => null)
        return { ...this.emptyBootstrap(), file: status?.file ?? this.store.file, dataRoot: this.store.dataRoot }
      }
      throw normalizeError(error)
    }
  }

  bootstrap() {
    return this.enqueue(() => this.buildBootstrap())
  }

  list() {
    return this.enqueue(async () => {
      const today = todayStr(this.now())
      try {
        const shard = await this.store.read()
        if (shard.model.readOnly) {
          throw new TaskError('read-only', `想法池文件只读：${shard.model.errors[0]?.message ?? '格式不受支持'}`, 409, {
            errors: shard.model.errors,
          })
        }
        return {
          ...deriveIdeaList(shard.model, { today }),
          hash: shard.hash,
          readOnly: false,
          warnings: shard.model.warnings,
        }
      } catch (error) {
        if (error instanceof TaskError && error.code === 'file-missing') return emptyIdeaList()
        throw normalizeError(error)
      }
    })
  }

  get(ideaId) {
    return this.enqueue(async () => {
      assertIdeaId(ideaId)
      try {
        const shard = await this.store.read()
        const idea = findIdea(shard.model, ideaId)
        if (!idea) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
        return { idea: publicIdea(idea, todayStr(this.now())), hash: shard.hash }
      } catch (error) {
        if (error instanceof TaskError && error.code === 'file-missing') {
          throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
        }
        throw normalizeError(error)
      }
    })
  }

  // ── 写入 ────────────────────────────────────────────────────────────────
  ensureWritable(shard) {
    if (shard.model.readOnly) {
      throw new TaskError('read-only', `想法池文件只读：${shard.model.errors[0]?.message ?? '格式不受支持'}`, 409, {
        errors: shard.model.errors,
      })
    }
  }

  checkHash(shard, baseHash) {
    if (typeof baseHash === 'string' && baseHash !== '' && baseHash !== shard.hash) {
      throw new TaskError('external-change', '想法池文件已被外部修改，已阻止覆盖；请重新加载后再操作', 409, {
        currentHash: shard.hash,
      })
    }
  }

  async commit(shard, newText, { actor, op, ideaId, before = null, after = null }) {
    let parsed
    try {
      parsed = parseIdeaPool(newText, { file: shard.file })
    } catch (error) {
      throw new TaskError('write-failed', `写入内容无法解析：${error instanceof Error ? error.message : String(error)}`, 500)
    }
    if (parsed.readOnly) {
      throw new TaskError('write-failed', `写入内容解析失败：${parsed.errors[0]?.message ?? '未知结构错误'}`, 500)
    }
    const ids = parsed.ideas.map((idea) => idea.id)
    if (new Set(ids).size !== ids.length) {
      throw new TaskError('validation-error', '写入会产生重复想法 ID，已中止', 400)
    }
    try {
      const { backupPath, hash } = await this.store.backupAndWrite(newText, shard.text)
      await this.audit({
        ok: true,
        actor: actor.id,
        actorKind: actor.kind,
        op,
        ideaId,
        before,
        after,
        oldHash: shard.hash,
        newHash: hash,
        backupPath,
      })
      return { hash, backupPath, model: parsed }
    } catch (error) {
      const normalized = normalizeError(error)
      await this.audit({
        ok: false,
        actor: actor.id,
        actorKind: actor.kind,
        op,
        ideaId,
        oldHash: shard.hash,
        error: { code: normalized.code, message: normalized.message },
      })
      throw normalized
    }
  }

  create(input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      const today = todayStr(this.now())
      const clean = normalizeIdeaCreateInput(input, today)
      await this.store.ensureFile()
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)

      const idState = await this.loadIdState()
      const idea = {
        id: generateIdeaId(shard.model, today, Number(idState[today]) || 0),
        name: clean.name,
        description: clean.description,
        status: DEFAULT_IDEA_STATUS,
        maturity: clean.maturity,
        category: clean.category,
        created: today,
        updated: today,
        completed: null,
        unknown: [],
      }
      const newText = appendIdeaBlock(shard.text, idea, today)
      const { hash, backupPath, model } = await this.commit(shard, newText, {
        actor,
        op: 'idea-create',
        ideaId: idea.id,
        after: publicIdea(idea, today),
      })
      const created = findIdea(model, idea.id)
      idState[today] = Number(idea.id.slice(-2))
      await this.saveIdState()
      return { idea: created ? publicIdea(created, today) : publicIdea(idea, today), hash, backupPath }
    }))
  }

  update(ideaId, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertIdeaId(ideaId)
      const changes = normalizeIdeaUpdateChanges(input?.changes ?? input ?? {})
      if (changes.status !== undefined && actor?.kind !== 'user') {
        throw new TaskError('permission-denied', '想法状态只能由人修改，AI 不能执行', 403)
      }
      const today = todayStr(this.now())
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)
      const existing = findIdea(shard.model, ideaId)
      if (!existing) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)

      const merged = { ...normalizeIdea(existing), ...changes, updated: today }
      if (changes.status !== undefined) {
        merged.completed = changes.status === '完成' ? (existing.completed || today) : null
      }
      const newText = replaceIdeaBlock(shard.text, ideaId, merged, today)
      const { hash, backupPath, model } = await this.commit(shard, newText, {
        actor,
        op: 'idea-update',
        ideaId,
        before: publicIdea(existing, today),
        after: publicIdea(merged, today),
      })
      const updated = findIdea(model, ideaId)
      return { idea: updated ? publicIdea(updated, today) : publicIdea(merged, today), hash, backupPath }
    }))
  }

  remove(ideaId, input, actor, { requestId } = {}) {
    return this.enqueue(() => this.writeOp(requestId, async () => {
      assertIdeaId(ideaId)
      const today = todayStr(this.now())
      const shard = await this.store.read()
      this.ensureWritable(shard)
      this.checkHash(shard, input?.baseHash)
      const existing = findIdea(shard.model, ideaId)
      if (!existing) throw new TaskError('not-found', `想法 ${ideaId} 不存在`, 404)
      const newText = removeIdeaBlock(shard.text, ideaId, today)
      const { hash, backupPath } = await this.commit(shard, newText, {
        actor,
        op: 'idea-delete',
        ideaId,
        before: publicIdea(existing, today),
        after: null,
      })
      return { deleted: { id: existing.id, name: existing.name }, hash, backupPath }
    }))
  }

  // ── 管理 ────────────────────────────────────────────────────────────────
  reload() {
    return this.enqueue(async () => {
      try {
        await this.store.reload()
      } catch (error) {
        if (!(error instanceof TaskError && error.code === 'file-missing')) throw normalizeError(error)
      }
      return this.buildBootstrap()
    })
  }
}
