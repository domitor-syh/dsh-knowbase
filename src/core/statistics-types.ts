/** JSON-only statistics views shared by Host, tool and Client. */
export interface StatisticsCounters {
  readonly requests: number
  readonly hits: number
  readonly noMatch: number
  readonly notReady: number
  readonly emptyScope: number
  readonly errors: number
}

export interface StatisticsMaterial {
  readonly kbId: string
  readonly materialId: string
  readonly kbName: string
  readonly title: string
}

export interface StatisticsEntry extends StatisticsMaterial {
  readonly recallTurns: number
}

export interface StatisticsView {
  readonly enabled: boolean
  readonly available: boolean
  readonly persistenceError: boolean
  readonly retentionDays: number
  readonly since: number
  readonly runtimeDedupOnly: boolean
  readonly dropped: number
  readonly counters: StatisticsCounters
  readonly hitRate: number | null
  readonly entries: readonly StatisticsEntry[]
  readonly total: number
  readonly offset: number
  readonly nextOffset: number | null
}
