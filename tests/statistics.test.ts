import { describe, expect, it, vi } from 'vitest'
import { StatisticsRegistry, MAX_STATISTICS_QUEUE, type StatisticsRecord, type StatisticsSettings, type StatisticsStore } from '../src/core/statistics.ts'
import type { StatisticsMaterial } from '../src/core/statistics-types.ts'
import type { RetrievalOutcome } from '../src/pre-step.ts'

class Store implements StatisticsStore {
  settings: StatisticsSettings | undefined
  readonly records = new Map<string, StatisticsRecord>()
  fail = false
  failSettings = false
  loadSettings() { return this.settings }
  loadRecords() { return [...this.records.values()] }
  async saveSettings(value: StatisticsSettings) { if (this.failSettings) throw Error('secret path'); this.settings = { ...value } }
  async put(value: StatisticsRecord) { if (this.fail) throw Error('secret path'); this.records.set(value.id, structuredClone(value)) }
  async delete(id: string) { if (this.fail) throw Error('secret path'); this.records.delete(id) }
}

const material: StatisticsMaterial = { kbId: 'a', materialId: 'one.md', kbName: '库 A', title: 'one.md' }
const another = { ...material, kbId: 'b', kbName: '库 B' }
function hits(ids: readonly string[] = ['a']): RetrievalOutcome {
  return { kind: 'hits', passages: ids.map(kbId => ({ kbId, materialId: 'one.md', kbName: '库', materialTitle: 'one.md', text: 'private body', locator: '1' })) }
}

async function fixture() {
  const time = { now: new Date(2026, 9, 24, 12).getTime() }
  const store = new Store()
  const stats = new StatisticsRegistry({ now: () => time.now })
  await stats.useStore(store)
  const observe = (turn: number, outcome: RetrievalOutcome = hits(), inputKey = `private question ${turn}`, scopeIds = ['a']) => {
    stats.record({ sessionId: 'secret-session', turn, inputKey, scopeIds, outcome })
  }
  const snapshot = (ids = ['a', 'b']) => stats.snapshot([material, another], ids)
  return { stats, store, time, observe, snapshot }
}

