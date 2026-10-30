/**
 * Text extraction from images (PNG/JPG), run off the host's main thread.
 *
 * ## Why a worker, like the PDF extractor
 *
 * Same reason as `./pdf.ts`: recognising a photograph is hundreds of
 * milliseconds of WASM, and the implementation rule is that parsing and
 * inference happen in a background worker while the host's main thread stays
 * responsive. Unlike pdfjs, tesseract.js already owns a worker of its own — so
 * the worker here is a thread that starts that worker, which is what keeps a
 * cancellation able to really stop the work: terminating this thread takes the
 * spawned OCR process with it.
 *
 * ## Why the language packs are a precondition, checked before anything starts
 *
 * The packs live in a cache directory the user fills on demand (see
 * `./ocr-resources.ts`). When they are not there the answer is
 * {@link OcrError} `resources-missing` — decided with two `stat` calls, without
 * loading WASM at all, and without ever falling back to a download. `langPath`
 * is pointed at a directory that deliberately does not exist, so a missing pack
 * inside the worker fails as a read error instead of reaching for a CDN: the
 * plugin never fetches anything the user did not ask for.
 *
 * ## Why the output is normalized here
 *
 * Tesseract inserts a space between adjacent Chinese characters (measured in the OCR integration tests). Those spaces would survive into the chunker and split a
 * sentence into fragments that retrieval can never match, so the text is
 * normalized in the one place every OCR result passes through.
 *
 * ## Why the engine is bundled and not depended on
 *
 * The published plugin declares no `tesseract.js`. That package's manifest
 * carries a `postinstall`, and pnpm 11 aborts an install that meets an
 * undecided build script — `ERR_PNPM_IGNORED_BUILDS` — while the setting it
 * wants belongs to the profile's `pnpm-workspace.yaml`, which a plugin cannot
 * write. A fresh `dsh plugin add` therefore failed before this plugin was ever
 * loaded (initial install blocker). Both halves of the engine are
 * built into `lib/` instead — see {@link ocrEngine}.
 *
 * @module @domitor-syh/dsh-knowbase/core/ocr
 */

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { OCR_LANGS } from './ocr-resources.ts'

/** Why an image yielded no text. Callers switch on this rather than on wording. */
export type OcrFailureCode =
  /** The language packs are not downloaded yet; the plugin will not fetch them. */
  | 'resources-missing'
  /** Recognition ran and failed, timed out, or its worker died. */
  | 'parse-failed'
  /** The caller asked to stop. */
  | 'cancelled'

/** An OCR failure with a machine-readable code. */
export class OcrError extends Error {
  readonly code: OcrFailureCode

  constructor(code: OcrFailureCode, message: string) {
    super(message)
    this.name = 'OcrError'
    this.code = code
  }
}

/** What the domain layer needs from an OCR engine — see `./service.ts`. */
export interface OcrEngine {
  /**
   * Recognize the text in one image.
   *
   * @throws {OcrError} `resources-missing`, `parse-failed` or `cancelled`.
   */
  recognize(data: Uint8Array, options?: { readonly signal?: AbortSignal }): Promise<string>
}

/** Options for {@link extractImageText}. */
export interface OcrExtractOptions {
  /** Directory holding `<lang>.traineddata`; absolute path used by the OCR worker. */
  readonly cacheDir: string
  /** Languages to load. Defaults to the two packs the plugin manages. */
  readonly langs?: readonly string[]
  /** Seconds recognition may take before it is abandoned. Default 60s. */
  readonly timeoutMs?: number
  /** Abort signal; terminating the worker is what cancels a running recognition. */
  readonly signal?: AbortSignal
}

/** Default wall-clock bound. One image, one pass: measured at ≈0.5s for 1.67 MP. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * LSTM-only recognition.
 *
 * `oem=1` is what the packs are for: the `_best_int` data has no legacy
 * component, so asking for the default `oem=3` would make tesseract print
 * `Failed loading language` at the model layer and fall back. It also prints a
 * harmless `Error opening data file` on stderr without a legacy component —
 * expected, not a failure (OCR worker configuration).
 */
const OCR_OEM = 1

