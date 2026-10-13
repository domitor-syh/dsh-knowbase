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
 * The artifacts it emits are plain data — zod schemas plus
 * `InvocationDescriptor` records — over public, documented protocol types. The
 * Host half needs nothing generated at all: the Gateway discovers a
 * `TypertRemoteService` through its own runtime binding. Only the client
 * contribution is written by hand, in `./client/contribution.ts`.
 *
 * @module @domitor-syh/dsh-knowbase/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { backupFileName, BackupError, parseBackupDocument, serializeBackup, type BackupDocument } from './core/backup.ts'
import { materialText } from './core/model.ts'
import type { SessionSelectionRegistry } from './core/session-scope.ts'
import type { KnowbaseService } from './core/service.ts'
import { installRemoteMarkers } from './remote-methods.ts'

/** Cordis service key, wire namespace, and registry key. */
const SERVICE_KEY = 'knowbase'

/** One knowledge base, as the settings list needs it. */
export interface KnowledgeBaseView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly materialCount: number
  readonly chunkCount: number
  readonly updatedAt: number
}

/** One material, as the material list needs it. */
export interface MaterialView {
  readonly id: string
  readonly kbId: string
  readonly title: string
  readonly revision: number
  readonly chunkCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One retrievable passage, for the material detail view. */
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

/** The recycle bin: soft-deleted bases and materials, as one view. */
export interface RecycleBinView {
  readonly bases: readonly KnowledgeBaseView[]
  readonly materials: readonly MaterialView[]
}

/**
 * A material already holding the text the user is about to add.
 *
 * Returned instead of thrown so the page can warn inline and offer 「仍然添加」;
 * the Host still refuses the add itself, so a client that skips the check gets
 * an error rather than a silent duplicate.
 */
export interface DuplicateView {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly chunkCount: number
}

/**
 * A backup, ready to be written to a file by the browser.
 *
 * The bytes travel as a string because the Host is not the one choosing where
 * the file lands: the page turns this into a download, so the user picks the
 * destination with the file dialog they already know.
 */
export interface BackupPayloadView {
  readonly fileName: string
  readonly json: string
  readonly bases: number
  readonly materials: number
  readonly bytes: number
}

/**
 * What a restore did.
 *
 * A discriminated result rather than a throw for the "wrong file" case: picking
 * the wrong file is an ordinary thing to do, and it has to arrive in the page as
 * a sentence the user can read. Whether a thrown error keeps its message across
 * the Remote boundary is the gateway's business, and this is not the place to
 * depend on it. Genuine faults — a store that fails to write — still throw.
 */
export type ImportResultView =
  | {
      readonly outcome: 'imported'
      readonly bases: number
      readonly materials: number
      readonly skippedMaterials: number
      readonly reallocatedBases: number
      readonly baseNames: readonly string[]
    }
  | {
      readonly outcome: 'rejected'
      /** Why the file was refused, in words the user can act on. */
      readonly reason: string
    }

/** What the service methods need from the plugin. */
interface Dependencies {
  readonly service: KnowbaseService
  readonly selection: SessionSelectionRegistry
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

/**
 * Operations the settings page needs.
 *
 * Which methods reach the browser is decided by `./remote-methods.ts`, which
 * installs the prototype marker the Gateway reads — see that module for why the
 * `@Remote` decorator is not used here. A method missing from that list is
 * unreachable from the browser, which `tests/contribution.test.ts` catches.
 */
export class KnowbaseRemote extends TypertRemoteService {
  constructor(ctx: Context, service: KnowbaseService, selection: SessionSelectionRegistry) {
    super(ctx, SERVICE_KEY)
    DEPENDENCIES.set(SERVICE_KEY, { service, selection })
  }

  /** Every knowledge base, ordered by name. */
  async listKnowledgeBases(): Promise<readonly KnowledgeBaseView[]> {
    const { service } = deps()
    return service.listKnowledgeBases().map(knowledgeBase => {
      const materials = service.listMaterials(knowledgeBase.id)
      return {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        materialCount: materials.length,
        chunkCount: materials.reduce((sum, material) => sum + material.chunks.length, 0),
        updatedAt: knowledgeBase.updatedAt,
      }
    })
  }

  /** Create a knowledge base. */
  async createKnowledgeBase(name: string, description: string): Promise<KnowledgeBaseView> {
    const created = await deps().service.createKnowledgeBase(name, description)
    return {
      id: created.id,
      name: created.name,
      description: created.description,
      materialCount: 0,
      chunkCount: 0,
      updatedAt: created.updatedAt,
    }
  }

  /** Rename a knowledge base. */
  async renameKnowledgeBase(id: string, name: string): Promise<boolean> {
    await deps().service.renameKnowledgeBase(id, name)
    return true
  }

  /** Delete a knowledge base and everything inside it. */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    return deps().service.deleteKnowledgeBase(id)
  }

  /** Materials inside one knowledge base. */
  async listMaterials(kbId: string): Promise<readonly MaterialView[]> {
    return deps()
      .service.listMaterials(kbId)
      .map(material => ({
        id: material.id,
        kbId: material.kbId,
        title: material.title,
        revision: material.revision,
        chunkCount: material.chunks.length,
        createdAt: material.createdAt,
        updatedAt: material.updatedAt,
      }))
  }

  /** Add typed or pasted text as a new material. */
  async addTextMaterial(
    kbId: string,
    title: string,
    text: string,
    allowDuplicate: boolean,
  ): Promise<MaterialView> {
    const material = await deps().service.addText(kbId, title, text, { allowDuplicate })
    return {
      id: material.id,
      kbId: material.kbId,
      title: material.title,
      revision: material.revision,
      chunkCount: material.chunks.length,
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
    }
  }

