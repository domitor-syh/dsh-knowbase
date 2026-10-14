/**
 * The material reader: the right column's tab body and title for
 * `dsh-resource://knowbase/…`.
 *
 * ## Why the right column and not an overlay
 *
 * The host docks, resizes and keeps the right column alive across session
 * switches, and it keeps the chat visible beside the material. The reader
 * reuses that infrastructure (`ctx.resources` + `ctx.sidebarRightTabs` + the two
 * keyed seats) and contributes only the body.
 *
 * ## Read-only by design
 *
 * A file in the vault belongs to the user's own file manager, and two editors
 * over one path is how a document gets silently clobbered. So this panel can
 * only *show*: text files render their extracted text with the hit located
 * inside it, images render their bytes, and anything it cannot render says so.
 * Editing happens in the user's own editor, on the file in the base's folder.
 *
 * ## Why the load and the view are separate components
 *
 * `ReaderView` takes a loaded material and nothing else, so every branch that
 * matters — the highlight, the callout for an unlocatable hit, the deleted
 * material, the unrenderable file — is reachable from a render-to-string test.
 *
 * @module @domitor-syh/dsh-knowbase/client/reader-panel
 */

import * as React from 'react'
import type { MaterialDetailView, PassageView } from '../remote.ts'
import { knowbaseApi, knowbaseChannelError } from './api.ts'
import { chunkOfParams, parseReaderAddress, provisionalTitle, titleOfParams } from './reader-address.ts'

const COLORS = {
  border: '#dce3ed',
  muted: '#526176',
  accent: '#185fa5',
  subtle: '#f6f8fb',
  warn: '#8a6100',
  hit: '#fff2b8',
  text: '#1c2733',
} as const

/** Extensions the panel renders as an image. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

/** A material as the reader needs it. */
export interface LoadedMaterial {
  /** Title, or `''` when the material could not be found in its knowledge base. */
  readonly title: string
  /** The file's name and extension, so the panel knows what it is looking at. */
  readonly fileName: string
  readonly extension: string
  /** The text the plugin extracted; `''` for a file it cannot read. */
  readonly text: string
  /** The indexed chunks, in order. */
  readonly chunks: readonly PassageView[]
}

/** True when the load found nothing — a deleted file reads as empty too. */
export function isEmptyMaterial(material: LoadedMaterial): boolean {
  return material.title === '' && material.text === '' && material.chunks.length === 0
}

/** True when the panel can show this file as an image. */
export function isImageMaterial(material: LoadedMaterial): boolean {
  return IMAGE_EXTENSIONS.has(material.extension)
}

/**
 * Loads in flight, so the body and the title share one request.
 *
 * A failed load is removed rather than cached: the panel offers a retry, and a
 * cached rejection would make that retry a no-op.
 */
const inFlight = new Map<string, Promise<LoadedMaterial>>()

/** Drop every cached load. Exported for tests and for a future refresh action. */
export function clearMaterialCache(): void {
  inFlight.clear()
}

/**
 * Load one material through the typed Remote.
 *
 * @param kbId - owning knowledge base.
 * @param materialId - the file's path relative to the base folder.
 * @returns its title, extension, text and chunks.
 * @throws when the channel is not mounted, or a call fails on the Host.
 */
export function loadMaterial(kbId: string, materialId: string): Promise<LoadedMaterial> {
  const key = `${kbId}\u0000${materialId}`
  const known = inFlight.get(key)
  if (known !== undefined) return known

  const pending = fetchMaterial(kbId, materialId)
  inFlight.set(key, pending)
  pending.catch(() => {
    inFlight.delete(key)
  })
  return pending
}

async function fetchMaterial(kbId: string, materialId: string): Promise<LoadedMaterial> {
  const api = knowbaseApi()
  if (api === undefined) {
    throw new Error(knowbaseChannelError() ?? '知识库通道尚未就绪，请稍后重试。')
  }
  const detail: MaterialDetailView | null = await api.readMaterial(kbId, materialId)
  if (detail === null) {
    // A file that is gone reads as an empty load; the view says so instead of
    // throwing, because a citation to a deleted file is ordinary, not a bug.
    return { title: '', fileName: materialId, extension: '', text: '', chunks: [] }
  }
  return {
    title: detail.title,
    fileName: detail.fileName,
    extension: detail.extension,
    text: detail.text,
    chunks: detail.chunks,
  }
}

