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
 * Resolve a session selection into the concrete ids to search.
 *
 * @returns the ids, or `null` when the session has the feature switched off —
 *   which is not the same as an empty scope and must not be treated as one.
 */
export function resolveScope(
  selection: SessionSelection,
  service: KnowbaseService,
): string[] | null {
  if (!selection.enabled) return null
  if (selection.scope === 'all') {
    return service.listKnowledgeBases().map(knowledgeBase => knowledgeBase.id)
  }
  return [...selection.scope]
}