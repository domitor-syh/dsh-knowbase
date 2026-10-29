/**
 * The knowledge base page.
 *
 * Rendered in the host's centre column by `./panel.tsx`; the module was called
 * `settings-page` while the page lived in the settings shell, and the seat is
 * the only thing that changed.
 *
 * ## What this page is
 *
 * A file manager over a folder. A base IS a directory in the vault, and every
 * file in it is a material — so the page's job is to list what is there, let the
 * user put more in, and take things out. There is no text editor and no recycle
 * bin: files belong to the user's own explorer, and deleting means the file is
 * moved into the vault's `_回收站` folder, which is a plain folder the user can
 * drag things back out of.
 *
 * The 「重扫」 button, and the row menu's 「从文件资源管理器打开」, are what make
 * the user's own explorer a supported way in: drop a document into the base's
 * folder, press it, and the file appears.
 *
 * ## Shape
 *
 * The layout follows the host's management pages: title and add action, a
 * full-width retrieval toolbar, then the base list and selected base's files.
 * Scan diagnostics and OCR follow in a separate utility area. Existing menus,
 * controls and the centred confirmation modals keep their original behavior.
 *
 * Styling is a stylesheet (`./page-style.ts`), not inline objects: the hand-off
 * states hover, focus, disabled and reduced-motion behaviour, and a page this
 * size is exactly the case where a stylesheet is the smaller artefact.
 *
 * One thing leaves the page: a row's ⋯ menu, which is drawn into `document.body`
 * so it is not clipped by the scrolling list it hangs off (see `RowMenu`).
 *
 * ## The hooks
 *
 * `data-kb-*` attributes are the page's test surface (`scripts/probe-*.mjs`).
 * They are on the element that owns the behaviour, never on a wrapper, and no
 * hook name appears twice — a selector that matches two elements makes every
 * assertion written against it ambiguous.
 *
 * @module @domitor-syh/dsh-knowbase/client/knowbase-page
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import type { KnowledgeBaseView, MaterialView, SearchReportView, ShellInfoView } from '../remote.ts'
import { knowbaseApi, knowbaseChannelError } from './api.ts'
import { Icon } from './icons.tsx'
import { OcrHint, OcrSection, useOcrController } from './ocr-panel.tsx'
import { pageTokens } from './page-style.ts'
import { ScopePicker } from './scope-picker.tsx'
import { SearchResultsPopover } from './search-results-popover.tsx'
import { MaterialStatus } from './material-status.tsx'
import { ScanSummary } from './scan-summary.tsx'
import { useSpin } from './spin.ts'
import { useColorScheme } from './theme.ts'
import { localizeError, localizeLocator, useUiText } from './ui-locale.ts'
import { pageMessage, pageFileManager, pageFormat, renderPageMessage, type PageMessage } from './page-locale.ts'

/**
 * Largest file the browser may push through the Remote channel.
 *
 * Mirrors `MAX_UPLOAD_BYTES` on the Host. It is duplicated rather than fetched
 * so the page can refuse an oversized pick before reading it into memory at all
 * — the Host's own check would only run after the bytes had already crossed.
 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/**
 * Extensions the Host runs OCR on.
 *
 * Mirrored from the core's own list for the same reason as
 * `MAX_UPLOAD_BYTES`: the page needs the answer before making any call, to
 * decide whether the upload it just made warrants the pack hint.
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg'])

/** A file name's extension, lower-cased and without the dot; `''` when none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Report a failure without letting it escape into React's error path. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Human-readable byte size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * What one Host call left behind for the user to read.
 *
 * The hand-off draws one alert in two tones — a failure is the same strip with
 * a triangle and the error colour — so an action reports which tone its
 * sentence deserves rather than the page guessing from the text. A mixed upload
 * is the case that needs it: files went in *and* files were refused, and the
 * hand-off colours that as a failure.
 */
interface Outcome {
  readonly text: PageMessage
  readonly kind: 'notice' | 'error'
}

/** A sentence that reports success. */
function note(text: PageMessage): Outcome {
  return { text, kind: 'notice' }
}

/** A sentence that reports something the user should look at. */
function problem(text: PageMessage): Outcome {
  return { text, kind: 'error' }
}

/** One step that must ask before it acts. */
type Dialog =
  | { readonly kind: 'new' }
  | { readonly kind: 'rename'; readonly id: string }
  | { readonly kind: 'deleteBase'; readonly id: string }
  | { readonly kind: 'deleteFile'; readonly id: string }

/** Floating page-local feedback; each new message lives for three seconds. */
function Alert(props: { text: string; kind: 'notice' | 'error'; revision: number }): React.ReactElement {
  const [shown, setShown] = React.useState(false)
  const { text, kind, revision } = props
  const hasText = text !== ''

  React.useEffect(() => {
    setShown(hasText)
    if (!hasText) return
    const timer = window.setTimeout(() => setShown(false), 3000)
    return () => window.clearTimeout(timer)
  }, [hasText, kind, revision])

  return (
    <div
      className={`kb-alert kb-alert--${kind}`}
      data-kb-alert
      role="status"
      aria-live="polite"
      hidden={!shown}
    >
      <Icon name={kind === 'error' ? 'alert-triangle' : 'check-circle'} />
      <span>{shown ? text : ''}</span>
    </div>
  )
}

