/**
 * The per-answer knowledge-base source panel.
 *
 * The host's markdown pipeline is closed — no link hooks, no component map —
 * so the `[1] …` markers inside an answer's text cannot become clickable
 * inline. The next best surface is the assistant action strip, the same row
 * the feedback buttons use: this renders a 「知识库来源」 button for every
 * answer whose turn carries this plugin's evidence, and clicking opens an
 * overlay listing the passages in marker order — full text, source title,
 * locator.
 *
 * The structured passages arrive inside the evidence message's `source`
 * payload (see `../pre-step.ts` and `./citation-scan.ts`), so the panel needs
 * no round trip and no text parsing. Answers written before that field
 * existed simply show no button.
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
import { passagesForAnswer, type SourcePassage } from './citation-scan.ts'

const COLORS = {
  border: '#dce3ed',
  muted: '#526176',
  accent: '#185fa5',
  danger: '#b3261e',
  surface: '#fff',
  subtle: '#f6f8fb',
} as const

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

/** One passage row: numbered like the answer's `[n]` markers. */
function PassageRow(props: { passage: SourcePassage; index: number }): React.ReactElement {
  const { passage, index } = props
  return (
    <div
      style={{
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        background: COLORS.subtle,
        padding: 10,
        marginBottom: 8,
      }}
    >
      <div style={{ fontSize: 12, color: COLORS.accent, marginBottom: 4 }}>
        [{index + 1}] {passage.kbName} / {passage.materialTitle} · {passage.locator}
      </div>
      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: '#1c2733' }}>
        {passage.text}
      </div>
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
            <PassageRow key={index} passage={passage} index={index} />
          ))}
          <p style={{ color: COLORS.muted, fontSize: 11, margin: '4px 2px 0' }}>
            编号与回答中「[1]」等标记对应；片段为检索命中的原文。
          </p>
        </div>
      </div>
    </div>
  )
}

/** The assistant action: the button when the turn carries evidence, else nothing. */
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

  const passages =
    typeof messageId === 'string' ? passagesForAnswer(chat, messageId) : []

  if (typeof messageId !== 'string') return null
  if (passages.length === 0) return null

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