/**
 * The OCR language packs: which ones, where they come from, and whether they
 * are already here.
 *
 * ## Why the packs are not shipped with the plugin
 *
 * `chi_sim` + `eng` at the `4.0.0_best_int` revision is 4.46 MB gzipped and
 * 7.3 MB on disk, and it is the one artifact in this plugin that a user may
 * never need — an install with no photographs in it would be paying for a
 * Chinese OCR model it never runs. So the packs are fetched once, on the user's
 * click, into a cache directory the plugin owns.
 *
 * ## Why detection and download are separate functions
 *
 * `readOcrResourceStatus` only reads — two `stat` calls, no network, no state.
 * That separation is deliberate and load-bearing: a "check" button that quietly
 * started a 4.5 MB download would be downloading without being asked, and the
 * one rule this feature has is that nothing here talks to the network unless the
 * user pressed a button that says so.
 *
 * ## Why the download is a state machine instead of a promise the page awaits
 *
 * The page polls. A Remote call is a plain request/response, so a download that
 * reported progress would have to be a stream, which the channel does not carry
 * (it is lossless JSON only). {@link OcrResourceManager} therefore keeps the
 * download in a field and answers `view()` while it runs — the page reads it on
 * a timer and renders a progress bar from it.
 *
 * ## Why cancel *deletes*
 *
 * A half-downloaded pack is worse than none: it is invisible to the user, and
 * `readOcrResourceStatus` would report a file of the wrong length as "present".
 * So a cancelled or failed download removes every file this run created — the
 * temp files and the packs it had already finished — which is what makes
 * 「取消」 mean «as if I never pressed it».
 *
 * @module @domitor-syh/dsh-knowbase/core/ocr-resources
 */

import { gunzip } from 'node:zlib'
import path from 'node:path'
import { promisify } from 'node:util'
import type { VaultFileSystem } from '../vault-fs.ts'

/** Language packs the plugin reads from, in the order they are downloaded. */
export const OCR_LANGS = ['chi_sim', 'eng'] as const

/** One of {@link OCR_LANGS}. */
export type OcrLang = (typeof OCR_LANGS)[number]

/**
 * Where the packs come from.
 *
 * The package's own CDN mirror of `@tesseract.js-data`, which is the source
 * tesseract.js itself defaults to. Pinned to a full version and revision rather
 * than to `latest`: an unpinned URL would let the model behind a hash change
 * under a published plugin, and recognition behavior then differs from the version
 * this code was tested against.
 */
const PACK_ROOT = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data'

/** Frozen revision of each pack. `_best_int` is the LSTM-only set. */
const PACK_REVISION = '4.0.0_best_int'

/** One pack, as this module describes it. */
export interface OcrPack {
  readonly lang: OcrLang
  /** File name inside the cache directory; also what tesseract looks for. */
  readonly fileName: string
  /** The only network address this plugin ever fetches. */
  readonly url: string
  /**
   * Approximately how many `.gz` bytes this pack costs.
   *
   * Used for the progress bar before a `content-length` arrives, and for the
   * "will download about 4.5 MB" figure in the settings page. The measured
   * total is stated as 约 in the UI, because a mirror may serve a different
   * encoding than the one measured on this machine.
   */
  readonly gzipBytes: number
}

/** The packs, in download order. Smaller first, so progress moves early. */
export const OCR_PACKS: readonly OcrPack[] = [
  { lang: 'chi_sim', gzipBytes: 1_719_617 },
  { lang: 'eng', gzipBytes: 2_957_176 },
].map(entry => ({
  ...entry,
  lang: entry.lang as OcrLang,
  fileName: `${entry.lang}.traineddata`,
  url: `${PACK_ROOT}/${entry.lang}/${PACK_REVISION}/${entry.lang}.traineddata.gz`,
}))

/**
 * Cache directory name, inside the vault root.
 *
 * Inside rather than beside the vault: `$DSH_HOME/knowbase` is the one directory
 * this plugin is entitled to write, and the vault is a
 * plain folder the user can move or back up as a unit. The leading dot keeps it
 * out of the way, and the vault's own reconciliation ignores any directory whose
 * name does not parse as `<name>--<kbId>` (`./vault.ts`), so this one is never
 * mistaken for a knowledge base nor scanned for materials.
 */
export const OCR_CACHE_DIR_NAME = '.ocr'

/** Absolute path of the OCR cache directory for one vault. */
export function ocrCacheDir(root: string): string {
  return path.join(root, OCR_CACHE_DIR_NAME)
}

/** One pack as it is actually found on disk. */
export interface OcrPackState {
  readonly lang: OcrLang
  readonly fileName: string
  readonly url: string
  readonly gzipBytes: number
  /** True when a non-empty file is already there. */
  readonly present: boolean
  /** Size on disk; `0` when it is not there. */
  readonly bytes: number
}

