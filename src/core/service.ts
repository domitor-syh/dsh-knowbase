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
import { chunkPages, chunkText, type ChunkOptions } from './chunk.ts'
import { MAX_PDF_PAGES, PdfError, extractPdfPages } from './pdf.ts'
import {
  extensionOf,
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

/** How deep a scan walks into sub-folders of a base. */
const MAX_SCAN_DEPTH = 8

/** Knowledge base and material operations over a {@link KnowbaseStore} and a vault. */
export class KnowbaseService {
  readonly #store: KnowbaseStore
  readonly #fs: VaultFileSystem
  readonly #root: string
  readonly #now: () => number
  readonly #chunkOptions: ChunkOptions
  readonly #index = new Bm25Index()
  readonly #chunks = new Map<string, ChunkContext>()
  readonly #knowledgeBases = new Map<string, KnowledgeBase>()
  readonly #materials = new Map<string, Map<string, Material>>()

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
    this.#knowledgeBases.clear()
    this.#materials.clear()
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
      materials += (await this.#scanBase(base)).length
    }

    return { knowledgeBases: this.#knowledgeBases.size, materials, migrated }
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
  }

  /** Rename a base, moving its folder so the name is the same in both places. */
  async renameKnowledgeBase(id: string, rawName: string): Promise<KnowledgeBase> {
    const current = this.#requireKnowledgeBase(id)

    const name = normalizeName(rawName)
    if (name.length === 0) throw new KnowbaseError('invalid-name', '知识库名称不能为空。')
    const clash = this.findKnowledgeBaseByName(name)
    if (clash !== undefined && clash.id !== id) {
      throw new KnowbaseError('duplicate-name', `已存在名为「${name}」的知识库。`)
    }

    const folderName = vaultFolderName(name, id)
    if (folderName !== current.folderName) {
      await this.#fs.move(this.#baseDir(current), path.join(this.#root, folderName))
    }

    const updated: KnowledgeBase = { ...current, name, folderName, updatedAt: this.#now() }
    this.#knowledgeBases.set(id, updated)
    // Citations carry the base name, so a rename has to reach the contexts
    // already in the index or old passages would cite the old name.
    for (const [chunkId, context] of this.#chunks) {
      if (context.kbId === id) this.#chunks.set(chunkId, { ...context, kbName: name })
    }
    await this.#store.saveKnowledgeBase(updated)
    return updated
  }

  /** Update a knowledge base's description. */
  async updateDescription(id: string, rawDescription: string): Promise<KnowledgeBase> {
    const current = this.#requireKnowledgeBase(id)
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
   * Delete a knowledge base by moving its folder into the recycle folder.
   *
   * Nothing is destroyed: the folder keeps its name and content, and the user
   * can drag it back out of `_回收站`. The record is dropped, because the base
   * is no longer on disk — a record without a folder would be resurrected as an
   * empty base by the next sync, which is not what deleting it meant.
   */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    const current = this.#knowledgeBases.get(id)
    if (current === undefined) return false

    this.#unindexBase(id)
    const target = await this.#freeRecycleName(current.folderName)
    await this.#fs.move(this.#baseDir(current), target)

    this.#materials.delete(id)
    this.#knowledgeBases.delete(id)
    await this.#store.deleteKnowledgeBase(id)
    return true
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
    const base = this.#requireKnowledgeBase(kbId)
    if (files.length === 0) return []

    const taken = new Set((await this.#fs.listDir(this.#baseDir(base))).map(entry => entry.name))
    const created: string[] = []

    for (const file of files) {
      const wanted = sanitizeSegment(file.name, '未命名文件')
      const name = options.overwrite === true ? wanted : uniqueSegment(wanted, taken)
      taken.add(name)
      await this.#fs.writeFile(path.join(this.#baseDir(base), name), file.data)
      created.push(name)
    }

    const materials = await this.#scanBase(base)
    await this.#bumpRevision(base)
    const wanted = new Set(created)
    return materials.filter(material => wanted.has(material.fileName))
  }

  /**
   * Delete one file by moving it into the recycle folder.
   *
   * Read-only for the record, exactly like deleting a base: the file is not
   * removed from the disk at all, and the user can drag it back.
   */
  async deleteMaterial(kbId: string, id: string): Promise<boolean> {
    const base = this.#requireKnowledgeBase(kbId)
    const material = this.#materials.get(kbId)?.get(id)
    if (material === undefined) return false

    const source = path.join(this.#baseDir(base), ...id.split('/'))
    const target = await this.#freeRecycleName(path.basename(id))
    await this.#fs.move(source, target)

    await this.#scanBase(base)
    await this.#bumpRevision(base)
    return true
  }

  /** Re-read a base from the disk, or every base when `kbId` is omitted. */
  async rescan(kbId?: string): Promise<void> {
    await this.#fs.ensureDir(this.#root)
    await this.#fs.ensureDir(recycleDir(this.#root))
    const bases = kbId === undefined ? [...this.#knowledgeBases.values()] : [this.#requireKnowledgeBase(kbId)]
    if (kbId === undefined) await this.#syncFromDisk()
    for (const base of bases) {
      const live = this.#knowledgeBases.get(base.id)
      if (live === undefined) continue
      await this.#scanBase(live)
    }
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
      // The folder moved or was renamed outside the app: the disk wins, because
      // that is the name the user can see.
      const renamed: KnowledgeBase = {
        ...existing,
        folderName,
        name: parseVaultFolderName(folderName)?.name ?? existing.name,
        updatedAt: this.#now(),
      }
      this.#knowledgeBases.set(id, renamed)
      for (const [chunkId, context] of this.#chunks) {
        if (context.kbId === id) this.#chunks.set(chunkId, { ...context, kbName: renamed.name })
      }
      await this.#store.saveKnowledgeBase(renamed)
    }

    for (const id of [...this.#knowledgeBases.keys()]) {
      if (present.has(id)) continue
      this.#unindexBase(id)
      this.#materials.delete(id)
      this.#knowledgeBases.delete(id)
      await this.#store.deleteKnowledgeBase(id)
    }
  }

  /** Re-read one base's folder and rebuild its contribution to the index. */
  async #scanBase(base: KnowledgeBase): Promise<readonly Material[]> {
    const previous = this.#materials.get(base.id)
    if (previous !== undefined) {
      for (const material of previous.values()) this.#unindexMaterial(material)
    }

    const found = new Map<string, Material>()
    const baseDir = this.#baseDir(base)
    for (const entry of await this.#walk(baseDir, baseDir, 0)) {
      const material = await this.#readMaterial(base, entry)
      found.set(material.id, material)
      this.#indexMaterial(material, base.name)
    }

    this.#materials.set(base.id, found)
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
    return await this.#readText(shell, entry)
  }

  /** Read a plain-text file into the index. */
  async #readText(shell: MaterialShell, entry: ScanEntry): Promise<Material> {
    if (entry.size > MAX_TEXT_BYTES) {
      return this.#silent(shell, `文件超过 ${formatMb(MAX_TEXT_BYTES)}，未解析。`)
    }
    try {
      const text = await this.#fs.readText(entry.absolute)
      return this.#publish(shell, text, chunkText(text, this.#chunkOptions))
    } catch {
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

  /** A file that is listed but contributes nothing to the index. */
  #silent(shell: MaterialShell, note: string): Material {
    return { ...shell, indexed: false, note, chunks: [] }
  }

  /** A file the index can search, carrying the text the reader shows. */
  #publish(shell: MaterialShell, extractedText: string, chunks: readonly ChunkRecord[]): Material {
    return { ...shell, indexed: true, extractedText, chunks, note: '' }
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

  async #bumpRevision(base: KnowledgeBase): Promise<void> {
    const updated: KnowledgeBase = {
      ...base,
      indexRevision: base.indexRevision + 1,
      updatedAt: this.#now(),
    }
    this.#knowledgeBases.set(updated.id, updated)
    await this.#store.saveKnowledgeBase(updated)
  }
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
