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
import { useUiText, localizeError } from './ui-locale.ts'

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
      // Flex centers the boxes; the Chinese glyph ink sits slightly lower.
      // Keep this optical correction local to the composer book icon.
      style={{ display: 'block', flexShrink: 0, transform: 'translateY(1px)' }}
    >
      <path d="M12 6.5C10 5 7.5 4.5 5 4.5v13c2.5 0 5 .5 7 2" />
      <path d="M12 6.5c2-1.5 4.5-2 7-2v13c-2.5 0-5 .5-7 2" />
      <path d="M12 6.5v13" />
    </svg>
  )
}

/** One line box for the icon and the complete label, including an enabled count. */
export function ComposerToggleContent({ label }: { label: string }): React.ReactElement {
  return (
    <span data-kb-toggle-content style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 14,
      fontFamily: 'inherit', fontSize: 12, fontWeight: 400, lineHeight: '12px',
    }}>
      <BookGlyph size={14} />
      <span data-kb-toggle-label style={{ display: 'block', lineHeight: '12px' }}>{label}</span>
    </span>
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

/**
 * The row's switch: a capsule frame whose ball is a *standard circle*, small when
 * off and grown when on.
 *
 * Two mockups define the two states, and they are not the same shape scaled:
 * *off* is a hollow frame with a small ball, *on* is the same frame filled with
 * the accent and a ball that has grown to fill it. The mockups are the host's own
 * switch drawn at 2× — a 73×44/46 track, a ~3px frame, a 22px ball off and a 33px
 * ball on — so the 1× geometry is about 36×22 with an 11px / 16.5px ball. The
 * height is the mockup's own 44/46 at 2×; a 20px track read as slightly flat,
 * which is why it went back up to 22 (v33). The off ball is 10px rather than 11,
 * and the on ball 18 rather than 16.5, for the reasons below.
 *
 * The frame is 2px, not the mockup's 1.5px, so that every number the ball depends
 * on is a whole pixel: the inner box is 18 tall and the two insets are 4 and 0.
 * At 1.5px the insets were 0.5px and the frame 1.5px, and the browser rounded
 * those half pixels independently on the two edges — the ball sat about a pixel
 * above centre on a 150%-scaled display.
 *
 * The off ball is 10px because of *device-pixel parity*. The gaps a ball leaves have
 * to be an *even* number of device pixels to split in half: a 10px ball in an 18px
 * inner box leaves 8 CSS pixels, which is 8, 12 and 16 device pixels at 100%, 150%
 * and 200% — all even, so it centres at every zoom. At 150% that is 27 device
 * pixels of inner box minus 15 of ball, i.e. 6/6. A gap of 6 CSS pixels instead (a
 * 12px ball) is 9 device pixels at 150% — odd, so the browser floors it on one edge
 * and ceils it on the other, following the element's sub-pixel phase, and one
 * geometry rasterises as 4/5 at one moment and 5/4 at the next. That is the v31
 * report — "the ball is off-centre until you toggle it once" — two renderings of a
 * single layout, not a moving element. Hence any ball that only has to look centred
 * is the inner height minus a multiple of 4: the 20-to-22 track change moved the off
 * ball from 12 to 14 (v33), and asking for a smaller one again allows 10 and not 12
 * (v34). Both balls obey it — the on ball is 18, whose gap is 0 device pixels, and the
 * 16 that sits between 18 and 14 is ruled out below (v37).
 *
 * Both balls are also *concentric with the cap they sit in*: the inner box is 32×18
 * with a cap radius of 9. Either ball is centred vertically — its `top` is
 * (18 − d) / 2 — so its centre always falls on the inner box's midline, y = 9. Off,
 * d = 10 puts the centre at (4 + 5, 9) = (9, 9), the *left* cap's own centre. On,
 * d = 18 puts it at (14 + 9, 9) = (23, 9), the *right* cap's own centre — which is
 * what {@link KNOB_ON_LEFT} computes, and why it is stated as a centre rather than a
 * right-edge anchor. Parallel arcs need a shared centre, not equal radii: at 9 against
 * the cap's 9 the ball fills the inner height, so the ring is 0 and the ball is flush.
 *
 * At 18 the two statements coincide, because the ball's radius (9) equals the cap's:
 * touching the right edge *is* sharing a centre. A smaller ball would break that
 * coincidence — anchored flush its arc would be parallel but pushed sideways, a ring
 * thin at the nose and thick at the shoulders — which is why {@link KNOB_ON_LEFT}
 * names the centre even though at 18 it computes the same number as the edge.
 *
 * The parity rule above is a *hard* constraint, not a heuristic (v37). A 16px on ball
 * was tried in between (v36) — 18 − 16 is 2 CSS pixels, i.e. 3 device pixels, which
 * cannot be split into two equal halves — and it is ruled out on evidence: it measured
 * symmetric in a controlled 150% capture, yet the user still saw the ball sitting
 * off-centre on their own display. Screenshot symmetry is not enough; the size has to
 * be one the grid can centre at all. Both balls are therefore inner height minus a
 * multiple of 4, and 18 is what a ball that fills the track looks like.
 *
 * Both halves carry {@link TRUE_ROUND}. The host sets `corner-shape:
 * superellipse(1.5)` on the root, and `corner-shape` inherits — so every
 * border-radius in the app, ours included, is drawn as a *squircle*. That is what
 * made the ball read as a rounded square, and why changing the page zoom never
 * changed its shape (a squircle is geometry, not a raster artefact — the earlier
 * "the ball is too small / the pixels round it off" theory was wrong, see the v28
 * note). Opting back out to `round` gives the ball a true circle and the frame a
 * true capsule without touching any of the mockup's measurements.
 *
 * The knob is positioned against the *padding* box, which is what an absolutely
 * positioned child resolves against — so every number below is the outer
 * geometry minus the 2px frame.
 */
