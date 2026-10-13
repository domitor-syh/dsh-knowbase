/**
 * Per-session retrieval selection.
 *
 * A session's knowledge-base switch is its own state: two conversations in the
 * same install may search different bases, and the plan requires the choice to
 * survive a host restart. The registry answers reads synchronously — the
 * pre-step seam runs on every turn and must not await anything — and, once
 * storage is open, mirrors every write through a {@link SessionScopeStore} and
 * adopts what the store already holds.
 *
 * Host-free by design: the storageDomain adapter lives in `../store.ts`, so the
 * whole module is unit-testable. Same split as `./service.ts`.
 *
 * @module @domitor-syh/dsh-knowbase/core/session-scope
 */

import type { KnowbaseService } from './service.ts'

/** Per-session retrieval selection. */
export interface SessionSelection {
  readonly enabled: boolean
  /** `'all'` or an explicit set of knowledge base ids. */
  readonly scope: 'all' | readonly string[]
}

/** One session selection in its persisted shape. */
export interface SessionScopeRecord {
  readonly sessionId: string
  readonly enabled: boolean
  /** True when every knowledge base is in scope. */
  readonly all: boolean
  /** Ignored when {@link SessionScopeRecord.all} is true. */
  readonly kbIds: readonly string[]
  readonly updatedAt: number
}

/** Persistence port for session selections. */
export interface SessionScopeStore {
  loadAll(): readonly SessionScopeRecord[]
  save(record: SessionScopeRecord): Promise<void>
}

/**
 * In-memory session selections with write-through persistence.
 *
 * Selections default to disabled, so a session the user never touched
 * retrieves nothing — the plan's "new sessions start off" rule is the default
 * rather than an initialization pass that could be missed.
 */
export class SessionSelectionRegistry {
  readonly #selections = new Map<string, SessionSelection>()
  readonly #now: () => number
  #store: SessionScopeStore | undefined

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Start persisting through `store` and adopt the selections it holds.
   *
   * Separate from the constructor because the registry must exist before
   * storage opens: the pre-step seam and the command surface are wired at
   * `apply()` time and both already hold this instance. Until this is called
   * the registry is memory-only, which is exactly the honest state before the
   * durable backend can be reached.
   */
  async useStore(store: SessionScopeStore): Promise<void> {
    this.#store = store
    for (const record of store.loadAll()) {
      this.#selections.set(record.sessionId, {
        enabled: record.enabled,
        scope: record.all ? 'all' : [...record.kbIds],
      })
    }
  }

  /** The selection for a session, defaulting to disabled. */
  get(agentId: string): SessionSelection {
    return this.#selections.get(agentId) ?? { enabled: false, scope: 'all' }
  }

  /**
   * Replace a session's selection.
   *
   * The durable write happens first: when it fails, memory and disk still
   * agree on the previous value, instead of the session diverging from what
   * the next restart will load. A failure is surfaced to the caller rather
   * than logged, because the caller is a UI action that can say so.
   */
  async set(agentId: string, selection: SessionSelection): Promise<void> {
    if (this.#store !== undefined) {
      await this.#store.save({
        sessionId: agentId,
        enabled: selection.enabled,
        all: selection.scope === 'all',
        kbIds: selection.scope === 'all' ? [] : [...selection.scope],
        updatedAt: this.#now(),
      })
    }
    this.#selections.set(agentId, selection)
  }
}

/**
 * What a session selection means once resolved against the bases that exist.
 *
 * A discriminated result rather than `string[] | null`, because "the user
 * ticked nothing", "there are no bases to search" and "the bases they ticked
 * are gone" all reduce to an empty id list but need three different sentences.
 * Deciding that here — in the host-free module — is what keeps the pre-step
 * seam and the `/kb search` command from answering the same question
 * differently, and it is the reason the ids are not pre-filtered for existence:
 * filtering would erase the third case before anyone could name it.
 */
export type ResolvedScope =
  /** The session has the knowledge base switched off. */
  | { readonly kind: 'disabled' }
  /**
   * Switched on, but no base is ticked.
   *
   * A decision the user made, not a failure: multi-select made "nothing" a
   * reachable state, and reporting it as an invalid scope would blame a
   * deletion that never happened.
   */
  | { readonly kind: 'nothing-selected' }
  /** Scope is "all" and the install holds no bases at all. */
  | { readonly kind: 'no-bases' }
  /** The ids to search. The service drops any that no longer exist. */
  | { readonly kind: 'bases'; readonly ids: readonly string[] }

/**
 * Resolve a session selection into the concrete ids to search.
 *
 * @returns what the selection means — never a bare array, see
 *   {@link ResolvedScope} for why the distinction has to survive.
 */
export function resolveScope(
  selection: SessionSelection,
  service: KnowbaseService,
): ResolvedScope {
  if (!selection.enabled) return { kind: 'disabled' }

  if (selection.scope !== 'all') {
    if (selection.scope.length === 0) return { kind: 'nothing-selected' }
    return { kind: 'bases', ids: [...selection.scope] }
  }

  const ids = service.listKnowledgeBases().map(knowledgeBase => knowledgeBase.id)
  // "All" over an install that holds nothing is not an invalid selection — the
  // answer is "add some material", which is a different sentence.
  if (ids.length === 0) return { kind: 'no-bases' }
  return { kind: 'bases', ids }
}