/** What the settings page's 「检测」 reports. Read-only by construction. */
export interface OcrResourceStatus {
  /** True when every pack is present, i.e. OCR can run without any network. */
  readonly ready: boolean
  readonly dir: string
  readonly packs: readonly OcrPackState[]
  /** Bytes already on disk (gunzipped sizes). */
  readonly downloadedBytes: number
  /** `.gz` bytes still to fetch; `0` when {@link ready}. */
  readonly fetchBytes: number
  readonly missing: readonly OcrLang[]
}

/**
 * Look at the cache directory and report what is there.
 *
 * A pack counts as present when it is a non-empty regular file. Content is not
 * verified here — the engine itself is the thing that decides whether a pack is
 * usable, and it says so by failing. Guessing at the file's validity would mean
 * hashing 7.3 MB on every status check, to replace a failure that already has a
 * sentence of its own.
 */
export async function readOcrResourceStatus(
  fs: VaultFileSystem,
  root: string,
): Promise<OcrResourceStatus> {
  const dir = ocrCacheDir(root)
  const packs: OcrPackState[] = []
  for (const pack of OCR_PACKS) {
    const info = await fs.stat(path.join(dir, pack.fileName)).catch(() => undefined)
    const bytes = info?.kind === 'file' ? info.size : 0
    packs.push({ ...pack, present: bytes > 0, bytes })
  }
  const missing = packs.filter(pack => !pack.present).map(pack => pack.lang)
  return {
    ready: missing.length === 0,
    dir,
    packs,
    downloadedBytes: packs.reduce((sum, pack) => sum + pack.bytes, 0),
    fetchBytes: packs.reduce((sum, pack) => sum + (pack.present ? 0 : pack.gzipBytes), 0),
    missing,
  }
}

/** How far a download has got. */
export interface OcrDownloadProgress {
  /** `.gz` bytes received so far, across every pack in this run. */
  readonly downloadedBytes: number
  /** `.gz` bytes this run intends to fetch. */
  readonly totalBytes: number
  /** Pack being fetched right now; `''` when none is. */
  readonly lang: OcrLang | ''
}

/** A download failure with a machine-readable code. */
export type OcrDownloadFailureCode = 'cancelled' | 'failed'

/** A download that stopped, either because the user asked or because it broke. */
export class OcrDownloadError extends Error {
  readonly code: OcrDownloadFailureCode

  constructor(code: OcrDownloadFailureCode, message: string) {
    super(message)
    this.name = 'OcrDownloadError'
    this.code = code
  }
}

/** The fetch this module is handed; narrowed so tests can pass a fake. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  readonly body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
}>

/** Options for {@link downloadOcrPacks}. */
export interface OcrDownloadOptions {
  readonly fs: VaultFileSystem
  readonly root: string
  /** The packs to fetch; packs already on disk are not passed. */
  readonly packs: readonly OcrPack[]
  readonly fetch: FetchLike
  readonly onProgress?: (progress: OcrDownloadProgress) => void
  /** Aborted means cancelled: everything this run created is then removed. */
  readonly signal?: AbortSignal
  /** Attempts per pack before the download is called failed. Default 3. */
  readonly attempts?: number
  /** Per-attempt deadline. Default 120s — 4.5 MB at the measured 150–190 KB/s. */
  readonly timeoutMs?: number
  /** First retry delay; it doubles. Default 1s. */
  readonly retryDelayMs?: number
}

/** Default attempt budget. The CDN fails intermittently. */
const DEFAULT_ATTEMPTS = 3
/** Default per-attempt deadline. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Default first retry delay. */
const DEFAULT_RETRY_DELAY_MS = 1_000

/**
 * Largest a pack may be, compressed or not, before it is refused.
 *
 * Both bounds are guards against a mirror serving something other than the
 * model — an HTML error page that gunzips into garbage, or a payload that
 * expands without bound. The real packs are 1.7 MB / 3.0 MB gzipped and
 * 2.4 MB / 5.0 MB expanded, so 16 MB leaves twelve times the headroom.
 */
const MAX_PACK_BYTES = 16 * 1024 * 1024

const gunzipAsync = promisify(gunzip)

/**
 * Fetch the missing packs into the cache directory.
 *
 * Every pack lands through a temp file and an atomic rename, so a file that
 * exists is a file that finished: a crash mid-write leaves a `.download` file
 * nobody reads rather than a truncated model tesseract would load.
 *
 * The directory is created before the first byte: tesseract's own cache writing
 * silently does nothing when the directory is missing,
 * so a download that looked like it succeeded would leave the engine unable to
 * read what it had just fetched.
 *
 * @throws {OcrDownloadError} on cancel or failure; every file this run created
 *   has been removed by then.
 */
