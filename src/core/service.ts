/**
 * Knowledge base domain logic.
 *
 * The disk is the record: a base is a folder, a material is a file in it, and
 * every listing is produced by reading the folder rather than by consulting a
 * table. That is what makes a file dropped in through the user's own explorer
 * show up, and it is why nothing here caches a file's existence — a cache is a
 * second copy of the truth, and the copy the user cannot see is the one that
 * would win.
 *
 * The store is an interface, not a concrete backend, and so is the filesystem
 * ({@link VaultFileSystem}), so all of this is testable without a host: the
 * tests drive an in-memory pair.
 *
 * Reads of the vault are asynchronous; reads of the knowledge-base metadata are
 * synchronous, matching the storage contract, which loads a snapshot into memory
 * on open.
 *
 * @module @domitor-syh/dsh-knowbase/core/service
 */

import path from 'node:path'
import type { RetrievedPassage, ServiceOutcome } from '../pre-step.ts'
import type { VaultFileSystem } from '../vault-fs.ts'
import { Bm25Index } from './bm25.ts'
import { createCitationId } from './citation-id.ts'
import { chunkPages, chunkText, type ChunkOptions } from './chunk.ts'
import { OcrError, type OcrEngine } from './ocr.ts'
import { MAX_PDF_PAGES, PdfError, extractPdfPages } from './pdf.ts'
import {
  extensionOf,
  IMAGE_EXTENSIONS,
  isIndexable,
  legacyMaterialText,
  newId,
  normalizeName,
  type ChunkRecord,
  type KnowledgeBase,
  type LegacyMaterial,
  type Material,
  type StoredKnowledgeBase,
} from './model.ts'
import { compareText } from './order.ts'
import { TextReadError } from './text.ts'
import {
  isRecycleName,
  parseVaultFolderName,
  recycleDir,
  recycleTarget,
  sanitizeSegment,
  uniqueSegment,
  vaultFolderName,
} from './vault.ts'

/** Persistence port for knowledge-base metadata. */
export interface KnowbaseStore {
  /** Snapshot of every knowledge base record, live and legacy alike. */
  loadKnowledgeBases(): readonly StoredKnowledgeBase[]
  saveKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void>
  deleteKnowledgeBase(id: string): Promise<boolean>
  /** Text materials left behind by the pre-vault build; read once, by the migration. */
  loadLegacyMaterials(): readonly LegacyMaterial[]
  deleteLegacyMaterial(id: string): Promise<boolean>
}

/** Failure codes a caller can act on, rather than parsing messages. */
export type KnowbaseErrorCode = 'duplicate-name' | 'invalid-name' | 'not-found' | 'io'

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
  /** Position of the chunk inside its material; the reader scrolls to it. */
  readonly ordinal: number
  readonly kbName: string
  readonly materialTitle: string
  /** Absolute path of the file the passage came from, for the reader. */
  readonly filePath: string
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

/** Options for {@link KnowbaseService.addFiles}. */
export interface AddFilesOptions {
  /** Overwrite a same-named file instead of keeping both. Default `false`. */
  readonly overwrite?: boolean
}

/** Explicit controls for a rescan. The snapshot is intentionally in-memory only. */
export interface RescanOptions {
  /** Re-read every indexable file and rebuild its index contribution. */
  readonly force?: boolean
}

/** Counts from the most recent scan of one base. */
export interface ScanReport {
  readonly added: number
  readonly reused: number
  readonly changed: number
  readonly deleted: number
  /** Indexable files that remain listed but are not searchable. */
  readonly unsearchable: number
}

/** One file as a scan found it: where it is, how big, when it changed. */
interface ScanEntry {
  /** Path relative to its base folder, `/`-separated; also the material's id. */
  readonly relative: string
  readonly absolute: string
  readonly size: number
  readonly mtimeMs: number
}

/**
 * What a scan knows about a material before it has read a byte of it.
 *
 * Keeping this separate from {@link Material} is what lets the three extraction
 * paths — nothing, plain text, PDF — differ in exactly one place instead of
 * three copies of the same six fields.
 */
type MaterialShell = Omit<Material, 'indexed' | 'note' | 'chunks' | 'extractedText'>

/** A file arriving from outside the plugin. */
export interface IncomingFile {
  /** The name the uploader had for it; sanitised and de-duplicated on the way in. */
  readonly name: string
  readonly data: Uint8Array
}

/** Construction options. */
export interface KnowbaseServiceOptions {
  /** Injectable clock, so tests are not time-dependent. */
  readonly now?: () => number
  /** Chunking budget. */
  readonly chunk?: ChunkOptions
  /**
   * The local OCR engine, when the host wired one.
   *
   * Optional because "there is no engine" is a state the domain has to describe
   * anyway — the packs not being downloaded is the same sentence, and a service
   * with no engine at all (a unit test, a host that never wired OCR) should not
   * be a special case that crashes on a photograph.
   */
  readonly ocr?: OcrEngine
}

