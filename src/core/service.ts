/**
 * Knowledge base domain logic.
 *
 * The store is an interface, not a concrete backend, so all of this is testable
 * without a host: `StorageDomainStore` in `../store.ts` is one implementation,
 * and the tests use an in-memory one. The plan's requirement that "核心接口与宿主
 * 适配器分离" is what makes this file possible to verify at all.
 *
 * Reads are synchronous and writes are asynchronous, matching the storage
 * contract: the backend loads a snapshot into memory on open, so `get` and
 * iteration need no await, while `put` and `delete` resolve only after
 * durability.
 *
 * @module @domitor-syh/dsh-knowbase/core/service
 */

import type { RetrievalOutcome, RetrievedPassage } from '../pre-step.ts'
import { buildBackupDocument, planImport, type BackupDocument } from './backup.ts'
import { Bm25Index } from './bm25.ts'
import { chunkText, type ChunkOptions } from './chunk.ts'
import { contentFingerprint } from './fingerprint.ts'
import { materialText, newId, normalizeName, type KnowledgeBase, type Material } from './model.ts'

/** Recorded in every backup so a file says which build wrote it. */
const PACKAGE_NAME = '@domitor-syh/dsh-knowbase'

/** Persistence port. */
export interface KnowbaseStore {
  /** Snapshot of every knowledge base. */
  loadKnowledgeBases(): readonly KnowledgeBase[]
  /** Snapshot of every material, including its chunks. */
  loadMaterials(): readonly Material[]
  saveKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void>
  deleteKnowledgeBase(id: string): Promise<boolean>
  saveMaterial(material: Material): Promise<void>
  deleteMaterial(id: string): Promise<boolean>
}

/** Failure codes a caller can act on, rather than parsing messages. */
export type KnowbaseErrorCode =
  | 'duplicate-name'
  | 'duplicate-material'
  | 'invalid-name'
  | 'not-found'

/** A domain failure with a machine-readable code. */
export class KnowbaseError extends Error {
  readonly code: KnowbaseErrorCode

  constructor(code: KnowbaseErrorCode, message: string) {
    super(message)
    this.name = 'KnowbaseError'
    this.code = code
  }
}

/** Where a retrieved chunk came from, kept for citation. */
interface ChunkContext {
  readonly kbId: string
  readonly materialId: string
  readonly kbName: string
  readonly materialTitle: string
  readonly headingPath: string
  readonly locator: string
  readonly text: string
}

/** Options for {@link KnowbaseService.retrieve}. */
export interface RetrieveOptions {
  /** Maximum passages. Default 6. */
  readonly limit?: number
  /** Minimum query-term coverage. Default 0 — see the calibration note in `bm25.ts`. */
  readonly minCoverage?: number
}

/**
 * Identity a restore carries over from a backup.
 *
 * Only a restore sets these. A normal create allocates a fresh id and stamps
 * the clock, which is what makes "restore onto a clean profile" reproduce the
 * original exactly — including the session selections that reference base ids —
 * without giving every other caller a way to invent an id.
 */
export interface RestoreFields {
  /** Keep this id when it is free. */
  readonly id?: string
  readonly createdAt?: number
  readonly updatedAt?: number
  /** Keep this revision, so citations recorded against it still resolve. */
  readonly revision?: number
}

/** Options for {@link KnowbaseService.addText}. */
export interface AddTextOptions {
  /**
   * Accept content that already exists in this base. Default `false`: the plan
   * asks for 同库重复检测, and a silent duplicate doubles the chunks, the bytes
   * and every retrieval result.
   */
  readonly allowDuplicate?: boolean
  /** Preserved identity, used by restore. */
  readonly restore?: RestoreFields
}

/** What {@link KnowbaseService.importBackup} did. */
export interface ImportSummary {
  readonly bases: number
  readonly materials: number
  /** Materials in the file that carried no indexable text and were dropped. */
  readonly skippedMaterials: number
  /** Bases that could not keep their original id because something already used it. */
  readonly reallocatedBases: number
  /** Names actually created, after any 「（导入 n）」 disambiguation. */
  readonly baseNames: readonly string[]
}