/**
 * A whitespace-collapsed projection of `text`, with a map back to the original.
 *
 * The index collapses whitespace runs when it chunks a material, so a chunk's
 * text can differ from the stored text by exactly that: a double space, a
 * reflowed line. Searching the stored text for the chunk's literal bytes
 * therefore fails on materials that look perfectly ordinary — which is how the
 * reader ends up unable to locate a passage it is literally showing.
 *
 * Every character of the projection carries the index it came from, so a match
 * found in the projection converts back to a range in the original.
 */
function collapseWhitespace(text: string): { readonly normalized: string; readonly map: readonly number[] } {
  const chars: string[] = []
  const map: number[] = []
  let runStart = -1
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v') {
      if (runStart === -1) runStart = index
      continue
    }
    if (runStart !== -1) {
      // A leading run has nothing before it to separate, so it is dropped
      // rather than turned into a space that would shift every later index.
      if (chars.length > 0) {
        chars.push(' ')
        map.push(runStart)
      }
      runStart = -1
    }
    chars.push(char)
    map.push(index)
  }
  return { normalized: chars.join(''), map }
}

/**
 * Where the hit chunk sits inside the material text.
 *
 * Exact match first, then a whitespace-collapsed match mapped back to the
 * original indices. When neither finds it, the honest answer is "not locatable"
 * and the caller shows a callout: highlighting the wrong characters would put
 * evidence in the user's face that the answer never cited.
 */
export function locateHit(text: string, chunk: string): { start: number; end: number } | undefined {
  if (chunk === '') return undefined
  const exact = text.indexOf(chunk)
  if (exact >= 0) return { start: exact, end: exact + chunk.length }

  const haystack = collapseWhitespace(text)
  const needle = collapseWhitespace(chunk).normalized
  if (needle === '') return undefined
  const at = haystack.normalized.indexOf(needle)
  if (at < 0) return undefined
  const start = haystack.map[at]
  const last = haystack.map[at + needle.length - 1]
  if (start === undefined || last === undefined) return undefined
  return { start, end: last + 1 }
}

/** The chunk a navigation asked for, and where it sits in the stored text. */
export interface Hit {
  readonly passage: PassageView
  /** Absent when the passage's text could not be found in the material text. */
  readonly range: { readonly start: number; readonly end: number } | undefined
}

/** Resolve the hit chunk, or `undefined` when the navigation named none. */
export function resolveHit(material: LoadedMaterial, chunk: number | undefined): Hit | undefined {
  if (chunk === undefined) return undefined
  const passage = material.chunks.find(row => row.ordinal === chunk)
  if (passage === undefined) return undefined
  return { passage, range: locateHit(material.text, passage.text) }
}

/** One line of quiet explanatory copy. */
function Notice(props: { children: React.ReactNode }): React.ReactElement {
  return (
    <p style={{ color: COLORS.muted, fontSize: 13, margin: '8px 0', lineHeight: 1.7 }}>{props.children}</p>
  )
}

/** The passage the navigation named, shown whole when it cannot be located inline. */
function HitCallout(props: { hit: Hit }): React.ReactElement {
  const { passage } = props.hit
  return (
    <div
      data-kb-reader-callout
      style={{
        border: `1px solid ${COLORS.border}`,
        borderLeft: `3px solid ${COLORS.warn}`,
        borderRadius: 6,
        background: COLORS.subtle,
        padding: '8px 10px',
        fontSize: 12,
        color: COLORS.muted,
      }}
    >
      <div style={{ color: COLORS.warn, marginBottom: 4 }}>
        命中片段（原文中未能精确定位，可能已被编辑）
        {passage.locator === '' ? '' : ` · ${passage.locator}`}
      </div>
      <div style={{ whiteSpace: 'pre-wrap', color: COLORS.text }}>{passage.text}</div>
    </div>
  )
}

/**
 * An image file, rendered from the bytes the Host sends base64-encoded.
 *
 * The object URL is revoked when the component unmounts — a long-lived tab that
 * viewed twenty images would otherwise hold twenty decoded blobs.
 */
