/**
 * The composer's knowledge-base control.
 *
 * The plan's largest usability gap: without a visible switch, a user has to
 * know `/kb use` exists before the knowledge base can participate in a
 * conversation at all. This renders the compact button the plan draws —
 * `知识库：关闭` / `知识库：产品资料` / `知识库：全部（2）` — and the popover
 * behind it holds the switch and the scope choice.
 *
 * ## Deliberate boundaries
 *
 * The scope model is the Host's: off, one base, or every base. Multi-select is
 * the plan's post-MVP enhancement and the Host methods already carry the
 * general shape when it lands. A deleted base keeps its selection and is
 * reported as invalid rather than silently switching the session to "all" —
 * the plan is explicit that the two must not be conflated.
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
import { missingBaseIds, scopeLabel } from './labels.ts'

const COLORS = {
  border: '#dce3ed',
  muted: '#526176',
  accent: '#185fa5',
  danger: '#b3261e',
  surface: '#fff',
} as const

/** Props the seat composes: the inject face supplies the session. */
interface Props {
  sessionId: string
}

/** Report a failure without letting it escape into React's error path. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** One scope choice: a radio-style row. */
function ScopeRow(props: {
  checked: boolean
  disabled: boolean
  title: string
  subtitle?: string
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onSelect}
      style={{
        display: 'flex',
        width: '100%',
        gap: 8,
        alignItems: 'flex-start',
        border: 'none',
        background: 'transparent',
        padding: '5px 2px',
        cursor: props.disabled ? 'default' : 'pointer',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          marginTop: 2,
          width: 13,
          height: 13,
          borderRadius: 7,
          border: `1.5px solid ${props.checked ? COLORS.accent : '#b6bfcc'}`,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.checked && (
          <span style={{ width: 7, height: 7, borderRadius: 4, background: COLORS.accent }} />
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13 }}>{props.title}</span>
        {props.subtitle !== undefined && (
          <span style={{ display: 'block', fontSize: 11, color: COLORS.muted }}>
            {props.subtitle}
          </span>
        )}
      </span>
    </button>
  )
}

/** The composer toggle and its popover. */
export function ComposerKnowbaseToggle(props: Props): React.ReactElement {
  const { sessionId } = props
  const [scope, setScope] = React.useState<SessionScopeView | undefined>(undefined)
  const [bases, setBases] = React.useState<readonly KnowledgeBaseView[]>([])
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
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
      const width = 264
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
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

  const enabled = scope?.enabled ?? false
  const missing = missingBaseIds(scope, bases)

  const panel: React.CSSProperties = {
    position: 'fixed',
    left: anchor?.left ?? 0,
    bottom: anchor?.bottom ?? 0,
    zIndex: 80,
    width: 264,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    background: COLORS.surface,
    color: '#1c2733',
    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.16)',
    padding: 10,
    fontSize: 13,
    textAlign: 'left',
  }

  return (
    <span ref={root} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={scope === undefined}
        onClick={() => {
          const next = !open
          setOpen(next)
          // The scope can change from other surfaces (the `/kb` command);
          // re-read on open so the panel never shows a stale decision.
          if (next) void refresh()
        }}
        style={{
          border: `1px solid ${enabled ? COLORS.accent : COLORS.border}`,
          borderRadius: 6,
          background: COLORS.surface,
          color: enabled ? COLORS.accent : COLORS.muted,
          padding: '2px 8px',
          fontSize: 12,
          lineHeight: '18px',
          cursor: scope === undefined ? 'default' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {scopeLabel(scope, bases)}
      </button>

      {open &&
        createPortal(
          <div ref={popover} role="dialog" aria-label="知识库" style={panel}>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={busy || scope === undefined}
              onClick={() => void apply(!enabled, scope?.all ?? true, scope?.kbIds ?? [])}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                border: 'none',
                background: 'transparent',
                padding: '2px 2px',
                cursor: 'pointer',
                font: 'inherit',
                color: 'inherit',
              }}
            >
              <span style={{ fontWeight: 600 }}>使用知识库</span>
              <span
                aria-hidden="true"
                style={{
                  width: 30,
                  height: 18,
                  borderRadius: 9,
                  background: enabled ? COLORS.accent : '#c3ccd9',
                  position: 'relative',
                  flexShrink: 0,
                  transition: 'background 120ms',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: enabled ? 14 : 2,
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    background: '#fff',
                    transition: 'left 120ms',
                  }}
                />
              </span>
            </button>

            <div style={{ borderTop: `1px solid ${COLORS.border}`, margin: '8px 0 4px' }} />

            <div role="radiogroup" aria-label="检索范围" style={{ opacity: busy ? 0.6 : 1 }}>
              <ScopeRow
                checked={scope?.all === true}
                disabled={busy || scope === undefined}
                title={`全部知识库（${bases.length}）`}
                onSelect={() => void apply(true, true, [])}
              />
              {bases.map(base => (
                <ScopeRow
                  key={base.id}
                  checked={scope !== undefined && !scope.all && scope.kbIds.includes(base.id)}
                  disabled={busy || scope === undefined}
                  title={base.name}
                  subtitle={
                    base.materialCount === 0
                      ? '暂无资料'
                      : `${base.materialCount} 份资料 / ${base.chunkCount} 个片段`
                  }
                  onSelect={() => void apply(true, false, [base.id])}
                />
              ))}
            </div>

            {bases.length === 0 && (
              <p style={{ color: COLORS.muted, fontSize: 11, margin: '6px 2px 0' }}>
                还没有知识库。先在「设置 → 知识库」里新建一个。
              </p>
            )}
            {missing.length > 0 && (
              <p style={{ color: COLORS.danger, fontSize: 11, margin: '6px 2px 0' }}>
                原来选择的知识库已被删除，请重新选择（不会自动改为全部）。
              </p>
            )}
            {error !== '' && (
              <p style={{ color: COLORS.danger, fontSize: 11, margin: '6px 2px 0' }}>{error}</p>
            )}

            <p style={{ color: COLORS.muted, fontSize: 11, margin: '8px 2px 0' }}>
              提问时自动检索所选库，回答会标注来源。
            </p>
          </div>,
          document.body,
        )}
    </span>
  )
}