/** Construction options. */
export interface KnowbaseServiceOptions {
  /** Injectable clock, so tests are not time-dependent. */
  readonly now?: () => number
  /** Chunking budget. */
  readonly chunk?: ChunkOptions
}

/** Knowledge base and material operations over a {@link KnowbaseStore}. */
export class KnowbaseService {
  readonly #store: KnowbaseStore
  readonly #now: () => number
  readonly #chunkOptions: ChunkOptions
  readonly #index = new Bm25Index()
  readonly #chunks = new Map<string, ChunkContext>()
  readonly #knowledgeBases = new Map<string, KnowledgeBase>()
  readonly #materials = new Map<string, Material>()

  constructor(store: KnowbaseStore, options: KnowbaseServiceOptions = {}) {
    this.#store = store
    this.#now = options.now ?? (() => Date.now())
    this.#chunkOptions = options.chunk ?? {}
  }

  /** Load persisted state and build the index. Call once, before serving. */
  async initialize(): Promise<void> {
    this.#knowledgeBases.clear()
    this.#materials.clear()
    this.#chunks.clear()
    this.#index.clear()

    for (const knowledgeBase of this.#store.loadKnowledgeBases()) {
      this.#knowledgeBases.set(knowledgeBase.id, knowledgeBase)
    }
    for (const material of this.#store.loadMaterials()) {
      this.#materials.set(material.id, material)
      // The index holds only what is currently retrievable: a soft-deleted
      // material, and any material inside a soft-deleted base, is invisible
      // until restored. Everything else about the record is kept as-is.
      if (material.deletedAt !== undefined) continue
      const base = this.#knowledgeBases.get(material.kbId)
      if (base === undefined || base.deletedAt !== undefined) continue
      this.#indexMaterial(material)
    }
  }

  // ------------------------------------------------------------- knowledge bases

