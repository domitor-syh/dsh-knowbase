/**
 * The OCR language-pack controls.
 *
 * ## Two jobs, two buttons
 *
 * 「检测」 and 「下载」 are separate controls because they are separate
 * intentions: one reads two `stat` results and one spends 4.5 MB of someone's
 * bandwidth. The check is a button that only ever calls `getOcrStatus`, and the
 * download only ever starts when the button that says 「下载语言包」 is pressed —
 * nothing here downloads on mount, on failure, or on upload (`HANDOFF.md`
 * §16 ⑦).
 *
 * ## Why the page owns the state
 *
 * The same controls appear twice — in the OCR block and, when an image is
 * uploaded without the packs, next to the file it concerns. Both are driven by
 * one {@link OcrController} the page holds, so the two places cannot show two
 * different states of the same download (which is exactly what two independent
 * pollers would do).
 *
 * @module @domitor-syh/dsh-knowbase/client/ocr-panel
 */

import * as React from 'react'
import type { OcrDownloadStateView, OcrStatusView } from '../remote.ts'
import { knowbaseApi } from './api.ts'

const COLORS = {
  border: '#dce3ed',
  muted: '#526176',
  accent: '#185fa5',
  surface: '#fff',
  subtle: '#f6f8fb',
  warn: '#8a6100',
} as const

/**
 * How often the page asks where the download is.
 *
 * Fast enough that a 30-second download looks like a progress bar rather than a
 * sequence of jumps; slow enough that polling is not the busiest thing the Host
 * is doing.
 */
const POLL_MS = 400

const button: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  background: COLORS.surface,
  padding: '4px 10px',
  fontSize: 13,
  cursor: 'pointer',
}

/** The emphasised choice, matching the settings page's own active style. */
const primaryButton: React.CSSProperties = {
  ...button,
  borderColor: COLORS.accent,
  color: COLORS.accent,
  fontWeight: 600,
}

/** Human-readable byte size, matching the settings page. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Report a failure without letting it escape into React's error path. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Everything the two OCR controls need, owned by the page. */
export interface OcrController {
  /** What is on disk; `undefined` until the first check (or the channel) is ready. */
  readonly status: OcrStatusView | undefined
  /** The current download, running or just finished; `undefined` before any. */
  readonly download: OcrDownloadStateView | undefined
  readonly error: string
  /** True while a download is in flight. */
  readonly running: boolean
  /**
   * Re-read the packs. Never downloads.
   *
   * Returns what it read so a caller that needs the answer in the same breath
   * (an upload deciding whether to show the hint) does not have to ask twice.
   */
  refresh(): Promise<OcrStatusView | undefined>
  /** Begin the download of whatever is missing. */
  start(): Promise<void>
  /** Stop it and delete what it wrote. */
  cancel(): Promise<void>
}

/**
 * The OCR state the page holds, including the polling loop.
 *
 * Polling lives here rather than in the Host because the Remote channel carries
 * plain request/response (lossless JSON only — `HANDOFF.md` §15 ④): a download
 * cannot push progress at the page, so the page asks. `startOcrDownload` returns
 * as soon as the download begins, which is what makes the first poll land while
 * there is still something to watch.
 */
export function useOcrController(): OcrController {
  const [status, setStatus] = React.useState<OcrStatusView>()
  const [download, setDownload] = React.useState<OcrDownloadStateView>()
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(async (): Promise<OcrStatusView | undefined> => {
    const api = knowbaseApi()
    if (api === undefined) return undefined
    try {
      const next = await api.getOcrStatus()
      setStatus(next)
      return next
    } catch (failure) {
      setError(messageOf(failure))
      return undefined
    }
  }, [])

  const start = React.useCallback(async (): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) {
      setError('知识库通道尚未就绪，请稍候重试。')
      return
    }
    setError('')
    try {
      setDownload(await api.startOcrDownload())
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [])

  const cancel = React.useCallback(async (): Promise<void> => {
    const api = knowbaseApi()
    if (api === undefined) return
    try {
      setDownload(await api.cancelOcrDownload())
      // The files this download wrote are gone by now, so what is on disk is
      // whatever was there before it started.
      setStatus(await api.getOcrStatus())
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [])

  const running = download?.state === 'running'

  React.useEffect(() => {
    if (!running) return
    let cancelled = false
    const timer = window.setInterval(() => {
      const api = knowbaseApi()
      if (api === undefined) return
      void api
        .getOcrDownload()
        .then(view => {
          if (cancelled) return
          setDownload(view)
          // A finished download changed what is on disk, and the status the
          // page shows must not be a screenshot of the moment before it.
          if (view.state !== 'running') void refresh()
        })
        .catch((failure: unknown) => {
          if (!cancelled) setError(messageOf(failure))
        })
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [running, refresh])

  return { status, download, error, running, refresh, start, cancel }
}

/** The progress bar, drawn only while there is something to watch. */
function Progress(props: { download: OcrDownloadStateView }): React.ReactElement {
  const { download } = props
  const percent =
    download.totalBytes > 0
      ? Math.min(100, Math.round((download.downloadedBytes / download.totalBytes) * 100))
      : 0
  return (
    <div data-kb-ocr-progress={download.state} style={{ marginTop: 8 }}>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: '#e8eef6',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: '100%', width: `${percent}%`, background: COLORS.accent }} />
      </div>
      <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 4 }}>
        {formatBytes(download.downloadedBytes)} / {formatBytes(download.totalBytes)}（{percent}%）
        {download.lang === '' ? '' : ` · 正在下载 ${download.lang}`}
      </div>
    </div>
  )
}

/** The buttons and progress: the two controls both places share. */
function Controls(props: {
  controller: OcrController
  disabled: boolean
}): React.ReactElement {
  const { controller, disabled } = props
  const ready = controller.status?.ready === true
  const running = controller.running

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button
        type="button"
        data-kb-ocr-detect
        style={button}
        disabled={disabled || running}
        onClick={() => void controller.refresh()}
      >
        检测
      </button>
      {running ? (
        <button
          type="button"
          data-kb-ocr-cancel
          style={button}
          disabled={disabled}
          onClick={() => void controller.cancel()}
        >
          取消下载
        </button>
      ) : (
        <button
          type="button"
          data-kb-ocr-download={ready ? 'present' : 'missing'}
          style={primaryButton}
          disabled={disabled || ready || controller.status === undefined}
          onClick={() => void controller.start()}
        >
          {ready ? '语言包已就绪' : '下载语言包'}
        </button>
      )}
    </span>
  )
}

