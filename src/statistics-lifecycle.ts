import type { StatisticsRegistry } from './core/statistics.ts'
import type { OpenedStatisticsStore } from './store.ts'

/** Optional storage mount: callers never await ready on the knowledge startup path. */
export function mountStatisticsStore(
  statistics: StatisticsRegistry,
  open: () => Promise<OpenedStatisticsStore>,
  unavailable: () => void = () => {},
): { readonly ready: Promise<void>; close(): Promise<void> } {
  let active = true
  let opened: OpenedStatisticsStore | undefined
  let closing: Promise<void> | undefined
  const ready = Promise.resolve().then(open).then(async handle => {
    opened = handle
    if (active) await statistics.useStore(handle.store)
  }).catch(async () => {
    await statistics.suspend()
    try { await opened?.close() } catch { /* Optional storage failure stays local. */ }
    opened = undefined
    unavailable()
  })
  return {
    ready,
    close() {
      if (closing !== undefined) return closing
      active = false
      closing = ready.then(async () => {
        await statistics.suspend()
        await opened?.close()
        opened = undefined
      })
      return closing
    },
  }
}
