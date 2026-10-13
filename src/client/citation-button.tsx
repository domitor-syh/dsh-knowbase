/**
 * The per-answer knowledge-base surface: a source panel when the answer had
 * evidence, a status badge when it did not.
 *
 * The host's markdown pipeline is closed — no link hooks, no component map —
 * so the `[1] …` markers inside an answer's text cannot become clickable
 * inline. The next best surface is the assistant action strip, the same row
 * the feedback buttons use: this renders a 「知识库来源」 button for every
 * answer whose turn carries this plugin's evidence, and clicking opens an
 * overlay listing the passages in marker order — full text, source title,
 * locator.
 *
 * ## Why the badge matters as much as the panel
 *
 * The plan's rule is that a miss must not be left to the model to remember to
 * mention (「未命中提示不能只交给模型"记得说"」). An answer with no badge is
 * indistinguishable from an answer the knowledge base never reached, so a turn
 * that searched and found nothing says so, in a fixed string the plugin owns.
 * The badge reports the outcome; it never claims the answer is wrong.
 *
 * The structured payload arrives inside the plugin message's `source` field
 * (see `../pre-step.ts` and `./citation-scan.ts`), so both surfaces need no
 * round trip and no text parsing. Answers written before either field existed
 * show nothing at all.
 *
 * ## Why a portal
 *
 * The overlay must escape the action strip's stacking context; rendering into
 * `document.body` with fixed positioning is the same choice the composer
 * popover makes.
 *
 * @module @domitor-syh/dsh-knowbase/client/citation-button
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { outcomeForAnswer, type AnswerOutcome, type SourcePassage } from './citation-scan.ts'
import { openMaterialInReader } from './reader.ts'

const COLORS = {
  border: '#dce3ed',
  muted: '#526176',
  accent: '#185fa5',
  danger: '#b3261e',
  surface: '#fff',
  subtle: '#f6f8fb',
  warn: '#8a6100',
} as const

/**
 * Fixed text per outcome, owned by the plugin rather than the model.
 *
 * `hits` is absent on purpose: it is the one outcome with something to open,
 * so it gets the button instead of a label.
 */
const STATUS_TEXT: Record<string, string> = {
  no_match: '未检索到相关知识',
  not_ready: '知识库还没有资料',
  no_selection: '未勾选知识库',
  empty_scope: '所选知识库已失效',
  error: '知识库检索暂不可用',
}

/** Longer explanation, shown on hover rather than in the strip. */
const STATUS_HINT: Record<string, string> = {
  no_match: '本次提问在所选知识库里没有命中片段。回答可能来自模型自身知识，不是库内资料。',
  not_ready: '所选知识库里还没有已索引的资料，本次回答没有知识库依据。',
  no_selection: '本会话已开启知识库，但一个库都没有勾选，本次没有检索任何知识库。',
  empty_scope: '本次选中的知识库不存在或已被删除，本次回答没有知识库依据。',
  error: '知识库检索失败，本次回答没有知识库依据。',
}

/**
 * Props the seat composes.
 *
 * The chat package publishes these as loose view types (rollback reads them
 * as `any` for the same reason); everything actually consumed is narrowed at
 * runtime, and the snapshot walk itself lives in `./citation-scan.ts`.
 */
interface Props {
  readonly messageId?: unknown
  readonly useSession?: unknown
  readonly useChat?: unknown
}

/** Report a failure without letting it escape into React's error path. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * One passage row: numbered like the answer's `[n]` markers.
 *
 * A passage whose answer predates the reader carries no ids, so the row offers
 * no action rather than a button that cannot work — the same degradation the
 * status badge uses for messages written before it existed.
 *
 * @param props - the passage, its 1-based position, and the overlay's close.
 */
function PassageRow(props: {
  passage: SourcePassage
  index: number
  onOpened: () => void
}): React.ReactElement {
  const { passage, index, onOpened } = props
  const [failure, setFailure] = React.useState<string | undefined>(undefined)
  const { kbId, materialId, ordinal } = passage
  const openable = kbId !== undefined && materialId !== undefined

  const onOpen = (): void => {
    if (kbId === undefined || materialId === undefined) return
    const problem = openMaterialInReader({
      kbId,
      materialId,
      ...(ordinal === undefined ? {} : { chunk: ordinal }),
      title: passage.materialTitle,
    })
    // On success the overlay closes so the column it just revealed is visible;
    // on failure the row says why instead of leaving a dead click.
    if (problem === undefined) onOpened()
    else setFailure(problem)
  }

  return (
    <div
      data-kb-passage
      style={{
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        background: COLORS.subtle,
        padding: 10,
        marginBottom: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 4,
        }}
      >
        <div data-kb-passage-header style={{ fontSize: 12, color: COLORS.accent }}>
          [{index + 1}] {passage.kbName} / {passage.materialTitle} · {passage.locator}
        </div>
        {openable ? (
          <button
            type="button"
            data-kb-open-in-reader
            title="在右侧栏打开这份资料并定位到该片段"
            onClick={onOpen}
            style={{
              flexShrink: 0,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surface,
              borderRadius: 4,
              padding: '1px 6px',
              fontSize: 11,
              color: COLORS.accent,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            在右栏打开
          </button>
        ) : null}
      </div>
      <div data-kb-passage-text style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: '#1c2733' }}>
        {passage.text}
      </div>
      {failure === undefined ? null : (
        <div style={{ fontSize: 11, color: COLORS.danger, marginTop: 6 }}>{failure}</div>
      )}
    </div>
  )
}