/** One line describing what the last check found. */
function statusLine(status: OcrStatusView | undefined): string {
  if (status === undefined) return '正在读取本地语言包状态…'
  if (status.ready) {
    return `语言包已就绪（${status.packs.map(pack => `${pack.lang} ${formatBytes(pack.bytes)}`).join(' · ')}），图片可以离线识别。`
  }
  return `缺少 ${status.missing.join('、')} 语言包，需要下载约 ${formatBytes(status.fetchBytes)}。`
}

/**
 * The OCR block on the settings page.
 *
 * The sentence about where recognition happens is not decoration: the plan's
 * rule is that image text is recognized locally and the plugin never sends a
 * picture anywhere (`HANDOFF.md` §16 ⑦), and a user who is about to download a
 * model is entitled to read that before they press the button.
 */
export function OcrSection(props: {
  controller: OcrController
  disabled: boolean
}): React.ReactElement {
  const { controller, disabled } = props
  return (
    <div data-kb-ocr-section style={{ padding: 10, marginBottom: 12, border: `1px solid ${COLORS.border}`, borderRadius: 8, background: COLORS.surface }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: COLORS.muted }}>图片文字识别（OCR）</span>
        <Controls controller={controller} disabled={disabled} />
      </div>
      <p data-kb-ocr-status={controller.status?.ready === true ? 'ready' : 'missing'} style={{ fontSize: 12, margin: 0, color: COLORS.muted }}>
        {statusLine(controller.status)}
      </p>
      {controller.status !== undefined && (
        <p style={{ fontSize: 11, color: COLORS.muted, margin: '4px 0 0', wordBreak: 'break-all' }}>
          语言包目录：{controller.status.dir}
        </p>
      )}
      {controller.status !== undefined && controller.status.ready && (
        <p style={{ fontSize: 11, color: COLORS.muted, margin: '4px 0 0' }}>
          识别在你的电脑上完成，图片不会被上传；语言包只在点「下载语言包」时从 CDN 取一次。
        </p>
      )}
      {controller.download !== undefined && controller.download.state !== 'idle' && (
        <div style={{ marginTop: 6 }}>
          {controller.error === '' && controller.download.message !== '' && (
            <p style={{ fontSize: 12, margin: 0, color: controller.download.state === 'failed' ? COLORS.warn : COLORS.muted }}>
              {controller.download.message}
            </p>
          )}
          {controller.running && <Progress download={controller.download} />}
        </div>
      )}
      {controller.error !== '' && (
        <p style={{ fontSize: 12, margin: '6px 0 0', color: COLORS.warn }}>{controller.error}</p>
      )}
    </div>
  )
}

/**
 * The line that appears when an image is uploaded and the packs are missing.
 *
 * It is not a nag: it is the answer to the question the user is about to ask
 * ("why is my screenshot 暂不可检索?"), placed next to the file list they are
 * looking at. It carries a real download button rather than a pointer to
 * another part of the page, so acting on it costs one click.
 */
export function OcrHint(props: {
  controller: OcrController
  disabled: boolean
}): React.ReactElement {
  const { controller, disabled } = props
  return (
    <div
      data-kb-ocr-hint
      style={{
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        background: COLORS.subtle,
        padding: '8px 10px',
        marginTop: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12, color: COLORS.muted }}>
          刚上传的图片要等 OCR 语言包就绪后才能检索；下载完点上面的「重扫」就会入库
          （约 4.5 MB，在你本机识别，图片不会上传）。
        </span>
        <Controls controller={controller} disabled={disabled} />
      </div>
      {controller.download !== undefined && (controller.running || controller.download.message !== '') && (
        <div style={{ marginTop: 4 }}>
          {controller.download.message !== '' && (
            <p style={{ fontSize: 11, margin: 0, color: COLORS.muted }}>{controller.download.message}</p>
          )}
          {controller.running && <Progress download={controller.download} />}
        </div>
      )}
    </div>
  )
}