function ProgressOverlay(props: { text: string }): React.ReactElement | null {
  if (props.text === '') return null
  return (
    <div className="kb-progress-overlay" data-kb-progress role="status" aria-live="polite" aria-busy="true">
      <div className="kb-progress-dialog">
        <Icon name="loader" spinning />
        <span>{props.text}</span>
      </div>
    </div>
  )
}

/**
 * The centred modal every destructive step goes through.
 *
 * Backdrop click closes it, but only when the click is on the backdrop itself —
 * `event.target === event.currentTarget` — because a click that started inside
 * the panel and ended on the overlay (a drag across the title, a text selection
 * released outside) must not discard what the user typed.
 */
function Modal(props: {
  title: string
  confirmText: string
  danger?: boolean
  confirmDisabled?: boolean
  onConfirm: () => void
  onClose: () => void
  children?: React.ReactNode
}): React.ReactElement {
  const tx = useUiText()
  return (
    <div
      className="kb-modal-overlay"
      data-kb-modal
      onClick={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div className="kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-modal-title">
        <h3 className="kb-modal-title" id="kb-modal-title" data-kb-modal-title>
          {props.title}
        </h3>
        <div className="kb-modal-body" data-kb-modal-body>
          {props.children}
        </div>
        <div className="kb-modal-actions">
          <button type="button" className="kb-btn" data-kb-modal-cancel onClick={props.onClose}>
            {tx('取消', 'Cancel')}
          </button>
          <button
            type="button"
            className={`kb-btn ${props.danger === true ? 'kb-btn--danger' : 'kb-btn--primary'}`}
            data-kb-modal-confirm
            disabled={props.confirmDisabled === true}
            onClick={props.onConfirm}
          >
            {props.confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The name field inside the add / rename dialogs.
 *
 * Focused and selected on mount, and Enter commits: the whole dialog exists to
 * capture one string, so the user should be able to type it and press Enter
 * without ever touching the mouse.
 *
 * `showLabel` is off for the add dialog, whose label and placeholder are the
 * same words twice; the string still reaches assistive technology through
 * `aria-label`, and the rename dialog keeps its label because there the value is
 * a name the user has already met and the label is what says which one.
 */
function NameField(props: {
  id: string
  label: string
  showLabel?: boolean
  placeholder?: string
  value: string
  onChange: (value: string) => void
  onEnter: () => void
}): React.ReactElement {
  const ref = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    const node = ref.current
    if (node === null) return
    node.focus()
    node.select()
  }, [])

  return (
    <>
      {props.showLabel !== false && (
        <label className="kb-field-label" htmlFor={props.id}>
          {props.label}
        </label>
      )}
      <input
        id={props.id}
        ref={ref}
        type="text"
        className="kb-input"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.label}
        autoComplete="off"
        onChange={event => props.onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            props.onEnter()
          }
        }}
      />
    </>
  )
}

/** One menu item's height, in the stylesheet's own numbers. */
const MENU_ITEM_HEIGHT = 32
/** The menu's padding (6px twice) and its 1px border. */
const MENU_CHROME = 14
/** The menu's `min-width`; also what keeps it inside the window when anchoring. */
const MENU_WIDTH = 148
/** How far the menu sits from the button it belongs to. */
const MENU_GAP = 4

/** Where the menu goes, in viewport coordinates. */
interface MenuAt {
  readonly top: number
  readonly right: number
}

/**
 * Place a menu against its trigger.
 *
 * Below the button when there is room and above it otherwise — the last row of a
 * long list is exactly the case where "below" runs off the bottom. The height is
 * computed from the item count instead of measured so the first painted frame is
 * already in the right place.
 */
function menuPosition(anchor: HTMLElement, items: number): MenuAt {
  const rect = anchor.getBoundingClientRect()
  const height = items * MENU_ITEM_HEIGHT + MENU_CHROME
  const below = rect.bottom + MENU_GAP
  const top =
    below + height + 8 <= window.innerHeight ? below : Math.max(8, rect.top - height - MENU_GAP)
  const right = Math.min(
    Math.max(8, window.innerWidth - rect.right),
    window.innerWidth - MENU_WIDTH - 8,
  )
  return { top, right }
}

/**
 * One base's ⋯ menu.
 *
 * Drawn into `document.body` rather than into the row. `.kb-lib-list` scrolls,
 * and a scrolling box clips on both axes, so a menu inside it is cut off
 * mid-item the moment it reaches past the list — which is what a menu on the
 * last row always does. `position: fixed` alone would not help: the page itself
 * clips (`#kb-settings-page { overflow: hidden }`). So the menu leaves the
 * subtree entirely, the same choice the composer popover makes.
 *
 * It carries the page's tokens because the `--brand-*` custom properties are
 * declared on the page container, and a portal is not inside it.
 */