/** The overlay listing every passage behind one answer. */
function SourceOverlay(props: {
  passages: readonly SourcePassage[]
  onClose: () => void
}): React.ReactElement {
  const { passages, onClose } = props

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-label="知识库来源"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'rgba(15, 23, 42, 0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={event => event.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 10,
          border: `1px solid ${COLORS.border}`,
          maxWidth: 640,
          width: '100%',
          maxHeight: '76vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 16px 48px rgba(15, 23, 42, 0.24)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            知识库来源（{passages.length} 个片段）
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 16,
              color: COLORS.muted,
              cursor: 'pointer',
              lineHeight: 1,
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto' }}>
          {passages.map((passage, index) => (
            <PassageRow key={index} passage={passage} index={index} onOpened={onClose} />
          ))}
          <p style={{ color: COLORS.muted, fontSize: 11, margin: '4px 2px 0' }}>
            编号与回答中「[1]」等标记对应；片段为检索命中的原文。
          </p>
        </div>
      </div>
    </div>
  )
}

/** The status badge: a fixed sentence the plugin owns, not the model. */
function StatusBadge(props: { outcome: AnswerOutcome }): React.ReactElement | null {
  const status = props.outcome.status
  if (status === undefined) return null

  const label = STATUS_TEXT[status.outcome]
  // An outcome this build has never heard of still renders — as the raw token,
  // which is ugly but honest. A client that hid it would turn a newer Host's
  // new state into "no status at all", which is the one reading that lies.
  if (label === undefined && status.outcome === 'hits') return null

  const text = label ?? status.outcome
  // The reason rides along even for a known outcome: the fixed sentence says
  // what the user needs, the reason is what makes a broken retrieval fixable.
  // This is a local app and the reader is the operator, so the raw text is
  // diagnostic rather than a leak.
  const base = STATUS_HINT[status.outcome] ?? text
  const hint = status.reason === '' ? base : `${base}（${status.reason}）`

  return (
    <span
      title={hint}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        fontSize: 12,
        color: COLORS.muted,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: COLORS.warn,
          flexShrink: 0,
        }}
      />
      {text}
    </span>
  )
}

/** The assistant action: the source button when there is evidence, a badge otherwise. */
export function KnowbaseSourceAction(props: Props): React.ReactElement | null {
  // Hook discipline on this seat is strict, and two earlier attempts proved it:
  // a conditional or factory-nested hook call changes the hook count across
  // renders and React aborts the whole entry with #300. So every hook is called
  // unconditionally at the top level, and the guard on `messageId` sits after
  // them.
  //
  // The two kit hooks are safe to branch on `typeof`: both are standard sources
  // the host materializes for every session-scoped entry (`materializeStandardBinding`
  // turns `binding.hooks` into `use<Name>` props), and both are registered
  // unconditionally by their owners — the runtime's `session` source and
  // ui-chat's `chat` source — so the branch never flips within one composition.
  const { messageId, useSession, useChat } = props

  const [open, setOpen] = React.useState(false)

  const sessionSnapshot =
    typeof useSession === 'function'
      ? (useSession as (selector: (state: unknown) => unknown) => unknown)(
          (state: unknown) => state,
        )
      : undefined

  // `useChat` is the route this host publishes the chat slice on. The snapshot
  // fallback covers the older shape that carried `chat` on the session
  // snapshot — reading only that one is exactly why the button never appeared:
  // the seat was fine, the data was simply on the other route.
  const liveChat =
    typeof useChat === 'function'
      ? (useChat as (selector: (state: unknown) => unknown) => unknown)((state: unknown) => state)
      : undefined
  const chat = liveChat ?? (sessionSnapshot as { chat?: unknown } | undefined)?.chat

  const outcome = typeof messageId === 'string' ? outcomeForAnswer(chat, messageId) : undefined
  const passages = outcome?.passages ?? []

  if (typeof messageId !== 'string') return null
  if (outcome === undefined) return null
  if (passages.length === 0) return <StatusBadge outcome={outcome} />

  const actionButton = (
    <button
      type="button"
      title="查看本次回答引用的知识库片段"
      onClick={() => setOpen(true)}
      style={{
        border: 'none',
        background: 'transparent',
        padding: '2px 6px',
        fontSize: 12,
        color: COLORS.muted,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          padding: '0 5px',
          borderRadius: 4,
          border: `1px solid ${COLORS.border}`,
          fontSize: 11,
          lineHeight: '16px',
          color: COLORS.accent,
        }}
      >
        {passages.length}
      </span>
      知识库来源
    </button>
  )

  return (
    <>
      {actionButton}
      {open &&
        createPortal(
          <SourceOverlay passages={passages} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  )
}