describe('local automatic retrieval statistics', () => {
  it('defaults off, persists opt-in and counts only observed automatic requests', async () => {
    const f = await fixture()
    f.observe(1)
    expect(f.snapshot()).toMatchObject({ enabled: false, available: true, since: 0, hitRate: null, counters: { requests: 0 } })
    await f.stats.setEnabled(true)
    f.observe(2)
    await f.stats.flush()
    const restored = new StatisticsRegistry({ now: () => f.time.now })
    await restored.useStore(f.store)
    expect(restored.snapshot([material], ['a'])).toMatchObject({ enabled: true, since: f.time.now, counters: { requests: 1, hits: 1 }, hitRate: 1 })
    await f.stats.setEnabled(false)
    f.observe(3)
    expect(f.snapshot().counters.requests).toBe(1)
    await f.stats.dispose()
    expect(f.snapshot().available).toBe(false)
  })

  it('deduplicates steps/retries and repeated passages but admits new input in a turn', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1, hits(['a', 'a']))
    f.observe(1, hits(['a', 'a']))
    f.observe(1, hits(), 'steering input')
    f.observe(2)
    expect(f.snapshot().counters).toMatchObject({ requests: 3, hits: 3 })
    expect(f.snapshot().entries).toEqual([{ ...material, recallTurns: 2 }])
    await f.stats.flush()
    const persisted = JSON.stringify(f.store.loadRecords())
    for (const secret of ['private question', 'private body', 'secret-session', 'steering input']) expect(persisted).not.toContain(secret)
  })

  it('keeps failures distinct and excludes disabled, empty input and no selection', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1, { kind: 'disabled' })
    f.observe(2, { kind: 'no_selection' })
    f.observe(3, hits(), '  ')
    f.observe(4, { kind: 'hits', passages: [] })
    f.observe(5, { kind: 'not_ready' })
    f.observe(6, { kind: 'empty_scope' })
    f.observe(7, { kind: 'error', reason: 'secret path' })
    f.observe(8)
    expect(f.snapshot()).toMatchObject({ counters: { requests: 5, hits: 1, noMatch: 1, notReady: 1, emptyScope: 1, errors: 1 }, hitRate: 0.5 })
    await f.stats.flush()
    expect(JSON.stringify(f.store.loadRecords())).not.toContain('secret path')
  })

  it('does not split multi-base requests or expose counters to partially overlapping scope', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1, hits(['a', 'b']), 'both', ['a', 'b'])
    expect(f.snapshot().counters.requests).toBe(1)
    expect(f.snapshot(['a']).counters.requests).toBe(0)
    expect(f.snapshot(['a']).entries).toEqual([{ ...material, recallTurns: 1 }])
    expect(f.stats.snapshot([material, another], []).entries).toEqual([])
    expect(f.snapshot().entries).toHaveLength(2)
  })

  it('retains 30 local calendar days and clears removed materials using complete live metadata', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1)
    const date = new Date(f.time.now)
    date.setDate(date.getDate() + 29)
    f.time.now = date.getTime()
    expect(f.snapshot().counters.requests).toBe(1)
    date.setDate(date.getDate() + 1)
    f.time.now = date.getTime()
    expect(f.snapshot().counters.requests).toBe(0)
    f.observe(2)
    f.stats.reconcile([], ['a'])
    expect(f.snapshot().entries).toEqual([])
    expect(f.snapshot().counters.requests).toBe(1)
    f.stats.reconcile([], [])
    expect(f.snapshot().counters.requests).toBe(0)
    await f.stats.flush()
    expect(f.store.records.size).toBe(0)
  })

  it('reports storage loss without breaking recording, and rejects undurable setting changes', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.store.fail = true
    expect(() => f.observe(1)).not.toThrow()
    await f.stats.flush()
    expect(f.snapshot()).toMatchObject({ persistenceError: true, counters: { requests: 1 }, dropped: 1 })
    f.store.failSettings = true
    await expect(f.stats.setEnabled(false)).rejects.toThrow('统计设置未保存')
    expect(f.snapshot().enabled).toBe(true)
    await expect(f.stats.clear()).rejects.toThrow('统计设置未保存')
    expect(f.snapshot().counters.requests).toBe(1)
  })

  it('clear switches durable generation so failed deletion cannot resurrect counts on restart', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1)
    await f.stats.flush()
    f.store.fail = true // deletion fails; settings write is still available
    await f.stats.clear()
    await f.stats.flush()
    expect(f.snapshot().counters.requests).toBe(0)
    const restored = new StatisticsRegistry({ now: () => f.time.now })
    await restored.useStore(f.store)
    expect(restored.snapshot([material], ['a']).counters.requests).toBe(0)
    f.store.fail = false
    await restored.flush()
    f.observe(1) // old request key was cleared intentionally
    expect(f.snapshot().counters.requests).toBe(1)
    await f.stats.flush()
  })

  it('keeps slow I/O outside the request and bounds queued work', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const put = f.store.put.bind(f.store)
    f.store.put = async value => { await gate; await put(value) }
    for (let i = 0; i < MAX_STATISTICS_QUEUE + 10; i += 1) f.observe(i)
    expect(f.snapshot().dropped).toBeGreaterThan(0)
    expect(f.snapshot().counters.requests).toBeLessThanOrEqual(MAX_STATISTICS_QUEUE)
    release()
    await f.stats.flush()
  })

  it('cleans more expired records than the queue capacity in one startup batch', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1)
    await f.stats.flush()
    const template = [...f.store.records.values()][0]!
    f.store.records.clear()
    for (let i = 0; i < 200; i += 1) {
      const record = { ...template, id: `expired-${i}`, day: '2020-01-01' }
      f.store.records.set(record.id, record)
    }
    const restored = new StatisticsRegistry({ now: () => f.time.now })
    await restored.useStore(f.store)
    await restored.flush()
    expect(f.store.records.size).toBe(0)
    expect(restored.snapshot([material], ['a'])).toMatchObject({ dropped: 0, counters: { requests: 0 } })
  })

  it('expires idle statistics on the next local day boundary and releases its timer', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      await f.stats.setEnabled(true)
      f.observe(1)
      await f.stats.flush()
      const future = new Date(f.time.now)
      future.setDate(future.getDate() + 30)
      f.time.now = future.getTime()
      await vi.advanceTimersByTimeAsync(13 * 60 * 60 * 1000)
      await f.stats.flush()
      expect(f.store.records.size).toBe(0)
      await f.stats.suspend()
      expect(vi.getTimerCount()).toBe(0)
    } finally { await f.stats.dispose(); vi.useRealTimers() }
  })

  it('can suspend storage, await writes and reconnect without permanent disposal', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1)
    await f.stats.suspend()
    expect(f.snapshot().available).toBe(false)
    f.observe(2)
    await f.stats.useStore(f.store)
    expect(f.snapshot()).toMatchObject({ available: true, counters: { requests: 1 } })
    f.observe(3)
    expect(f.snapshot().counters.requests).toBe(2)
    await f.stats.flush()
  })

  it('pages live materials with stable tie ordering and rejects invalid bounds', async () => {
    const f = await fixture()
    await f.stats.setEnabled(true)
    f.observe(1, hits(['a', 'b']), 'both', ['a', 'b'])
    const first = f.stats.snapshot([material, another], ['a', 'b'], 0, 1)
    expect(first).toMatchObject({ total: 2, nextOffset: 1, entries: [{ kbId: 'a' }] })
    expect(f.stats.snapshot([material, another], ['a', 'b'], 1, 1)).toMatchObject({ nextOffset: null, entries: [{ kbId: 'b' }] })
    expect(() => f.stats.snapshot([], [], -1)).toThrow()
    expect(() => f.stats.snapshot([], [], 0, 51)).toThrow()
  })
})
