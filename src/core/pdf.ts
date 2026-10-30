/**
 * Text-layer extraction for PDF files, run off the host's main thread.
 *
 * Why a worker and not a plain call: the host's main thread is the one that
 * keeps the app responsive, and pdfjs parsing a hundred pages is CPU-bound for
 * seconds. The implementation rule is explicit — 解析与推理放后台 worker，
 * UI 与 Host 主线程不做大文件同步解析 — and a spawned thread is the cheapest
 * way to honour it here.
 *
 * Why the worker body is a string rather than its own module: the plugin ships
 * as one `lib/index.js` (`files` in `package.json`, one `tsdown` entry), so a
 * second artifact would have to be built, packed and kept in step with this
 * file. An `eval` worker takes a script instead, and importing pdfjs by its
 * absolute path keeps module resolution inside the plugin's own dependency
 * graph — which also means the script is valid as both CommonJS and ESM, so
 * nothing here depends on how Node decides to interpret it.
 *
 * Why `pdfjs-dist`: it is Mozilla's reference implementation (Apache-2.0) and
 * it is the only one that ships the CJK CMaps and the standard font data a
 * Chinese PDF needs. Wrappers like `unpdf` are thin layers over this same
 * engine, and going direct leaves the per-page loop and the error taxonomy
 * under our control.
 *
 * @module @domitor-syh/dsh-knowbase/core/pdf
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

/** Why a PDF yielded no text. Callers switch on this rather than on wording. */
export type PdfFailureCode =
  /** The file is password-protected; the plugin has no password to offer. */
  | 'encrypted'
  /** Not a PDF the parser understands — broken, truncated, or not a PDF at all. */
  | 'unsupported'
  /** More pages than the plugin will read in one go. */
  | 'too-many-pages'
  /** Extraction itself failed, timed out, or the worker died. */
  | 'parse-failed'
  /** The caller asked to stop. */
  | 'cancelled'

/** A PDF extraction failure with a machine-readable code. */
export class PdfError extends Error {
  readonly code: PdfFailureCode

  constructor(code: PdfFailureCode, message: string) {
    super(message)
    this.name = 'PdfError'
    this.code = code
  }
}

/** Options for {@link extractPdfPages}. */
export interface PdfExtractOptions {
  /** Pages beyond this count are refused instead of read. Default 100 (§1.1). */
  readonly maxPages?: number
  /** Seconds a whole extraction may take before it is abandoned. Default 60s. */
  readonly timeoutMs?: number
  /** Abort signal; terminating the worker is what cancels a running parse. */
  readonly signal?: AbortSignal
}

/** Default page ceiling: the plan's 100-page bound, applied where it is read. */
export const MAX_PDF_PAGES = 100

/** Default wall-clock bound. A text layer is linear in pages; 100 pages fit. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * The worker's script.
 *
 * One message in, one message out: `{ ok: true, pages }` or
 * `{ ok: false, code | name, message }`. Text is collected per page because a
 * citation has to be able to say 第 N 页, and that boundary is only known here.
 */
const WORKER_SOURCE = String.raw`
const run = async () => {
  const { parentPort, workerData } = await import('node:worker_threads')
  const { pathToFileURL } = await import('node:url')
  const pdfjs = await import(pathToFileURL(workerData.entry).href)

  const loading = pdfjs.getDocument({
    data: workerData.data,
    cMapUrl: workerData.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: workerData.standardFontDataUrl,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  })

  try {
    const document = await loading.promise
    if (document.numPages > workerData.maxPages) {
      parentPort.postMessage({
        ok: false,
        code: 'too-many-pages',
        message: String(document.numPages),
      })
      return
    }

    const pages = []
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const parts = []
      for (const item of content.items) {
        if (typeof item.str === 'string') parts.push(item.str)
      }
      pages.push(parts.join(''))
    }
    document.cleanup()
    parentPort.postMessage({ ok: true, pages })
  } finally {
    await loading.destroy().catch(() => {})
  }
}

run().catch(error => {
  import('node:worker_threads').then(({ parentPort }) => {
    parentPort.postMessage({
      ok: false,
      name: String((error && error.name) || 'Error'),
      message: String((error && error.message) || error),
    })
  })
})
`

