import * as React from 'react'
import { outcomeForAnswer, type AnswerOutcome, type SourcePassage } from './citation-scan.ts'
import { openMaterialInReader } from './reader.ts'
import { closeSources, showSources, sourceDialogActive, useSourceDialog } from './citation-dialog.ts'
import { useCitationText } from './citation-locale.ts'
import { citationCopyText, citationLabel, copyCitation, sourceGroups, validCitationId, type CopyResult } from './citation-view.ts'

const COLORS = {
  border: 'var(--dsw-alias-border-l1)', muted: 'var(--dsw-alias-label-secondary)',
  text: 'var(--dsw-alias-label-primary)', accent: 'var(--dsw-alias-brand-primary)',
  danger: 'var(--dsw-alias-state-error-primary)', surface: 'var(--dsw-alias-bg-overlay)',
  subtle: 'var(--dsw-alias-bg-layer-2)', warn: 'var(--dsw-alias-state-warn-primary)',
} as const
const control: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '4px 8px',
  background: COLORS.surface, color: COLORS.text, fontSize: 12, cursor: 'pointer',
}
interface Props { readonly messageId?: unknown; readonly useSession?: unknown; readonly useChat?: unknown }

function PassageRow({ passage, index, onOpened }: {
  passage: SourcePassage; index: number; onOpened: () => void
}): React.ReactElement {
  const t = useCitationText()
  const [failure, setFailure] = React.useState(false)
  const [copy, setCopy] = React.useState<CopyResult | 'busy' | undefined>()
  const alive = React.useRef(true)
  const busy = React.useRef(false)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const text = citationCopyText(passage, index, {
    base: t('base'), file: t('file'), location: t('location'), id: t('id'), legacy: t('legacy'), hidden: t('hidden'),
  })
  const label = (value: string) => citationLabel(value, t('hidden'))
  const onCopy = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true; setCopy('busy')
    let result: CopyResult
    try { result = await copyCitation(text, globalThis.navigator?.clipboard) }
    catch { result = 'failed' }
    busy.current = false
    if (alive.current) setCopy(result)
  }
  const onOpen = (): void => {
    if (passage.kbId === undefined || passage.materialId === undefined) return
    try {
      const problem = openMaterialInReader({
        kbId: passage.kbId, materialId: passage.materialId,
        ...(passage.ordinal === undefined ? {} : { chunk: passage.ordinal }), title: passage.materialTitle,
      })
      if (problem === undefined) onOpened()
      else setFailure(true)
    } catch { setFailure(true) }
  }
  return (
    <div data-kb-passage style={{ border: `1px solid ${COLORS.border}`, borderRadius: 6, background: COLORS.subtle, padding: 10, marginTop: 8, overflowWrap: 'anywhere' }}>
      <div data-kb-passage-header style={{ fontSize: 12, color: COLORS.accent }}>
        [{index + 1}] {label(passage.kbName)} / {label(passage.materialTitle)} · {label(passage.locator)}
      </div>
      <div style={{ fontSize: 11, color: COLORS.muted, margin: '4px 0', overflowWrap: 'anywhere' }}>
        {validCitationId(passage.citationId) ? `${t('id')}: ${passage.citationId}` : t('legacy')}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        <button type="button" style={control} onClick={() => { void onCopy() }} disabled={copy === 'busy'}>{copy === 'busy' ? t('copying') : t('copy')}</button>
        {passage.kbId !== undefined && passage.materialId !== undefined ? (
          <button type="button" data-kb-open-in-reader title={t('openHint')} style={control} onClick={onOpen}>{t('open')}</button>
        ) : null}
      </div>
      <div role="status" aria-live="polite" style={{ color: COLORS.muted, fontSize: 12 }}>
        {copy === undefined || copy === 'busy' ? null : t(copy)}
      </div>
      {copy === 'failed' || copy === 'unavailable' ? (
        <textarea aria-label={t('manual')} readOnly value={text} rows={6} onFocus={event => event.currentTarget.select()} style={{ ...control, width: '100%', boxSizing: 'border-box', cursor: 'text', marginTop: 6 }} />
      ) : null}
      <div data-kb-passage-text style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: COLORS.text }}>{passage.text}</div>
      {failure ? <div role="alert" style={{ fontSize: 12, color: COLORS.danger, marginTop: 6 }}>{t('openFailed')}</div> : null}
    </div>
  )
}