  /** Every live knowledge base, ordered by name. Soft-deleted ones are hidden. */
  listKnowledgeBases(): readonly KnowledgeBase[] {
    return [...this.#knowledgeBases.values()]
      .filter(knowledgeBase => knowledgeBase.deletedAt === undefined)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  /** Every soft-deleted knowledge base, most recently deleted first. */
  listDeletedKnowledgeBases(): readonly KnowledgeBase[] {
    return [...this.#knowledgeBases.values()]
      .filter(knowledgeBase => knowledgeBase.deletedAt !== undefined)
      .sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
  }

  /** Look one up by id. */
  getKnowledgeBase(id: string): KnowledgeBase | undefined {
    return this.#knowledgeBases.get(id)
  }

  /** Look one up by name — the convenience path a command surface needs. */
  findKnowledgeBaseByName(name: string): KnowledgeBase | undefined {
    const normalized = normalizeName(name)
    return this.listKnowledgeBases().find(knowledgeBase => knowledgeBase.name === normalized)
  }

  /**
   * Create a knowledge base. Names are display-only and must be unique.
   *
   * `restore` is set only by {@link importBackup}; see {@link RestoreFields} for
   * why a restore keeps the original identity and nothing else does.
   */
  async createKnowledgeBase(
    rawName: string,
    description = '',
    restore: RestoreFields = {},
  ): Promise<KnowledgeBase> {
    const name = normalizeName(rawName)
    if (name.length === 0) throw new KnowbaseError('invalid-name', '知识库名称不能为空。')
    if (this.findKnowledgeBaseByName(name) !== undefined) {
      throw new KnowbaseError('duplicate-name', `已存在名为「${name}」的知识库。`)
    }
    // A restore may ask to keep an id, but only if it is genuinely free: an id
    // that is already in use would replace an existing base rather than add one,
    // which is the one thing a restore must never do.
    const id = restore.id !== undefined && restore.id !== '' && !this.#knowledgeBases.has(restore.id)
      ? restore.id
      : newId('kb')

    const timestamp = this.#now()
    const knowledgeBase: KnowledgeBase = {
      id,
      name,
      description: description.trim(),
      createdAt: restore.createdAt ?? timestamp,
      updatedAt: restore.updatedAt ?? timestamp,
      indexRevision: 0,
    }
    this.#knowledgeBases.set(knowledgeBase.id, knowledgeBase)
    await this.#store.saveKnowledgeBase(knowledgeBase)
    return knowledgeBase
  }

  /** Rename. Never touches the index — names are not searchable content. */
  async renameKnowledgeBase(id: string, rawName: string): Promise<KnowledgeBase> {
    const current = this.#requireLiveKnowledgeBase(id)

    const name = normalizeName(rawName)
    if (name.length === 0) throw new KnowbaseError('invalid-name', '知识库名称不能为空。')
    const clash = this.findKnowledgeBaseByName(name)
    if (clash !== undefined && clash.id !== id) {
      throw new KnowbaseError('duplicate-name', `已存在名为「${name}」的知识库。`)
    }

    const updated: KnowledgeBase = { ...current, name, updatedAt: this.#now() }
    this.#knowledgeBases.set(id, updated)
    // Citations carry the base name, so a rename has to be reflected in the
    // contexts already in the index or old passages would cite the old name.
    for (const [chunkId, context] of this.#chunks) {
      if (context.kbId === id) this.#chunks.set(chunkId, { ...context, kbName: name })
    }
    await this.#store.saveKnowledgeBase(updated)
    return updated
  }

  /** Update a knowledge base's description. */
  async updateDescription(id: string, rawDescription: string): Promise<KnowledgeBase> {
    const current = this.#requireLiveKnowledgeBase(id)

    const updated: KnowledgeBase = {
      ...current,
      description: rawDescription.trim(),
      updatedAt: this.#now(),
    }
    this.#knowledgeBases.set(id, updated)
    await this.#store.saveKnowledgeBase(updated)
    return updated
  }

  /**
   * Move a knowledge base to the recycle bin.
   *
   * Soft delete: the record and every material inside it are kept, the base
   * disappears from lists and from the `all` scope, and its materials leave
   * the index so nothing inside it is retrievable. `restoreKnowledgeBase`
   * undoes all of it; only {@link purgeKnowledgeBase} destroys data.
   */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined || current.deletedAt !== undefined) return false

    this.#unindexKnowledgeBase(id)
    const updated: KnowledgeBase = { ...current, deletedAt: this.#now() }
    this.#knowledgeBases.set(id, updated)
    await this.#store.saveKnowledgeBase(updated)
    return true
  }

  /**
   * Take a soft-deleted knowledge base back out of the recycle bin.
   *
   * The base's materials were left untouched by the delete, so re-indexing the
   * live ones restores exactly what was searchable before. `@returns false`
   * when the id is unknown or the base is not in the bin.
   */
  async restoreKnowledgeBase(id: string): Promise<boolean> {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined || current.deletedAt === undefined) return false

    const updated: KnowledgeBase = { ...current, deletedAt: undefined }
    this.#knowledgeBases.set(id, updated)
    for (const material of this.#materials.values()) {
      if (material.kbId === id && material.deletedAt === undefined) {
        this.#indexMaterial(material)
      }
    }
    await this.#store.saveKnowledgeBase(updated)
    await this.#bumpRevision(updated)
    return true
  }

  /**
   * Destroy a soft-deleted knowledge base and every material inside it —
   * including materials a user had separately recycled. Refuses a live base:
   * the recycle bin is the only door to permanent deletion, so a purge can
   * never overtake an accidental click on the ordinary delete button.
   */
  async purgeKnowledgeBase(id: string): Promise<boolean> {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined || current.deletedAt === undefined) return false

    for (const material of [...this.#materials.values()]) {
      if (material.kbId !== id) continue
      this.#unindexMaterial(material)
      this.#materials.delete(material.id)
      await this.#store.deleteMaterial(material.id)
    }
    this.#knowledgeBases.delete(id)
    await this.#store.deleteKnowledgeBase(id)
    return true
  }

  // ----------------------------------------------------------------- materials

  /**
   * Live materials, optionally limited to one knowledge base.
   *
   * Soft-deleted materials are hidden here — they surface through
   * {@link listDeletedMaterials} instead — and so are the materials of a
   * soft-deleted base, which follow their base in the recycle bin rather than
   * being listed separately.
   */
  listMaterials(kbId?: string): readonly Material[] {
    const all = [...this.#materials.values()].filter(
      material => material.deletedAt === undefined,
    )
    const scoped = kbId === undefined ? all : all.filter(material => material.kbId === kbId)
    return scoped.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** Soft-deleted materials, most recently deleted first. */
  listDeletedMaterials(): readonly Material[] {
    return [...this.#materials.values()]
      .filter(material => material.deletedAt !== undefined)
      .sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
  }

  /** Look one up by id. */
  getMaterial(id: string): Material | undefined {
    return this.#materials.get(id)
  }

  /**
   * Add typed or pasted text as a new material.
   *
   * Refuses content that already exists in the same base unless
   * `allowDuplicate` is set. The check is per base, not global: the same
   * paragraph legitimately belongs in two different bases, and blocking that
   * would make the plugin wrong about the user's own filing.
   */
  async addText(
    kbId: string,
    title: string,
    text: string,
    options: AddTextOptions = {},
  ): Promise<Material> {
    const knowledgeBase = this.#requireLiveKnowledgeBase(kbId)

    const chunks = chunkText(text, this.#chunkOptions)
    if (chunks.length === 0) throw new KnowbaseError('invalid-name', '内容为空，没有可入库的文字。')

    const contentHash = contentFingerprint(text)
    if (options.allowDuplicate !== true) {
      const existing = this.#findDuplicateByHash(kbId, contentHash)
      if (existing !== undefined) {
        throw new KnowbaseError(
          'duplicate-material',
          `该知识库中已有内容相同的资料「${existing.title}」。如果确实要再存一份，请选择「仍然添加」。`,
        )
      }
    }

    const timestamp = this.#now()
    const restore = options.restore ?? {}
    const material: Material = {
      id: restore.id !== undefined && restore.id !== '' && !this.#materials.has(restore.id)
        ? restore.id
        : newId('mat'),
      kbId,
      title: normalizeName(title) || '未命名资料',
      source: 'text',
      createdAt: restore.createdAt ?? timestamp,
      updatedAt: restore.updatedAt ?? timestamp,
      revision: restore.revision ?? 1,
      text,
      contentHash,
      chunks,
    }
    this.#materials.set(material.id, material)
    this.#indexMaterial(material)
    await this.#store.saveMaterial(material)
    await this.#bumpRevision(knowledgeBase)
    return material
  }

  /**
   * The live material in `kbId` whose content matches `text`, if any.
   *
   * The UI calls this before adding so it can show the warning inline and offer
   * 「仍然添加」, instead of making the user read an error message and guess at
   * the remedy.
   */
  findDuplicateMaterial(kbId: string, text: string): Material | undefined {
    return this.#findDuplicateByHash(kbId, contentFingerprint(text))
  }

  /** Replace a material's text and re-index it. */
  async updateMaterialText(id: string, text: string): Promise<Material> {
    const current = this.#materials.get(id)
    if (current === undefined) throw new KnowbaseError('not-found', '资料不存在。')
    // A recycled material must be restored before it can be edited: the editor
    // is a live-content surface, and editing inside the bin would silently
    // change what a later restore brings back.
    if (current.deletedAt !== undefined) {
      throw new KnowbaseError('not-found', '资料在回收站中，恢复后才能编辑。')
    }

    const chunks = chunkText(text, this.#chunkOptions)
    if (chunks.length === 0) throw new KnowbaseError('invalid-name', '内容为空，没有可入库的文字。')

    // Unindex first: `add` on the index would replace, but the context map is
    // keyed by chunk id and the new chunks have fresh ids, so the old contexts
    // would linger and keep the deleted text retrievable.
    this.#unindexMaterial(current)

    const updated: Material = {
      ...current,
      text,
      // Re-hashed on every save: an edit that happens to reproduce another
      // material's text leaves the fingerprint correct for the next add.
      // Duplicates created *by* an edit are not blocked — refusing a save would
      // discard the user's work, and the plan's rule is to prevent duplicate
      // ingest, not to police editing.
      contentHash: contentFingerprint(text),
      chunks,
      revision: current.revision + 1,
      updatedAt: this.#now(),
    }
    this.#materials.set(id, updated)
    this.#indexMaterial(updated)
    await this.#store.saveMaterial(updated)

    const knowledgeBase = this.#knowledgeBases.get(updated.kbId)
    if (knowledgeBase !== undefined) await this.#bumpRevision(knowledgeBase)
    return updated
  }

  /**
   * Move a material to the recycle bin.
   *
   * Soft delete: the record is kept with a marker, the material leaves the
   * index and every list, and {@link restoreMaterial} brings it back exactly
   * as it was. Nothing is destroyed here — that is {@link purgeMaterial}'s
   * job, and it only accepts what is already in the bin.
   */
  async deleteMaterial(id: string): Promise<boolean> {
    const material = this.#materials.get(id)
    if (material === undefined || material.deletedAt !== undefined) return false

    this.#unindexMaterial(material)
    const updated: Material = { ...material, deletedAt: this.#now() }
    this.#materials.set(id, updated)
    await this.#store.saveMaterial(updated)

    const knowledgeBase = this.#knowledgeBases.get(updated.kbId)
    if (knowledgeBase !== undefined) await this.#bumpRevision(knowledgeBase)
    return true
  }

  /**
   * Take a soft-deleted material out of the recycle bin.
   *
   * A material whose base is also in the bin brings the base back with it —
   * otherwise the restored material would exist but be visible nowhere, which
   * reads as a lost restore.
   */
  async restoreMaterial(id: string): Promise<boolean> {
    const material = this.#materials.get(id)
    if (material === undefined || material.deletedAt === undefined) return false

    const base = this.#knowledgeBases.get(material.kbId)
    if (base !== undefined && base.deletedAt !== undefined) {
      await this.restoreKnowledgeBase(base.id)
    }

    const updated: Material = { ...material, deletedAt: undefined }
    this.#materials.set(id, updated)
    this.#indexMaterial(updated)
    await this.#store.saveMaterial(updated)

    const liveBase = this.#knowledgeBases.get(updated.kbId)
    if (liveBase !== undefined) await this.#bumpRevision(liveBase)
    return true
  }

  /**
   * Destroy a soft-deleted material for good. Refuses a live material: the
   * recycle bin is the only door to permanent deletion, so a purge can never
   * overtake an accidental click on the ordinary delete button.
   */
  async purgeMaterial(id: string): Promise<boolean> {
    const material = this.#materials.get(id)
    if (material === undefined || material.deletedAt === undefined) return false

    this.#unindexMaterial(material)
    this.#materials.delete(id)
    await this.#store.deleteMaterial(id)

    const knowledgeBase = this.#knowledgeBases.get(material.kbId)
    if (knowledgeBase !== undefined) await this.#bumpRevision(knowledgeBase)
    return true
  }

  // ---------------------------------------------------------------- retrieval

  /**
   * Retrieve passages for a query.
   *
   * Returns an outcome rather than a bare list because the caller has to tell
   * "nothing matched" apart from "nothing was searched" and "the index is not
   * ready" — the plan requires those to be distinguishable in the UI and to the
   * model, and collapsing them into an empty array loses that.
   */
  retrieve(query: string, kbIds: readonly string[], options: RetrieveOptions = {}): RetrievalOutcome {
    const scope = kbIds.filter(id => this.#knowledgeBases.has(id))
    if (scope.length === 0) return { kind: 'empty_scope' }
    if (this.#index.size === 0) return { kind: 'not_ready' }

    const allowed = new Set(scope)

    // Emptiness has to be judged against the SELECTION, not the whole index. A
    // brand-new knowledge base inside a populated install would otherwise be
    // searched, find nothing, and report `no_match` — telling the user their
    // question is unrelated to material that does not exist yet. The two states
    // need different answers: "nothing matched" invites a rephrase, "nothing
    // here" invites adding material.
    if (!this.#hasIndexedChunks(allowed)) return { kind: 'not_ready' }

    const hits = this.#index.search(query, {
      limit: options.limit ?? 6,
      minCoverage: options.minCoverage ?? 0,
      accept: chunkId => {
        const context = this.#chunks.get(chunkId)
        return context !== undefined && allowed.has(context.kbId)
      },
    })

    const passages: RetrievedPassage[] = []
    for (const hit of hits) {
      const context = this.#chunks.get(hit.id)
      if (context === undefined) continue
      passages.push({
        kbName: context.kbName,
        materialTitle: context.materialTitle,
        locator: context.locator,
        text: context.text,
      })
    }

    return passages.length === 0 ? { kind: 'no_match' } : { kind: 'hits', passages }
  }

  // -------------------------------------------------------------------- backup

  /**
   * Everything the user currently has, as a portable document.
   *
   * Live records only — see `backup.ts` for why the recycle bin stays out — and
   * source text rather than chunks, so the file does not bake in a chunking
   * decision that a later version would make differently.
   */
  exportBackup(exportedAt: number): BackupDocument {
    return buildBackupDocument({
      exportedAt,
      generator: PACKAGE_NAME,
      bases: this.listKnowledgeBases().map(base => ({
        id: base.id,
        name: base.name,
        description: base.description,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
        materials: this.listMaterials(base.id).map(material => ({
          id: material.id,
          title: material.title,
          text: materialText(material),
          createdAt: material.createdAt,
          updatedAt: material.updatedAt,
          revision: material.revision,
        })),
      })),
    })
  }

  /**
   * Write a parsed backup into this profile, without destroying anything.
   *
   * Each base goes through the ordinary create path and each material through
   * the ordinary add path, so a restored library is indexed, validated and
   * persisted exactly like one the user typed — no second code path to keep in
   * sync. `allowDuplicate` is set because the file is the source of truth about
   * its own contents: a backup that legitimately held two identical materials
   * must restore as two, not as one plus a silent drop.
   */
  async importBackup(document: BackupDocument): Promise<ImportSummary> {
    const plan = planImport(
      document,
      {
        baseIds: [...this.#knowledgeBases.keys()],
        // Recycled bases count as occupying their name: restoring one would
        // otherwise collide with the import.
        baseNames: [...this.#knowledgeBases.values()].map(base => base.name),
      },
      newId,
    )

    const baseNames: string[] = []
    let materials = 0

    for (const planned of plan.bases) {
      const base = await this.createKnowledgeBase(planned.name, planned.description, {
        id: planned.id,
        createdAt: planned.createdAt,
        updatedAt: planned.updatedAt,
      })
      baseNames.push(base.name)

      for (const material of planned.materials) {
        await this.addText(base.id, material.title, material.text, {
          allowDuplicate: true,
          restore: {
            id: material.id,
            createdAt: material.createdAt,
            updatedAt: material.updatedAt,
            revision: material.revision,
          },
        })
        materials += 1
      }
    }

    return {
      bases: plan.bases.length,
      materials,
      skippedMaterials: plan.skippedMaterials,
      reallocatedBases: plan.reallocatedBases,
      baseNames,
    }
  }

  // ------------------------------------------------------------------ internals

  /**
   * The live material in `kbId` carrying this fingerprint.
   *
   * Records written before fingerprints existed have none stored, so theirs is
   * computed on demand rather than the record being treated as absent from the
   * check — otherwise every material predating this feature would be silently
   * exempt from duplicate detection.
   */
  #findDuplicateByHash(kbId: string, contentHash: string): Material | undefined {
    for (const material of this.#materials.values()) {
      if (material.kbId !== kbId) continue
      if (material.deletedAt !== undefined) continue
      const candidate = material.contentHash ?? contentFingerprint(materialText(material))
      if (candidate === contentHash) return material
    }
    return undefined
  }

  /**
   * The knowledge base an operation acts on, requiring the LIVE record.
   *
   * A soft-deleted base is hidden from every list and from name lookup, but
   * its id still resolves here — which is exactly why write paths go through
   * this guard: without it, a stale client could add or rename inside a base
   * the user believes is deleted.
   */
  #requireLiveKnowledgeBase(id: string): KnowledgeBase {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined || current.deletedAt !== undefined) {
      throw new KnowbaseError('not-found', '知识库不存在。')
    }
    return current
  }

  /** Whether any indexed chunk belongs to one of the allowed knowledge bases. */
  #hasIndexedChunks(allowed: ReadonlySet<string>): boolean {
    for (const context of this.#chunks.values()) {
      if (allowed.has(context.kbId)) return true
    }
    return false
  }

  /** Remove every material of one knowledge base from the index. */
  #unindexKnowledgeBase(id: string): void {
    for (const material of this.#materials.values()) {
      if (material.kbId === id) this.#unindexMaterial(material)
    }
  }

  #indexMaterial(material: Material): void {
    const kbName = this.#knowledgeBases.get(material.kbId)?.name ?? '未知知识库'
    for (const chunk of material.chunks) {
      // The title is indexed with the chunk even though the citation shows the
      // chunk text alone. A material called 「刘一江的电话」 whose body is just
      // a number is unfindable otherwise: the words a person naturally searches
      // for live in the title, and a title that is not searchable is a material
      // that does not exist as far as retrieval is concerned.
      //
      // The knowledge base name is deliberately NOT indexed: it labels a
      // container, so including it would make every chunk in a base match a
      // query for that base's name.
      this.#index.add(chunk.id, `${material.title}\n${chunk.text}`)
      this.#chunks.set(chunk.id, {
        kbId: material.kbId,
        materialId: material.id,
        kbName,
        materialTitle: material.title,
        headingPath: chunk.headingPath,
        locator: chunk.locator,
        text: chunk.text,
      })
    }
  }

  #unindexMaterial(material: Material): void {
    for (const chunk of material.chunks) {
      this.#index.remove(chunk.id)
      this.#chunks.delete(chunk.id)
    }
  }

  async #bumpRevision(knowledgeBase: KnowledgeBase): Promise<void> {
    const updated: KnowledgeBase = {
      ...knowledgeBase,
      indexRevision: knowledgeBase.indexRevision + 1,
      updatedAt: this.#now(),
    }
    this.#knowledgeBases.set(updated.id, updated)
    await this.#store.saveKnowledgeBase(updated)
  }
}

/** In-memory store. Used by tests and as a reference implementation. */
export class MemoryStore implements KnowbaseStore {
  readonly #knowledgeBases = new Map<string, KnowledgeBase>()
  readonly #materials = new Map<string, Material>()

  loadKnowledgeBases(): readonly KnowledgeBase[] {
    return [...this.#knowledgeBases.values()]
  }

  loadMaterials(): readonly Material[] {
    return [...this.#materials.values()]
  }

  async saveKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void> {
    this.#knowledgeBases.set(knowledgeBase.id, knowledgeBase)
  }

  async deleteKnowledgeBase(id: string): Promise<boolean> {
    return this.#knowledgeBases.delete(id)
  }

  async saveMaterial(material: Material): Promise<void> {
    this.#materials.set(material.id, material)
  }

  async deleteMaterial(id: string): Promise<boolean> {
    return this.#materials.delete(id)
  }
}
