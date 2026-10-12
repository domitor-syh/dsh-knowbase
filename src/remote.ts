/**
 * The Host service the browser half calls.
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
 * The artifacts the generator emits are plain data — zod schemas plus
 * `InvocationDescriptor` records — over public, documented protocol types. The
 * Host half needs nothing generated at all: the Gateway discovers a
 * `TypertRemoteService` through its own runtime binding. So only the client
 * contribution is written by hand, in `./client/contribution.ts`, and a test
 * asserts the two stay in step.
 *
 * ## Why not commands
 *
 * Dispatching internal slash commands and parsing the returned text works — the
 * reference plugin does exactly that — but it has two costs a settings page
 * cannot pay: every call writes `command/run` and `command/done` session events,
 * which render as rows in the conversation, and every structured result becomes
 * a parsing problem on the client.
 *
 * @module @domitor-syh/dsh-knowbase/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionSelectionRegistry } from './commands.ts'
import { KnowbaseError, type KnowbaseService } from './core/service.ts'
import { installRemoteMarkers } from './remote-methods.ts'

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

/**
 * Operations the settings page needs.
 *
 * Which methods reach the browser is decided by `./remote-methods.ts`, which
 * installs the prototype marker the Gateway reads — see that module for why the
 * `@Remote` decorator is not used here. A method missing from that list is
 * unreachable from the browser, which `tests/contribution.test.ts` catches.
 */
export class KnowbaseRemote extends TypertRemoteService {
  readonly #service: KnowbaseService
  readonly #selection: SessionSelectionRegistry

  constructor(ctx: Context, service: KnowbaseService, selection: SessionSelectionRegistry) {
    super(ctx, 'knowbase')
    this.#service = service
    this.#selection = selection
  }

  /** Every knowledge base, ordered by name. */
  async listKnowledgeBases(): Promise<readonly KnowledgeBaseView[]> {
    return this.#service.listKnowledgeBases().map(knowledgeBase => {
      const materials = this.#service.listMaterials(knowledgeBase.id)
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
    const created = await this.#service.createKnowledgeBase(name, description)
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
    await this.#service.renameKnowledgeBase(id, name)
    return true
  }

  /** Delete a knowledge base and everything inside it. */
  async deleteKnowledgeBase(id: string): Promise<boolean> {
    return this.#service.deleteKnowledgeBase(id)
  }

  /** Materials inside one knowledge base. */
  async listMaterials(kbId: string): Promise<readonly MaterialView[]> {
    return this.#service.listMaterials(kbId).map(material => ({
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
    const material = await this.#service.addText(kbId, title, text)
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
    return this.#service.deleteMaterial(id)
  }

  /** The chunks a material was split into, for the detail view. */
  async readMaterialChunks(id: string): Promise<readonly PassageView[]> {
    const material = this.#service.getMaterial(id)
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
    const outcome = this.#service.retrieve(query, kbIds)
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
    const current = this.#selection.get(agentId)
    return {
      enabled: current.enabled,
      all: current.scope === 'all',
      kbIds: current.scope === 'all' ? [] : [...current.scope],
    }
  }

  /** Replace the scope for one session. */
  async setSessionScope(
    agentId: string,
    enabled: boolean,
    all: boolean,
    kbIds: readonly string[],
  ): Promise<SessionScopeView> {
    this.#selection.set(agentId, { enabled, scope: all ? 'all' : [...kbIds] })
    return this.getSessionScope(agentId)
  }
}

/** Domain error codes a caller can branch on. */
export function isKnowbaseError(error: unknown): error is KnowbaseError {
  return error instanceof KnowbaseError
}

// Publish the method list as the prototype marker the Gateway reads. See
// `./remote-methods.ts` for why this is not a decorator.
installRemoteMarkers(KnowbaseRemote)