const TRACK_WIDTH = 36
const TRACK_HEIGHT = 22
const TRACK_FRAME = 2
const KNOB_OFF = 10
const KNOB_ON = 18
/** The host's squircle corners; the switch opts back out to true round corners. */
const TRUE_ROUND = { cornerShape: 'round' } as unknown as React.CSSProperties
/** Off: the same inset on every side, so the ball looks like it floats. */
const KNOB_OFF_INSET = (TRACK_HEIGHT - TRACK_FRAME * 2 - KNOB_OFF) / 2
/** On: the same inset top and bottom, so the ring round the ball is even. */
const KNOB_ON_INSET = (TRACK_HEIGHT - TRACK_FRAME * 2 - KNOB_ON) / 2
/**
 * On: centred on the right cap, so the ball's arc stays parallel to the track's.
 *
 * Parallel arcs need a shared *centre*, not equal radii. The cap's own centre is
 * `inner width − inner radius` across, so putting the ball's centre there keeps the
 * ball concentric with the cap. At 18 its radius also matches the cap's 9, so the same
 * number is what the ball's right edge flush with the inner frame would give.
 */
const KNOB_ON_LEFT =
  TRACK_WIDTH - TRACK_FRAME * 2 - (TRACK_HEIGHT - TRACK_FRAME * 2) / 2 - KNOB_ON / 2

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
          ...TRUE_ROUND,
          width: TRACK_WIDTH,
          height: TRACK_HEIGHT,
          borderRadius: TRACK_HEIGHT / 2,
          flexShrink: 0,
          position: 'relative',
          boxSizing: 'border-box',
          background: props.checked ? palette.accent : palette.trackOff,
          border: `${TRACK_FRAME}px solid ${
            props.checked ? palette.accent : palette.trackOffBorder
          }`,
          transition: 'background 120ms, border-color 120ms',
        }}
      >
        <span
          style={{
            ...TRUE_ROUND,
            position: 'absolute',
            top: props.checked ? KNOB_ON_INSET : KNOB_OFF_INSET,
            left: props.checked ? KNOB_ON_LEFT : KNOB_OFF_INSET,
            width: props.checked ? KNOB_ON : KNOB_OFF,
            height: props.checked ? KNOB_ON : KNOB_OFF,
            borderRadius: '50%',
            background: props.checked ? palette.knobOn : palette.knobOff,
            transition:
              'top 120ms, left 120ms, width 120ms, height 120ms, background 120ms',
          }}
        />
      </span>
    </button>
  )
}

