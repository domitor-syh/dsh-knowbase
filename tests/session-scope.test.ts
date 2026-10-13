/**
 * Session selection tests.
 *
 * These cover the properties the composer toggle and the pre-step seam both
 * rest on: an untouched session stays off, a choice survives a restart, a
 * failed durable write leaves memory and disk agreeing, and an explicit scope
 * is never silently widened.
 */

import { describe, expect, it } from 'vitest'
import {
  resolveScope,
  SessionSelectionRegistry,
  type SessionScopeRecord,
  type SessionScopeStore,
} from '../src/core/session-scope.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'

/** The port's reference implementation for tests. */
class MemoryScopeStore implements SessionScopeStore {
  readonly records = new Map<string, SessionScopeRecord>()
  /** Make the next save reject, to model a failing durable write. */
  failNext = false

  loadAll(): readonly SessionScopeRecord[] {
    return [...this.records.values()]
  }

  async save(record: SessionScopeRecord): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('disk on fire')
    }
    this.records.set(record.sessionId, record)
  }
}

async function freshService(): Promise<KnowbaseService> {
  const service = new KnowbaseService(new MemoryStore(), { now: () => 1_700_000_000_000 })
  await service.initialize()
  return service
}

describe('SessionSelectionRegistry', () => {
  it('defaults every unknown session to disabled', () => {
    const registry = new SessionSelectionRegistry()
    expect(registry.get('s1')).toEqual({ enabled: false, scope: 'all' })
  })

  it('remembers a selection in memory when no store is attached', async () => {
    const registry = new SessionSelectionRegistry()
    await registry.set('s1', { enabled: true, scope: ['kb_a'] })
    expect(registry.get('s1')).toEqual({ enabled: true, scope: ['kb_a'] })
    expect(registry.get('s2')).toEqual({ enabled: false, scope: 'all' })
  })

  it('persists an explicit selection in record shape', async () => {
    const store = new MemoryScopeStore()
    const registry = new SessionSelectionRegistry({ now: () => 42 })
    await registry.useStore(store)
    await registry.set('s1', { enabled: true, scope: ['kb_a', 'kb_b'] })
    expect(store.records.get('s1')).toEqual({
      sessionId: 's1',
      enabled: true,
      all: false,
      kbIds: ['kb_a', 'kb_b'],
      updatedAt: 42,
    })
  })

  it('persists an all-scope with an empty id list', async () => {
    const store = new MemoryScopeStore()
    const registry = new SessionSelectionRegistry()
    await registry.useStore(store)
    await registry.set('s1', { enabled: true, scope: 'all' })
    expect(store.records.get('s1')).toMatchObject({ all: true, kbIds: [] })
  })

  it('keeps the previous scope when the switch is turned off', async () => {
    const store = new MemoryScopeStore()
    const registry = new SessionSelectionRegistry()
    await registry.useStore(store)
    await registry.set('s1', { enabled: true, scope: ['kb_a'] })
    await registry.set('s1', { enabled: false, scope: ['kb_a'] })
    expect(registry.get('s1')).toEqual({ enabled: false, scope: ['kb_a'] })
  })

  it('adopts persisted selections when the store opens', async () => {
    const store = new MemoryScopeStore()
    store.records.set('s1', {
      sessionId: 's1',
      enabled: true,
      all: false,
      kbIds: ['kb_a'],
      updatedAt: 1,
    })
    store.records.set('s2', {
      sessionId: 's2',
      enabled: true,
      all: true,
      kbIds: [],
      updatedAt: 2,
    })
    const registry = new SessionSelectionRegistry()
    await registry.useStore(store)
    expect(registry.get('s1')).toEqual({ enabled: true, scope: ['kb_a'] })
    expect(registry.get('s2')).toEqual({ enabled: true, scope: 'all' })
  })

  it('leaves memory unchanged when the durable write fails', async () => {
    const store = new MemoryScopeStore()
    const registry = new SessionSelectionRegistry()
    await registry.useStore(store)
    await registry.set('s1', { enabled: true, scope: ['kb_a'] })
    store.failNext = true
    await expect(registry.set('s1', { enabled: false, scope: 'all' })).rejects.toThrow(
      'disk on fire',
    )
    expect(registry.get('s1')).toEqual({ enabled: true, scope: ['kb_a'] })
  })

  it('round-trips through a fresh registry', async () => {
    const store = new MemoryScopeStore()
    const first = new SessionSelectionRegistry()
    await first.useStore(store)
    await first.set('s1', { enabled: true, scope: ['kb_a'] })
    const second = new SessionSelectionRegistry()
    await second.useStore(store)
    expect(second.get('s1')).toEqual({ enabled: true, scope: ['kb_a'] })
  })
})

describe('resolveScope', () => {
  it('reports the session as switched off', async () => {
    const service = await freshService()
    expect(resolveScope({ enabled: false, scope: 'all' }, service)).toEqual({ kind: 'disabled' })
  })

  it('expands all to every knowledge base id', async () => {
    const service = await freshService()
    const first = await service.createKnowledgeBase('甲')
    const second = await service.createKnowledgeBase('乙')
    const scope = resolveScope({ enabled: true, scope: 'all' }, service)
    expect(scope.kind).toBe('bases')
    expect(scope.kind === 'bases' ? scope.ids.slice().sort() : []).toEqual(
      [first.id, second.id].sort(),
    )
  })

  it('passes an explicit selection through unchanged', async () => {
    const service = await freshService()
    expect(resolveScope({ enabled: true, scope: ['kb_x'] }, service)).toEqual({
      kind: 'bases',
      ids: ['kb_x'],
    })
  })

  it('keeps an explicit multi-base selection whole', async () => {
    const service = await freshService()
    expect(resolveScope({ enabled: true, scope: ['kb_x', 'kb_y'] }, service)).toEqual({
      kind: 'bases',
      ids: ['kb_x', 'kb_y'],
    })
  })

  // The three empty answers below are the reason this returns a discriminated
  // result instead of `string[] | null`: they all have no ids and each needs a
  // different sentence, so collapsing any two of them would make the plugin
  // explain a deletion that never happened.
  it('separates "nothing ticked" from "nothing exists"', async () => {
    const populated = await freshService()
    await populated.createKnowledgeBase('甲')
    expect(resolveScope({ enabled: true, scope: [] }, populated)).toEqual({
      kind: 'nothing-selected',
    })

    const empty = await freshService()
    expect(resolveScope({ enabled: true, scope: 'all' }, empty)).toEqual({ kind: 'no-bases' })
    expect(resolveScope({ enabled: true, scope: [] }, empty)).toEqual({
      kind: 'nothing-selected',
    })
  })

  it('does not pre-filter ids whose base was deleted', async () => {
    const service = await freshService()
    const base = await service.createKnowledgeBase('甲')
    await service.deleteKnowledgeBase(base.id)
    // The id survives resolution so that `retrieve()` is the one place that
    // reports `empty_scope` — a selection going stale is a different sentence
    // from a selection never being made.
    expect(resolveScope({ enabled: true, scope: [base.id] }, service)).toEqual({
      kind: 'bases',
      ids: [base.id],
    })
  })
})