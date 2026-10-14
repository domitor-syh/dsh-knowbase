/**
 * The Host service the browser half calls.
 *
 * ## Why the dependencies live outside the instance
 *
 * The first version kept them in `#private` fields. The first Remote call
 * failed with:
 *
 *   Cannot read private member #service from an object whose class did not
 *   declare it
 *
 * Private fields require the receiver to carry the class's brand, and the object
 * a registered Cordis service is invoked through is not the instance itself.
 * Plain properties would very likely survive that wrapper, but "very likely" is
 * not worth another round trip on a channel that has already cost several: a
 * registry keyed by service key cannot depend on how `this` is bound at all.
 *
 * ## Why this is hand-written rather than generated
 *
 * `@deepseek-ai/dsh-typert-generator` would derive the client-side descriptors
 * from these types, but it hard-requires the dsh monorepo layout — contributing
 * packages under `<root>/packages/` and, decisively, the
 * `@deepseek-ai/dsh-typert-protocol` package vendored under `<root>/vendor/` so
 * that its `Remote` symbol belongs to a registered project. That is not a
 * reasonable price for a standalone plugin (see the stage-0 report, §12).
 *
 * @module @domitor-syh/dsh-knowbase/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { OcrResourceManager, OcrResourceStatus } from './core/ocr-resources.ts'
import type { SessionSelectionRegistry } from './core/session-scope.ts'
import type { KnowbaseService } from './core/service.ts'
import { installRemoteMarkers } from './remote-methods.ts'

/** Cordis service key, wire namespace, and registry key. */
const SERVICE_KEY = 'knowbase'

/**
 * Largest file the browser may push through the Remote channel.
 *
 * The channel carries lossless JSON only (see `HANDOFF.md` §15 ④), so a file
 * travels base64-encoded inside a string — a third larger than the file, held
 * in memory on both sides at once. The cap is where that stops being reasonable
 * for a browser tab; past it the user is told to drop the file into the base's
 * folder instead, which costs nothing.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/** Largest file the reading pane will pull back as bytes. */
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024

/** One knowledge base, as the list needs it. */
export interface KnowledgeBaseView {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Folder name inside the vault; shown so the user can find it in their explorer. */
  readonly folderName: string
  readonly materialCount: number
  /** Files the plugin can search inside, i.e. those it extracted text from. */
  readonly indexedCount: number
  readonly bytes: number
  readonly updatedAt: number
}

/** One file inside a knowledge base, as the list needs it. */
export interface MaterialView {
  readonly id: string
  readonly kbId: string
  readonly fileName: string
  readonly title: string
  readonly bytes: number
  readonly extension: string
  /** Whether the plugin extracted searchable text from it. */
  readonly indexed: boolean
  readonly mtimeMs: number
  /** Why there is no searchable text, when there should be; `''` otherwise. */
  readonly note: string
}

/** One file with its extracted text, for the reading pane. */
export interface MaterialDetailView {
  readonly id: string
  readonly kbId: string
  readonly fileName: string
  readonly title: string
  readonly bytes: number
  readonly extension: string
  readonly indexed: boolean
  /** Extracted text, `''` for a file the plugin cannot read. */
  readonly text: string
  readonly chunks: readonly PassageView[]
  /** Why there is no searchable text, when there should be; `''` otherwise. */
  readonly note: string
}

/** One retrievable passage, for the reading pane's locator. */
export interface PassageView {
  readonly ordinal: number
  readonly headingPath: string
  readonly locator: string
  readonly text: string
}

/** One retrieval-test hit, carrying its source and its ranking signal. */
export interface SearchHitView {
  readonly kbName: string
  readonly materialTitle: string
  readonly locator: string
  readonly text: string
  /** BM25 score, comparable only within one query. */
  readonly score: number
  /** Fraction of query terms this passage matched, 0–1. */
  readonly coverage: number
}

/** Outcome of a retrieval test. */
export interface SearchReportView {
  /** `hits` | `no_match` | `empty_scope` | `not_ready` | `error`. */
  readonly outcome: string
  readonly passages: readonly SearchHitView[]
  /** Human-readable reason; empty when the outcome needs none. */
  readonly reason: string
  /** Wall-clock milliseconds the retrieval took. */
  readonly elapsedMs: number
}