/**
 * Largest plain-text file the plugin will read.
 *
 * A knowledge base is for documents, not for disk images: past this size the
 * file is still stored and listed, it just contributes no chunks. The bound
 * exists so one stray 500 MB file cannot turn a scan into a memory event.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Largest PDF the plugin will parse.
 *
 * Looser than {@link MAX_TEXT_BYTES} because the units differ: the plan's §1.1
 * bounds a *file* at 20 MB while a 2 MB bound exists to keep megabytes of prose
 * out of memory. Twenty megabytes of PDF is roughly the hundred-page cap below
 * — the two limits have to agree or one of them decides nothing.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024

/**
 * Largest image the OCR engine will read.
 *
 * The same bound as a PDF, for a different reason: twenty megabytes is a
 * twelve-megapixel photograph or a full-page scan, and past it the recognizer is
 * holding a bitmap it was never going to finish inside its wall-clock bound
 * anyway.
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/**
 * What an image says when the OCR language packs are not downloaded.
 *
 * One sentence for two causes — no engine wired, and the engine's own
 * `resources-missing` — because from the user's seat they are the same
 * situation, and two wordings for it would read as two different problems.
 */
const OCR_PACKS_HINT =
  '图片文字识别需要 OCR 语言包（约 4.5 MB）：在上方「图片文字识别」里点「下载语言包」，下载后重扫即可检索。'

/** How deep a scan walks into sub-folders of a base. */
const MAX_SCAN_DEPTH = 8

/** Knowledge base and material operations over a {@link KnowbaseStore} and a vault. */
export class KnowbaseService {
  readonly #store: KnowbaseStore
  readonly #fs: VaultFileSystem
  readonly #root: string
  readonly #now: () => number
  readonly #chunkOptions: ChunkOptions
  readonly #ocr: OcrEngine | undefined
  #ocrTail: Promise<void> = Promise.resolve()
  readonly #index = new Bm25Index()
  readonly #chunks = new Map<string, ChunkContext>()
  readonly #knowledgeBases = new Map<string, KnowledgeBase>()
  readonly #materials = new Map<string, Map<string, Material>>()
  readonly #scanReports = new Map<string, ScanReport>()
  readonly #dirtyMaterials = new Map<string, Set<string>>()
  // Serialize public mutations, including disk reconciliation, across bases.
  // This deliberately simple queue prevents an awaited extraction from later
  // committing over a rename/delete/upload. Reads keep seeing the prior stage.
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(
    store: KnowbaseStore,
    fs: VaultFileSystem,
    root: string,
    options: KnowbaseServiceOptions = {},
  ) {
    this.#store = store
    this.#fs = fs
    this.#root = root
    this.#now = options.now ?? (() => Date.now())
    this.#chunkOptions = options.chunk ?? {}
    this.#ocr = options.ocr
  }

  /** The vault root this service reads and writes. */
  get root(): string {
    return this.#root
  }

  /**
   * Reconcile the metadata with the disk, then build the index.
   *
   * Order matters: legacy text is written out first so the bases the migration
   * creates are the ones the subsequent sync sees, and the sync runs before the
   * scan so every listed base has a folder to read.
   */
  async initialize(): Promise<{ knowledgeBases: number; materials: number; migrated: number }> {
    return this.#mutate(async () => {
      this.#knowledgeBases.clear()
      this.#materials.clear()
      this.#scanReports.clear()
      this.#dirtyMaterials.clear()
      this.#chunks.clear()
      this.#index.clear()

      await this.#fs.ensureDir(this.#root)
      await this.#fs.ensureDir(recycleDir(this.#root))

      this.#loadRecords()
      await this.#ensureFolders()
      const migrated = await this.#migrateLegacy()
      await this.#syncFromDisk()

      let materials = 0
      for (const base of this.#knowledgeBases.values()) {
        materials += (await this.#scanBase(base, {}, new Set(), false)).length
      }

      return { knowledgeBases: this.#knowledgeBases.size, materials, migrated }
    })
  }

  // ------------------------------------------------------------- knowledge bases

  /** Every knowledge base, ordered by name. */
  listKnowledgeBases(): readonly KnowledgeBase[] {
    return [...this.#knowledgeBases.values()].sort((left, right) => compareText(left.name, right.name))
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
   * Create a knowledge base and its folder.
   *
   * The folder is created before the record is written: a record whose folder
   * does not exist would be dropped by the next sync, which reads to the user as
   * "I made a base and it vanished".
   */
  async createKnowledgeBase(rawName: string, description = ''): Promise<KnowledgeBase> {
    return this.#mutate(async () => {
      const name = normalizeName(rawName)
      if (name.length === 0) throw new KnowbaseError('invalid-name', '知识库名称不能为空。')
      if (this.findKnowledgeBaseByName(name) !== undefined) {
        throw new KnowbaseError('duplicate-name', `已存在名为「${name}」的知识库。`)
      }

      const id = newId('kb')
      const folderName = vaultFolderName(name, id)
      await this.#fs.ensureDir(this.#baseDir({ folderName }))

      const timestamp = this.#now()
      const knowledgeBase: KnowledgeBase = {
        id,
        name,
        description: description.trim(),
        folderName,
        createdAt: timestamp,
        updatedAt: timestamp,
        indexRevision: 0,
      }
      this.#knowledgeBases.set(id, knowledgeBase)
      this.#materials.set(id, new Map())
      await this.#store.saveKnowledgeBase(knowledgeBase)
      return knowledgeBase
    })
  }