/** Rendered in the inspected shell.overlay slot, never appended to the app body. */
function SourceOverlay({ passages, onClose, owner }: { passages: readonly SourcePassage[]; onClose: () => void; owner: object }): React.ReactElement {
  const t = useCitationText()
  const [selected, setSelected] = React.useState('')
  const groups = sourceGroups(passages)
  const visible = selected === '' ? groups : groups.filter(group => group.key === selected)
  const dialog = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const root = dialog.current
    root?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!sourceDialogActive(owner)) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab' || root === null) return
      const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), select, textarea, summary')].filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (first === undefined || last === undefined) { event.preventDefault(); root.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus() }
    }
    const onFocus = (event: FocusEvent): void => {
      if (sourceDialogActive(owner) && root !== null && event.target instanceof Node && !root.contains(event.target)) root.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocus)
    return () => { document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('focusin', onFocus) }
  }, [onClose, owner])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 65%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, pointerEvents: 'auto' }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t('sources')} tabIndex={-1} ref={dialog} onClick={event => event.stopPropagation()} style={{ color: COLORS.text, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: 16, borderBottom: `1px solid ${COLORS.border}` }}>
          <strong>{t('sources')} ({passages.length})</strong>
          <button type="button" onClick={onClose} style={control}>{t('close')}</button>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <label style={{ fontSize: 12 }}>{t('filter')}<select value={selected} onChange={event => setSelected(event.currentTarget.value)} style={{ ...control, display: 'block', width: '100%', marginTop: 6 }}>
            <option value="">{t('all')}</option>
            {groups.map((group, i) => <option key={group.key} value={group.key}>{i + 1}. {citationLabel(group.kbName, t('hidden'))} / {citationLabel(group.materialTitle, t('hidden'))} ({group.entries.length})</option>)}
          </select></label>
        </div>
        <div style={{ padding: '0 16px 16px', overflowY: 'auto', minHeight: 0 }}>
          {visible.map(group => <details key={group.key} open style={{ borderTop: `1px solid ${COLORS.border}`, padding: '10px 0' }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, overflowWrap: 'anywhere' }}>{citationLabel(group.kbName, t('hidden'))} / {citationLabel(group.materialTitle, t('hidden'))} ({group.entries.length})</summary>
            {group.entries.map(({ passage, index }) => <PassageRow key={index} passage={passage} index={index} onOpened={onClose} />)}
          </details>)}
          <p style={{ fontSize: 12, color: COLORS.muted }}>{t('note')}</p>
        </div>
      </div>
    </div>
  )
}
const dismissSources = () => closeSources()
export function KnowbaseSourceOverlay(): React.ReactElement | null {
  const state = useSourceDialog()
  return state === undefined ? null : <SourceOverlay key={overlayKey(state.owner)} owner={state.owner} passages={state.passages} onClose={dismissSources} />
}
let nextOwner = 0
const owners = new WeakMap<object, number>()
function overlayKey(owner: object): number {
  let key = owners.get(owner)
  if (key === undefined) { key = ++nextOwner; owners.set(owner, key) }
  return key
}

function StatusBadge({ outcome }: { outcome: AnswerOutcome }): React.ReactElement | null {
  const t = useCitationText()
  const status = outcome.status
  if (status === undefined || status.outcome === 'hits') return null
  const known = ['no_match', 'not_ready', 'no_selection', 'empty_scope', 'error'].includes(status.outcome)
  const text = known ? t(status.outcome as 'no_match') : status.outcome
  const base = known ? t(`${status.outcome}Hint` as 'no_matchHint') : text
  const hint = status.reason === '' ? base : `${base}（${citationLabel(status.reason, t('hidden'))}）`
  return <span title={hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px', fontSize: 12, color: COLORS.muted }}>
    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: COLORS.warn }} />{text}
  </span>
}

export function KnowbaseSourceAction(props: Props): React.ReactElement | null {
  const t = useCitationText()
  const owner = React.useRef<object>({})
  React.useEffect(() => { const key = owner.current; return () => closeSources(key) }, [])
  const { messageId, useSession, useChat } = props
  const sessionSnapshot = typeof useSession === 'function'
    ? (useSession as (selector: (state: unknown) => unknown) => unknown)((state: unknown) => state) : undefined
  const liveChat = typeof useChat === 'function'
    ? (useChat as (selector: (state: unknown) => unknown) => unknown)((state: unknown) => state) : undefined
  const chat = liveChat ?? (sessionSnapshot as { chat?: unknown } | undefined)?.chat
  const outcome = typeof messageId === 'string' ? outcomeForAnswer(chat, messageId) : undefined
  if (outcome === undefined) return null
  if (outcome.passages.length === 0) return <StatusBadge outcome={outcome} />
  return <button type="button" title={t('view')} onClick={event => showSources({ owner: owner.current, passages: outcome.passages, restoreFocus: event.currentTarget })} style={{ border: 'none', background: 'transparent', padding: '2px 6px', fontSize: 12, color: COLORS.muted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span aria-hidden="true" style={{ padding: '0 5px', borderRadius: 4, border: `1px solid ${COLORS.border}`, fontSize: 11, color: COLORS.accent }}>{outcome.passages.length}</span>{t('sources')}
  </button>
}
