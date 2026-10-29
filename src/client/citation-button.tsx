import * as React from 'react'
import { outcomeForAnswer, type AnswerOutcome, type SourcePassage } from './citation-scan.ts'
import { openMaterialInReader } from './reader.ts'
import { closeSources, showSources, sourceDialogActive, useSourceDialog } from './citation-dialog.ts'
import { useCitationText } from './citation-locale.ts'
import { citationCopyText, citationLabel, copyCitation, sourceGroups, validCitationId, type CopyResult } from './citation-view.ts'
import { Icon } from './icons.tsx'
import { SourceFilter } from './source-filter.tsx'

const COLORS = {
  border: 'var(--dsw-alias-border-l1)',
  text: 'var(--dsw-alias-label-primary)',
  muted: 'var(--dsw-alias-label-secondary)',
  accent: 'var(--dsw-alias-brand-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  surface: 'var(--dsw-alias-bg-layer-1)',
  card: 'var(--dsw-alias-bg-layer-2)',
} as const

const control: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  padding: '5px 9px',
  background: 'transparent',
  color: COLORS.text,
  fontSize: 12,
  lineHeight: 1.2,
  cursor: 'pointer',
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
  const onCopy = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setCopy('busy')
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
        kbId: passage.kbId,
        materialId: passage.materialId,
        ...(passage.ordinal === undefined ? {} : { chunk: passage.ordinal }),
        title: passage.materialTitle,
      })
      if (problem === undefined) onOpened()
      else setFailure(true)
    } catch { setFailure(true) }
  }
  return (
    <article data-kb-passage data-kb-passage-index={index + 1} style={{
      border: `1px solid ${COLORS.border}`, borderRadius: 8, background: COLORS.card,
      padding: '10px 12px', marginTop: 8, overflowWrap: 'anywhere',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span data-kb-passage-header style={{ minWidth: 0, fontSize: 12, color: COLORS.muted, overflowWrap: 'anywhere' }}>
          [{index + 1}] · {citationLabel(passage.locator, t('hidden'))}
        </span>
        <div style={{ display: 'flex', flex: 'none', gap: 6 }}>
          <button type="button" style={control} onClick={() => { void onCopy() }} disabled={copy === 'busy'}>
            {copy === 'busy' ? t('copying') : t('copy')}
          </button>
          {passage.kbId !== undefined && passage.materialId !== undefined ? (
            <button type="button" data-kb-open-in-reader title={t('openHint')} style={control} onClick={onOpen}>{t('open')}</button>
          ) : null}
        </div>
      </div>
      <div data-kb-passage-text style={{ marginTop: 8, fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', color: COLORS.text }}>
        {passage.text}
      </div>
      <div role="status" aria-live="polite" style={{ color: COLORS.muted, fontSize: 11, marginTop: copy === undefined || copy === 'busy' ? 0 : 6 }}>
        {copy === undefined || copy === 'busy' ? null : t(copy)}
      </div>
      {copy === 'failed' || copy === 'unavailable' ? (
        <textarea aria-label={t('manual')} readOnly value={text} rows={4} onFocus={event => event.currentTarget.select()} style={{ ...control, width: '100%', boxSizing: 'border-box', cursor: 'text', marginTop: 6 }} />
      ) : null}
      {failure ? <div role="alert" style={{ fontSize: 12, color: COLORS.danger, marginTop: 6 }}>{t('openFailed')}</div> : null}
    </article>
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
      if (event.key === 'Escape') {
        if (root?.querySelector('[data-kb-source-filter] [aria-expanded="true"]')) return
        event.preventDefault(); event.stopPropagation(); onClose(); return
      }
      if (event.key !== 'Tab' || root === null) return
      const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, [role="listbox"]')].filter(item => item.getClientRects().length > 0)
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
    <div data-kb-source-overlay style={{
      position: 'fixed', inset: 0, zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 68%, transparent)', pointerEvents: 'auto',
    }} onClick={onClose}>
      <div data-kb-source-dialog role="dialog" aria-modal="true" aria-label={t('sources')} tabIndex={-1} ref={dialog} onClick={event => event.stopPropagation()} style={{
        color: COLORS.text, background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 24, outline: 'none',
        width: '100%', maxWidth: 720, maxHeight: '82vh', display: 'flex', flexDirection: 'column', minHeight: 0,
        overflow: 'hidden', boxShadow: '0 12px 32px color-mix(in srgb, var(--dsw-alias-bg-base) 35%, transparent)',
      }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: `1px solid ${COLORS.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 15, fontWeight: 600 }}>{t('sources')}</strong>
            <span style={{ color: COLORS.muted, fontSize: 12 }}>{passages.length}</span>
          </div>
          <button type="button" className="kb-source-close" aria-label={t('close')} title={t('close')} onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </header>
        {groups.length > 1 ? (
          <div style={{ flex: 'none', position: 'relative', zIndex: 1, padding: '10px 16px', borderBottom: `1px solid ${COLORS.border}` }}>
            <SourceFilter label={t('filter')} value={selected} onChange={setSelected} options={[
              { value: '', label: `${t('all')} · ${passages.length}` },
              ...groups.map(group => ({ value: group.key, label: `${citationLabel(group.materialTitle, t('hidden'))} · ${group.entries.length}` })),
            ]} />
          </div>
        ) : null}
        <div data-kb-source-list style={{ padding: '4px 16px 16px', overflowY: 'auto', minHeight: 0 }}>
          {visible.map(group => (
            <section key={group.key} data-kb-source-group aria-label={`${citationLabel(group.materialTitle, t('hidden'))} ${group.entries.length}`}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '12px 0 2px' }}>
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <strong style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{citationLabel(group.materialTitle, t('hidden'))}</strong>
                  <span style={{ display: 'block', marginTop: 2, color: COLORS.muted, fontSize: 11 }}>{citationLabel(group.kbName, t('hidden'))}</span>
                </div>
                <span style={{ flex: 'none', color: COLORS.muted, fontSize: 11 }}>{group.entries.length}</span>
              </div>
              {group.entries.map(({ passage, index }) => <PassageRow key={`${group.key}-${index}`} passage={passage} index={index} onOpened={onClose} />)}
            </section>
          ))}
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
    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--dsw-alias-state-warn-primary)' }} />{text}
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
  return <button
    type="button"
    data-kb-source-action
    aria-label={`${t('sources')} ${outcome.passages.length}`}
    title={t('view')}
    onClick={event => showSources({ owner: owner.current, passages: outcome.passages, restoreFocus: event.currentTarget })}
    className="kb-source-action"
  >
    <span data-kb-source-icon><Icon name="knowledge-base" size={17} /></span>
    <span data-kb-source-count>{outcome.passages.length}</span>
  </button>
}