function ImagePreview(props: { kbId: string; materialId: string; extension: string }): React.ReactElement {
  const { kbId, materialId, extension } = props
  const [url, setUrl] = React.useState<string | undefined>(undefined)
  const [failure, setFailure] = React.useState('')

  React.useEffect(() => {
    let live = true
    let created: string | undefined
    const api = knowbaseApi()
    if (api === undefined) {
      setFailure(knowbaseChannelError() ?? '知识库通道尚未就绪。')
      return
    }
    api
      .readMaterialBytes(kbId, materialId)
      .then(bytes => {
        if (bytes === undefined) {
          if (live) setFailure('文件已不存在，或它太大，无法在这里预览。')
          return
        }
        // `svg` has a text mime type; everything else here is binary.
        const mime = extension === 'svg' ? 'image/svg+xml' : `image/${extension === 'jpg' ? 'jpeg' : extension}`
        // A copied ArrayBuffer keeps the Blob independent of the source view.
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })
        created = URL.createObjectURL(blob)
        if (live) setUrl(created)
        else URL.revokeObjectURL(created)
      })
      .catch((error: unknown) => {
        if (live) setFailure(error instanceof Error ? error.message : String(error))
      })
    return () => {
      live = false
      if (created !== undefined) URL.revokeObjectURL(created)
    }
  }, [kbId, materialId, extension])

  if (failure !== '') return <Notice>{failure}</Notice>
  if (url === undefined) return <Notice>正在读取图片…</Notice>
  return (
    <img
      data-kb-reader-image
      src={url}
      alt={materialId}
      style={{ maxWidth: '100%', borderRadius: 6, border: `1px solid ${COLORS.border}` }}
    />
  )
}

/**
 * The material, rendered.
 *
 * Pure in its props: the heading, the text, and where the hit is. Everything
 * that decides *what* to show lives here, so a render-to-string test reaches
 * every branch.
 */
export function ReaderView(props: {
  heading: string
  material: LoadedMaterial
  hit: Hit | undefined
  /** Bumped by the host on every navigation; moving the viewport keys off it. */
  revision: number
  /** Owning base and file path, so the image preview can fetch bytes. */
  kbId: string
  materialId: string
}): React.ReactElement {
  const { heading, material, hit, revision, kbId, materialId } = props
  const hitRef = React.useRef<HTMLElement | null>(null)

  // Scroll on every navigation, not only the first: re-opening the same
  // material at another passage bumps `revision` and must move the viewport.
  React.useEffect(() => {
    const node = hitRef.current
    if (node === null || typeof node.scrollIntoView !== 'function') return
    node.scrollIntoView({ block: 'center' })
  }, [revision, hit])

  if (isEmptyMaterial(material)) {
    // A file that is gone and a file with nothing to show produce the same
    // payload — no title, no text, no chunks — so the panel says "gone" rather
    // than inventing an empty document.
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{heading}</div>
        <Notice>这份文件已经不存在了，可能已被删除或改名。请回到对话重新检索。</Notice>
      </div>
    )
  }

  if (isImageMaterial(material)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{heading}</div>
        <ImagePreview kbId={kbId} materialId={materialId} extension={material.extension} />
      </div>
    )
  }

  if (material.text === '') {
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{heading}</div>
        <Notice>
          这个文件（{material.extension === '' ? '未知格式' : `.${material.extension}`}）暂时无法在应用内预览，
          插件也还不能从它里面提取可检索的文字。文件本身已保存在知识库文件夹里，可以用系统自带的方式打开。
        </Notice>
      </div>
    )
  }

  const range = hit?.range
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{heading}</div>
      {hit !== undefined && range === undefined ? <HitCallout hit={hit} /> : null}
      <div
        data-kb-reader-text
        style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: COLORS.text }}
      >
        {range === undefined ? (
          material.text
        ) : (
          <>
            {material.text.slice(0, range.start)}
            <mark
              ref={node => {
                hitRef.current = node
              }}
              data-kb-reader-hit
              style={{ background: COLORS.hit, color: 'inherit', padding: '1px 0', borderRadius: 2 }}
            >
              {material.text.slice(range.start, range.end)}
            </mark>
            {material.text.slice(range.end)}
          </>
        )}
      </div>
      {hit !== undefined && range !== undefined ? (
        <div style={{ fontSize: 11, color: COLORS.accent }}>
          已定位到片段{hit.passage.locator === '' ? '' : ` · ${hit.passage.locator}`}
        </div>
      ) : null}
    </div>
  )
}

