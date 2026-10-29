import * as React from 'react'
import type { StatisticsView } from '../core/statistics-types.ts'
import { knowbaseApi, type KnowbaseApi } from './api.ts'
import { uiLanguage } from './ui-locale.ts'
import { useCitationText } from './citation-locale.ts'

type StatisticsApi = Pick<KnowbaseApi, 'getStatistics' | 'setStatisticsEnabled' | 'clearStatistics'>
export interface StatisticsPanelState {
  readonly open: boolean
  readonly busy: boolean
  readonly failed: boolean
  readonly confirmClear: boolean
  readonly view?: StatisticsView
}

/** Event-driven requests only; no background refresh or work while collapsed. */
export function createStatisticsController(getApi: () => StatisticsApi | undefined = knowbaseApi) {
  let state: StatisticsPanelState = { open: false, busy: false, failed: false, confirmClear: false }
  let alive = true
  let sequence = 0
  const listeners = new Set<() => void>()
  const update = (patch: Partial<StatisticsPanelState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }
  const run = async (action: (api: StatisticsApi) => Promise<StatisticsView>): Promise<void> => {
    if (!alive || !state.open || state.busy) return
    const request = ++sequence
    update({ busy: true, failed: false, confirmClear: false })
    try {
      const api = getApi()
      if (api === undefined) throw new Error('unavailable')
      const view = await action(api)
      if (alive && request === sequence) update({ view })
    } catch {
      if (alive && request === sequence) update({ failed: true })
    } finally {
      if (alive && request === sequence) update({ busy: false })
    }
  }
  const refresh = (offset = state.view?.offset ?? 0) => run(api => api.getStatistics(offset, 50))
  const mutable = () => alive && state.open && !state.busy && state.view?.available === true
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    activate() { alive = true; return () => { alive = false; sequence++; state = { ...state, busy: false } } },
    setOpen(open: boolean) {
      if (!alive || state.open === open) return
      update({ open, confirmClear: false })
      if (open) void refresh(0)
    },
    refresh,
    setEnabled(enabled: boolean) {
      if (!mutable()) return Promise.resolve()
      return run(api => api.setStatisticsEnabled(enabled))
    },
    requestClear() { if (mutable()) update({ confirmClear: true }) },
    cancelClear() { update({ confirmClear: false }) },
    clear() {
      if (!mutable() || !state.confirmClear) return Promise.resolve()
      return run(api => api.clearStatistics())
    },
  }
}

const secondary: React.CSSProperties = { color: 'var(--dsw-alias-label-secondary)', margin: '8px 0' }
const control: React.CSSProperties = {
  color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '5px 10px',
  font: 'inherit',
}

/** Loaded view is separate so empty and degraded storage states stay inspectable. */
export function StatisticsContent({ state, controller }: {
  state: StatisticsPanelState
  controller: ReturnType<typeof createStatisticsController>
}): React.ReactElement {
  const t = useCitationText()
  const view = state.view
  const disabled = state.busy || view?.available !== true
  const counts = view === undefined ? [] : [
    [t('statsRequests'), view.counters.requests], [t('statsHits'), view.counters.hits],
    [t('statsNoMatch'), view.counters.noMatch], [t('statsNotReady'), view.counters.notReady],
    [t('statsEmptyScope'), view.counters.emptyScope], [t('statsErrors'), view.counters.errors],
    [t('statsHitRate'), view.hitRate === null ? t('statsNoRate') : `${(view.hitRate * 100).toFixed(1)}%`],
  ] as const
  return <div style={{ paddingTop: 12 }} aria-busy={state.busy}>
    <p style={secondary}>{t('statsHelp')}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" role="switch" aria-checked={view?.enabled ?? false} checked={view?.enabled ?? false} disabled={disabled}
          onChange={event => { void controller.setEnabled(event.target.checked) }} />
        {t('statsEnable')}
      </label>
      <button type="button" style={control} disabled={state.busy} onClick={() => { void controller.refresh() }}>{t('statsRefresh')}</button>
      <button type="button" style={control} disabled={disabled} onClick={controller.requestClear}>{t('statsClear')}</button>
    </div>
    {state.confirmClear ? <div role="group" aria-label={t('statsConfirmHelp')} style={{ marginTop: 12 }}>
      <p>{t('statsConfirmHelp')}</p>
      <button type="button" style={control} disabled={disabled} onClick={() => { void controller.clear() }}>{t('statsConfirm')}</button>{' '}
      <button type="button" style={control} disabled={state.busy} onClick={controller.cancelClear}>{t('statsCancel')}</button>
    </div> : null}
    {state.busy ? <p role="status">{t('statsLoading')}</p> : null}
    {state.failed ? <p role="alert">{t('statsFailed')}</p> : null}
    {view === undefined ? null : <>
      {!view.available ? <p role="status">{t('statsUnavailable')}</p> : null}
      {view.persistenceError ? <p role="status">{t('statsPersistence')}</p> : null}
      {view.dropped > 0 ? <p role="status">{t('statsDropped')}: {view.dropped}</p> : null}
      {!view.enabled ? <p style={secondary}>{t('statsOff')}</p> : null}
      <p style={secondary}>{t('statsSince')}: {view.since === 0 ? t('statsNever') : new Date(view.since).toLocaleString(uiLanguage() === 'en' ? 'en-US' : 'zh-CN')} · {t('statsRetention')}: {view.retentionDays}</p>
      <dl style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', margin: '12px 0' }}>
        {counts.map(([label, value]) => <div key={label} style={{ display: 'flex', gap: 6 }}>
          <dt style={{ color: 'var(--dsw-alias-label-secondary)' }}>{label}</dt><dd style={{ margin: 0 }}>{value}</dd>
        </div>)}
      </dl>
      <strong>{t('statsMaterials')}</strong>
      {view.entries.length === 0 ? <p style={secondary}>{t('statsEmpty')}</p> : <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
        <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead><tr><th>{t('base')}</th><th>{t('file')}</th><th>{t('statsRecallTurns')}</th></tr></thead>
          <tbody>{view.entries.map(entry => <tr key={JSON.stringify([entry.kbId, entry.materialId])}>
            <td style={{ padding: '6px 8px 6px 0', overflowWrap: 'anywhere' }}>{entry.kbName}</td>
            <td style={{ padding: '6px 8px 6px 0', overflowWrap: 'anywhere' }}>{entry.title}</td>
            <td>{entry.recallTurns}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <span style={secondary}>{t('statsTotal')}: {view.total}</span>
        <button type="button" style={control} disabled={disabled || view.offset === 0} onClick={() => { void controller.refresh(Math.max(0, view.offset - 50)) }}>{t('statsPrevious')}</button>
        <button type="button" style={control} disabled={disabled || view.nextOffset === null} onClick={() => { if (view.nextOffset !== null) void controller.refresh(view.nextOffset) }}>{t('statsNext')}</button>
      </div>
      {view.runtimeDedupOnly ? <p style={secondary}>{t('statsDedup')}</p> : null}
    </>}
  </div>
}

export function StatisticsPanel(): React.ReactElement {
  const t = useCitationText()
  const [controller] = React.useState(() => createStatisticsController())
  const state = React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  React.useEffect(() => controller.activate(), [controller])
  return <details data-kb-statistics open={state.open}
    onToggle={event => controller.setOpen(event.currentTarget.open)}
    style={{ flex: 'none', padding: 16, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 12 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('statsTitle')}</summary>
    {state.open ? <StatisticsContent state={state} controller={controller} /> : null}
  </details>
}
