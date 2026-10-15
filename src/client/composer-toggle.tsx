/**
 * The composer's knowledge-base control.
 *
 * The plan's largest usability gap: without a visible switch, a user has to
 * know `/kb use` exists before the knowledge base can participate in a
 * conversation at all. This renders the compact pill the hand-off draws — a
 * book, then either 「知识库」 or 「知识库 · N」 — and the popover behind it holds
 * the per-base switches.
 *
 * ## What the hand-off changed
 *
 * The old control was a prose label (「知识库：全部（2）」, 「知识库：关闭」,
 * 「知识库：未选择」) plus a master switch above a checkbox list. The design
 * replaces that with a count on the button and switches in the panel, and drops
 * the master switch: *a switch that is on means the knowledge base is in use*,
 * so nothing ticked is the same statement as switched off. That is why the pill
 * is accent-coloured exactly when the count is non-zero, and why unticking the
 * last base writes `enabled: false` rather than the empty-selection state.
 *
 * The panel gained a search box, which is what makes a long base list usable,
 * and its one footer action flips between 「全部开启」 and 「全部关闭」 because the
 * design gives that slot a single button. 「全部开启」 stores the *dynamic* all
 * rather than ticking every row, because the two differ for a base created
 * afterwards and only the dynamic one is what a user asking for "all" means.
 *
 * ## Deliberate boundaries
 *
 * The scope model stays the Host's. A deleted base keeps its selection and is
 * reported as invalid rather than silently switching the session to "all" — the
 * plan is explicit that the two must not be conflated, and with the button now
 * carrying only a count, the panel's warning is where that requirement lives.
 *
 * ## Why a portal
 *
 * The popover opens upward out of the composer tool row, which sits inside
 * containers that clip and stack. Rendering it into `document.body` with fixed
 * positioning keeps it out of every ancestor's overflow, the same choice the
 * reference plugin made for its composer overlays.
 *
 * @module @domitor-syh/dsh-knowbase/client/composer-toggle
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import type { KnowledgeBaseView, SessionScopeView } from '../remote.ts'
import { knowbaseApi } from './api.ts'
import {
  allSelected,
  isBaseSelected,
  matchesQuery,
  missingBaseIds,
  scopeCount,
  scopeLabel,
  toggleBaseSelection,
} from './labels.ts'
import { usePalette } from './theme.ts'

/** Props the seat composes: the inject face supplies the session. */
interface Props {
  sessionId: string
}

/** The panel's width; also what keeps it inside the viewport when anchoring. */
const PANEL_WIDTH = 300

/** Report a failure without letting it escape into React's error path. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The book the pill and the sidebar row share a silhouette with.
 *
 * Deliberately *not* the sidebar's component: that one carries
 * `data-kb-panel-icon`, and the probes use it to find the sidebar row. Two
 * elements answering to the same hook would make "open the page" click whichever
 * came first in the DOM — the exact trap pitfall 50 records.
 */
function BookGlyph(props: { size: number }): React.ReactElement {
  return (
    <svg
      data-kb-toggle-icon
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M12 6.5C10 5 7.5 4.5 5 4.5v13c2.5 0 5 .5 7 2" />
      <path d="M12 6.5c2-1.5 4.5-2 7-2v13c-2.5 0-5 .5-7 2" />
      <path d="M12 6.5v13" />
    </svg>
  )
}

/** The search box's magnifier. */
function SearchGlyph(): React.ReactElement {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      style={{ position: 'absolute', left: 9, top: '50%', marginTop: -6.5, pointerEvents: 'none' }}
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </svg>
  )
}