export async function downloadOcrPacks(options: OcrDownloadOptions): Promise<void> {
  if (options.packs.length === 0) return

  const dir = ocrCacheDir(options.root)
  await options.fs.ensureDir(dir)

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const totalBytes = options.packs.reduce((sum, pack) => sum + pack.gzipBytes, 0)

  // Everything this run wrote, so a cancel can take back exactly that and
  // nothing that was here before it.
  const written: string[] = []
  let fetched = 0

  try {
    for (const pack of options.packs) {
      throwIfCancelled(options.signal)
      const { data, received } = await fetchPack(pack, {
        fetch: options.fetch,
        signal: options.signal,
        attempts,
        timeoutMs,
        retryDelayMs,
        onProgress: chunk =>
          options.onProgress?.({ downloadedBytes: fetched + chunk, totalBytes, lang: pack.lang }),
      })

      const temp = path.join(dir, `.${pack.lang}.download`)
      await options.fs.writeFile(temp, data)
      written.push(temp)
      const target = path.join(dir, pack.fileName)
      await options.fs.move(temp, target)
      written.push(target)

      // Counted in the same unit as `gzipBytes`, which is what `totalBytes` is
      // built from: a figure in expanded bytes would make the bar jump backwards
      // the moment a pack finished.
      fetched += received
      options.onProgress?.({ downloadedBytes: fetched, totalBytes, lang: pack.lang })
    }
  } catch (error) {
    for (const file of written) await options.fs.remove(file).catch(() => {})
    throw error
  }
}

/** Stream one pack down, retrying the intermittently unreachable CDN. */
async function fetchPack(
  pack: OcrPack,
  options: {
    readonly fetch: FetchLike
    readonly signal?: AbortSignal
    readonly attempts: number
    readonly timeoutMs: number
    readonly retryDelayMs: number
    readonly onProgress: (received: number) => void
  },
): Promise<{ readonly data: Uint8Array; readonly received: number }> {
  let last: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    throwIfCancelled(options.signal)
    try {
      return await fetchOnce(pack, options)
    } catch (error) {
      // A user cancel is final; a connection that timed out is worth retrying.
      if (options.signal?.aborted === true) throw cancelled()
      last = error
      if (attempt < options.attempts) {
        await wait(options.retryDelayMs * attempt, options.signal)
      }
    }
  }
  throw new OcrDownloadError(
    'failed',
    `下载 ${pack.lang} 语言包失败：${messageOf(last)}。请检查网络后重试。`,
  )
}

/** One attempt: read the body as it arrives, then gunzip it. */
async function fetchOnce(
  pack: OcrPack,
  options: {
    readonly fetch: FetchLike
    readonly signal?: AbortSignal
    readonly timeoutMs: number
    readonly onProgress: (received: number) => void
  },
): Promise<{ readonly data: Uint8Array; readonly received: number }> {
  const deadline = combineSignals(options.signal, options.timeoutMs)
  try {
    const response = await options.fetch(pack.url, { signal: deadline.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.body === null) throw new Error('响应没有内容')

    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let received = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value === undefined) continue
      received += chunk.value.byteLength
      if (received > MAX_PACK_BYTES) throw new Error('压缩包过大，已放弃')
      parts.push(chunk.value)
      options.onProgress(received)
    }

    const gzipped = Buffer.concat(parts)
    return {
      data: new Uint8Array(
        await gunzipAsync(gzipped, { maxOutputLength: MAX_PACK_BYTES }).catch(() => {
          throw new Error('下载到的不是有效的 gzip 数据')
        }),
      ),
      // The compressed length, which is the unit a progress bar has to use —
      // see the note at the call site.
      received,
    }
  } finally {
    deadline.stop()
  }
}

/** An abort error, or the reason the caller passed to `abort()`. */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  )
}

/** Combine the caller's signal with a per-attempt deadline. */
function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(signal?.reason ?? new Error('已取消'))
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('连接超时')), timeoutMs)
  return {
    signal: controller.signal,
    stop: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** Throw {@link cancelled} when the caller has already pressed cancel. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelled()
}

/** The one sentence a cancel reports. */
function cancelled(): OcrDownloadError {
  return new OcrDownloadError('cancelled', '已取消下载，本次下载的文件已删除。')
}

/** Sleep, unless the caller cancels while sleeping. */
async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(cancelled())
    }
    if (signal?.aborted === true) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** One sentence from an unknown failure, for a status line. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** What the downloader is doing, as the settings page polls it. */
export type OcrDownloadState = 'idle' | 'running' | 'done' | 'cancelled' | 'failed'