/** Where pdfjs lives, plus the two asset folders it reads from disk in Node. */
interface PdfAssets {
  /** Absolute path of the legacy Node build, the one without a DOM. */
  readonly entry: string
  /** Forward-slashed, trailing-slash directory paths — see {@link pdfAssets}. */
  readonly cMapUrl: string
  readonly standardFontDataUrl: string
}

let assets: PdfAssets | undefined

/**
 * Resolve pdfjs and its asset folders.
 *
 * Node's pdfjs reads CMap and font files with `fs.readFile`, so a plain
 * filesystem path is right — but `cMapUrl` goes through a URL-shaped check that
 * demands forward slashes and a trailing slash, and a Windows path satisfies
 * neither. That check is why these are rewritten rather than joined.
 *
 * @throws when `pdfjs-dist` is not installed.
 */
function pdfAssets(): PdfAssets {
  if (assets !== undefined) return assets
  const require = createRequire(import.meta.url)
  const entry = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
  // …/pdfjs-dist/legacy/build/pdf.mjs → …/pdfjs-dist
  const root = path.resolve(path.dirname(entry), '..', '..').split(path.sep).join('/')
  assets = {
    entry,
    cMapUrl: `${root}/cmaps/`,
    standardFontDataUrl: `${root}/standard_fonts/`,
  }
  return assets
}

/** Turn a worker reply carrying failures into the error the caller sees. */
function failureOf(reply: { code?: unknown; name?: unknown; message?: unknown }): PdfError {
  const message = typeof reply.message === 'string' ? reply.message : ''
  if (reply.code === 'too-many-pages') {
    return new PdfError('too-many-pages', `PDF 有 ${message} 页，超过 ${MAX_PDF_PAGES} 页上限。`)
  }
  if (reply.name === 'PasswordException') {
    return new PdfError('encrypted', 'PDF 已加密，需要密码才能提取文字。')
  }
  if (reply.name === 'InvalidPDFException') {
    return new PdfError('unsupported', '文件不是可解析的 PDF，可能已损坏或并非 PDF。')
  }
  return new PdfError('parse-failed', message === '' ? 'PDF 解析失败。' : `PDF 解析失败：${message}`)
}

/**
 * Read the text layer of a PDF, one string per page.
 *
 * A page with no text layer — a scan — comes back as `''` rather than as an
 * error: "this page has no text" is a fact about the document, and the caller
 * is the one that knows whether the whole file being empty is worth reporting.
 *
 * @param data - the file's bytes.
 * @param options - page, time and cancellation bounds.
 * @returns one entry per page, in document order.
 * @throws {PdfError} on encryption, unreadable files, page overflow, or cancel.
 */
export async function extractPdfPages(
  data: Uint8Array,
  options: PdfExtractOptions = {},
): Promise<readonly string[]> {
  const resolved = pdfAssets()
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      entry: resolved.entry,
      cMapUrl: resolved.cMapUrl,
      standardFontDataUrl: resolved.standardFontDataUrl,
      data,
      maxPages: options.maxPages ?? MAX_PDF_PAGES,
    },
  })

  if (options.signal?.aborted === true) {
    await worker.terminate()
    throw new PdfError('cancelled', 'PDF 解析已取消。')
  }

  return await new Promise<readonly string[]>((resolve, reject) => {
    let done = false

    const stop = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
    }

    const succeed = (pages: readonly string[]): void => {
      if (done) return
      stop()
      resolve(pages)
    }

    const fail = (error: PdfError): void => {
      if (done) return
      stop()
      reject(error)
    }

    function onAbort(): void {
      fail(new PdfError('cancelled', 'PDF 解析已取消。'))
    }

    const timer = setTimeout(
      () => fail(new PdfError('parse-failed', 'PDF 解析超时，已放弃这一份文件。')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )

    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', reply => {
      if (reply?.ok === true) {
        succeed(Array.isArray(reply.pages) ? (reply.pages as string[]) : [])
        return
      }
      fail(failureOf(reply ?? {}))
    })
    worker.on('error', error => {
      fail(new PdfError('parse-failed', `PDF 解析出错：${error.message}`))
    })
    worker.on('exit', () => {
      fail(new PdfError('parse-failed', 'PDF 解析进程提前退出。'))
    })
  })
}
