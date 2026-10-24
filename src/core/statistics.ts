import { createHash, randomUUID } from 'node:crypto'
import type { RetrievalOutcome } from '../pre-step.ts'
import type { StatisticsCounters, StatisticsMaterial, StatisticsView } from './statistics-types.ts'

export const STATISTICS_RETENTION_DAYS = 30
export const MAX_STATISTICS_RECORDS = 10000
export const MAX_STATISTICS_QUEUE = 128
const MAX_DEDUP_KEYS = 4096

export interface StatisticsSettings {
  readonly enabled: boolean
  readonly since: number
  readonly generation: string
}

/** Daily aggregates contain no query, session, passage text or display path. */
export interface StatisticsRecord {
  readonly id: string
  readonly generation: string
  readonly day: string
  readonly scopeIds: readonly string[]
  readonly kbId: string
  readonly materialId: string
  readonly counters: StatisticsCounters
  readonly recallTurns: number
}

export interface StatisticsStore {
  loadSettings(): StatisticsSettings | undefined
  loadRecords(): readonly StatisticsRecord[]
  saveSettings(settings: StatisticsSettings): Promise<void>
  put(record: StatisticsRecord): Promise<void>
  delete(id: string): Promise<void>
}

export interface StatisticsObservation {
  readonly sessionId: string
  readonly turn: number
  readonly inputKey: string
  readonly scopeIds: readonly string[]
  readonly outcome: RetrievalOutcome
}

function emptyCounters(): StatisticsCounters {
  return { requests: 0, hits: 0, noMatch: 0, notReady: 0, emptyScope: 0, errors: 0 }
}

function addCounters(a: StatisticsCounters, b: StatisticsCounters): StatisticsCounters {
  return {
    requests: a.requests + b.requests, hits: a.hits + b.hits, noMatch: a.noMatch + b.noMatch,
    notReady: a.notReady + b.notReady, emptyScope: a.emptyScope + b.emptyScope, errors: a.errors + b.errors,
  }
}

