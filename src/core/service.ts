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
import { Bm25Index } from './bm25.ts'
import { chunkText, type ChunkOptions } from './chunk.ts'
import { newId, normalizeName, type KnowledgeBase, type Material } from './model.ts'

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
export type KnowbaseErrorCode = 'duplicate-name' | 'invalid-name' | 'not-found'

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
      this.#indexMaterial(material)
    }
  }

  // ------------------------------------------------------------- knowledge bases

  /** Every knowledge base, ordered by name. */
  listKnowledgeBases(): readonly KnowledgeBase[] {
    return [...this.#knowledgeBases.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
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

  /** Create a knowledge base. Names are display-only and must be unique. */
  async createKnowledgeBase(rawName: string, description = ''): Promise<KnowledgeBase> {
    const name = normalizeName(rawName)
    if (name.length === 0) throw new KnowbaseError('invalid-name', '知识库名称不能为空。')
    if (this.findKnowledgeBaseByName(name) !== undefined) {
      throw new KnowbaseError('duplicate-name', `已存在名为「${name}」的知识库。`)
    }

    const timestamp = this.#now()
    const knowledgeBase: KnowledgeBase = {
      id: newId('kb'),
      name,
      description: description.trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      indexRevision: 0,
    }
    this.#knowledgeBases.set(knowledgeBase.id, knowledgeBase)
    await this.#store.saveKnowledgeBase(knowledgeBase)
    return knowledgeBase
  }

  /** Rename. Never touches the index — names are not searchable content. */
  async renameKnowledgeBase(id: string, rawName: string): Promise<KnowledgeBase> {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined) throw new KnowbaseError('not-found', '知识库不存在。')

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
    const current = this.#knowledgeBases.get(id)
    if (current === undefined) throw new KnowbaseError('not-found', '知识库不存在。')

    const updated: KnowledgeBase = {
      ...current,
      description: rawDescription.trim(),
      updatedAt: this.#now(),
    }
    this.#knowledgeBases.set(id, updated)
    await this.#store.saveKnowledgeBase(updated)
    return updated
  }

  /** Delete a knowledge base and every material inside it. */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    if (!this.#knowledgeBases.has(id)) return false

    for (const material of this.listMaterials(id)) {
      await this.deleteMaterial(material.id)
    }
    this.#knowledgeBases.delete(id)
    await this.#store.deleteKnowledgeBase(id)
    return true
  }

  // ----------------------------------------------------------------- materials

  /** Materials, optionally limited to one knowledge base. */
  listMaterials(kbId?: string): readonly Material[] {
    const all = [...this.#materials.values()]
    const scoped = kbId === undefined ? all : all.filter(material => material.kbId === kbId)
    return scoped.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** Look one up by id. */
  getMaterial(id: string): Material | undefined {
    return this.#materials.get(id)
  }

  /** Add typed or pasted text as a new material. */
  async addText(kbId: string, title: string, text: string): Promise<Material> {
    const knowledgeBase = this.#knowledgeBases.get(kbId)
    if (knowledgeBase === undefined) throw new KnowbaseError('not-found', '知识库不存在。')

    const chunks = chunkText(text, this.#chunkOptions)
    if (chunks.length === 0) throw new KnowbaseError('invalid-name', '内容为空，没有可入库的文字。')

    const timestamp = this.#now()
    const material: Material = {
      id: newId('mat'),
      kbId,
      title: normalizeName(title) || '未命名资料',
      source: 'text',
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1,
      text,
      chunks,
    }
    this.#materials.set(material.id, material)
    this.#indexMaterial(material)
    await this.#store.saveMaterial(material)
    await this.#bumpRevision(knowledgeBase)
    return material
  }

  /** Replace a material's text and re-index it. */
  async updateMaterialText(id: string, text: string): Promise<Material> {
    const current = this.#materials.get(id)
    if (current === undefined) throw new KnowbaseError('not-found', '资料不存在。')

    const chunks = chunkText(text, this.#chunkOptions)
    if (chunks.length === 0) throw new KnowbaseError('invalid-name', '内容为空，没有可入库的文字。')

    // Unindex first: `add` on the index would replace, but the context map is
    // keyed by chunk id and the new chunks have fresh ids, so the old contexts
    // would linger and keep the deleted text retrievable.
    this.#unindexMaterial(current)

    const updated: Material = {
      ...current,
      text,
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

  /** Remove a material and everything it contributed to the index. */
  async deleteMaterial(id: string): Promise<boolean> {
    const material = this.#materials.get(id)
    if (material === undefined) return false

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

  // ------------------------------------------------------------------ internals

  /** Whether any indexed chunk belongs to one of the allowed knowledge bases. */
  #hasIndexedChunks(allowed: ReadonlySet<string>): boolean {
    for (const context of this.#chunks.values()) {
      if (allowed.has(context.kbId)) return true
    }
    return false
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
