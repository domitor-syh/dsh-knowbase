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
 * The hand-off's layout, top to bottom: a title, a two-card grid (OCR packs,
 * retrieval test), one sliding notice, then two columns — the base list on the
 * left, the selected base's files on the right. Everything destructive goes
 * through one centred modal rather than the inline two-step confirm this page
 * used to carry, because there are now four of them (add, rename, delete base,
 * delete file) and four different inline confirmations is four different
 * behaviours to learn.
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
import { useSpin } from './spin.ts'
import { useColorScheme } from './theme.ts'

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
  readonly text: string
  readonly kind: 'notice' | 'error'
}

/** A sentence that reports success. */
function note(text: string): Outcome {
  return { text, kind: 'notice' }
}

/** A sentence that reports something the user should look at. */
function problem(text: string): Outcome {
  return { text, kind: 'error' }
}

/** One step that must ask before it acts. */
type Dialog =
  | { readonly kind: 'new' }
  | { readonly kind: 'rename'; readonly id: string }
  | { readonly kind: 'deleteBase'; readonly id: string }
  | { readonly kind: 'deleteFile'; readonly id: string }

/**
 * The one notice strip.
 *
 * Always mounted, `hidden` when there is nothing to say: the hand-off's slide-in
 * needs the element to exist one frame before the class lands, and a live region
 * that is created at the same moment as its text is not announced by every
 * screen reader. The double `requestAnimationFrame` is the standard way to get a
 * transition to run on an element that was hidden a moment ago.
 */