/** One base row: its name, and the switch that puts it in scope. */
function BaseRow(props: {
  name: string
  detail: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
}): React.ReactElement {
  const palette = usePalette()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.name}
      disabled={props.disabled}
      onClick={props.onToggle}
      style={{
        display: 'flex',
        width: '100%',
        gap: 10,
        alignItems: 'center',
        justifyContent: 'space-between',
        border: 'none',
        background: 'transparent',
        padding: '9px 0',
        cursor: props.disabled ? 'default' : 'pointer',
        textAlign: 'left',
        font: 'inherit',
        color: palette.text,
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            lineHeight: '18px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {props.name}
        </span>
        <span style={{ display: 'block', fontSize: 11, color: palette.muted }}>{props.detail}</span>
      </span>
      <span
        aria-hidden="true"
        style={{
          width: 34,
          height: 20,
          borderRadius: 10,
          flexShrink: 0,
          position: 'relative',
          boxSizing: 'border-box',
          background: props.checked ? palette.accent : palette.trackOff,
          border: `1px solid ${props.checked ? palette.accent : palette.trackOffBorder}`,
          transition: 'background 120ms, border-color 120ms',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: props.checked ? 15 : 1,
            width: 16,
            height: 16,
            borderRadius: 8,
            background: props.checked ? palette.knobOn : palette.knobOff,
            transition: 'left 120ms, background 120ms',
          }}
        />
      </span>
    </button>
  )
}