function dayOf(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function cutoffDay(time: number): string {
  const date = new Date(time)
  date.setDate(date.getDate() - STATISTICS_RETENTION_DAYS + 1)
  return dayOf(date.getTime())
}

/** Ephemeral dedup keys are bounded and never persisted. Eviction permits recounting. */
function remember(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false
  keys.add(key)
  if (keys.size > MAX_DEDUP_KEYS) keys.delete(keys.values().next().value!)
  return true
}

/** Best-effort local aggregates; recording never awaits storage or throws to retrieval. */
export class StatisticsRegistry {
  readonly #now: () => number
  readonly #records = new Map<string, StatisticsRecord>()
  readonly #requests = new Set<string>()
  readonly #materials = new Set<string>()
  #settings: StatisticsSettings = { enabled: false, since: 0, generation: 'initial' }
  #store: StatisticsStore | undefined
  #persistenceError = false
  #dropped = 0
  #disposed = false
  #changing = false
  #control: Promise<void> = Promise.resolve()
  #jobs: Array<() => Promise<void>> = []
  readonly #deletions = new Set<string>()
  #drain: Promise<void> | undefined
  #maintenance: ReturnType<typeof setTimeout> | undefined

  constructor(options: { now?: () => number } = {}) { this.#now = options.now ?? Date.now }

  async useStore(store: StatisticsStore): Promise<void> {
    if (this.#disposed) return
    await this.flush()
    this.#records.clear()
    const settings = store.loadSettings()
    const records = store.loadRecords()
    this.#store = store
    this.#settings = settings ?? { enabled: false, since: 0, generation: 'initial' }
    this.#persistenceError = false
    const cutoff = cutoffDay(this.#now())
    const obsolete: string[] = []
    for (const record of records) {
      if (record.generation !== this.#settings.generation || record.day < cutoff || this.#records.size >= MAX_STATISTICS_RECORDS) {
        obsolete.push(record.id)
      } else this.#records.set(record.id, record)
    }
    this.#deleteLater(obsolete)
    this.#scheduleMaintenance()
  }

  record(observation: StatisticsObservation): void {
    if (this.#disposed || this.#changing || !this.#settings.enabled || this.#store === undefined) return
    try {
      const { outcome } = observation
      if (outcome.kind === 'disabled' || outcome.kind === 'no_selection' || observation.inputKey.trim() === '') return
      const scopeIds = [...new Set(observation.scopeIds)].sort()
      // Without a live scope there is no attributable request. An empty selection
      // must not become a global bucket visible to unrelated sessions.
      if (scopeIds.length === 0) return
      if (this.#jobs.length >= MAX_STATISTICS_QUEUE) { this.#dropped += 1; return }
      const requestKey = JSON.stringify([observation.sessionId, observation.turn,
        createHash('sha256').update(observation.inputKey).digest('hex')])
      if (!remember(this.#requests, requestKey)) return
      const now = this.#now()
      this.#prune()
      const day = dayOf(now)
      const kind = outcome.kind === 'hits' && outcome.passages.length === 0 ? 'no_match' : outcome.kind
      const counters: StatisticsCounters = {
        requests: 1, hits: kind === 'hits' ? 1 : 0, noMatch: kind === 'no_match' ? 1 : 0,
        notReady: kind === 'not_ready' ? 1 : 0, emptyScope: kind === 'empty_scope' ? 1 : 0,
        errors: kind === 'error' ? 1 : 0,
      }
      const id = JSON.stringify([this.#settings.generation, day, 'request', scopeIds])
      const updates: StatisticsRecord[] = []
      const prior = this.#records.get(id)
      if (prior === undefined && this.#records.size >= MAX_STATISTICS_RECORDS) { this.#dropped += 1; return }
      const request: StatisticsRecord = {
        id, generation: this.#settings.generation, day, scopeIds, kbId: '', materialId: '',
        counters: addCounters(prior?.counters ?? emptyCounters(), counters), recallTurns: 0,
      }
      this.#records.set(id, request)
      updates.push(request)
      if (outcome.kind === 'hits') {
        for (const passage of outcome.passages) {
          const { kbId, materialId } = passage
          if (kbId === undefined || materialId === undefined || !scopeIds.includes(kbId)) continue
          const key = JSON.stringify([observation.sessionId, observation.turn, kbId, materialId])
          if (!remember(this.#materials, key)) continue
          const materialKey = JSON.stringify([this.#settings.generation, day, 'material', kbId, materialId])
          const previous = this.#records.get(materialKey)
          if (previous === undefined && this.#records.size >= MAX_STATISTICS_RECORDS) { this.#dropped += 1; continue }
          const record: StatisticsRecord = {
            id: materialKey, generation: this.#settings.generation, day, scopeIds: [], kbId, materialId,
            counters: emptyCounters(), recallTurns: (previous?.recallTurns ?? 0) + 1,
          }
          this.#records.set(materialKey, record)
          updates.push(record)
        }
      }
      const store = this.#store
      this.#enqueue(async () => { for (const update of updates) if (this.#records.has(update.id)) await store.put(update) })
    } catch { this.#dropped += 1; this.#persistenceError = true }
  }

  snapshot(materials: readonly StatisticsMaterial[], allowedKbIds: readonly string[], offset = 0, limit = 50): StatisticsView {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('统计分页参数不合法。')
    }
    this.#prune()
    const allowed = new Set(allowedKbIds)
    const live = new Map(materials.filter(material => allowed.has(material.kbId))
      .map(material => [JSON.stringify([material.kbId, material.materialId]), material]))
    let counters = emptyCounters()
    const counts = new Map<string, number>()
    for (const record of this.#records.values()) {
      if (record.kbId === '') {
        // A multi-base request cannot be partially attributed to a smaller scope.
        if (record.scopeIds.length > 0 && record.scopeIds.every(id => allowed.has(id))) counters = addCounters(counters, record.counters)
      } else {
        const key = JSON.stringify([record.kbId, record.materialId])
        if (live.has(key)) counts.set(key, (counts.get(key) ?? 0) + record.recallTurns)
      }
    }
    const entries = [...counts.entries()].map(([key, recallTurns]) => ({ ...live.get(key)!, recallTurns }))
      .sort((a, b) => b.recallTurns - a.recallTurns || a.kbId.localeCompare(b.kbId, 'en') || a.materialId.localeCompare(b.materialId, 'en'))
    const end = Math.min(offset + limit, entries.length)
    const valid = counters.hits + counters.noMatch
    return {
      enabled: this.#settings.enabled, available: this.#store !== undefined && !this.#disposed,
      persistenceError: this.#persistenceError, retentionDays: STATISTICS_RETENTION_DAYS,
      since: this.#settings.since, runtimeDedupOnly: true, dropped: this.#dropped,
      counters, hitRate: valid === 0 ? null : counters.hits / valid,
      entries: entries.slice(offset, end), total: entries.length, offset, nextOffset: end < entries.length ? end : null,
    }
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('统计开关参数不合法。'))
    return this.#change(async () => {
      if (enabled === this.#settings.enabled) return
      const next = { ...this.#settings, enabled, since: this.#settings.since || (enabled ? this.#now() : 0) }
      await this.#store!.saveSettings(next)
      this.#settings = next
    })
  }

  clear(): Promise<void> {
    return this.#change(async () => {
      const next = { ...this.#settings, since: this.#settings.enabled ? this.#now() : 0, generation: randomUUID() }
      // One durable generation switch is the logical clear. Old buckets cannot
      // reappear after restart even if best-effort physical cleanup fails.
      await this.#store!.saveSettings(next)
      this.#settings = next
      const ids = [...this.#records.keys()]
      this.#records.clear()
      this.#requests.clear()
      this.#materials.clear()
      this.#dropped = 0
      this.#persistenceError = false
      this.#deleteLater(ids)
    })
  }

  /** Called only with a complete live material list, never an Agent-filtered view. */
  reconcile(materials: readonly StatisticsMaterial[], baseIds: readonly string[]): void {
    const live = new Set(materials.map(material => JSON.stringify([material.kbId, material.materialId])))
    const bases = new Set(baseIds)
    this.#prune(record => record.kbId === '' ? record.scopeIds.some(id => !bases.has(id)) : !live.has(JSON.stringify([record.kbId, record.materialId])))
  }

  async flush(): Promise<void> { while (this.#drain !== undefined) await this.#drain }

  async suspend(): Promise<void> {
    if (this.#maintenance !== undefined) clearTimeout(this.#maintenance)
    this.#maintenance = undefined
    this.#changing = true
    await this.#control
    await this.flush()
    this.#store = undefined
    this.#changing = false
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    await this.suspend()
    this.#requests.clear()
    this.#materials.clear()
  }

  #change(action: () => Promise<void>): Promise<void> {
    const operation = this.#control.then(async () => {
      if (this.#disposed || this.#store === undefined) throw new Error('统计存储尚未就绪。')
      this.#changing = true
      try { await this.flush(); await action() }
      catch { this.#persistenceError = true; throw new Error('统计设置未保存，请重试。') }
      finally { this.#changing = false }
    })
    this.#control = operation.catch(() => {})
    return operation
  }

  #scheduleMaintenance(): void {
    if (this.#maintenance !== undefined) clearTimeout(this.#maintenance)
    if (this.#disposed || this.#store === undefined) return
    const now = this.#now()
    const next = new Date(now)
    next.setHours(24, 0, 0, 0)
    this.#maintenance = setTimeout(() => {
      this.#maintenance = undefined
      this.#prune()
      this.#scheduleMaintenance()
    }, Math.max(1000, next.getTime() - now))
    this.#maintenance.unref?.()
  }

  #prune(remove?: (record: StatisticsRecord) => boolean): void {
    const cutoff = cutoffDay(this.#now())
    const ids: string[] = []
    for (const [id, record] of this.#records) {
      if (record.day < cutoff || remove?.(record)) { this.#records.delete(id); ids.push(id) }
    }
    this.#deleteLater(ids)
  }

  #deleteLater(ids: readonly string[]): void {
    if (this.#store === undefined || ids.length === 0) return
    for (const id of ids) this.#deletions.add(id)
    this.#startDrain()
  }

  #enqueue(job: () => Promise<void>): void {
    if (this.#jobs.length >= MAX_STATISTICS_QUEUE) { this.#dropped += 1; return }
    this.#jobs.push(job)
    this.#startDrain()
  }

  #startDrain(): void {
    if (this.#drain !== undefined || (this.#jobs.length === 0 && this.#deletions.size === 0)) return
    // Defer I/O until the caller has returned its retrieval result.
    this.#drain = Promise.resolve().then(async () => {
      while (this.#jobs.length > 0 || this.#deletions.size > 0) {
        const id = this.#deletions.values().next().value
        const task = id === undefined ? this.#jobs.shift()! : async () => {
          this.#deletions.delete(id)
          if (!this.#records.has(id)) await this.#store?.delete(id)
        }
        try { await task() } catch { this.#persistenceError = true; this.#dropped += 1 }
      }
    }).finally(() => {
      this.#drain = undefined
      this.#startDrain()
    })
  }
}