  /** The material already holding this text in this base, if any. */
  async findDuplicateMaterial(kbId: string, text: string): Promise<DuplicateView | null> {
    const found = deps().service.findDuplicateMaterial(kbId, text)
    if (found === undefined) return null
    return {
      id: found.id,
      title: found.title,
      updatedAt: found.updatedAt,
      chunkCount: found.chunks.length,
    }
  }

  /** Remove a material. */
  async deleteMaterial(id: string): Promise<boolean> {
    return deps().service.deleteMaterial(id)
  }

  /** The chunks a material was split into, for the detail view. */
  async readMaterialChunks(id: string): Promise<readonly PassageView[]> {
    const material = deps().service.getMaterial(id)
    if (material === undefined) return []
    return material.chunks.map(chunk => ({
      ordinal: chunk.ordinal,
      headingPath: chunk.headingPath,
      locator: chunk.locator,
      text: chunk.text,
    }))
  }

  /**
   * The text as the user supplied it, for the editor.
   *
   * Records written before the editor existed have no stored text and are
   * reassembled from their chunks, which normalises blank lines — good enough to
   * edit, and the next save writes the field properly.
   */
  async readMaterialText(id: string): Promise<string> {
    const material = deps().service.getMaterial(id)
    if (material === undefined) return ''
    return materialText(material)
  }

  /** Replace a material's text and re-index it. */
  async updateMaterialText(id: string, text: string): Promise<MaterialView> {
    const material = await deps().service.updateMaterialText(id, text)
    return {
      id: material.id,
      kbId: material.kbId,
      title: material.title,
      revision: material.revision,
      chunkCount: material.chunks.length,
      createdAt: material.createdAt,
      updatedAt: material.updatedAt,
    }
  }

  /** Update a knowledge base's description. */
  async updateDescription(id: string, description: string): Promise<boolean> {
    await deps().service.updateDescription(id, description)
    return true
  }

  /**
   * Run retrieval without touching the model.
   *
   * The plan's retrieval-test panel: it answers "what would be sent?" without
   * spending a model call, which is the only way to calibrate ranking against
   * real questions.
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
          // Absent on passages recorded before the panel showed them; the test
          // endpoint always searches live, so here they are always present. A
          // zero is honest for a ranking signal the index did not report.
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

  // ------------------------------------------------------------------- backup

  /**
   * Serialize the library into a downloadable backup.
   *
   * `kbId` of `''` means every live knowledge base; anything else exports that
   * one. The filename is generated on the Host rather than the client so it is
   * the same name however the file is produced — including from a script that
   * never renders the page.
   */
  async exportBackup(kbId: string): Promise<BackupPayloadView> {
    const { service } = deps()
    const document = service.exportBackup(Date.now())
    const scoped =
      kbId === '' ? document : { ...document, bases: document.bases.filter(base => base.id === kbId) }

    const json = serializeBackup(scoped)
    return {
      fileName: backupFileName(scoped.exportedAt),
      json,
      bases: scoped.bases.length,
      materials: scoped.bases.reduce((sum, base) => sum + base.materials.length, 0),
      bytes: new TextEncoder().encode(json).length,
    }
  }

  /**
   * Restore a backup file.
   *
   * Parsing happens here rather than in the page so the file is validated
   * against the format on the side that owns the format, and a malformed file is
   * refused as a whole instead of half-importing.
   */
  async importBackup(json: string): Promise<ImportResultView> {
    let document: BackupDocument
    try {
      document = parseBackupDocument(json)
    } catch (error) {
      if (error instanceof BackupError) return { outcome: 'rejected', reason: error.message }
      throw error
    }
    const summary = await deps().service.importBackup(document)
    return { outcome: 'imported', ...summary }
  }

  // --------------------------------------------------------------- recycle bin

  /** Everything currently in the recycle bin. */
  async listRecycleBin(): Promise<RecycleBinView> {
    const { service } = deps()
    // Every material that belongs to the base, whatever its own state: a base
    // in the bin is restored (or purged) together with all of them.
    const everyMaterial = [...service.listMaterials(), ...service.listDeletedMaterials()]

    const bases = service.listDeletedKnowledgeBases().map(base => {
      const inside = everyMaterial.filter(material => material.kbId === base.id)
      return {
        id: base.id,
        name: base.name,
        description: base.description,
        materialCount: inside.length,
        chunkCount: inside.reduce((sum, material) => sum + material.chunks.length, 0),
        updatedAt: base.deletedAt ?? base.updatedAt,
      }
    })

    const materials = service.listDeletedMaterials().map(material => ({
      id: material.id,
      kbId: material.kbId,
      title: material.title,
      revision: material.revision,
      chunkCount: material.chunks.length,
      createdAt: material.createdAt,
      updatedAt: material.deletedAt ?? material.updatedAt,
    }))
    return { bases, materials }
  }

  /** Take a soft-deleted knowledge base out of the bin. */
  async restoreKnowledgeBase(id: string): Promise<boolean> {
    return deps().service.restoreKnowledgeBase(id)
  }

  /** Take a soft-deleted material out of the bin. */
  async restoreMaterial(id: string): Promise<boolean> {
    return deps().service.restoreMaterial(id)
  }

  /** Destroy a soft-deleted knowledge base and its materials for good. */
  async purgeKnowledgeBase(id: string): Promise<boolean> {
    return deps().service.purgeKnowledgeBase(id)
  }

  /** Destroy a soft-deleted material for good. */
  async purgeMaterial(id: string): Promise<boolean> {
    return deps().service.purgeMaterial(id)
  }
}

// Publish the method list as the prototype marker the Gateway reads. See
// `./remote-methods.ts` for why this is not a decorator.
installRemoteMarkers(KnowbaseRemote)
