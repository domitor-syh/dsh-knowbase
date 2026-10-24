import * as React from 'react'
import type { ProposalView } from '../remote.ts'
import { knowbaseApi } from './api.ts'
import { usePalette } from './theme.ts'

interface Props { readonly sessionId: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '提案操作失败。'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** User-only review surface for model-generated write proposals. */
export function ProposalInbox({ sessionId }: Props): React.ReactElement | null {
  const palette = usePalette()
  const [proposals, setProposals] = React.useState<readonly ProposalView[]>([])
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState<string | undefined>()
  const [error, setError] = React.useState('')
  const alive = React.useRef(true)

  const refresh = React.useCallback(async (): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) return
    try {
      const next = await api.listProposals(sessionId)
      if (alive.current) {
        setProposals(next.filter(proposal => proposal.status === 'pending'))
        setError('')
      }
    } catch (failure) {
      if (alive.current) setError(messageOf(failure))
    }
  }, [sessionId])

  React.useEffect(() => {
    alive.current = true
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const act = async (proposal: ProposalView, action: 'approve' | 'reject'): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined || busy !== undefined) return
    setBusy(proposal.id)
    setError('')
    try {
      if (action === 'approve') await api.approveProposal(sessionId, proposal.id)
      else await api.rejectProposal(sessionId, proposal.id)
      await refresh()
    } catch (failure) {
      if (alive.current) setError(messageOf(failure))
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }

  if (proposals.length === 0 && error === '') return null
  const border = `1px solid ${palette.panelBorder}`
  return (
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)} style={{ position: 'relative' }}>
      <summary
        aria-label="待确认的知识库提案"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          border, borderRadius: 999, padding: '5px 9px', background: palette.panel,
          color: palette.text, fontSize: 12, listStyle: 'none',
        }}
      >
        <span aria-hidden="true">✎</span>待确认提案{proposals.length > 0 ? ` · ${proposals.length}` : ''}
      </summary>
      <div
        role="dialog"
        aria-label="知识库写入提案"
        style={{
          position: 'fixed', left: 12, bottom: 52, zIndex: 90, width: 360, maxWidth: 'calc(100vw - 24px)',
          boxSizing: 'border-box', border, borderRadius: 12, padding: 12,
          background: palette.panel, color: palette.text, boxShadow: palette.shadow,
        }}
      >
        {proposals.map(proposal => (
          <ProposalCard key={proposal.id} proposal={proposal} busy={busy === proposal.id} onAction={action => void act(proposal, action)} palette={palette} />
        ))}
        {error !== '' && <p role="alert" style={{ color: palette.accent, fontSize: 12, margin: '8px 0 0' }}>{error}</p>}
      </div>
    </details>
  )
}

function ProposalCard(props: {
  readonly proposal: ProposalView
  readonly busy: boolean
  readonly onAction: (action: 'approve' | 'reject') => void
  readonly palette: ReturnType<typeof usePalette>
}): React.ReactElement {
  const { proposal, busy, onAction, palette } = props
  return (
    <article style={{ borderBottom: `1px solid ${palette.divider}`, paddingBottom: 10, marginBottom: 10 }}>
      <strong style={{ display: 'block', fontSize: 13 }}>{proposal.kbName} / {proposal.fileName}</strong>
      <span style={{ display: 'block', color: palette.muted, fontSize: 11, marginTop: 3 }}>
        {formatBytes(proposal.contentBytes)} · revision {proposal.baseRevision}
      </span>
      {proposal.reason !== '' && <p style={{ fontSize: 12, margin: '7px 0' }}>{proposal.reason}</p>}
      <pre style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', margin: '7px 0', padding: 8, borderRadius: 6, background: palette.field, fontSize: 11 }}>{proposal.content}</pre>
      <div style={{ display: 'flex', gap: 7, justifyContent: 'flex-end' }}>
        <button type="button" disabled={busy} onClick={() => onAction('reject')} style={buttonStyle(palette, false)}>拒绝</button>
        <button type="button" disabled={busy} onClick={() => onAction('approve')} style={buttonStyle(palette, true)}>{busy ? '处理中…' : '批准写入'}</button>
      </div>
    </article>
  )
}

function buttonStyle(palette: ReturnType<typeof usePalette>, primary: boolean): React.CSSProperties {
  return {
    border: `1px solid ${primary ? palette.accent : palette.panelBorder}`,
    borderRadius: 6, padding: '5px 9px', cursor: 'pointer', fontSize: 12,
    background: primary ? palette.accentWash : palette.panel,
    color: primary ? palette.accent : palette.text,
  }
}