/** The composer pill and its popover. */
export function ComposerKnowbaseToggle(props: Props): React.ReactElement {
  const { sessionId } = props
  const palette = usePalette()
  const [scope, setScope] = React.useState<SessionScopeView | undefined>(undefined)
  const [bases, setBases] = React.useState<readonly KnowledgeBaseView[]>([])
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [query, setQuery] = React.useState('')
  const [anchor, setAnchor] = React.useState<{ left: number; bottom: number } | undefined>(
    undefined,
  )
  const root = React.useRef<HTMLSpanElement | null>(null)
  const popover = React.useRef<HTMLDivElement | null>(null)
  const alive = React.useRef(true)

  const refresh = React.useCallback(async (): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) return
    try {
      const [view, list] = await Promise.all([
        api.getSessionScope(sessionId),
        api.listKnowledgeBases(),
      ])
      if (!alive.current) return
      setScope(view)
      setBases(list)
      setError('')
    } catch (failure) {
      if (alive.current) setError(messageOf(failure))
    }
  }, [sessionId])

  // The Remote channel mounts asynchronously, so the first render has no API
  // yet. Poll briefly and load once it appears — an unconfigured-looking
  // control that cannot work is worse than one that arrives a beat late.
  React.useEffect(() => {
    alive.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (knowbaseApi() !== undefined) {
        window.clearInterval(timer)
        void refresh()
      }
    }, 500)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  // Anchor the popover to the button while open; follow layout shifts so the
  // panel does not drift away from its control.
  React.useEffect(() => {
    if (!open) return
    const update = (): void => {
      const rect = root.current?.getBoundingClientRect()
      if (rect === undefined) return
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
        bottom: window.innerHeight - rect.top + 6,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  // Dismiss on outside press or Escape. The popover lives in a portal, so the
  // button's own subtree check is not enough — both containers are consulted.
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (root.current?.contains(target) === true) return
      if (popover.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const apply = async (
    enabled: boolean,
    all: boolean,
    kbIds: readonly string[],
  ): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) return
    setBusy(true)
    setError('')
    try {
      const view = await api.setSessionScope(sessionId, enabled, all, kbIds)
      if (!alive.current) return
      setScope(view)
    } catch (failure) {
      if (alive.current) setError(messageOf(failure))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const count = scopeCount(scope, bases)
  const on = count > 0
  const missing = missingBaseIds(scope, bases)
  const visible = bases.filter(base => matchesQuery(base.name, query))
  const everything = allSelected(scope, bases)
  const ready = scope !== undefined

  const panel: React.CSSProperties = {
    position: 'fixed',
    left: anchor?.left ?? 0,
    bottom: anchor?.bottom ?? 0,
    zIndex: 80,
    width: PANEL_WIDTH,
    border: `1px solid ${palette.panelBorder}`,
    borderRadius: 12,
    background: palette.panel,
    color: palette.text,
    boxShadow: palette.shadow,
    fontSize: 13,
    textAlign: 'left',
    overflow: 'hidden',
  }

  const divider: React.CSSProperties = {
    height: 1,
    background: palette.divider,
  }

  const warning: React.CSSProperties = {
    color: palette.muted,
    fontSize: 11,
    margin: '6px 0 0',
  }

  return (
    <span ref={root} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        data-kb-composer-toggle
        aria-haspopup="true"
        aria-expanded={open}
        disabled={!ready}
        onClick={() => {
          const next = !open
          setOpen(next)
          // The scope can change from other surfaces (the `/kb` command);
          // re-read on open so the panel never shows a stale decision.
          if (next) {
            setQuery('')
            void refresh()
          }
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 26,
          boxSizing: 'border-box',
          padding: '0 9px',
          border: `1px solid ${on ? palette.accent : palette.idleBorder}`,
          borderRadius: 999,
          background: on ? palette.accentWash : 'transparent',
          color: on ? palette.accent : palette.idleText,
          fontSize: 12,
          lineHeight: 1,
          cursor: ready ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
          opacity: ready ? 1 : 0.6,
          transition: 'border-color 120ms, color 120ms, background 120ms',
        }}
      >
        <BookGlyph size={14} />
        {scopeLabel(scope, bases)}
      </button>

      {open &&
        createPortal(
          <div ref={popover} role="dialog" aria-label="知识库" style={panel}>
            <div style={{ padding: 10 }}>
              <span style={{ position: 'relative', display: 'block' }}>
                <SearchGlyph />
                <input
                  data-kb-search
                  type="text"
                  value={query}
                  placeholder="搜索知识库"
                  aria-label="搜索知识库"
                  onChange={event => setQuery(event.target.value)}
                  style={{
                    width: '100%',
                    height: 30,
                    boxSizing: 'border-box',
                    padding: '0 9px 0 27px',
                    border: `1px solid ${palette.fieldBorder}`,
                    borderRadius: 8,
                    background: palette.field,
                    color: palette.text,
                    fontSize: 12,
                    font: 'inherit',
                    outline: 'none',
                  }}
                />
              </span>
            </div>

            <div style={divider} />

            <div
              role="group"
              aria-label="检索范围"
              style={{
                padding: '2px 10px 8px',
                maxHeight: 264,
                overflowY: 'auto',
                opacity: busy ? 0.6 : 1,
              }}
            >
              {visible.map(base => (
                <BaseRow
                  key={base.id}
                  name={base.name}
                  detail={
                    base.materialCount === 0
                      ? '暂无文件'
                      : `${base.materialCount} 个文件 / ${base.indexedCount} 可检索`
                  }
                  checked={isBaseSelected(scope, base.id)}
                  disabled={busy || !ready}
                  onToggle={() => {
                    const next = toggleBaseSelection(scope, bases, base.id)
                    // Nothing ticked is the same statement as switched off, so
                    // the last untick writes `enabled: false` rather than the
                    // empty-selection state the plan keeps for other writers.
                    void apply(next.length > 0, false, next)
                  }}
                />
              ))}

              {bases.length === 0 && (
                <p style={warning}>还没有知识库。点左侧栏的「知识库」图标去新建一个。</p>
              )}
              {bases.length > 0 && visible.length === 0 && (
                <p style={warning}>没有匹配的知识库。</p>
              )}
              {missing.length > 0 && (
                <p style={{ ...warning, color: '#e5484d' }}>
                  原来选择的知识库已被删除，请重新选择（不会自动改为全部）。
                </p>
              )}
              {error !== '' && <p style={{ ...warning, color: '#e5484d' }}>{error}</p>}
            </div>

            <div style={divider} />

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '8px 10px',
              }}
            >
              <span data-kb-count style={{ fontSize: 12, color: palette.muted }}>
                开启{' '}
                <strong style={{ color: palette.text, fontWeight: 600 }}>{count}</strong>/
                {bases.length} 个知识库
              </span>
              <button
                type="button"
                data-kb-toggle-all
                disabled={busy || !ready || bases.length === 0}
                onClick={() =>
                  // The one footer slot carries both directions: the design
                  // gives it a single action, and the label says which way it
                  // will go.
                  everything ? void apply(false, false, []) : void apply(true, true, [])
                }
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: palette.accent,
                  fontSize: 12,
                  font: 'inherit',
                  padding: 0,
                  cursor: bases.length === 0 ? 'default' : 'pointer',
                  opacity: bases.length === 0 ? 0.5 : 1,
                }}
              >
                {everything ? '全部关闭' : '全部开启'}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  )
}