/** Per-session retrieval scope. */
export interface SessionScopeView {
  readonly enabled: boolean
  /** True when the scope is every knowledge base. */
  readonly all: boolean
  readonly kbIds: readonly string[]
}

/** A file the browser is pushing into a base. */
export interface UploadedFileView {
  readonly name: string
  /** The file's bytes, base64-encoded — see {@link MAX_UPLOAD_BYTES}. */
  readonly base64: string
}

/** One OCR language pack, as the settings page shows it. */
export interface OcrPackView {
  readonly lang: string
  readonly fileName: string
  /** Where the pack is fetched from; shown so the source is not a secret. */
  readonly url: string
  /** Approximate `.gz` size, so an absent pack still has a size to quote. */
  readonly gzipBytes: number
  readonly present: boolean
  /** Size on disk once it is here; `0` otherwise. */
  readonly bytes: number
}

/** What the language packs look like right now. Detecting only — it fetches nothing. */
export interface OcrStatusView {
  /** True when every pack is on disk, i.e. images can be read offline. */
  readonly ready: boolean
  /** The cache directory, so the user can look at it. */
  readonly dir: string
  readonly packs: readonly OcrPackView[]
  readonly downloadedBytes: number
  /** `.gz` bytes still to fetch; `0` when {@link ready}. */
  readonly fetchBytes: number
  readonly missing: readonly string[]
}

/** A download of the language packs: running, or the last one that ended. */
export interface OcrDownloadStateView {
  /** `idle` | `running` | `done` | `cancelled` | `failed`. */
  readonly state: string
  readonly downloadedBytes: number
  readonly totalBytes: number
  /** Pack being fetched right now; `''` when none is. */
  readonly lang: string
  /** One sentence for the user; `''` while running and nothing has gone wrong. */
  readonly message: string
}

/** What one upload did. */
export interface UploadResultView {
  readonly added: number
  /** Files that were refused, by name, with the reason. */
  readonly rejected: readonly { readonly name: string; readonly reason: string }[]
}

/** What the service methods need from the plugin. */
interface Dependencies {
  readonly service: KnowbaseService
  readonly selection: SessionSelectionRegistry
  /** The language-pack download, held between calls — see `./core/ocr-resources.ts`. */
  readonly ocr: OcrResourceManager
}

/** See the module note: instance state is not reachable from a Remote call. */
const DEPENDENCIES = new Map<string, Dependencies>()

/** Resolve the dependencies, failing loudly rather than with a TypeError. */
function deps(): Dependencies {
  const found = DEPENDENCIES.get(SERVICE_KEY)
  if (found === undefined) {
    throw new Error('knowbase: Remote service was invoked before it was initialized')
  }
  return found
}

/** Read one session's scope in wire shape. */
function readScope(agentId: string): SessionScopeView {
  const current = deps().selection.get(agentId)
  return {
    enabled: current.enabled,
    all: current.scope === 'all',
    kbIds: current.scope === 'all' ? [] : [...current.scope],
  }
}

/** Project the language-pack status into the shape the page reads. */
function ocrStatusView(status: OcrResourceStatus): OcrStatusView {
  return {
    ready: status.ready,
    dir: status.dir,
    packs: status.packs.map(pack => ({
      lang: pack.lang,
      fileName: pack.fileName,
      url: pack.url,
      gzipBytes: pack.gzipBytes,
      present: pack.present,
      bytes: pack.bytes,
    })),
    downloadedBytes: status.downloadedBytes,
    fetchBytes: status.fetchBytes,
    missing: status.missing,
  }
}

/** Project one base, with the counts the list shows. */
function baseView(service: KnowbaseService, id: string): KnowledgeBaseView | undefined {
  const knowledgeBase = service.getKnowledgeBase(id)
  if (knowledgeBase === undefined) return undefined
  const materials = service.listMaterials(id)
  return {
    id: knowledgeBase.id,
    name: knowledgeBase.name,
    description: knowledgeBase.description,
    folderName: knowledgeBase.folderName,
    materialCount: materials.length,
    indexedCount: materials.filter(material => material.indexed).length,
    bytes: materials.reduce((sum, material) => sum + material.bytes, 0),
    updatedAt: knowledgeBase.updatedAt,
  }
}