  /** Rename a base, moving its folder so the name is the same in both places. */
  async renameKnowledgeBase(id: string, rawName: string): Promise<KnowledgeBase> {
    return this.#mutate(async () => {
      const current = this.#requireKnowledgeBase(id)

      const name = normalizeName(rawName)
      if (name.length === 0) throw new KnowbaseError('invalid-name', '知识库名称不能为空。')
      const clash = this.findKnowledgeBaseByName(name)
      if (clash !== undefined && clash.id !== id) {
        throw new KnowbaseError('duplicate-name', `已存在名为「${name}」的知识库。`)
      }

      const folderName = vaultFolderName(name, id)
      if (name === current.name && folderName === current.folderName) return current
      if (folderName !== current.folderName) {
        await this.#fs.move(this.#baseDir(current), path.join(this.#root, folderName))
      }

      const updated: KnowledgeBase = {
        ...current,
        name,
        folderName,
        updatedAt: this.#now(),
        indexRevision: current.indexRevision + 1,
      }
      this.#knowledgeBases.set(id, updated)
      // Citations carry the base name, so a rename has to reach the contexts
      // already in the index or old passages would cite the old name.
      for (const [chunkId, context] of this.#chunks) {
        if (context.kbId !== id) continue
        this.#chunks.set(chunkId, {
          ...context,
          kbName: name,
          filePath: path.join(this.#root, folderName, ...context.materialId.split('/')),
        })
      }
      await this.#store.saveKnowledgeBase(updated)
      return updated
    })
  }

  /** Update a knowledge base's description. */
  async updateDescription(id: string, rawDescription: string): Promise<KnowledgeBase> {
    return this.#mutate(async () => {
      const current = this.#requireKnowledgeBase(id)
      const description = rawDescription.trim()
      if (description === current.description) return current
      const updated: KnowledgeBase = {
        ...current,
        description,
        updatedAt: this.#now(),
      }
      this.#knowledgeBases.set(id, updated)
      await this.#store.saveKnowledgeBase(updated)
      return updated
    })
  }

  /**
   * Delete a knowledge base by moving its folder into the recycle folder.
   *
   * Nothing is destroyed: the folder keeps its name and content, and the user
   * can drag it back out of `_回收站`. The record is dropped, because the base
   * is no longer on disk — a record without a folder would be resurrected as an
   * empty base by the next sync, which is not what deleting it meant.
   */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    return this.#mutate(async () => {
      const current = this.#knowledgeBases.get(id)
      if (current === undefined) return false

      const target = await this.#freeRecycleName(current.folderName)
      await this.#fs.move(this.#baseDir(current), target)

      this.#unindexBase(id)
      this.#materials.delete(id)
      this.#scanReports.delete(id)
      this.#dirtyMaterials.delete(id)
      this.#knowledgeBases.delete(id)
      await this.#store.deleteKnowledgeBase(id)
      return true
    })
  }

  // ----------------------------------------------------------------- materials

  /** Live materials of one base, ordered by name; every base's when omitted. */
  listMaterials(kbId?: string): readonly Material[] {
    const bases = kbId === undefined ? [...this.#materials.values()] : [this.#materials.get(kbId)]
    const all: Material[] = []
    for (const files of bases) {
      if (files === undefined) continue
      all.push(...files.values())
    }
    return all.sort((left, right) => compareText(left.fileName, right.fileName))
  }

  /** Last successful scan report; never persisted or used as disk truth. */
  getLastScanReport(kbId: string): ScanReport | undefined {
    return this.#scanReports.get(kbId)
  }

  /** Look one up inside its base. */
  getMaterial(kbId: string, id: string): Material | undefined {
    return this.#materials.get(kbId)?.get(id)
  }

  /** Resolve a material's absolute path. */
  materialPath(kbId: string, id: string): string | undefined {
    const base = this.#knowledgeBases.get(kbId)
    if (base === undefined) return undefined
    return path.join(this.#root, base.folderName, ...id.split('/'))
  }

  /**
   * The absolute path of one base's folder, or `undefined` when it is gone.
   *
   * Handed to the OS file manager so the user can put a file in by hand — the
   * supported way in that 「重扫」 exists to complete.
   */
  baseFolderPath(kbId: string): string | undefined {
    const base = this.#knowledgeBases.get(kbId)
    if (base === undefined) return undefined
    return this.#baseDir(base)
  }

  /**
   * Read one file's bytes, or `undefined` when it is gone or too large.
   *
   * The size check runs against the scan's figure before a read is attempted,
   * so a preview request for a 2 GB file costs a map lookup rather than a
   * memory event.
   */
  async readMaterialBytes(
    kbId: string,
    id: string,
    maxBytes: number,
  ): Promise<Uint8Array | undefined> {
    const material = this.#materials.get(kbId)?.get(id)
    if (material === undefined || material.bytes > maxBytes) return undefined
    const target = this.materialPath(kbId, id)
    if (target === undefined) return undefined
    return this.#fs.readBytes(target).catch(() => undefined)
  }

  /**
   * Write files into a base and re-scan it.
   *
   * A same-named file becomes 「名字 (2).ext」 rather than replacing what is
   * there, unless the caller asked to overwrite: two different files called
   * 「说明书.pdf」 in one base is ordinary, and silently losing one of them is
   * the one outcome nobody would accept.
   *
   * @returns every file the call created, as the scan sees them.
   */
  async addFiles(
    kbId: string,
    files: readonly IncomingFile[],
    options: AddFilesOptions = {},
  ): Promise<readonly Material[]> {
    return this.#mutate(async () => {
      const base = this.#requireKnowledgeBase(kbId)
      if (files.length === 0) return []

      const taken = new Set((await this.#fs.listDir(this.#baseDir(base))).map(entry => entry.name))
      const created: string[] = []
      const dirty = this.#dirtyMaterials.get(kbId) ?? new Set<string>()
      this.#dirtyMaterials.set(kbId, dirty)

      for (const file of files) {
        const wanted = sanitizeSegment(file.name, '未命名文件')
        const name = options.overwrite === true ? wanted : uniqueSegment(wanted, taken)
        taken.add(name)
        dirty.add(name)
        await this.#fs.writeFile(path.join(this.#baseDir(base), name), file.data)
        created.push(name)
      }

      // A write is an invalidation even when size and mtime happen to match.
      const materials = await this.#scanBase(base, {}, new Set(created))
      const wanted = new Set(created)
      return materials.filter(material => wanted.has(material.fileName))
    })
  }

  /**
   * Delete one file by moving it into the recycle folder.
   *
   * Read-only for the record, exactly like deleting a base: the file is not
   * removed from the disk at all, and the user can drag it back.
   */
  async deleteMaterial(kbId: string, id: string): Promise<boolean> {
    return this.#mutate(async () => {
      const base = this.#requireKnowledgeBase(kbId)
      const material = this.#materials.get(kbId)?.get(id)
      if (material === undefined) return false

      const source = path.join(this.#baseDir(base), ...id.split('/'))
      const target = await this.#freeRecycleName(path.basename(id))
      await this.#fs.move(source, target)

      await this.#scanBase(base)
      return true
    })
  }

  /** Re-read a base from the disk, or every base when `kbId` is omitted. */
  async rescan(kbId?: string, options: RescanOptions = {}): Promise<void> {
    return this.#mutate(async () => {
      await this.#fs.ensureDir(this.#root)
      await this.#fs.ensureDir(recycleDir(this.#root))
      // Adopt first: newly discovered folders must be scanned on this call too.
      if (kbId === undefined) await this.#syncFromDisk()
      const bases = kbId === undefined ? [...this.#knowledgeBases.values()] : [this.#requireKnowledgeBase(kbId)]
      for (const base of bases) await this.#scanBase(base, options)
    })
  }

  // ---------------------------------------------------------------- retrieval

  /**
   * Retrieve passages for a query.
   *
   * Returns an outcome rather than a bare list because the caller has to tell
   * "nothing matched" apart from "nothing was searched" and "the index is not
   * ready" — those are different sentences to a user, and collapsing them into
   * an empty array loses the distinction.
   *
   * `no_selection` is deliberately excluded: this method is handed ids and
   * either finds bases behind them or does not. Whether anything was ticked is
   * decided by `resolveScope` one layer up, before there is a call to make.
   */
  retrieve(query: string, kbIds: readonly string[], options: RetrieveOptions = {}): ServiceOutcome {
    const scope = kbIds.filter(id => this.#knowledgeBases.has(id))
    if (scope.length === 0) return { kind: 'empty_scope' }
    if (this.#index.size === 0) return { kind: 'not_ready' }

    const allowed = new Set(scope)

    // Emptiness is judged against the SELECTION, not the whole index: a
    // brand-new base inside a populated install would otherwise be searched,
    // find nothing, and report `no_match` — telling the user their question is
    // unrelated to material that does not exist yet.
    if (!this.#hasIndexedChunks(allowed)) return { kind: 'not_ready' }

    const hits = this.#index.search(query, {
      limit: options.limit ?? 6,
      minCoverage: options.minCoverage ?? 0,
      accept: chunkId => {
        const context = this.#chunks.get(chunkId)
        return context !== undefined && allowed.has(context.kbId)
      },
      distinctKey: chunkId => {
        const context = this.#chunks.get(chunkId)!
        // Keep independent sources and differing text; only equivalent text in
        // the same material shares one context-budget slot. No fixed overfetch.
        return JSON.stringify([context.kbId, context.materialId,
          context.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()])
      },
    })

    const passages: RetrievedPassage[] = []
    for (const hit of hits) {
      const context = this.#chunks.get(hit.id)
      if (context === undefined) continue
      passages.push({
        citationId: createCitationId({
          kbId: context.kbId,
          materialId: context.materialId,
          ordinal: context.ordinal,
          locator: context.locator,
          text: context.text,
        }),
        kbName: context.kbName,
        materialTitle: context.materialTitle,
        locator: context.locator,
        text: context.text,
        kbId: context.kbId,
        materialId: context.materialId,
        filePath: context.filePath,
        ordinal: context.ordinal,
        score: hit.score,
        coverage: hit.coverage,
      })
    }

    return passages.length === 0 ? { kind: 'no_match' } : { kind: 'hits', passages }
  }

  // ------------------------------------------------------------------ internals

  /** Run mutations in call order; one rejection must not poison later work. */
  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation)
    this.#mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Absolute path of one base's folder. */
  #baseDir(base: Pick<KnowledgeBase, 'folderName'>): string {
    return path.join(this.#root, base.folderName)
  }

  /** The live base an operation acts on. */
  #requireKnowledgeBase(id: string): KnowledgeBase {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined) throw new KnowbaseError('not-found', '知识库不存在。')
    return current
  }

  /** Read the stored records into memory, dropping legacy soft-deleted ones. */
  #loadRecords(): void {
    for (const stored of this.#store.loadKnowledgeBases()) {
      if (stored.deletedAt !== undefined) {
        // The pre-vault build had already deleted this base; its folder was
        // never created, so there is nothing to adopt and nothing to keep.
        void this.#store.deleteKnowledgeBase(stored.id)
        continue
      }
      this.#knowledgeBases.set(stored.id, {
        id: stored.id,
        name: stored.name,
        description: stored.description,
        folderName: stored.folderName ?? vaultFolderName(stored.name, stored.id),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        indexRevision: stored.indexRevision,
      })
      this.#materials.set(stored.id, new Map())
    }
  }

  /**
   * Give every record a folder, writing the name back when it had none.
   *
   * A record from the text era carries no `folderName`; computing one here is
   * what turns it into a folder, and saving it is what stops the computation
   * from being redone — and possibly redone differently — on the next start.
   */
  async #ensureFolders(): Promise<void> {
    for (const base of [...this.#knowledgeBases.values()]) {
      const stored = this.#store.loadKnowledgeBases().find(record => record.id === base.id)
      await this.#fs.ensureDir(this.#baseDir(base))
      if (stored?.folderName === undefined) await this.#store.saveKnowledgeBase(base)
    }
  }

  /**
   * Write every surviving legacy text material out as a `.txt` file.
   *
   * Naturally idempotent: the record is deleted once its file exists, so a
   * restart finds nothing left to migrate and a base the user deleted stops
   * being resurrected. An existing file of the same name is never overwritten —
   * user content outranks a migration's convenience.
   */
  async #migrateLegacy(): Promise<number> {
    let written = 0
    for (const material of this.#store.loadLegacyMaterials()) {
      const base = this.#knowledgeBases.get(material.kbId)
      if (base === undefined || material.deletedAt !== undefined) {
        await this.#store.deleteLegacyMaterial(material.id)
        continue
      }
      const stem = sanitizeSegment(stripTextExtension(material.title), '资料')
      const taken = new Set((await this.#fs.listDir(this.#baseDir(base))).map(entry => entry.name))
      const name = uniqueSegment(`${stem}.txt`, taken)
      await this.#fs.writeFile(path.join(this.#baseDir(base), name), legacyMaterialText(material))
      await this.#store.deleteLegacyMaterial(material.id)
      written += 1
    }
    return written
  }

  /**
   * Reconcile records with the folders actually present.
   *
   * The folder is authoritative, keyed by the id in its name: a base the user
   * moved in from elsewhere is adopted, a folder the user renamed is followed
   * (its new display name adopted with it), and a record whose folder is gone is
   * dropped. Matching on the id rather than the whole name is what keeps an
   * external rename from looking like a deletion plus a new base.
   */
  async #syncFromDisk(): Promise<void> {
    const entries = await this.#fs.listDir(this.#root)
    const present = new Map<string, string>()
    for (const entry of entries) {
      if (entry.kind !== 'directory' || isRecycleName(entry.name)) continue
      const parsed = parseVaultFolderName(entry.name)
      if (parsed === undefined) continue
      present.set(parsed.id, entry.name)
    }

    for (const [id, folderName] of present) {
      const existing = this.#knowledgeBases.get(id)
      if (existing === undefined) {
        const timestamp = this.#now()
        const adopted: KnowledgeBase = {
          id,
          name: parseVaultFolderName(folderName)?.name ?? '知识库',
          description: '',
          folderName,
          createdAt: timestamp,
          updatedAt: timestamp,
          indexRevision: 0,
        }
        this.#knowledgeBases.set(id, adopted)
        this.#materials.set(id, new Map())
        await this.#store.saveKnowledgeBase(adopted)
        continue
      }
      if (existing.folderName === folderName) continue
      // Treat an external folder rename as an independent identity commit. Save
      // the bumped revision before publishing the new metadata or citation
      // contexts; a later walk failure must not expose a half-renamed snapshot.
      const renamed: KnowledgeBase = {
        ...existing,
        folderName,
        name: parseVaultFolderName(folderName)?.name ?? existing.name,
        updatedAt: this.#now(),
        indexRevision: existing.indexRevision + 1,
      }
      await this.#store.saveKnowledgeBase(renamed)
      this.#knowledgeBases.set(id, renamed)
      for (const [chunkId, context] of this.#chunks) {
        if (context.kbId !== id) continue
        this.#chunks.set(chunkId, {
          ...context,
          kbName: renamed.name,
          filePath: path.join(this.#root, renamed.folderName, ...context.materialId.split('/')),
        })
      }
    }

    for (const id of [...this.#knowledgeBases.keys()]) {
      if (present.has(id)) continue
      this.#unindexBase(id)
      this.#materials.delete(id)
      this.#scanReports.delete(id)
      this.#dirtyMaterials.delete(id)
      this.#knowledgeBases.delete(id)
      await this.#store.deleteKnowledgeBase(id)
    }
  }

  /**
   * Walk, extract, then commit one base. The old map/index is untouched until
   * walk succeeds; this is important when a directory read fails halfway.
   */
  async #scanBase(
    base: KnowledgeBase,
    options: RescanOptions = {},
    forced: ReadonlySet<string> = new Set(),
    bumpRevision = true,
  ): Promise<readonly Material[]> {
    const entries = await this.#walk(this.#baseDir(base), this.#baseDir(base), 0)
    const previous = this.#materials.get(base.id) ?? new Map<string, Material>()
    const oldIds = new Set(previous.keys())
    const found = new Map<string, Material>()
    const toExtract: ScanEntry[] = []
    let added = 0
    let reused = 0
    let changed = 0
    let unsearchable = 0

    for (const entry of entries) {
      const prior = previous.get(entry.relative)
      const sameFingerprint = prior !== undefined &&
        prior.bytes === entry.size && prior.mtimeMs === entry.mtimeMs
      // A failed indexable read is deliberately never reusable: OCR packs may
      // become available between scans. Unindexable formats have no extractor.
      const canReuse = prior !== undefined && sameFingerprint &&
        options.force !== true && !forced.has(entry.relative) &&
        !this.#dirtyMaterials.get(base.id)?.has(entry.relative) &&
        ((prior.indexed && prior.chunks.length > 0) || !isIndexable(entry.relative))
      oldIds.delete(entry.relative)
      if (canReuse) {
        found.set(entry.relative, prior)
        reused += 1
      } else {
        toExtract.push(entry)
        if (prior === undefined) added += 1
      }
    }

    // Extraction is the asynchronous stage. No index/material map mutation is
    // performed until every file has produced a material.
    const extracted: Material[] = []
    // Bound extraction fan-out: PDF/OCR workers are much heavier than a stat.
    for (let offset = 0; offset < toExtract.length; offset += 4) {
      extracted.push(...await Promise.all(toExtract.slice(offset, offset + 4)
        .map(entry => this.#readMaterial(base, entry))))
    }
    const replacements: Material[] = []
    for (const material of extracted) {
      const prior = previous.get(material.id)
      const sameState = prior !== undefined && sameMaterialState(prior, material)
      if (prior !== undefined && !sameState) changed += 1
      // A retry with the same outcome is not a state change. Force still
      // rebuilds chunks, but fresh random chunk ids are not a new revision.
      const replace = !sameState || options.force === true
      found.set(material.id, replace ? material : prior!)
      if (replace) replacements.push(material)
      if (!material.indexed && isIndexable(material.fileName)) unsearchable += 1
    }

    const deleted = oldIds.size
    const changedState = added + changed + deleted > 0
    const report: ScanReport = { added, reused, changed, deleted, unsearchable }
    if (bumpRevision && changedState) await this.#bumpRevision(base.id)

    // Commit only after the revision record is durable. A storage failure leaves
    // the previous material/index/report snapshot visible and dirty markers live.
    for (const id of oldIds) {
      const prior = previous.get(id)
      if (prior !== undefined) this.#unindexMaterial(prior)
    }
    for (const material of replacements) {
      const prior = previous.get(material.id)
      if (prior !== undefined) this.#unindexMaterial(prior)
      this.#indexMaterial(material, base.name)
    }
    this.#materials.set(base.id, found)
    this.#scanReports.set(base.id, report)
    this.#dirtyMaterials.delete(base.id)
    return [...found.values()]
  }

  /** Everything a scan needs about one file. */
  async #readMaterial(
    base: KnowledgeBase,
    entry: ScanEntry,
  ): Promise<Material> {
    const shell: MaterialShell = {
      id: entry.relative,
      kbId: base.id,
      fileName: entry.relative,
      title: entry.relative,
      bytes: entry.size,
      extension: extensionOf(entry.relative),
      mtimeMs: entry.mtimeMs,
    }

    if (!isIndexable(entry.relative)) {
      // Stored and listed, never searched. No note: the format list is what
      // tells the user the plugin does not read this kind of file.
      return this.#silent(shell, '')
    }
    if (shell.extension === 'pdf') return await this.#readPdf(shell, entry)
    if (IMAGE_EXTENSIONS.has(shell.extension)) return await this.#readImage(shell, entry)
    return await this.#readText(shell, entry)
  }

  /** Read a plain-text file into the index. */
  async #readText(shell: MaterialShell, entry: ScanEntry): Promise<Material> {
    if (entry.size > MAX_TEXT_BYTES) {
      return this.#silent(shell, `文件超过 ${formatMb(MAX_TEXT_BYTES)}，未解析。`)
    }
    try {
      const text = await this.#fs.readText(entry.absolute, MAX_TEXT_BYTES)
      const legacyText = ['txt', 'md', 'markdown', 'text'].includes(shell.extension)
      return this.#publish(shell, text, chunkText(text, {
        ...this.#chunkOptions,
        ...(legacyText ? {} : { markdownHeadings: false }),
      }))
    } catch (error) {
      if (error instanceof TextReadError) {
        if (error.code === 'too-large') return this.#silent(shell, `文件超过 ${formatMb(MAX_TEXT_BYTES)}，未解析。`)
        if (error.code === 'invalid-utf8') return this.#silent(shell, '文件不是有效的 UTF-8 文本，请转换编码后重扫。')
        return this.#silent(shell, '文件包含二进制或不支持的控制字符，未作为文本解析。')
      }
      return this.#silent(shell, '文件无法读取，可能已被其他程序占用或删除。')
    }
  }

  /**
   * Read a PDF's text layer into the index.
   *
   * Every way this can come up empty gets its own sentence: an encrypted file,
   * a scan with no text layer, a file past a bound. They are different problems
   * with different fixes — remove the password, convert the page to an image,
   * or split the document — so the panel is told which one it is instead of
   * reporting all three as "暂不可检索".
   */
  async #readPdf(shell: MaterialShell, entry: ScanEntry): Promise<Material> {
    if (entry.size > MAX_PDF_BYTES) {
      return this.#silent(shell, `文件超过 ${formatMb(MAX_PDF_BYTES)}，未解析。请拆分后再导入。`)
    }

    let bytes: Uint8Array
    try {
      bytes = await this.#fs.readBytes(entry.absolute)
    } catch {
      return this.#silent(shell, '文件无法读取，可能已被其他程序占用或删除。')
    }

    try {
      const pages = await extractPdfPages(bytes, { maxPages: MAX_PDF_PAGES })
      const chunks = chunkPages(pages, this.#chunkOptions)
      if (chunks.length === 0) {
        return this.#silent(
          shell,
          `PDF 里没有可提取的文字（共 ${pages.length} 页，可能是扫描件）。` +
            '把需要的页面转成图片再导入即可；本版不做整本扫描件 OCR。',
        )
      }
      // Pages are joined with a blank line rather than with page markers: the
      // reader highlights a passage by its character range in this text, and a
      // marker would sit inside the ranges the index was built from.
      return this.#publish(shell, pages.join('\n\n'), chunks)
    } catch (error) {
      return this.#silent(shell, pdfNoteOf(error))
    }
  }

  /**
   * Read an image's text with the local OCR engine.
   *
   * Nothing here touches the network. When the language packs are absent the
   * engine answers `resources-missing` and the file carries the sentence that
   * says where to get them (`./ocr.ts` checks the packs before loading WASM, and
   * its `langPath` is a path that deliberately does not exist) — a photograph
   * must not turn a rescan into a download.
   */
  async #readImage(shell: MaterialShell, entry: ScanEntry): Promise<Material> {
    if (entry.size > MAX_IMAGE_BYTES) {
      return this.#silent(shell, `文件超过 ${formatMb(MAX_IMAGE_BYTES)}，未识别。`)
    }
    if (this.#ocr === undefined) return this.#silent(shell, OCR_PACKS_HINT)

    let bytes: Uint8Array
    try {
      bytes = await this.#fs.readBytes(entry.absolute)
    } catch {
      return this.#silent(shell, '文件无法读取，可能已被其他程序占用或删除。')
    }

    try {
      // The OCR port does not promise reentrancy. Keep a single recognition in
      // flight even while this scan extracts text/PDF materials concurrently.
      const engine = this.#ocr
      const recognition = this.#ocrTail.then(() => engine.recognize(bytes))
      this.#ocrTail = recognition.then(() => undefined, () => undefined)
      const text = await recognition
      // An image with no words in it is a fact about the file, not a failure:
      // a photo of a chair is not a broken document.
      if (text.trim() === '') return this.#silent(shell, '图片里没有识别出文字。')
      return this.#publish(shell, text, chunkText(text, this.#chunkOptions))
    } catch (error) {
      return this.#silent(shell, ocrNoteOf(error))
    }
  }

  /** A file that is listed but contributes nothing to the index. */
  #silent(shell: MaterialShell, note: string): Material {
    return { ...shell, indexed: false, note, chunks: [] }
  }

  /** A file the index can search, carrying the text the reader shows. */
  #publish(shell: MaterialShell, extractedText: string, chunks: readonly ChunkRecord[]): Material {
    return { ...shell, indexed: chunks.length > 0, extractedText, chunks, note: '' }
  }

  /** Every file under a directory, depth-first, as vault-relative paths. */
  async #walk(baseDir: string, dir: string, depth: number): Promise<ScanEntry[]> {
    if (depth > MAX_SCAN_DEPTH) return []
    const result: ScanEntry[] = []
    for (const entry of await this.#fs.listDir(dir)) {
      // Dot-entries are the user's own bookkeeping — editor swap files, `.DS_Store`
      // — not knowledge, and listing them would put noise in the file manager.
      if (entry.name.startsWith('.')) continue
      const absolute = path.join(dir, entry.name)
      if (entry.kind === 'directory') {
        result.push(...(await this.#walk(baseDir, absolute, depth + 1)))
        continue
      }
      if (entry.kind !== 'file') continue
      result.push({
        relative: path.relative(baseDir, absolute).split(path.sep).join('/'),
        absolute,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      })
    }
    return result
  }

  /** A free name in the recycle folder for one entry. */
  async #freeRecycleName(entryName: string): Promise<string> {
    const taken = new Set((await this.#fs.listDir(recycleDir(this.#root))).map(entry => entry.name))
    return recycleTarget(this.#root, entryName, taken)
  }

  /** Whether any indexed chunk belongs to one of the allowed knowledge bases. */
  #hasIndexedChunks(allowed: ReadonlySet<string>): boolean {
    for (const context of this.#chunks.values()) {
      if (allowed.has(context.kbId)) return true
    }
    return false
  }

  /** Remove every material of one knowledge base from the index. */
  #unindexBase(id: string): void {
    const files = this.#materials.get(id)
    if (files === undefined) return
    for (const material of files.values()) this.#unindexMaterial(material)
  }

  #indexMaterial(material: Material, kbName: string): void {
    if (material.chunks.length === 0) return
    const base = this.#knowledgeBases.get(material.kbId)
    for (const chunk of material.chunks) {
      // The title is indexed with the chunk even though the citation shows the
      // chunk text alone. A file called 「刘一江的电话.txt」 whose body is just a
      // number is unfindable otherwise: the words a person naturally searches
      // for live in the name, and a name that is not searchable is a file that
      // does not exist as far as retrieval is concerned.
      //
      // The knowledge base name is deliberately NOT indexed: it labels a
      // container, so including it would make every chunk match a query for the
      // base's own name.
      this.#index.add(chunk.id, `${material.title}\n${chunk.text}`)
      this.#chunks.set(chunk.id, {
        kbId: material.kbId,
        materialId: material.id,
        ordinal: chunk.ordinal,
        kbName,
        materialTitle: material.title,
        filePath:
          base === undefined
            ? ''
            : path.join(this.#root, base.folderName, ...material.fileName.split('/')),
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

  async #bumpRevision(kbId: string): Promise<void> {
    const base = this.#knowledgeBases.get(kbId)
    if (base === undefined) return
    const updated: KnowledgeBase = {
      ...base,
      indexRevision: base.indexRevision + 1,
      updatedAt: this.#now(),
    }
    await this.#store.saveKnowledgeBase(updated)
    this.#knowledgeBases.set(updated.id, updated)
  }
}

/** Ignore generated chunk identities when auditing an extraction's state. */
function sameMaterialState(left: Material, right: Material): boolean {
  return left.id === right.id && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs &&
    left.indexed === right.indexed && left.note === right.note &&
    left.extractedText === right.extractedText && left.chunks.length === right.chunks.length &&
    left.chunks.every((chunk, index) => {
      const other = right.chunks[index]!
      return chunk.ordinal === other.ordinal && chunk.text === other.text &&
        chunk.headingPath === other.headingPath && chunk.locator === other.locator
    })
}

/** One sentence for the user, from the PDF extractor's failure code. */
function pdfNoteOf(error: unknown): string {
  if (!(error instanceof PdfError)) return 'PDF 解析失败，未能提取文字。'
  switch (error.code) {
    case 'encrypted':
      return 'PDF 已加密，先去掉密码再导入。'
    case 'unsupported':
      return '这不是可解析的 PDF，可能已损坏或并非 PDF。'
    case 'too-many-pages':
      return error.message
    case 'cancelled':
      return 'PDF 解析已取消。'
    default:
      return 'PDF 解析失败，未能提取文字。'
  }
}

/** One sentence for the user, from the OCR engine's failure code. */
function ocrNoteOf(error: unknown): string {
  if (!(error instanceof OcrError)) return '图片文字识别失败，未能提取文字。'
  switch (error.code) {
    case 'resources-missing':
      return OCR_PACKS_HINT
    case 'cancelled':
      return '图片文字识别已取消。'
    default:
      return '图片文字识别失败，未能提取文字。'
  }
}

/** A byte bound as whole megabytes, for a sentence a user reads. */
function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

/** Drop a `.txt`/`.md` suffix a legacy title may already carry. */
function stripTextExtension(title: string): string {
  return title.replace(/\.(txt|md|markdown|text)$/i, '')
}

/** In-memory store. Used by tests and as a reference implementation. */
export class MemoryStore implements KnowbaseStore {
  readonly #knowledgeBases = new Map<string, StoredKnowledgeBase>()
  readonly #legacy = new Map<string, LegacyMaterial>()

  loadKnowledgeBases(): readonly StoredKnowledgeBase[] {
    return [...this.#knowledgeBases.values()]
  }

  async saveKnowledgeBase(knowledgeBase: KnowledgeBase): Promise<void> {
    this.#knowledgeBases.set(knowledgeBase.id, { ...knowledgeBase })
  }

  async deleteKnowledgeBase(id: string): Promise<boolean> {
    return this.#knowledgeBases.delete(id)
  }

  /**
   * Seed one record exactly as the storage layer would have read it.
   *
   * Used by the tests that stand in for an install written by an older build: a
   * record from the text era carries no `folderName`, and one the old build had
   * already deleted carries `deletedAt`. Neither can be expressed as a
   * {@link KnowledgeBase}, which is the whole point of the two shapes.
   */
  seedKnowledgeBase(record: StoredKnowledgeBase): void {
    this.#knowledgeBases.set(record.id, { ...record })
  }

  /** Seed one text-era material; used by the migration tests. */
  seedLegacyMaterial(material: LegacyMaterial): void {
    this.#legacy.set(material.id, material)
  }

  loadLegacyMaterials(): readonly LegacyMaterial[] {
    return [...this.#legacy.values()]
  }

  async deleteLegacyMaterial(id: string): Promise<boolean> {
    return this.#legacy.delete(id)
  }
}
