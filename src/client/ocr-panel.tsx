/**
 * The OCR language-pack controls, in the hand-off's shape.
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
 * The same controls appear twice — in the OCR card and, when an image is
 * uploaded without the packs, next to the file it concerns. Both are driven by
 * one {@link OcrController} the page holds, so the two places cannot show two
 * different states of the same download (which is exactly what two independent
 * pollers would do).
 *
 * ## The two sets of hooks
 *
 * The hand-off names the card's controls `data-kb-ocr-*` and the file block's
 * `data-kb-files-*`, and that split is kept: one button answering both selectors
 * would make every assertion about "the download button" ambiguous. The result
 * message is `data-kb-ocr-hint` on the card, which is where the hand-off puts
 * it — the sentence beside the file list is a different element
 * (`data-kb-files-hint`) doing a different job.
 *
 * @module @domitor-syh/dsh-knowbase/client/ocr-panel
 */

import * as React from 'react'
import type { OcrDownloadStateView, OcrStatusView } from '../remote.ts'
import { knowbaseApi } from './api.ts'
import { Icon, type IconName } from './icons.tsx'

/**
 * How often the page asks where the download is.
 *
 * Fast enough that a 30-second download looks like a progress bar rather than a
 * sequence of jumps; slow enough that polling is not the busiest thing the Host
 * is doing.
 */
const POLL_MS = 400

/** Human-readable byte size. */
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

/** Which copy of the shared controls this is, and therefore which hooks it carries. */
type ControlsScope = 'ocr' | 'files'

/** The progress bar, drawn only while there is something to watch. */
function Progress(props: {
  download: OcrDownloadStateView
  scope: ControlsScope
}): React.ReactElement {
  const { download, scope } = props
  const percent =
    download.totalBytes > 0
      ? Math.min(100, Math.round((download.downloadedBytes / download.totalBytes) * 100))
      : 0
  return (
    <div
      className="kb-progress"
      {...(scope === 'ocr'
        ? { 'data-kb-ocr-progress': download.state }
        : { 'data-kb-files-progress': download.state })}
    >
      <div className="kb-progress-track">
        <div className="kb-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="kb-progress-text">
        {formatBytes(download.downloadedBytes)} / {formatBytes(download.totalBytes)}（{percent}%）
        {download.lang === '' ? '' : ` · 正在下载 ${download.lang}`}
      </p>
    </div>
  )
}

/** The buttons and progress: the controls both places share. */
function Controls(props: {
  controller: OcrController
  disabled: boolean
  scope: ControlsScope
}): React.ReactElement {
  const { controller, disabled, scope } = props
  const ready = controller.status?.ready === true
  const running = controller.running
  const state = ready ? 'present' : 'missing'

  return (
    <>
      <div className="kb-btn-row">
        <button
          type="button"
          className="kb-btn"
          {...{ [`data-kb-${scope}-detect`]: '' }}
          disabled={disabled || running}
          onClick={() => void controller.refresh()}
        >
          <Icon name="refresh" />
          检测
        </button>
        {/* Hidden rather than unmounted while a download runs — the hand-off's own
            state machine, and it keeps the row from reflowing mid-download. */}
        <button
          type="button"
          className="kb-btn kb-btn--primary"
          {...{ [`data-kb-${scope}-download`]: state }}
          hidden={running}
          disabled={disabled || ready || controller.status === undefined}
          onClick={() => void controller.start()}
        >
          <Icon name="download" />
          {ready ? '语言包已就绪' : '下载语言包'}
        </button>
        <button
          type="button"
          className="kb-btn kb-btn--danger"
          {...{ [`data-kb-${scope}-cancel`]: '' }}
          hidden={!running}
          disabled={disabled}
          onClick={() => void controller.cancel()}
        >
          <Icon name="x" />
          取消下载
        </button>
      </div>
      {running && controller.download !== undefined && (
        <Progress download={controller.download} scope={scope} />
      )}
    </>
  )
}

/** The status line, as the three states the hand-off draws. */
function statusLine(status: OcrStatusView | undefined): {
  state: 'reading' | 'ready' | 'missing'
  icon: IconName
  text: string
} {
  if (status === undefined) {
    return { state: 'reading', icon: 'loader', text: '正在读取本地语言包状态…' }
  }
  if (status.ready) {
    return {
      state: 'ready',
      icon: 'check-circle',
      text: `语言包已就绪（${status.packs
        .map(pack => `${pack.lang} ${formatBytes(pack.bytes)}`)
        .join(' · ')}），图片可以离线识别。`,
    }
  }
  return {
    state: 'missing',
    icon: 'alert-triangle',
    text: `缺少 ${status.missing.join('、')} 语言包，需要下载约 ${formatBytes(status.fetchBytes)}。`,
  }
}

/**
 * The OCR card.
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
  const line = statusLine(controller.status)
  const download = controller.download
  const result = controller.error !== '' ? controller.error : (download?.message ?? '')
  const tone =
    controller.error !== '' || download?.state === 'failed'
      ? 'warn'
      : download?.state === 'done'
        ? 'ok'
        : ''

  return (
    <section className="kb-card" data-kb-ocr-section aria-labelledby="kb-ocr-title">
      <h2 className="kb-card-title" id="kb-ocr-title">
        图片文字识别（OCR）
      </h2>
      <p
        className={`kb-status kb-status--${line.state}`}
        data-kb-ocr-status={line.state === 'ready' ? 'ready' : 'missing'}
      >
        <Icon name={line.icon} />
        <span>{line.text}</span>
      </p>
      <div className="kb-ocr-actions">
        <Controls controller={controller} disabled={disabled} scope="ocr" />
      </div>
      {result !== '' && (
        <p className={`kb-msg${tone === '' ? '' : ` kb-msg--${tone}`}`} data-kb-ocr-hint>
          <Icon name={tone === 'ok' ? 'check' : tone === 'warn' ? 'alert-triangle' : 'info'} />
          <span>{result}</span>
        </p>
      )}
      {controller.status !== undefined && (
        <p className="kb-ocr-dir">语言包目录：{controller.status.dir}</p>
      )}
      {controller.status?.ready === true && (
        <p className="kb-ocr-privacy">
          <Icon name="lock" />
          <span>识别在你的电脑上完成，图片不会被上传；语言包只在点「下载语言包」时从 CDN 取一次。</span>
        </p>
      )}
    </section>
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
  const message = controller.download?.message ?? ''
  return (
    <div className="kb-inline-hint" data-kb-files-hint>
      <p>
        刚上传的图片要等 OCR 语言包就绪后才能检索；下载完点上面的「重扫」就会入库
        （约 4.5 MB，在你本机识别，图片不会上传）。
      </p>
      <Controls controller={controller} disabled={disabled} scope="files" />
      {message !== '' && controller.running !== true && <p>{message}</p>}
    </div>
  )
}