/** Read `tab.contentId` and `tab.navigation` off the tab body's injected hook. */
export function useReaderTab(useTabInfo: unknown): {
  address: string
  chunk: number | undefined
  title: string | undefined
  revision: number
} {
  let info: unknown
  if (typeof useTabInfo === 'function') {
    try {
      info = (useTabInfo as () => unknown)()
    } catch {
      info = undefined
    }
  }
  const tab = (info as { tab?: Record<string, unknown> } | undefined)?.tab
  const address = typeof tab?.contentId === 'string' ? tab.contentId : ''
  const navigation = tab?.navigation as { params?: unknown; revision?: unknown } | undefined
  return {
    address,
    chunk: chunkOfParams(navigation?.params),
    title: titleOfParams(navigation?.params),
    revision:
      typeof navigation?.revision === 'number' && Number.isSafeInteger(navigation.revision)
        ? navigation.revision
        : 0,
  }
}

/** One load's state, as the panel renders it. */
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly material: LoadedMaterial }
  | { readonly kind: 'error'; readonly message: string }

/**
 * The material body: the async shell around {@link ReaderView}.
 *
 * Props are the seat's own share: the standard kit plus `useTabInfo`, whose prop
 * name comes from the host rewriting the seat's `hooks` compartment
 * (`inject: { hooks: { tabInfo } }` becomes `useTabInfo`).
 */
export function ReaderPanel(props: Record<string, unknown>): React.ReactElement {
  const { address, chunk, title: paramTitle, revision } = useReaderTab(props.useTabInfo)
  const parts = parseReaderAddress(address)
  const kbId = parts?.kbId ?? ''
  const materialId = parts?.materialId ?? ''

  const [state, setState] = React.useState<LoadState>({ kind: 'loading' })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (materialId === '') {
      setState({ kind: 'error', message: '这个标签页没有指向任何文件。' })
      return
    }
    let live = true
    setState({ kind: 'loading' })
    loadMaterial(kbId, materialId)
      .then(material => {
        if (live) setState({ kind: 'ready', material })
      })
      .catch((error: unknown) => {
        if (!live) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      live = false
    }
  }, [kbId, materialId, attempt])

  if (state.kind === 'loading') return <Notice>正在读取文件…</Notice>
  if (state.kind === 'error') {
    return (
      <div>
        <Notice>{state.message}</Notice>
        <button
          type="button"
          data-kb-reader-retry
          onClick={() => setAttempt(value => value + 1)}
          style={{
            border: `1px solid ${COLORS.border}`,
            background: COLORS.subtle,
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </div>
    )
  }

  const material = state.material
  const heading = paramTitle ?? (material.title === '' ? provisionalTitle(address) : material.title)
  return (
    <ReaderView
      heading={heading}
      material={material}
      hit={resolveHit(material, chunk)}
      revision={revision}
      kbId={kbId}
      materialId={materialId}
    />
  )
}

/**
 * The tab chip's text.
 *
 * Prefers the title the opener carried — it is right on the first frame — and
 * falls back to the loaded material for a tab restored from a saved layout.
 */
export function ReaderTitle(props: Record<string, unknown>): React.ReactElement {
  const { address, title: paramTitle } = useReaderTab(props.useTabInfo)
  const parts = parseReaderAddress(address)
  const kbId = parts?.kbId
  const materialId = parts?.materialId
  const [loaded, setLoaded] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    if (paramTitle !== undefined || kbId === undefined || materialId === undefined) return
    let live = true
    loadMaterial(kbId, materialId)
      .then(material => {
        if (live && material.title !== '') setLoaded(material.title)
      })
      .catch(() => {
        // The chip keeps its provisional text; the body reports the failure.
      })
    return () => {
      live = false
    }
  }, [paramTitle, kbId, materialId])

  return <span data-kb-reader-title>{paramTitle ?? loaded ?? provisionalTitle(address)}</span>
}
