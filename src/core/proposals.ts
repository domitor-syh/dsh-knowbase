import { createHash } from 'node:crypto'
import { decodeUtf8Text } from './text.ts'
import { isSafeTextProposalName } from './proposal-name.ts'
import { type KnowledgeBase } from './model.ts'
import { resolveScope, type SessionSelectionRegistry } from './session-scope.ts'
import type { KnowbaseService } from './service.ts'

export const MAX_PROPOSAL_BYTES = 64 * 1024
export const PROPOSAL_TTL_MS = 30 * 60 * 1000
export const MAX_PROPOSAL_REASON = 500
export const MAX_PROPOSAL_PREVIEW = 4000

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'failed'

export interface StoredProposal {
  readonly id: string
  readonly sessionId: string
  readonly kbId: string
  readonly kbName: string
  readonly fileName: string
  readonly content: string
  readonly contentBytes: number
  readonly contentHash: string
  readonly reason: string
  readonly baseRevision: number
  readonly createdAt: number
  readonly expiresAt: number
  readonly status: ProposalStatus
  readonly appliedAt?: number
  readonly materialId?: string
  readonly failure?: string
}

export interface ProposalStore {
  loadAll(): readonly StoredProposal[]
  save(proposal: StoredProposal): Promise<void>
}

export interface ProposalView {
  readonly id: string
  readonly sessionId: string
  readonly kbId: string
  readonly kbName: string
  readonly fileName: string
  readonly content: string
  readonly contentBytes: number
  readonly contentHash: string
  readonly contentPreview: string
  readonly reason: string
  readonly baseRevision: number
  readonly createdAt: number
  readonly expiresAt: number
  readonly status: ProposalStatus
  readonly appliedAt?: number
  readonly materialId?: string
  readonly failure?: string
}

export class ProposalError extends Error {
  readonly code:
    | 'invalid-arguments'
    | 'disabled'
    | 'no-selection'
    | 'no-bases'
    | 'out-of-scope'
    | 'not-found'
    | 'expired'
    | 'not-pending'
    | 'stale'
    | 'duplicate'
    | 'apply-failed'
    | 'not-ready'

  constructor(code: ProposalError['code'], message: string) {
    super(message)
    this.name = 'ProposalError'
    this.code = code
  }
}

/** Session-bound proposal state with TTL and optimistic revision checks. */
export class ProposalRegistry {
  readonly #proposals = new Map<string, StoredProposal>()
  readonly #now: () => number
  readonly #service: () => KnowbaseService | undefined
  readonly #selection: SessionSelectionRegistry
  #store: ProposalStore | undefined

  constructor(options: {
    now?: () => number
    service: () => KnowbaseService | undefined
    selection: SessionSelectionRegistry
  }) {
    this.#now = options.now ?? (() => Date.now())
    this.#service = options.service
    this.#selection = options.selection
  }

  async useStore(store: ProposalStore): Promise<void> {
    this.#store = store
    for (const proposal of store.loadAll()) this.#proposals.set(proposal.id, proposal)
    await this.#expire()
  }

  async create(
    sessionId: string,
    kbId: string,
    rawFileName: string,
    content: string,
    rawReason: string,
  ): Promise<ProposalView> {
    const service = this.#requireService()
    const base = this.#requireInScope(sessionId, kbId, service)
    const fileName = validateFileName(rawFileName)
    if (service.listMaterials(kbId).some(material => material.fileName === fileName)) {
      throw new ProposalError('duplicate', '目标文件已存在，提案不会覆盖原资料。')
    }
    const text = validateText(content)
    const reason = rawReason.trim().slice(0, MAX_PROPOSAL_REASON)
    const now = this.#now()
    const proposal: StoredProposal = {
      id: `proposal_${createHash('sha256').update(`${sessionId}\0${kbId}\0${fileName}\0${now}\0${Math.random()}`).digest('hex').slice(0, 32)}`,
      sessionId,
      kbId,
      kbName: base.name,
      fileName,
      content: text,
      contentBytes: byteLength(text),
      contentHash: hashText(text),
      reason,
      baseRevision: base.indexRevision,
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
      status: 'pending',
    }
    await this.#save(proposal)
    return viewOf(proposal)
  }