/** The composer pill and its popover. */
export function ComposerKnowbaseToggle(props: Props): React.ReactElement {
  const tx = useUiText()
  const { sessionId } = props
  const palette = usePalette()
  const [scope, setScope] = React.useState<SessionScopeView | undefined>(undefined)
  const [bases, setBases] = React.useState<readonly KnowledgeBaseView[]>([])
  const [open, setOpen] = React.useState(false)
  const [hover, setHover] = React.useState(false)
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
  React.useLayoutEffect(() => {
    if (!open) {
      setAnchor(undefined)
      return
    }
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
    left: anchor?.left,
    bottom: anchor?.bottom,
    zIndex: 80,
    width: PANEL_WIDTH,
    border: `1px solid ${palette.panelBorder}`,
    borderRadius: 16,
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
        onMouseEnter={() => {
          if (ready) setHover(true)
        }}
        onMouseLeave={() => setHover(false)}
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
          // Both states answer the pointer. Off gets the host's neutral
          // interaction wash and a firmer border; on deepens its accent wash.
          // Without this the control was the only thing in the composer that
          // did nothing at all under the cursor.
          border: `1px solid ${
            on ? palette.accent : hover ? palette.idleBorderHover : palette.idleBorder
          }`,
          borderRadius: 999,
          background: on
            ? hover
              ? palette.accentWashHover
              : palette.accentWash
            : hover
              ? palette.interactiveHover
              : 'transparent',
          color: on ? palette.accent : hover ? palette.idleTextHover : palette.idleText,
          fontSize: 12,
          lineHeight: 1,
          cursor: ready ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
          opacity: ready ? 1 : 0.6,
          transition: 'border-color 120ms, color 120ms, background 120ms',
        }}
      >
        <ComposerToggleContent label={scopeLabel(scope, bases)} />
      </button>

      {open && anchor !== undefined &&
        createPortal(
          <div ref={popover} role="dialog" aria-label={tx('知识库', 'Knowledge bases')} style={panel}>
            <div style={{ padding: 10 }}>
              <span style={{ position: 'relative', display: 'block' }}>
                <SearchGlyph />
                <input
                  data-kb-search
                  type="text"
                  value={query}
                  placeholder={tx('搜索知识库', 'Search knowledge bases')}
                  aria-label={tx('搜索知识库', 'Search knowledge bases')}
                  onChange={event => setQuery(event.target.value)}
                  style={{
                    width: '100%',
                    height: 30,
                    boxSizing: 'border-box',
                    padding: '0 9px 0 27px',
                    border: `1px solid ${palette.fieldBorder}`,
                    borderRadius: 12,
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
              aria-label={tx('检索范围', 'Search scope')}
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
                      ? tx('暂无文件', 'No files yet')
                      : tx(`${base.materialCount} 个文件`, `${base.materialCount} files`)
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
                <p style={warning}>{tx('还没有知识库。点左侧栏的「知识库」图标去新建一个。', 'No knowledge bases yet. Use the Knowledge bases icon in the sidebar to create one.')}</p>
              )}
              {bases.length > 0 && visible.length === 0 && (
                <p style={warning}>{tx('没有匹配的知识库。', 'No matching knowledge bases.')}</p>
              )}
              {missing.length > 0 && (
                <p style={{ ...warning, color: '#e5484d' }}>
                  {tx('原来选择的知识库已被删除，请重新选择（不会自动改为全部）。', 'A previously selected knowledge base was deleted. Select again; the scope will not automatically switch to all bases.')}
                </p>
              )}
              {error !== '' && <p style={{ ...warning, color: '#e5484d' }}>{localizeError(error)}</p>}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                // No rule above the footer: the hand-off's second hairline was
                // dropped on review — the count and the one action read as part
                // of the list, and the line cut the panel in two.
                padding: '6px 10px 10px',
              }}
            >
              <span data-kb-count style={{ fontSize: 12, color: palette.muted }}>
                {tx('开启', 'Enabled')}{' '}
                <strong style={{ color: palette.text, fontWeight: 600 }}>{count}</strong>/
                {bases.length} {tx('个知识库', 'knowledge bases')}
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
                {everything ? tx('全部关闭', 'Disable all') : tx('全部开启', 'Enable all')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  )
}