/**
 * Operations the settings page and the reading pane need.
 *
 * Which methods reach the browser is decided by `./remote-methods.ts`, which
 * installs the prototype marker the Gateway reads — a method missing from that
 * list is unreachable from the browser, which `tests/contribution.test.ts`
 * catches.
 */
export class KnowbaseRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    service: KnowbaseService,
    selection: SessionSelectionRegistry,
    ocr: OcrResourceManager,
  ) {
    super(ctx, SERVICE_KEY)
    DEPENDENCIES.set(SERVICE_KEY, { service, selection, ocr })
  }

  /** Every knowledge base, ordered by name. */
  async listKnowledgeBases(): Promise<readonly KnowledgeBaseView[]> {
    const { service } = deps()
    return service
      .listKnowledgeBases()
      .map(knowledgeBase => baseView(service, knowledgeBase.id))
      .filter((view): view is KnowledgeBaseView => view !== undefined)
  }

  /** Create a knowledge base and its folder. */
  async createKnowledgeBase(name: string, description: string): Promise<KnowledgeBaseView> {
    const { service } = deps()
    const created = await service.createKnowledgeBase(name, description)
    return baseView(service, created.id) ?? {
      id: created.id,
      name: created.name,
      description: created.description,
      folderName: created.folderName,
      materialCount: 0,
      indexedCount: 0,
      bytes: 0,
      updatedAt: created.updatedAt,
    }
  }

  /** Rename a knowledge base, renaming its folder with it. */
  async renameKnowledgeBase(id: string, name: string): Promise<boolean> {
    await deps().service.renameKnowledgeBase(id, name)
    return true
  }

  /** Update a knowledge base's description. */
  async updateDescription(id: string, description: string): Promise<boolean> {
    await deps().service.updateDescription(id, description)
    return true
  }

  /** Delete a knowledge base by moving its folder into the recycle folder. */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    return deps().service.deleteKnowledgeBase(id)
  }

  /** Files inside one knowledge base. */
  async listMaterials(kbId: string): Promise<readonly MaterialView[]> {
    return deps()
      .service.listMaterials(kbId)
      .map(material => ({
        id: material.id,
        kbId: material.kbId,
        fileName: material.fileName,
        title: material.title,
        bytes: material.bytes,
        extension: material.extension,
        indexed: material.indexed,
        mtimeMs: material.mtimeMs,
        note: material.note,
      }))
  }

  /**
   * Push files from the browser into a base.
   *
   * Bytes arrive base64-encoded because the channel carries lossless JSON only;
   * anything larger than {@link MAX_UPLOAD_BYTES} is refused here rather than
   * discovered as a browser hang.
   */
  async addFiles(kbId: string, files: readonly UploadedFileView[]): Promise<UploadResultView> {
    const { service } = deps()
    const rejected: { name: string; reason: string }[] = []
    const accepted: { name: string; data: Uint8Array }[] = []

    for (const file of files) {
      const data = decodeBase64(file.base64)
      if (data === undefined) {
        rejected.push({ name: file.name, reason: '文件内容不是合法的 base64。' })
        continue
      }
      if (data.byteLength > MAX_UPLOAD_BYTES) {
        rejected.push({
          name: file.name,
          reason: '文件过大，无法通过浏览器上传。请把它直接放进该知识库的文件夹。',
        })
        continue
      }
      accepted.push({ name: file.name, data })
    }

    const created = await service.addFiles(kbId, accepted)
    return { added: created.length, rejected }
  }

  /** One file with its extracted text, for the reading pane. */
  async readMaterial(kbId: string, id: string): Promise<MaterialDetailView | null> {
    const material = deps().service.getMaterial(kbId, id)
    if (material === undefined) return null
    return {
      id: material.id,
      kbId: material.kbId,
      fileName: material.fileName,
      title: material.title,
      bytes: material.bytes,
      extension: material.extension,
      indexed: material.indexed,
      text: material.extractedText ?? '',
      note: material.note,
      chunks: material.chunks.map(chunk => ({
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        locator: chunk.locator,
        text: chunk.text,
      })),
    }
  }

  /**
   * One file's bytes, base64-encoded, so the pane can show an image.
   *
   * `''` means "not available": the file is gone, or it is larger than
   * {@link MAX_PREVIEW_BYTES} and pulling it into the page would cost more than
   * the preview is worth.
   */
  async readMaterialBytes(kbId: string, id: string): Promise<string> {
    const bytes = await deps().service.readMaterialBytes(kbId, id, MAX_PREVIEW_BYTES)
    return bytes === undefined ? '' : Buffer.from(bytes).toString('base64')
  }

  /** Delete one file by moving it into the recycle folder. */
  async deleteMaterial(kbId: string, id: string): Promise<boolean> {
    return deps().service.deleteMaterial(kbId, id)
  }

  /**
   * Re-read the vault from the disk.
   *
   * The button that makes the user's own explorer a supported way to add files:
   * drop a document into the base's folder, press this, and it appears.
   */
  async rescan(kbId: string): Promise<boolean> {
    await deps().service.rescan(kbId === '' ? undefined : kbId)
    return true
  }

  /** The vault root, so the page can show where the user's files actually live. */
  async getVaultRoot(): Promise<string> {
    return deps().service.root
  }

  /**
   * Report the OCR language packs without touching the network.
   *
   * This is the 「检测」 half, and it is a separate method on purpose: the button
   * that asks "do I have what I need?" must not be able to start a download, so
   * the check is a method that cannot do anything else (plan §11, `HANDOFF.md`
   * §16 ⑦).
   */
  async getOcrStatus(): Promise<OcrStatusView> {
    return ocrStatusView(await deps().ocr.status())
  }

  /**
   * Start fetching the missing language packs, and return at once.
   *
   * Returning at once is what lets the page draw a progress bar: it polls
   * {@link getOcrDownload} while the download runs here, rather than holding one
   * call open for thirty seconds with nothing to show.
   */
  async startOcrDownload(): Promise<OcrDownloadStateView> {
    return deps().ocr.start()
  }

  /** Stop the running download. Everything it had written is removed. */
  async cancelOcrDownload(): Promise<OcrDownloadStateView> {
    return deps().ocr.cancel()
  }

  /** Where the download is, for the page to poll. */
  async getOcrDownload(): Promise<OcrDownloadStateView> {
    return deps().ocr.view()
  }

  /**
   * Run retrieval without touching the model.
   *
   * The retrieval-test panel: it answers "what would be sent?" without spending
   * a model call, which is the only way to calibrate ranking against real
   * questions.
   */
  async testSearch(query: string, kbIds: readonly string[]): Promise<SearchReportView> {
    const started = Date.now()
    const outcome = deps().service.retrieve(query, kbIds)
    const elapsedMs = Date.now() - started

    if (outcome.kind === 'hits') {
      return {
        outcome: outcome.kind,
        passages: outcome.passages.map(passage => ({
          kbName: passage.kbName,
          materialTitle: passage.materialTitle,
          locator: passage.locator,
          text: passage.text,
          score: passage.score ?? 0,
          coverage: passage.coverage ?? 0,
        })),
        reason: '',
        elapsedMs,
      }
    }
    return {
      outcome: outcome.kind,
      passages: [],
      reason: outcome.kind === 'error' ? outcome.reason : '',
      elapsedMs,
    }
  }

  /** The scope the composer toggle and the retrieval seam both read. */
  async getSessionScope(agentId: string): Promise<SessionScopeView> {
    return readScope(agentId)
  }

  /** Replace the scope for one session. */
  async setSessionScope(
    agentId: string,
    enabled: boolean,
    all: boolean,
    kbIds: readonly string[],
  ): Promise<SessionScopeView> {
    await deps().selection.set(agentId, { enabled, scope: all ? 'all' : [...kbIds] })
    // Deliberately not `this.getSessionScope(...)`: `this` may be the wrapper a
    // Remote call arrives through, and nothing here should depend on it.
    return readScope(agentId)
  }
}

/** Decode base64 to bytes, or `undefined` when the string is not base64. */
function decodeBase64(value: string): Uint8Array | undefined {
  // `Buffer` accepts almost anything, so the shape is checked first: a client
  // that sent a truncated payload should be told, not handed empty bytes.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined
  const buffer = Buffer.from(value, 'base64')
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

// Publish the method list as the prototype marker the Gateway reads. See
// `./remote-methods.ts` for why this is not a decorator.
installRemoteMarkers(KnowbaseRemote)