  async list(sessionId: string): Promise<readonly ProposalView[]> {
    await this.#expire()
    return [...this.#proposals.values()]
      .filter(proposal => proposal.sessionId === sessionId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(viewOf)
  }

  async reject(sessionId: string, proposalId: string): Promise<ProposalView> {
    const proposal = this.#requireOwned(sessionId, proposalId)
    if (proposal.status !== 'pending') throw new ProposalError('not-pending', '该提案已经结束，不能重复拒绝。')
    const updated: StoredProposal = { ...proposal, status: 'rejected' }
    await this.#save(updated)
    return viewOf(updated)
  }

  async approve(sessionId: string, proposalId: string): Promise<ProposalView> {
    const proposal = this.#requireOwned(sessionId, proposalId)
    if (proposal.status !== 'pending') throw new ProposalError('not-pending', '该提案已经结束，不能重复批准。')
    if (this.#now() >= proposal.expiresAt) {
      const expired: StoredProposal = { ...proposal, status: 'expired' }
      await this.#save(expired)
      throw new ProposalError('expired', '提案已过期，请重新生成。')
    }

    const service = this.#requireService()
    const base = this.#requireInScope(sessionId, proposal.kbId, service)
    if (base.indexRevision !== proposal.baseRevision) {
      throw new ProposalError('stale', '知识库在提案后发生变化，请重新生成提案。')
    }

    try {
      const material = await service.addTextAtomically(
        proposal.kbId,
        proposal.fileName,
        proposal.content,
        proposal.baseRevision,
      )
      const applied: StoredProposal = {
        ...proposal,
        status: 'approved',
        appliedAt: this.#now(),
        materialId: material.id,
      }
      await this.#save(applied)
      return viewOf(applied)
    } catch (error) {
      const failure = error instanceof ProposalError ? error.message : '写入未完成，知识库未确认应用。'
      const failed: StoredProposal = { ...proposal, status: 'failed', failure }
      await this.#save(failed)
      if (error instanceof ProposalError) throw error
      throw new ProposalError('apply-failed', failure)
    }
  }

  async #expire(): Promise<void> {
    const now = this.#now()
    for (const proposal of this.#proposals.values()) {
      if (proposal.status !== 'pending' || proposal.expiresAt > now) continue
      await this.#save({ ...proposal, status: 'expired' })
    }
  }

  async #save(proposal: StoredProposal): Promise<void> {
    if (this.#store !== undefined) await this.#store.save(proposal)
    this.#proposals.set(proposal.id, proposal)
  }

  #requireOwned(sessionId: string, proposalId: string): StoredProposal {
    const proposal = this.#proposals.get(proposalId)
    if (proposal === undefined || proposal.sessionId !== sessionId) {
      throw new ProposalError('not-found', '提案不存在或不属于当前会话。')
    }
    return proposal
  }

  #requireService(): KnowbaseService {
    const service = this.#service()
    if (service === undefined) throw new ProposalError('not-ready', '知识库仍在初始化。')
    return service
  }

  #requireInScope(sessionId: string, kbId: string, service: KnowbaseService): KnowledgeBase {
    const scope = resolveScope(this.#selection.get(sessionId), service)
    if (scope.kind === 'disabled') throw new ProposalError('disabled', '当前会话的知识库已关闭，请由用户开启。')
    if (scope.kind === 'nothing-selected') throw new ProposalError('no-selection', '当前会话没有勾选知识库。')
    if (scope.kind === 'no-bases') throw new ProposalError('no-bases', '尚无知识库。')
    if (!scope.ids.includes(kbId)) throw new ProposalError('out-of-scope', '该知识库不在当前会话可写入范围内。')
    const base = service.getKnowledgeBase(kbId)
    if (base === undefined) throw new ProposalError('out-of-scope', '该知识库已不存在。')
    return base
  }
}

export function proposalToolView(view: ProposalView): Record<string, unknown> {
  return {
    proposalId: view.id,
    status: view.status,
    kbId: view.kbId,
    kbName: view.kbName,
    fileName: view.fileName,
    contentBytes: view.contentBytes,
    contentHash: view.contentHash,
    contentPreview: view.contentPreview,
    baseRevision: view.baseRevision,
    expiresAt: view.expiresAt,
    message: '提案已创建，等待用户在界面中查看并批准；Agent 不能直接应用提案。',
  }
}

function viewOf(proposal: StoredProposal): ProposalView {
  return {
    ...proposal,
    contentPreview: proposal.content.slice(0, MAX_PROPOSAL_PREVIEW),
  }
}

function validateFileName(raw: string): string {
  const fileName = raw.trim()
  if (!isSafeTextProposalName(fileName)) {
    throw new ProposalError('invalid-arguments', '文件名必须是安全的单层文本文件名，并使用已知 UTF-8 文本扩展名。')
  }
  return fileName
}

function validateText(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || byteLength(value) > MAX_PROPOSAL_BYTES) {
    throw new ProposalError('invalid-arguments', '文本不能为空且不能超过 64 KiB。')
  }
  try {
    decodeUtf8Text(new TextEncoder().encode(value), MAX_PROPOSAL_BYTES)
  } catch {
    throw new ProposalError('invalid-arguments', '文本必须是有效且可索引的 UTF-8 内容。')
  }
  return value
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function hashText(value: string): string {
  return createHash('sha256').update(new TextEncoder().encode(value)).digest('hex')
}