function Alert(props: { text: string; kind: 'notice' | 'error' }): React.ReactElement {
  const [shown, setShown] = React.useState(false)
  const { text, kind } = props

  React.useEffect(() => {
    setShown(false)
    if (text === '') return
    let inner = 0
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setShown(true))
    })
    return () => {
      window.cancelAnimationFrame(outer)
      window.cancelAnimationFrame(inner)
    }
  }, [text, kind])

  return (
    <div
      className={`kb-alert kb-alert--${kind}${shown ? ' is-in' : ''}`}
      data-kb-alert
      role="status"
      aria-live="polite"
      hidden={text === ''}
    >
      <Icon name={kind === 'error' ? 'alert-triangle' : 'check'} />
      <span>{text}</span>
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
            取消
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
        <span>重命名</span>
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
          <span>从{props.fileManager}打开</span>
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
        <span>删除知识库</span>
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
function Report(props: { report: SearchReportView; scopeNote: string }): React.ReactElement {
  const { report, scopeNote } = props
  const note = <p className="kb-report-scope">{scopeNote}</p>

  if (report.outcome !== 'hits') {
    const text: Record<string, string> = {
      no_match: '未命中：所选知识库中没有相关片段。换个说法或换关键词可能命中。',
      empty_scope: '所选知识库不存在或为空。',
      not_ready:
        '所选知识库里还没有可检索的文件（目前支持 .txt / .md 等纯文本、文本型 PDF 和 PNG/JPG 图片）。',
      error: `检索失败：${report.reason}`,
    }
    return (
      <div className="kb-report" data-kb-test-report>
        {note}
        <p className="kb-report-summary">
          {text[report.outcome] ?? report.outcome}（{report.elapsedMs} ms）
        </p>
      </div>
    )
  }

  return (
    <div className="kb-report" data-kb-test-report>
      {note}
      <p className="kb-report-summary">
        命中 {report.passages.length} 个片段，用时 {report.elapsedMs} ms
      </p>
      {report.passages.map((passage, index) => (
        <div key={`${passage.materialTitle}-${passage.locator}-${index}`} className="kb-hit">
          <div className="kb-hit-head">
            <span className="kb-hit-src">
              {index + 1}. {passage.kbName} / {passage.materialTitle} · {passage.locator}
            </span>
            <span className="kb-hit-score">
              score {passage.score.toFixed(2)} · 覆盖 {Math.round(passage.coverage * 100)}%
            </span>
          </div>
          <p className="kb-hit-body" data-kb-report-passage>
            {passage.text}
          </p>
        </div>
      ))}
      <p className="kb-report-foot">
        score 只在同一次提问内可比；覆盖偏低说明命中的查询词少，片段可能只是碰巧重叠。
      </p>
    </div>
  )
}

/** The knowledge base page body. */
export function KnowbasePage(): React.ReactElement {
  const scheme = useColorScheme()

  const [bases, setBases] = React.useState<readonly KnowledgeBaseView[]>([])
  const [selectedId, setSelectedId] = React.useState<string>('')
  const [materials, setMaterials] = React.useState<readonly MaterialView[]>([])
  const [report, setReport] = React.useState<SearchReportView | undefined>(undefined)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
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
  const [spinning, spin] = useSpin()

  const uploadInput = React.useRef<HTMLInputElement | null>(null)

  // The OCR state lives at page level rather than inside the block, because the
  // same controls appear twice: once in the always-visible card and once, when
  // it matters, under the file list (see `./ocr-panel.tsx`).
  const ocr = useOcrController()
  // Set when an image was uploaded while the packs were missing. The hint
  // withdraws itself once a download makes `ocr.status.ready` true.
  const [ocrHint, setOcrHint] = React.useState(false)

  /** Run one Host call with shared busy handling; the sentence it returns is the alert. */
  const run = React.useCallback(async (action: () => Promise<Outcome>): Promise<void> => {
    const current = knowbaseApi()
    if (current === undefined) {
      setNotice('')
      setError('知识库通道尚未就绪，请稍候重试。')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const outcome = await action()
      if (outcome.kind === 'error') setError(outcome.text)
      else setNotice(outcome.text)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [])

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
        setError('知识库通道尚未就绪，请稍候重试。')
        return
      }
      const tooBig: string[] = []
      const accepted: { name: string; bytes: Uint8Array }[] = []
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          tooBig.push(file.name)
          continue
        }
        accepted.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
      }

      await run(async () => {
        if (accepted.length === 0) {
          throw new Error(
            `有 ${tooBig.length} 个文件过大（超过 ${formatBytes(MAX_UPLOAD_BYTES)}），请把它们直接放进知识库文件夹。`,
          )
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
        const parts = [`已加入 ${result.added} 个文件`]
        if (result.rejected.length > 0) parts.push(`${result.rejected.length} 个被拒绝`)
        for (const file of tooBig) parts.push(`「${file}」太大，未上传`)
        const sentence = `${parts.join('，')}。`
        // A mixed result is coloured as a failure: the hand-off's own reading is
        // that a file the user chose did not go in, and that is worth looking at
        // even though the rest succeeded.
        return tooBig.length > 0 || result.rejected.length > 0
          ? problem(sentence)
          : note(sentence)
      })
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
        setError(`知识库通道挂载失败：${failure}`)
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
  const testScopeNote = testAll
    ? `检索范围：全部 ${bases.length} 个知识库，共 ${bases.reduce((sum, item) => sum + item.indexedCount, 0)} 个可检索文件`
    : `检索范围：「${selected?.name ?? ''}」，共 ${selected?.indexedCount ?? 0} 个可检索文件`

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
    spin(async () => {
      await run(async () => {
        const current = knowbaseApi()!
        await current.rescan(kbId)
        await refreshBases()
        if (kbId === '' || kbId === selectedId) {
          setMaterials(await current.listMaterials(kbId === '' ? selectedId : kbId))
        }
        return note(kbId === '' ? '已重新扫描全部知识库。' : '已重新扫描该知识库。')
      })
    })
  }

  /** Hand one base's folder to the desktop's file manager. */
  const reveal = (kbId: string): void => {
    setMenu(undefined)
    void run(async () => {
      const result = await knowbaseApi()!.revealBaseFolder(kbId)
      if (!result.ok) throw new Error(result.message)
      return note(`已在${result.fileManager}中打开：${result.path}`)
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
        return note(`已创建「${created.name}」，文件夹：${created.folderName}。`)
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
        return note('已保存（文件夹也一起改名了）。')
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
          `已把「${target.name}」的文件夹移入 _回收站（没有销毁，需要时可在资源管理器里拖回来）。`,
        )
      })
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
      return note(`已把「${target.fileName}」移入 _回收站。`)
    })
  }

  const dialogConfirmDisabled = (): boolean => {
    if (busy) return true
    if (dialog === undefined) return true
    if (dialog.kind === 'new' || dialog.kind === 'rename') return draftName.trim() === ''
    return false
  }

  const alertText = error !== '' ? error : notice

  return (
    <div
      id="kb-settings-page"
      data-kb-page
      data-kb-vault-root={vaultRoot}
      data-kb-folder-path={folderPath}
      style={pageTokens(scheme)}
    >
      <header className="kb-head">
        <h1 className="kb-head-title">知识库</h1>
      </header>

      <div className="kb-top-grid">
        {/* Packs are per installation, not per base, so this belongs to the page
            rather than to the detail pane below. */}
        <OcrSection controller={ocr} disabled={busy} />

        <section className="kb-card" data-kb-retrieval-test aria-label="检索测试">
          <div className="kb-block-head">
            <h2 className="kb-card-title">检索测试（不调用模型）</h2>
            <div className="kb-scope-group" role="group" aria-label="检索范围">
              <button
                type="button"
                className="kb-scope"
                data-kb-test-scope="base"
                aria-pressed={testAll ? 'false' : 'true'}
                disabled={busy || selected === undefined}
                onClick={() => {
                  setTestAll(false)
                  setReport(undefined)
                }}
              >
                当前库
              </button>
              <button
                type="button"
                className="kb-scope"
                data-kb-test-scope="all"
                aria-pressed={testAll ? 'true' : 'false'}
                disabled={busy || bases.length === 0}
                onClick={() => {
                  setTestAll(true)
                  setReport(undefined)
                }}
              >
                全部知识库（{bases.length}）
              </button>
            </div>
          </div>
          <div className="kb-search-row">
            <input
              type="text"
              className="kb-input"
              id="kb-test-input"
              placeholder="输入一个问题"
              autoComplete="off"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitTest()
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
              检索
            </button>
          </div>
          {report !== undefined && <Report report={report} scopeNote={testScopeNote} />}
        </section>
      </div>

      <Alert text={alertText} kind={error !== '' ? 'error' : 'notice'} />

      <div className="kb-columns">
        <aside className="kb-card" aria-label="知识库列表">
          <div className="kb-left-sec">
            <div className="kb-left-head">
              <p className="kb-sec-label">
                全部知识库 <span className="kb-sec-count" id="kb-lib-count">({bases.length})</span>
              </p>
              <button
                type="button"
                className="kb-icon-btn"
                id="kb-rescan-all"
                data-kb-rescan-all
                aria-label="重扫全部知识库"
                title="重扫全部知识库"
                disabled={busy}
                onClick={() => rescan('')}
              >
                <Icon name="refresh" spinning={spinning} />
              </button>
              <button
                type="button"
                className="kb-icon-btn kb-icon-btn--add"
                id="kb-new-toggle"
                data-kb-new-base
                aria-label="添加知识库"
                title="添加知识库"
                aria-haspopup="dialog"
                aria-expanded={dialog?.kind === 'new' ? 'true' : 'false'}
                disabled={busy}
                onClick={() => openDialog({ kind: 'new' }, '')}
              >
                <Icon name="plus" />
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
                        aria-label={`「${item.name}」更多操作`}
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
              还没有知识库。
            </p>
          </div>
        </aside>

        <div className="kb-right">
          {selected === undefined ? (
            <p className="kb-placeholder" id="kb-placeholder">
              左侧选择或新建一个知识库。
            </p>
          ) : (
            <div className="kb-detail" id="kb-detail">
              <section className="kb-card" id="kb-files-block" aria-label="文件">
                <div className="kb-block-head">
                  <div className="kb-title-group">
                    <h2 className="kb-card-title" id="kb-files-title" data-kb-files-title>
                      {selected.name}的文件（{materials.length}）
                    </h2>
                    <span className="kb-files-size" data-kb-files-size>
                      总大小 {formatBytes(selected.bytes)}
                    </span>
                  </div>
                  <div className="kb-btn-row">
                    <label
                      className={`kb-btn kb-upload${busy ? ' is-disabled' : ''}`}
                      htmlFor="kb-file-input"
                      data-kb-upload
                    >
                      <Icon name="upload" />
                      上传文件…
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
                      <Icon name="refresh" spinning={spinning} />
                      重扫
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
                            {material.note}
                          </span>
                        )}
                      </div>
                      <span className="kb-file-size" data-kb-file-size>
                        {formatBytes(material.bytes)}
                      </span>
                      <div className="kb-file-actions">
                        <button
                          type="button"
                          className="kb-btn kb-icon-only kb-btn--danger"
                          data-kb-file-delete
                          aria-label={`删除「${material.fileName}」`}
                          title="删除"
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
                  还没有文件。用「上传文件」加入，或者把文件直接放进上面那个文件夹再点「重扫」。
                </p>
                {ocrHint && ocr.status?.ready !== true && (
                  <OcrHint controller={ocr} disabled={busy} />
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {/* Outside the columns, and rendered into `document.body` — see `RowMenu`
          for why the list cannot hold it. */}
      {menu !== undefined && (
        <RowMenu
          anchor={menu.anchor}
          items={shell?.canReveal === false ? 2 : 3}
          fileManager={shell?.fileManager ?? '文件资源管理器'}
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
              ? '添加知识库'
              : dialog.kind === 'rename'
                ? '重命名知识库'
                : dialog.kind === 'deleteBase'
                  ? '删除知识库'
                  : '删除文件'
          }
          confirmText={
            dialog.kind === 'new'
              ? '确认添加'
              : dialog.kind === 'rename'
                ? '确认修改'
                : '确认删除'
          }
          danger={dialog.kind === 'deleteBase' || dialog.kind === 'deleteFile'}
          confirmDisabled={dialogConfirmDisabled()}
          onConfirm={confirmDialog}
          onClose={() => setDialog(undefined)}
        >
          {dialog.kind === 'new' && (
            <NameField
              id="kb-new-input"
              label="新知识库名称"
              showLabel={false}
              placeholder="新知识库名称"
              value={draftName}
              onChange={setDraftName}
              onEnter={confirmDialog}
            />
          )}
          {dialog.kind === 'rename' && (
            <NameField
              id="kb-rename-input"
              label="知识库名称"
              value={draftName}
              onChange={setDraftName}
              onEnter={confirmDialog}
            />
          )}
          {dialog.kind === 'deleteBase' && (
            <p>
              确认删除「{bases.find(item => item.id === dialog.id)?.name ?? ''}」？删除 = 移入
              _回收站，不销毁。
            </p>
          )}
          {dialog.kind === 'deleteFile' && (
            <p>
              确认删除「{materials.find(item => item.id === dialog.id)?.fileName ?? ''}」？删除 =
              移入 _回收站，不销毁。
            </p>
          )}
        </Modal>
      )}
    </div>
  )
}
