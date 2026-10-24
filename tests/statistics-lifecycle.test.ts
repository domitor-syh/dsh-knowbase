import { describe, expect, it, vi } from 'vitest'
import { StatisticsRegistry, type StatisticsStore } from '../src/core/statistics.ts'
import { mountStatisticsStore } from '../src/statistics-lifecycle.ts'

function store(): StatisticsStore {
  return {
    loadSettings: () => undefined, loadRecords: () => [],
    saveSettings: async () => {}, put: async () => {}, delete: async () => {},
  }
}

describe('optional statistics storage lifecycle', () => {
  it('mounts without waiting for open and closes a late handle exactly once', async () => {
    const stats = new StatisticsRegistry()
    let release!: (value: { store: StatisticsStore; close(): Promise<void> }) => void
    const opening = new Promise<{ store: StatisticsStore; close(): Promise<void> }>(resolve => { release = resolve })
    const mounted = mountStatisticsStore(stats, () => opening)
    const closed = vi.fn(async () => {})
    // Mount returned immediately; other plugin initialization is free to run.
    expect(stats.snapshot([], []).available).toBe(false)
    const cleanup = mounted.close()
    release({ store: store(), close: closed })
    await cleanup
    await mounted.close()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(stats.snapshot([], []).available).toBe(false)
  })

  it('awaits resource release and allows the same registry to remount', async () => {
    const stats = new StatisticsRegistry()
    const first = mountStatisticsStore(stats, async () => ({ store: store(), close: async () => {} }))
    await first.ready
    expect(stats.snapshot([], []).available).toBe(true)
    await first.close()
    expect(stats.snapshot([], []).available).toBe(false)
    const second = mountStatisticsStore(stats, async () => ({ store: store(), close: async () => {} }))
    await second.ready
    expect(stats.snapshot([], []).available).toBe(true)
    await second.close()
    await stats.dispose()
  })

  it('contains optional open failures', async () => {
    const stats = new StatisticsRegistry()
    const unavailable = vi.fn()
    const mounted = mountStatisticsStore(stats, async () => { throw Error('disk unavailable') }, unavailable)
    await mounted.ready
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(stats.snapshot([], []).available).toBe(false)
    await mounted.close()
  })
})