/**
 * Page segmentation mode — stated explicitly, not inherited.
 *
 * tesseract.js leaves the engine's built-in default in place, and that default
 * behaves as SINGLE_BLOCK (PSM 6) — measured, not assumed: on a real screenshot
 * whose Chinese paragraph is interleaved with the matching English, PSM 6 split
 * the middle Chinese line into noise while the English came out intact, and the
 * engine's no-argument run was byte-identical to an explicit PSM 6
 * (OCR worker configuration). AUTO (PSM 3) is tesseract's own general-purpose
 * default and read that same screenshot correctly, so it is set rather than
 * left to the wrapper.
 */
const OCR_PSM = '3'

/**
 * The worker's script.
 *
 * One message in, one message out: `{ ok: true, text }` or
 * `{ ok: false, name, message }`.
 */
const WORKER_SOURCE = String.raw`
const run = async () => {
  const { parentPort, workerData } = await import('node:worker_threads')
  const { pathToFileURL } = await import('node:url')
  const imported = await import(pathToFileURL(workerData.entry).href)
  const Tesseract = imported.default ?? imported

  const options = {
    // Absolute, or tesseract writes the model into whatever the process's
    // working directory happens to be.
    cachePath: workerData.cacheDir,
    // Deliberately a path that does not exist: read the pack from the cache or
    // fail, never fetch one.
    langPath: workerData.offlineLangPath,
    gzip: true,
    logger: () => {},
    errorHandler: () => {},
  }
  // Only assigned when there is one to assign: tesseract.js merges its defaults
  // with these options, so a present-but-undefined 'workerPath' would replace
  // the default it computes itself rather than leave it in place.
  if (workerData.workerPath) options.workerPath = workerData.workerPath

  const worker = await Tesseract.createWorker(workerData.langs, workerData.oem, options)

  try {
    await worker.setParameters({ tessedit_pageseg_mode: workerData.psm })
    const result = await worker.recognize(Buffer.from(workerData.data))
    const text = result && result.data && typeof result.data.text === 'string' ? result.data.text : ''
    parentPort.postMessage({ ok: true, text })
  } finally {
    await worker.terminate().catch(() => {})
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

/** Where the engine's two halves are, resolved once. */
let engine: { entry: string; workerPath: string | undefined } | undefined

/**
 * Resolve the OCR engine to absolute paths.
 *
 * The engine is bundled rather than depended on (see the module note), so both
 * paths sit next to this module's own bundle: in a built plugin
 * `import.meta.url` is `lib/index.js`, and `lib/ocr-runtime.cjs` plus
 * `lib/ocr-worker.cjs` are its neighbours.
 *
 * `workerPath` is handed to tesseract.js explicitly and must be. Its default is
 * computed from `__dirname` when the package is *loaded*
 * (`src/worker/node/defaultOptions.js`), and a single-file bundle replaces that
 * directory with the bundle's own — the default would then point at a
 * `worker-script` directory that does not exist.
 *
 * Running from source — the test suite never builds first — there is no `lib/`
 * to look in, so the installed copy of `tesseract.js` stands in. That branch is
 * unreachable from a published plugin, whose manifest declares no such
 * dependency; it exists so `pnpm test` does not require a build.
 *
 * @throws when neither location has the engine.
 */
function ocrEngine(): { entry: string; workerPath: string | undefined } {
  if (engine !== undefined) return engine
  const here = path.dirname(fileURLToPath(import.meta.url))
  const runtime = path.join(here, 'ocr-runtime.cjs')
  const worker = path.join(here, 'ocr-worker.cjs')
  engine =
    existsSync(runtime) && existsSync(worker)
      ? { entry: runtime, workerPath: worker }
      : { entry: createRequire(import.meta.url).resolve('tesseract.js'), workerPath: undefined }
  return engine
}

/** Language packs that are not on disk yet, by file name. */
async function missingPacks(cacheDir: string, langs: readonly string[]): Promise<readonly string[]> {
  const missing: string[] = []
  for (const lang of langs) {
    const info = await stat(path.join(cacheDir, `${lang}.traineddata`)).catch(() => undefined)
    if (info === undefined || info.size === 0) missing.push(lang)
  }
  return missing
}

/**
 * Read the text out of one image.
 *
 * Returns normalized text — see {@link normalizeOcrText}. An image with nothing
 * readable in it comes back as `''` rather than as an error: "this picture has
 * no words" is a fact about the file, and the caller is the one that decides
 * whether that is worth telling the user.
 *
 * @param data - the image's bytes (PNG/JPEG as tesseract's decoder reads them).
 * @param options - cache directory, languages, time and cancellation bounds.
 * @throws {OcrError} when the packs are missing, or when recognition fails.
 */
export async function extractImageText(
  data: Uint8Array,
  options: OcrExtractOptions,
): Promise<string> {
  const langs = options.langs ?? OCR_LANGS
  const missing = await missingPacks(options.cacheDir, langs)
  if (missing.length > 0) {
    throw new OcrError(
      'resources-missing',
      `OCR 语言包（${missing.join('、')}）尚未下载。`,
    )
  }

  const resolved = ocrEngine()

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      entry: resolved.entry,
      workerPath: resolved.workerPath,
      langs,
      oem: OCR_OEM,
      psm: OCR_PSM,
      cacheDir: options.cacheDir,
      offlineLangPath: path.join(options.cacheDir, '__no-network__'),
      data,
    },
  })

  if (options.signal?.aborted === true) {
    await worker.terminate()
    throw new OcrError('cancelled', '图片文字识别已取消。')
  }

  return await new Promise<string>((resolve, reject) => {
    let done = false

    const stop = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
    }

    const succeed = (text: string): void => {
      if (done) return
      stop()
      resolve(normalizeOcrText(text))
    }

    const fail = (error: OcrError): void => {
      if (done) return
      stop()
      reject(error)
    }

    function onAbort(): void {
      fail(new OcrError('cancelled', '图片文字识别已取消。'))
    }

    const timer = setTimeout(
      () => fail(new OcrError('parse-failed', '图片文字识别超时，已放弃这一份文件。')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )

    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.on('message', reply => {
      if (reply?.ok === true) {
        succeed(typeof reply.text === 'string' ? reply.text : '')
        return
      }
      fail(new OcrError('parse-failed', messageOf(reply?.message)))
    })
    worker.on('error', error => {
      fail(new OcrError('parse-failed', `图片文字识别出错：${error.message}`))
    })
    worker.on('exit', () => {
      fail(new OcrError('parse-failed', '图片文字识别进程提前退出。'))
    })
  })
}

/** One sentence from a worker failure, without repeating an empty message. */
function messageOf(message: unknown): string {
  const text = typeof message === 'string' ? message : ''
  return text === '' ? '图片文字识别失败，未能提取文字。' : `图片文字识别失败：${text}`
}

/**
 * The characters a space between which is an artifact rather than a word break.
 *
 * CJK ideographs plus the CJK punctuation that shares their spacing rules —
 * 「，」「。」「、」and the full-width brackets — because tesseract spaces those
 * out too, and a chunk cut at a stray space reads as two half-sentences.
 */
const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef'

/**
 * A space between two of {@link CJK}, which is not a word boundary.
 *
 * The full-width space `\u3000` is included: it is what tesseract produces when
 * the glyph spacing is wide, and it is just as much a word break as an ASCII
 * space is not.
 */
const CJK_SPACE = new RegExp(`([${CJK}])[ \\t\\u3000]+(?=[${CJK}])`, 'g')

/**
 * Undo the spacing tesseract inserts into Chinese text.
 *
 * Only spaces *between two CJK characters* are removed. A space next to a Latin
 * word or a number is left alone — `端口 8080` and `HTTP 服务` are words the
 * user typed and spaces that carry meaning, and collapsing everything would
 * both mangle them and glue unrelated fragments together.
 *
 * Runs, blank lines and trailing whitespace are left as they are: the chunker
 * bounds them, and the reader highlights passages by character range.
 */
export function normalizeOcrText(text: string): string {
  let previous = text
  for (;;) {
    const next = previous.replace(CJK_SPACE, '$1')
    if (next === previous) return next.trim()
    previous = next
  }
}

/** Build the engine the domain layer holds, bound to one cache directory. */
export function createOcrEngine(options: {
  readonly cacheDir: string
  readonly timeoutMs?: number
}): OcrEngine {
  return {
    recognize: (data, callOptions) =>
      extractImageText(data, {
        cacheDir: options.cacheDir,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(callOptions?.signal === undefined ? {} : { signal: callOptions.signal }),
      }),
  }
}
