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
import type { SessionSelectionRegistry } from './commands.ts'
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

/** One retrieval-test hit, carrying its source. */
export interface SearchHitView {
  readonly kbName: string
  readonly materialTitle: string
  readonly locator: string
  readonly text: string
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
  async addTextMaterial(kbId: string, title: string, text: string): Promise<MaterialView> {
    const material = await deps().service.addText(kbId, title, text)
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
    deps().selection.set(agentId, { enabled, scope: all ? 'all' : [...kbIds] })
    // Deliberately not `this.getSessionScope(...)`: `this` may be the wrapper a
    // Remote call arrives through, and nothing here should depend on it.
    return readScope(agentId)
  }
}

// Publish the method list as the prototype marker the Gateway reads. See
// `./remote-methods.ts` for why this is not a decorator.
installRemoteMarkers(KnowbaseRemote)