function RowMenu(props: {
  anchor: HTMLElement
  /** How many items it will draw; the position depends on it. */
  items: number
  fileManager: string
  canReveal: boolean
  onRename: () => void
  onReveal: () => void
  onDelete: () => void
}): React.ReactElement {
  const tx = useUiText()
  const { anchor, items } = props
  const scheme = useColorScheme()
  const [at, setAt] = React.useState<MenuAt>(() => menuPosition(anchor, items))

  // Follow the button: the list scrolls under it, and the window resizes.
  React.useEffect(() => {
    const update = (): void => {
      // A row can be re-rendered out of the document under us (the list is
      // re-read after every change); a detached node measures as all zeros.
      if (!anchor.isConnected) return
      setAt(menuPosition(anchor, items))
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, items])

  return createPortal(
    <div
      className="kb-menu"
      data-kb-menu
      role="menu"
      style={{ ...pageTokens(scheme), position: 'fixed', top: at.top, right: at.right }}
    >
      <button
        type="button"
        className="kb-menu-item"
        data-kb-menu-item="rename"
        role="menuitem"
        onClick={props.onRename}
      >
        <Icon name="pencil" />
        <span>{tx('重命名', 'Rename')}</span>
      </button>
      {/* Offered only where the desktop has something to open it with; the
          sentence that follows a click is the file manager's own name, so it is
          read before the item is drawn rather than guessed at. */}
      {props.canReveal && (
        <button
          type="button"
          className="kb-menu-item"
          data-kb-menu-item="reveal"
          role="menuitem"
          onClick={props.onReveal}
        >
          <Icon name="folder-open" />
          <span>{pageFormat(tx('从{manager}打开', 'Open in {manager}'), { manager: pageFileManager(props.fileManager, tx) })}</span>
        </button>
      )}
      <button
        type="button"
        className="kb-menu-item kb-menu-item--danger"
        data-kb-menu-item="delete"
        role="menuitem"
        onClick={props.onDelete}
      >
        <Icon name="trash" />
        <span>{tx('删除知识库', 'Delete knowledge base')}</span>
      </button>
    </div>,
    document.body,
  )
}

/**
 * Render a retrieval report.
 *
 * The scope note is passed in rather than derived from the report: the Host
 * reports what it found, not what it was asked to search, and a miss has to say
 * *where* it looked — "nothing matched in this one base" and "nothing matched in
 * all seven" are different answers.
 */
export function RetrievalReport(props: { report: SearchReportView; scopeNote: string }): React.ReactElement {
  const tx = useUiText()
  const { report, scopeNote } = props
  const summary = <div className="kb-report-overview">
    <span className="kb-report-scope">{scopeNote}</span>
    <span className="kb-report-summary">
      {report.outcome === 'hits' ? pageFormat(tx('{count} 个片段 · ', report.passages.length === 1 ? '{count} passage · ' : '{count} passages · '), { count: String(report.passages.length) }) : ''}{report.elapsedMs} ms
    </span>
  </div>

  if (report.outcome !== 'hits') {
    const text: Record<string, string> = {
      no_match: tx('未找到相关片段，试试更换关键词。', 'No relevant passages found. Try different keywords.'),
      empty_scope: tx('所选知识库不存在或为空。', 'The selected knowledge bases are missing or empty.'),
      not_ready: tx('所选知识库还没有可检索的文件。上传资料并完成扫描后再试。', 'The selected knowledge bases have no searchable files yet. Upload materials and complete a scan, then try again.'),
      error: pageFormat(tx('检索失败：{reason}', 'Search failed: {reason}'), { reason: localizeError(report.reason ?? '') }),
    }
    return <div className="kb-report" data-kb-test-report>
      {summary}
      <p className="kb-report-status">{text[report.outcome] ?? report.outcome}</p>
    </div>
  }

  return (
    <div className="kb-report" data-kb-test-report>
      {summary}
      <ol className="kb-hit-list">
        {report.passages.map((passage, index) => (
          <li key={`${passage.materialTitle}-${passage.locator}-${index}`} className="kb-hit">
            <h3 className="kb-hit-title">{passage.materialTitle}</h3>
            <p className="kb-hit-source">{passage.kbName} · {localizeLocator(passage.locator)}</p>
            <p className="kb-hit-body" data-kb-report-passage>{passage.text}</p>
          </li>
        ))}
      </ol>
      <details className="kb-report-details">
        <summary>{tx('检索详情', 'Search details')}</summary>
        <ul className="kb-report-metrics">
          {report.passages.map((passage, index) => (
            <li key={`${passage.materialTitle}-${passage.locator}-${index}`}>
              <span>{passage.kbName} / {passage.materialTitle} · {localizeLocator(passage.locator)}</span>
              <span>{pageFormat(tx('score {score} · 覆盖 {coverage}%', 'score {score} · coverage {coverage}%'), { score: passage.score.toFixed(2), coverage: String(Math.round(passage.coverage * 100)) })}</span>
            </li>
          ))}
        </ul>
        <p className="kb-report-foot">{tx('score 只在同一次提问内可比；覆盖偏低说明命中的查询词少，片段可能只是碰巧重叠。', 'Scores are comparable only within the same query. Low coverage means few query terms matched; the overlap may be coincidental.')}</p>
      </details>
    </div>
  )
}

/** The knowledge base page body. */
export function KnowbasePage(): React.ReactElement {
  const tx = useUiText()
  const scheme = useColorScheme()

  const [bases, setBases] = React.useState<readonly KnowledgeBaseView[]>([])
  const [selectedId, setSelectedId] = React.useState<string>('')
  const [materials, setMaterials] = React.useState<readonly MaterialView[]>([])
  const [report, setReport] = React.useState<SearchReportView | undefined>(undefined)
  const [error, setErrorState] = React.useState<PageMessage>('')
  const [notice, setNoticeState] = React.useState<PageMessage>('')
  const [feedbackRevision, setFeedbackRevision] = React.useState(0)
  const setError = React.useCallback((text: PageMessage): void => {
    setErrorState(() => text)
    if (text !== '') setFeedbackRevision(value => value + 1)
  }, [])
  const setNotice = React.useCallback((text: PageMessage): void => {
    setNoticeState(() => text)
    if (text !== '') setFeedbackRevision(value => value + 1)
  }, [])
  const [busy, setBusy] = React.useState(false)
  const [progressText, setProgressText] = React.useState<PageMessage>('')
  const [vaultRoot, setVaultRoot] = React.useState('')
  const [shell, setShell] = React.useState<ShellInfoView | undefined>(undefined)

  const [query, setQuery] = React.useState('')
  // Retrieval test scope. The chat seam searches a set of bases, so a panel
  // fixed to one base cannot answer "what would be sent?" for a multi-base
  // session — the question the panel exists to answer.
  const [testAll, setTestAll] = React.useState(false)

  const [dialog, setDialog] = React.useState<Dialog | undefined>(undefined)
  const [draftName, setDraftName] = React.useState('')
  /**
   * The open row menu: which base it belongs to, and the button it hangs off.
   *
   * The anchor travels with the id because the menu is drawn into
   * `document.body` — once it is out of the row it can no longer ask React for
   * the element it was opened from.
   */
  const [menu, setMenu] = React.useState<{ id: string; anchor: HTMLElement } | undefined>(undefined)
  const [rescanAllSpinning, spinAll] = useSpin()
  const [rescanCurrentSpinning, spinCurrent] = useSpin()

  const uploadInput = React.useRef<HTMLInputElement | null>(null)
  const searchRow = React.useRef<HTMLDivElement>(null)
  const queryInput = React.useRef<HTMLInputElement>(null)
  const closeResults = React.useCallback((): void => {
    setReport(undefined)
    queryInput.current?.focus({ preventScroll: true })
  }, [])

  // The OCR state lives at page level rather than inside the block, because the
  // same controls appear twice: once in the always-visible card and once, when
  // it matters, under the file list (see `./ocr-panel.tsx`).
  const ocr = useOcrController()
  // Set when an image was uploaded while the packs were missing. The hint
  // withdraws itself once a download makes `ocr.status.ready` true.
  const [ocrHint, setOcrHint] = React.useState(false)

  /** Run one Host call with shared busy handling; the sentence it returns is the alert. */
  const run = React.useCallback(async (action: () => Promise<Outcome>, progress?: PageMessage): Promise<void> => {
    const current = knowbaseApi()
    if (current === undefined) {
      setNotice('')
      setError(pageMessage('知识库通道尚未就绪，请稍候重试。', 'The knowledge base connection is not ready. Please try again shortly.'))
      return
    }
    setBusy(true)
    if (progress !== undefined) setProgressText(() => progress)
    setError('')
    setNotice('')
    try {
      const outcome = await action()
      if (outcome.kind === 'error') setError(outcome.text)
      else setNotice(outcome.text)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      if (progress !== undefined) setProgressText('')
      setBusy(false)
    }
  }, [])

  const detectOcr = React.useCallback(async (): Promise<void> => {
    await run(async () => {
      const status = await ocr.refresh({ throwOnError: true })
      if (status === undefined) throw new Error('知识库通道尚未就绪，请稍候重试。')
      return note(status.ready
        ? pageMessage('检测完成：OCR 语言包已就绪，图片可以离线识别。', 'Check complete: OCR language packs are ready for offline image recognition.')
        : pageMessage(`检测完成：缺少 ${status.missing.join('、')} 语言包，请点击「下载语言包」。`, `Check complete: missing ${status.missing.join(', ')} language packs. Select “Download language packs”.`))
    })
  }, [ocr.refresh, run])

  const refreshBases = React.useCallback(async (): Promise<void> => {
    const current = knowbaseApi()
    if (current === undefined) return
    const list = await current.listKnowledgeBases()
    setBases(list)
    setSelectedId(existing =>
      list.some(item => item.id === existing) ? existing : (list[0]?.id ?? ''),
    )
  }, [])

  /**
   * Push the picked files into the selected base.
   *
   * Oversized files are refused here, before they are read, and reported by
   * name: the remedy is the same one the Host would give (drop it into the
   * folder instead), and saying it now avoids a pointless transfer.
   */
  const uploadFiles = React.useCallback(
    async (files: readonly File[]): Promise<void> => {
      const kbId = selectedId
      if (kbId === '') return
      const current = knowbaseApi()
      if (current === undefined) {
        setNotice('')
        setError(pageMessage('知识库通道尚未就绪，请稍候重试。', 'The knowledge base connection is not ready. Please try again shortly.'))
        return
      }
      await run(async () => {
        const tooBig: string[] = []
        const accepted: { name: string; bytes: Uint8Array }[] = []
        for (const file of files) {
          if (file.size > MAX_UPLOAD_BYTES) {
            tooBig.push(file.name)
            continue
          }
          accepted.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
        }

        if (accepted.length === 0) {
          return problem(pageMessage(
            `有 ${tooBig.length} 个文件过大（超过 ${formatBytes(MAX_UPLOAD_BYTES)}），请把它们直接放进知识库文件夹。`,
            `${tooBig.length} ${tooBig.length === 1 ? 'file exceeds' : 'files exceed'} ${formatBytes(MAX_UPLOAD_BYTES)}. Add them directly to the knowledge base folder.`,
          ))
        }
        const result = await current.addFiles(kbId, accepted)
        setMaterials(await current.listMaterials(kbId))
        await refreshBases()
        if (accepted.some(file => IMAGE_EXTENSIONS.has(extensionOf(file.name)))) {
          // Asked here, at the moment the user is looking at the file they just
          // added, which is the only moment the question "can this screenshot
          // be searched?" is actually being asked. `refresh` is a read — two
          // `stat` calls — and never a download.
          setOcrHint((await ocr.refresh())?.ready !== true)
        }
        const sentence: PageMessage = tx => {
          const parts = [pageFormat(tx('已加入 {count} 个文件', result.added === 1 ? '{count} file added' : '{count} files added'), { count: String(result.added) })]
          if (result.rejected.length > 0) parts.push(pageFormat(tx('{count} 个被拒绝', '{count} rejected'), { count: String(result.rejected.length) }))
          for (const file of tooBig) parts.push(pageFormat(tx('「{name}」太大，未上传', '“{name}” is too large and was not uploaded'), { name: file }))
          return parts.join(tx('，', ', ')) + tx('。', '.')
        }
        // A mixed result is coloured as a failure: the hand-off's own reading is
        // that a file the user chose did not go in, and that is worth looking at
        // even though the rest succeeded.
        return tooBig.length > 0 || result.rejected.length > 0
          ? problem(sentence)
          : note(sentence)
      }, pageMessage(`正在上传并扫描 ${files.length} 个文件…`, `Uploading and scanning ${files.length} ${files.length === 1 ? 'file' : 'files'}…`))
    },
    [ocr.refresh, refreshBases, run, selectedId],
  )

  // The channel mounts asynchronously, so the first render has no API yet. The
  // interval also surfaces a mounting failure: a page whose buttons do nothing
  // should say why without the user opening developer tools.
  React.useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const current = knowbaseApi()
      if (current === undefined) return
      try {
        const [list, root, shellInfo] = await Promise.all([
          current.listKnowledgeBases(),
          current.getVaultRoot(),
          current.getShellInfo(),
        ])
        if (cancelled) return
        setBases(list)
        setVaultRoot(root)
        setShell(shellInfo)
        setSelectedId(existing =>
          list.some(item => item.id === existing) ? existing : (list[0]?.id ?? ''),
        )
        // Read the OCR packs in the same pass. Without this the card sits on
        // 「正在读取本地语言包状态…」 with its button disabled until someone
        // presses 检测, which reads as a broken panel rather than an unread one.
        // It is a read — two `stat` calls — and the download still only ever
        // starts from the button that says it does.
        void ocr.refresh()
      } catch (failure) {
        if (!cancelled) setError(messageOf(failure))
      }
    }
    void load()
    const timer = window.setInterval(() => {
      const failure = knowbaseChannelError()
      if (failure !== undefined) {
        window.clearInterval(timer)
        setError(tx => pageFormat(tx('知识库通道挂载失败：{reason}', 'Knowledge base connection failed to mount: {reason}'), { reason: localizeError(failure) }))
        return
      }
      if (knowbaseApi() !== undefined) {
        window.clearInterval(timer)
        void load()
      }
    }, 500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [ocr.refresh])

  React.useEffect(() => {
    let cancelled = false
    const current = knowbaseApi()
    if (current === undefined || selectedId === '') {
      setMaterials([])
      return
    }
    void current
      .listMaterials(selectedId)
      .then(list => {
        if (!cancelled) setMaterials(list)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(messageOf(failure))
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, bases])

  // Closing the row menu. Both listeners are installed only while one is open,
  // so a page with no menu pays nothing for them.
  React.useEffect(() => {
    if (menu === undefined) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      // The trigger's own click toggles; a click inside the menu is the menu's.
      if (target.closest('[data-kb-menu]') !== null) return
      if (target.closest('[data-kb-lib-more]') !== null) return
      setMenu(undefined)
    }
    document.addEventListener('click', onDown)
    return () => document.removeEventListener('click', onDown)
  }, [menu])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (dialog !== undefined) {
        event.preventDefault()
        setDialog(undefined)
        return
      }
      if (menu !== undefined) {
        event.preventDefault()
        setMenu(undefined)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog, menu])

  const selected = bases.find(item => item.id === selectedId)
  const folderPath =
    selected === undefined || vaultRoot === '' ? '' : `${vaultRoot}\\${selected.folderName}`

  /** Which bases the retrieval test searches, and what to call that set. */
  const testBases = testAll
    ? bases.map(item => item.id)
    : selected === undefined
      ? []
      : [selected.id]
  const testFileCount = testAll
    ? bases.reduce((sum, item) => sum + item.indexedCount, 0)
    : selected?.indexedCount ?? 0
  const testScopeNote = testAll
    ? pageFormat(tx('检索范围：全部 {count} 个知识库，共 {files} 个可检索文件', `Scope: all {count} knowledge ${bases.length === 1 ? 'base' : 'bases'}, {files} searchable ${testFileCount === 1 ? 'file' : 'files'}`), { count: String(bases.length), files: String(testFileCount) })
    : pageFormat(tx('检索范围：「{name}」，共 {files} 个可检索文件', `Scope: “{name}”, {files} searchable ${testFileCount === 1 ? 'file' : 'files'}`), { name: selected?.name ?? '', files: String(testFileCount) })

  /** Run the retrieval test over the chosen scope, without calling the model. */
  const submitTest = (): void => {
    if (busy || query.trim() === '' || testBases.length === 0) return
    void run(async () => {
      setReport(await knowbaseApi()!.testSearch(query, testBases))
      return note('')
    })
  }

  /** Switch the selected base and close the retrieval report. */
  const selectBase = (id: string): void => {
    if (busy || id === selectedId) return
    setSelectedId(id)
    setReport(undefined)
    setMenu(undefined)
  }

  /** Re-read one base — or every base — from the disk. */
  const rescan = (kbId: string): void => {
    const all = kbId === ''
    const start = all ? spinAll : spinCurrent
    start(async () => {
      await run(async () => {
        const current = knowbaseApi()!
        await current.rescan(kbId)
        await refreshBases()
        if (all || kbId === selectedId) {
          setMaterials(await current.listMaterials(all ? selectedId : kbId))
        }
        return note(all ? pageMessage('已重新扫描全部知识库。', 'All knowledge bases rescanned.') : pageMessage('已重新扫描该知识库。', 'Knowledge base rescanned.'))
      }, all ? pageMessage('正在扫描全部知识库…', 'Scanning all knowledge bases…') : pageMessage('正在扫描当前知识库…', 'Scanning the current knowledge base…'))
    })
  }

  /** Hand one base's folder to the desktop's file manager. */
  const reveal = (kbId: string): void => {
    setMenu(undefined)
    void run(async () => {
      const result = await knowbaseApi()!.revealBaseFolder(kbId)
      if (!result.ok) throw new Error(result.message)
      return note(tx => pageFormat(tx('已在{manager}中打开：{path}', 'Opened in {manager}: {path}'), { manager: pageFileManager(result.fileManager, tx), path: result.path }))
    })
  }

  /** Open the add / rename dialog, resetting the field it carries. */
  const openDialog = (next: Dialog, initial: string): void => {
    setMenu(undefined)
    setDraftName(initial)
    setDialog(next)
  }

  /**
   * Commit whatever the open dialog asked about.
   *
   * The dialog closes before the call rather than after: a failure has to be
   * readable, and the notice strip sits under the overlay, so a modal left open
   * on an error would hide the very sentence explaining it.
   */
  const confirmDialog = (): void => {
    const open = dialog
    if (open === undefined || busy) return
    const name = draftName.trim()

    if (open.kind === 'new') {
      if (name === '') return
      setDialog(undefined)
      void run(async () => {
        const created = await knowbaseApi()!.createKnowledgeBase(name, '')
        await refreshBases()
        setSelectedId(created.id)
        setReport(undefined)
        return note(pageMessage(`已创建「${created.name}」，文件夹：${created.folderName}。`, `Created “${created.name}”; folder: ${created.folderName}.`))
      })
      return
    }

    if (open.kind === 'rename') {
      const target = bases.find(item => item.id === open.id)
      if (target === undefined || name === '') return
      setDialog(undefined)
      if (name === target.name) return
      void run(async () => {
        await knowbaseApi()!.renameKnowledgeBase(open.id, name)
        await refreshBases()
        setReport(undefined)
        return note(pageMessage('重命名成功(文件夹名同改)', 'Renamed successfully (including the folder).'))
      })
      return
    }

    if (open.kind === 'deleteBase') {
      const target = bases.find(item => item.id === open.id)
      if (target === undefined) return
      setDialog(undefined)
      void run(async () => {
        await knowbaseApi()!.deleteKnowledgeBase(open.id)
        await refreshBases()
        setReport(undefined)
        return note(
          pageMessage(`已把「${target.name}」的文件夹移入 _回收站（没有销毁，需要时可在资源管理器里拖回来）。`, `Moved the folder for “${target.name}” to _回收站. You can restore it using your file manager.`),
        )
      }, pageMessage('正在删除知识库…', 'Deleting knowledge base…'))
      return
    }

    const kbId = selectedId
    const target = materials.find(item => item.id === open.id)
    if (target === undefined || kbId === '') return
    setDialog(undefined)
    void run(async () => {
      const current = knowbaseApi()!
      await current.deleteMaterial(kbId, target.id)
      setMaterials(await current.listMaterials(kbId))
      await refreshBases()
      return note(pageMessage(`已把「${target.fileName}」移入 _回收站。`, `Moved “${target.fileName}” to _回收站.`))
    }, pageMessage('正在删除文件…', 'Deleting file…'))
  }

  const dialogConfirmDisabled = (): boolean => {
    if (busy) return true
    if (dialog === undefined) return true
    if (dialog.kind === 'new' || dialog.kind === 'rename') return draftName.trim() === ''
    return false
  }

  const alertText = renderPageMessage(error !== '' ? error : notice, tx)

  return (
    <div
      id="kb-settings-page"
      data-kb-page
      data-kb-vault-root={vaultRoot}
      data-kb-folder-path={folderPath}
      style={pageTokens(scheme)}
    >
      <div className="kb-page-content">
      <header className="kb-head">
        <div>
          <h1 className="kb-head-title">{tx('知识库', 'Knowledge bases')}</h1>
          <p className="kb-head-description">{tx('管理本地资料，在会话中检索和引用。', 'Manage local materials to search and cite in conversations.')}</p>
        </div>
        <button
          type="button"
          className="kb-icon-btn kb-icon-btn--add kb-head-add"
          id="kb-new-toggle"
          data-kb-new-base
          aria-label={tx('添加知识库', 'Add knowledge base')}
          title={tx('添加知识库', 'Add knowledge base')}
          aria-haspopup="dialog"
          aria-expanded={dialog?.kind === 'new' ? 'true' : 'false'}
          disabled={busy}
          onClick={() => openDialog({ kind: 'new' }, '')}
        >
          <Icon name="plus" />
          {tx('添加知识库', 'Add knowledge base')}
        </button>
      </header>

      <div className="kb-retrieval-toolbar">
        <section className="kb-card" data-kb-retrieval-test aria-label={tx('检索测试', 'Search test')}>
          <div className="kb-search-row" ref={searchRow}>
            <ScopePicker
              value={testAll ? 'all' : 'base'}
              baseCount={bases.length}
              currentAvailable={selected !== undefined}
              disabled={busy}
              onChange={value => {
                setTestAll(value === 'all')
                setReport(undefined)
              }}
            />
            <input
              type="text"
              className="kb-input"
              id="kb-test-input"
              ref={queryInput}
              placeholder={tx('检索测试(不调用模型)，请输入一个问题', 'Enter a question to test retrieval (no model call)')}
              aria-label={tx('检索测试(不调用模型)，请输入一个问题', 'Enter a question to test retrieval (no model call)')}
              autoComplete="off"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitTest()
                } else if (event.key === 'Escape' && report !== undefined) {
                  event.preventDefault()
                  closeResults()
                }
              }}
            />
            <button
              type="button"
              className="kb-btn kb-btn--primary"
              id="kb-test-btn"
              disabled={busy || query.trim() === ''}
              onClick={submitTest}
            >
              <Icon name="search" />
              {tx('检索', 'Search')}
            </button>
          </div>
          {report !== undefined && <SearchResultsPopover anchor={searchRow} onClose={closeResults}>
            <RetrievalReport report={report} scopeNote={testScopeNote} />
          </SearchResultsPopover>}
        </section>
      </div>

      <div className="kb-columns">
        <aside className="kb-card" aria-label={tx('知识库列表', 'Knowledge base list')}>
          <div className="kb-left-sec">
            <div className="kb-left-head">
              <p className="kb-sec-label">
                {tx('全部知识库', 'All knowledge bases')} <span className="kb-sec-count" id="kb-lib-count">({bases.length})</span>
              </p>
              <button
                type="button"
                className="kb-icon-btn"
                id="kb-rescan-all"
                data-kb-rescan-all
                aria-label={tx('重扫全部知识库', 'Rescan all knowledge bases')}
                title={tx('重扫全部知识库', 'Rescan all knowledge bases')}
                disabled={busy}
                onClick={() => rescan('')}
              >
                <Icon name="refresh" spinning={rescanAllSpinning} />
              </button>
            </div>

            <ul className="kb-lib-list" id="kb-lib-list">
              {bases.map(item => {
                const active = item.id === selectedId
                const open = menu?.id === item.id
                return (
                  <li key={item.id} data-kb-lib-row={item.id}>
                    <div className={`kb-lib-row${active ? ' is-selected' : ''}`}>
                      <button
                        type="button"
                        className="kb-lib-select"
                        data-kb-lib-select
                        aria-pressed={active ? 'true' : 'false'}
                        disabled={busy}
                        onClick={() => selectBase(item.id)}
                      >
                        <span className="kb-lib-name" data-kb-lib-name>
                          {item.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="kb-lib-more"
                        data-kb-lib-more
                        aria-label={pageFormat(tx('「{name}」更多操作', 'More actions for “{name}”'), { name: item.name })}
                        aria-haspopup="menu"
                        aria-expanded={open ? 'true' : 'false'}
                        disabled={busy}
                        onClick={event =>
                          setMenu(open ? undefined : { id: item.id, anchor: event.currentTarget })
                        }
                      >
                        <Icon name="more-horizontal" size={16} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="kb-empty" id="kb-lib-empty" hidden={bases.length > 0}>
              {tx('还没有知识库。', 'No knowledge bases yet.')}
            </p>
          </div>
        </aside>

        <div className="kb-right">
          {selected === undefined ? (
            <p className="kb-placeholder" id="kb-placeholder">
              {tx('左侧选择或新建一个知识库。', 'Select or create a knowledge base on the left.')}
            </p>
          ) : (
            <div className="kb-detail" id="kb-detail">
              <section className="kb-card" id="kb-files-block" aria-label={tx('文件', 'Files')}>
                <div className="kb-block-head">
                  <div className="kb-title-group">
                    <h2 className="kb-card-title" id="kb-files-title" data-kb-files-title>
                      {pageFormat(tx('{name}的文件（{count}）', 'Files in {name} ({count})'), { name: selected.name, count: String(materials.length) })}
                    </h2>
                    <span className="kb-files-size" data-kb-files-size>
                      {pageFormat(tx('总大小 {size}', 'Total size {size}'), { size: formatBytes(selected.bytes) })}
                    </span>
                  </div>
                  <div className="kb-btn-row">
                    <label
                      className={`kb-btn kb-upload${busy ? ' is-disabled' : ''}`}
                      htmlFor="kb-file-input"
                      data-kb-upload
                    >
                      <Icon name="upload" />
                      {tx('上传文件…', 'Upload files…')}
                      <input
                        id="kb-file-input"
                        ref={uploadInput}
                        type="file"
                        multiple
                        className="kb-file-input"
                        data-kb-file-input
                        disabled={busy}
                        onChange={event => {
                          const files = [...(event.target.files ?? [])]
                          // Clear the input so picking the same file twice still
                          // fires a change event.
                          event.target.value = ''
                          if (files.length > 0) void uploadFiles(files)
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="kb-btn"
                      id="kb-rescan-one"
                      data-kb-rescan-one
                      disabled={busy}
                      onClick={() => rescan(selected.id)}
                    >
                      <Icon name="refresh" spinning={rescanCurrentSpinning} />
                      {tx('重扫', 'Rescan')}
                    </button>
                  </div>
                </div>

                <ul className="kb-file-list" id="kb-file-list">
                  {materials.map(material => (
                    <li key={material.id} className="kb-file-row" data-kb-file-row={material.id}>
                      <div className="kb-file-main">
                        <span className="kb-file-name" data-kb-file-name>
                          {material.fileName}
                        </span>
                        {material.note === '' ? null : (
                          <span className="kb-file-reason" data-kb-file-reason>
                            {localizeError(material.note)}
                          </span>
                        )}
                      </div>
                      <div className="kb-file-meta">
                        <MaterialStatus material={material} />
                        <span className="kb-file-size" data-kb-file-size>
                          {formatBytes(material.bytes)}
                        </span>
                      </div>
                      <div className="kb-file-actions">
                        <button
                          type="button"
                          className="kb-btn kb-icon-only kb-btn--danger"
                          data-kb-file-delete
                          aria-label={pageFormat(tx('删除「{name}」', 'Delete “{name}”'), { name: material.fileName })}
                          title={tx('删除', 'Delete')}
                          disabled={busy}
                          onClick={() => openDialog({ kind: 'deleteFile', id: material.id }, '')}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="kb-empty" id="kb-file-empty" hidden={materials.length > 0}>
                  {tx('还没有文件。用「上传文件」加入，或者把文件直接放进上面那个文件夹再点「重扫」。', 'No files yet. Upload files, or add them directly to the knowledge base folder and select “Rescan”.')}
                </p>
                {ocrHint && ocr.status?.ready !== true && (
                  <OcrHint controller={ocr} disabled={busy} onDetect={detectOcr} />
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      <div className="kb-utilities">
        {selected === undefined ? null : <ScanSummary report={selected.lastScan} />}
        <OcrSection controller={ocr} disabled={busy} onDetect={detectOcr} />
      </div>

      </div>
      <ProgressOverlay text={renderPageMessage(progressText, tx)} />
      <Alert text={alertText} kind={error !== '' ? 'error' : 'notice'} revision={feedbackRevision} />

      {/* Outside the columns, and rendered into `document.body` — see `RowMenu`
          for why the list cannot hold it. */}
      {menu !== undefined && (
        <RowMenu
          anchor={menu.anchor}
          items={shell?.canReveal === false ? 2 : 3}
          fileManager={shell?.fileManager ?? tx('文件资源管理器', 'File Explorer')}
          canReveal={shell?.canReveal !== false}
          onRename={() => {
            const target = bases.find(item => item.id === menu.id)
            openDialog({ kind: 'rename', id: menu.id }, target?.name ?? '')
          }}
          onReveal={() => reveal(menu.id)}
          onDelete={() => openDialog({ kind: 'deleteBase', id: menu.id }, '')}
        />
      )}

      {dialog !== undefined && (
        <Modal
          title={
            dialog.kind === 'new'
              ? tx('添加知识库', 'Add knowledge base')
              : dialog.kind === 'rename'
                ? tx('重命名知识库', 'Rename knowledge base')
                : dialog.kind === 'deleteBase'
                  ? tx('删除知识库', 'Delete knowledge base')
                  : tx('删除文件', 'Delete file')
          }
          confirmText={
            dialog.kind === 'new'
              ? tx('确认添加', 'Add')
              : dialog.kind === 'rename'
                ? tx('确认修改', 'Save changes')
                : tx('确认删除', 'Delete')
          }
          danger={dialog.kind === 'deleteBase' || dialog.kind === 'deleteFile'}
          confirmDisabled={dialogConfirmDisabled()}
          onConfirm={confirmDialog}
          onClose={() => setDialog(undefined)}
        >
          {dialog.kind === 'new' && (
            <NameField
              id="kb-new-input"
              label={tx('新知识库名称', 'New knowledge base name')}
              showLabel={false}
              placeholder={tx('新知识库名称', 'New knowledge base name')}
              value={draftName}
              onChange={setDraftName}
              onEnter={confirmDialog}
            />
          )}
          {dialog.kind === 'rename' && (
            <NameField
              id="kb-rename-input"
              label={tx('知识库名称', 'Knowledge base name')}
              value={draftName}
              onChange={setDraftName}
              onEnter={confirmDialog}
            />
          )}
          {dialog.kind === 'deleteBase' && (
            <>
              <p>{pageFormat(tx('确认删除「{name}」？', 'Delete “{name}”?'), { name: bases.find(item => item.id === dialog.id)?.name ?? '' })}</p>
              <p className="kb-delete-note">{tx('删除 = 移入 _回收站，不销毁。', 'Deleting moves items to _回收站; they can be restored.')}</p>
            </>
          )}
          {dialog.kind === 'deleteFile' && (
            <>
              <p>{pageFormat(tx('确认删除「{name}」？', 'Delete “{name}”?'), { name: materials.find(item => item.id === dialog.id)?.fileName ?? '' })}</p>
              <p className="kb-delete-note">{tx('删除 = 移入 _回收站，不销毁。', 'Deleting moves items to _回收站; they can be restored.')}</p>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