/** The download's state and progress, in wire shape. */
export interface OcrDownloadView {
  readonly state: OcrDownloadState
  /** `.gz` bytes received; for `done` it is the total that was fetched. */
  readonly downloadedBytes: number
  readonly totalBytes: number
  /** Pack being fetched right now; `''` when none is. */
  readonly lang: string
  /** One sentence for the user; `''` while running and nothing has gone wrong. */
  readonly message: string
}

/** Construction options for {@link OcrResourceManager}. */
export interface OcrResourceManagerOptions {
  readonly fs: VaultFileSystem
  readonly root: string
  /** Defaults to the host's global `fetch`. */
  readonly fetch?: FetchLike
  readonly attempts?: number
  readonly timeoutMs?: number
  readonly retryDelayMs?: number
}

/**
 * The download, held between Remote calls.
 *
 * The page starts it, polls it and may cancel it; each of those is one plain
 * call, and the download survives between them because it lives here rather than
 * in the promise a call returns.
 */
export class OcrResourceManager {
  readonly #fs: VaultFileSystem
  readonly #root: string
  readonly #fetch: FetchLike
  readonly #attempts: number
  readonly #timeoutMs: number
  readonly #retryDelayMs: number
  #running: { readonly controller: AbortController; view: OcrDownloadView } | undefined
  #last: OcrDownloadView = { state: 'idle', downloadedBytes: 0, totalBytes: 0, lang: '', message: '' }

  constructor(options: OcrResourceManagerOptions) {
    this.#fs = options.fs
    this.#root = options.root
    this.#fetch =
      options.fetch ?? ((url, init) => globalThis.fetch(url, init) as unknown as ReturnType<FetchLike>)
    this.#attempts = options.attempts ?? DEFAULT_ATTEMPTS
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  }

  /** What is on disk right now. Never touches the network. */
  async status(): Promise<OcrResourceStatus> {
    return await readOcrResourceStatus(this.#fs, this.#root)
  }

  /**
   * Begin fetching what is missing, and return at once.
   *
   * Returning at once is what makes a progress bar possible: the caller polls
   * {@link view} instead of holding one call open for the whole download.
   */
  async start(): Promise<OcrDownloadView> {
    if (this.#running !== undefined) return this.#running.view

    const status = await this.status()
    if (status.ready) {
      this.#last = {
        state: 'done',
        downloadedBytes: 0,
        totalBytes: 0,
        lang: '',
        message: '语言包已就绪，无需下载。',
      }
      return this.#last
    }

    const packs = OCR_PACKS.filter(pack => status.missing.includes(pack.lang))
    const controller = new AbortController()
    const view: OcrDownloadView = {
      state: 'running',
      downloadedBytes: 0,
      totalBytes: packs.reduce((sum, pack) => sum + pack.gzipBytes, 0),
      lang: packs[0]?.lang ?? '',
      message: '',
    }
    const entry = { controller, view }
    this.#running = entry

    void (async () => {
      try {
        await downloadOcrPacks({
          fs: this.#fs,
          root: this.#root,
          packs,
          fetch: this.#fetch,
          signal: controller.signal,
          attempts: this.#attempts,
          timeoutMs: this.#timeoutMs,
          retryDelayMs: this.#retryDelayMs,
          onProgress: progress => {
            entry.view = { ...entry.view, ...progress }
          },
        })
        this.#last = {
          state: 'done',
          downloadedBytes: entry.view.downloadedBytes,
          totalBytes: entry.view.totalBytes,
          lang: '',
          message: '语言包已下载完成。',
        }
      } catch (error) {
        const failure = error instanceof OcrDownloadError ? error : undefined
        this.#last = {
          state: failure?.code === 'cancelled' ? 'cancelled' : 'failed',
          downloadedBytes: entry.view.downloadedBytes,
          totalBytes: entry.view.totalBytes,
          lang: '',
          message: failure?.message ?? `下载失败：${messageOf(error)}。`,
        }
      } finally {
        if (this.#running === entry) this.#running = undefined
      }
    })()

    return view
  }

  /** Ask the running download to stop. The files it wrote are removed. */
  cancel(): OcrDownloadView {
    if (this.#running === undefined) return this.#last
    this.#running.controller.abort(new Error('已取消'))
    return this.#running.view
  }

  /** Where the download is: the running view, or the last one that finished. */
  view(): OcrDownloadView {
    return this.#running?.view ?? this.#last
  }
}

/** True for a failure the caller caused by cancelling. */
export function isCancellation(error: unknown): boolean {
  return error instanceof OcrDownloadError
    ? error.code === 'cancelled'
    : error instanceof Error && isAbort(error)
}
