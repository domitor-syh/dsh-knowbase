/**
 * OCR — normalization, the pack downloader, and the image branch of the scan.
 *
 * Three things here are load-bearing enough to be pinned rather than trusted:
 *
 *   - **The downloader's failure cleanup.** A half-downloaded model is invisible
 *     to the user and would be reported as "present" by the status check, so a
 *     cancel or a failure has to remove exactly what that run created — and only
 *     that. The cancel test asserts the first pack really had landed before the
 *     second was cancelled, so "it was cleaned up" cannot pass vacuously.
 *   - **No network without a click.** `readOcrResourceStatus` is two `stat`
 *     calls; `extractImageText` with no packs is `resources-missing` decided
 *     before any WASM loads. Both are checked against a directory that does not
 *     exist, which is also what makes the worker test deterministic.
 *   - **The image branch's sentence.** A missing pack, an empty picture and a
 *     broken engine are three different facts, and each has a wording of its
 *     own; a blanket 「暂不可检索」 is the failure mode being avoided.
 *
 * The real-worker test is deliberately the smallest one in the file: it spawns a
 * thread, so it is the only test here that can hang, and its point is only that
 * a bound exists and is enforced by terminating the thread.
 *
 * @module tests/ocr
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { OcrError, extractImageText, normalizeOcrText } from '../src/core/ocr.ts'
import type { OcrEngine } from '../src/core/ocr.ts'
import {
  OCR_PACKS,
  OcrDownloadError,
  OcrResourceManager,
  downloadOcrPacks,
  ocrCacheDir,
  readOcrResourceStatus,
} from '../src/core/ocr-resources.ts'
import type { FetchLike } from '../src/core/ocr-resources.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import type { VaultFileSystem } from '../src/vault-fs.ts'

/** The vault root every in-memory fixture in this file reads and writes. */
const ROOT = path.resolve('C:/vault')

/** A minimal PNG header; the engine is stubbed, so the bytes only need to be bytes. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('normalizeOcrText', () => {
  it('removes the spaces tesseract inserts between Chinese characters', () => {
    expect(normalizeOcrText('出 厂 默 认 波 特 率')).toBe('出厂默认波特率')
  })

  it('also closes a gap across full-width punctuation', () => {
    expect(normalizeOcrText('第一， 第二。')).toBe('第一，第二。')
  })

  it('closes a gap made of the full-width space', () => {
    expect(normalizeOcrText('第\u3000一')).toBe('第一')
  })

  it('keeps a space that separates a Chinese word from a number', () => {
    // Collapsing everything would be simpler and would destroy 端口 8080 and
    // HTTP 服务, where the space is the user's own formatting.
    expect(normalizeOcrText('波特率 为 115200')).toBe('波特率为 115200')
    expect(normalizeOcrText('HTTP 服务 端口')).toBe('HTTP 服务端口')
  })

  it('trims the ends and leaves blank lines where they are', () => {
    // The chunker bounds runs; a blank line inside a paragraph is a paragraph
    // break the reader draws text from by character range.
    expect(normalizeOcrText('  第一行\n\n第二行  ')).toBe('第一行\n\n第二行')
  })
})

describe('extractImageText', () => {
  it('answers resources-missing without a worker or a request when no pack is on disk', async () => {
    // A path that cannot exist: no fixture, no cleanup, and nothing that could
    // accidentally answer.
    const absent = path.join(tmpdir(), `dshkb-ocr-absent-${randomUUID()}`)

    await expect(
      extractImageText(PNG, { cacheDir: absent, langs: ['eng'] }),
    ).rejects.toMatchObject({ code: 'resources-missing' })
  })

  it('bounds a recognition that never comes back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dshkb-ocr-'))
    try {
      // Non-empty, so the pre-flight check passes and a real worker starts — the
      // bytes are not a model, so recognition can never succeed. The assertion is
      // that the deadline fires rather than the call hanging.
      await writeFile(path.join(dir, 'eng.traineddata'), 'not a model')

      const code = await extractImageText(PNG, { cacheDir: dir, langs: ['eng'], timeoutMs: 1 }).then(
        () => 'none',
        (error: unknown) => (error instanceof OcrError ? error.code : `not-an-OcrError:${String(error)}`),
      )

      expect(code).toBe('parse-failed')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** Hooks a test can use to steer {@link serveFetch}. */
interface FetchHooks {
  /** Make the first N calls throw, to exercise the retry path. */
  readonly failFirst?: number
  /** Called before a response is produced, with the 0-based call index. */
  readonly onCall?: (index: number, url: string) => void
  /** Awaited before any response is produced; holds the download open. */
  readonly gate?: Promise<void>
}

/** A `FetchLike` that answers each pack's URL with a gzip, in two chunks. */
function serveFetch(
  payloads: Record<string, string>,
  hooks: FetchHooks = {},
): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = []

  const fetch: FetchLike = async (url, init) => {
    const index = urls.length
    urls.push(url)
    hooks.onCall?.(index, url)
    if (hooks.gate !== undefined) await hooks.gate
    // Honouring the signal is what lets a test cancel mid-flight and see the
    // cleanup happen for real rather than be skipped.
    if (init.signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    if (index < (hooks.failFirst ?? 0)) throw new Error('连接超时')

    const text = payloads[url]
    if (text === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, body: null }
    }

    const data = new Uint8Array(gzipSync(Buffer.from(text)))
    const half = Math.max(1, Math.floor(data.length / 2))
    const chunks = [data.slice(0, half), data.slice(half)]
    let sent = 0

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () =>
            sent < chunks.length ? { done: false, value: chunks[sent++] } : { done: true },
        }),
      },
    }
  }

  return { fetch, urls }
}

/** The `.gz` size of one pack, as the progress bar counts it. */
function gzipBytesOf(lang: string): number {
  return OCR_PACKS.find(pack => pack.lang === lang)!.gzipBytes
}

/** One gunzipped payload per pack, keyed by the pack's own URL. */
const PAYLOADS: Record<string, string> = Object.fromEntries(
  OCR_PACKS.map(pack => [pack.url, `model:${pack.lang}`]),
)

/** The compressed length of what {@link serveFetch} serves for one pack. */
function servedBytesOf(lang: string): number {
  const pack = OCR_PACKS.find(entry => entry.lang === lang)!
  return gzipSync(Buffer.from(PAYLOADS[pack.url]!)).length
}

describe('readOcrResourceStatus', () => {
  it('reports every pack missing on a fresh vault, and stays off the network', async () => {
    const fs = createMemoryVaultFs(ROOT)

    const status = await readOcrResourceStatus(fs, ROOT)

    expect(status.ready).toBe(false)
    expect(status.missing).toEqual(['chi_sim', 'eng'])
    expect(status.downloadedBytes).toBe(0)
    expect(status.fetchBytes).toBe(
      gzipBytesOf('chi_sim') + gzipBytesOf('eng'),
    )
    expect(status.dir).toBe(ocrCacheDir(ROOT))
  })

  it('is ready once both packs are non-empty files', async () => {
    const fs = createMemoryVaultFs(ROOT)
    await fs.ensureDir(ocrCacheDir(ROOT))
    for (const pack of OCR_PACKS) {
      await fs.writeFile(path.join(ocrCacheDir(ROOT), pack.fileName), 'model')
    }

    const status = await readOcrResourceStatus(fs, ROOT)

    expect(status.ready).toBe(true)
    expect(status.missing).toEqual([])
    expect(status.fetchBytes).toBe(0)
  })

  it('counts a zero-length file as missing', async () => {
    // A truncated download is the case this exists for: a file that is there but
    // empty would otherwise read as 已就绪 and fail later inside the engine.
    const fs = createMemoryVaultFs(ROOT)
    await fs.ensureDir(ocrCacheDir(ROOT))
    await fs.writeFile(path.join(ocrCacheDir(ROOT), 'chi_sim.traineddata'), new Uint8Array())

    const status = await readOcrResourceStatus(fs, ROOT)

    expect(status.missing).toEqual(['chi_sim', 'eng'])
  })
})

describe('downloadOcrPacks', () => {
  it('writes both packs atomically, reports progress, and leaves no temp file', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const { fetch, urls } = serveFetch(PAYLOADS)
    const progress: number[] = []

    await downloadOcrPacks({
      fs,
      root: ROOT,
      packs: OCR_PACKS,
      fetch,
      onProgress: p => progress.push(p.downloadedBytes),
    })

    expect(urls).toEqual(OCR_PACKS.map(pack => pack.url))
    expect(await fs.readText(path.join(ocrCacheDir(ROOT), 'chi_sim.traineddata'))).toBe('model:chi_sim')
    expect(await fs.readText(path.join(ocrCacheDir(ROOT), 'eng.traineddata'))).toBe('model:eng')
    // `.<lang>.download` is gone, which is what makes "a file that exists is a
    // file that finished" true.
    const names = (await fs.listDir(ocrCacheDir(ROOT))).map(entry => entry.name).sort()
    expect(names).toEqual(['chi_sim.traineddata', 'eng.traineddata'])
    expect(progress).toContain(servedBytesOf('chi_sim'))
    expect(progress.at(-1)).toBe(servedBytesOf('chi_sim') + servedBytesOf('eng'))
    // Progress counts compressed bytes, so it never goes backwards when a pack
    // lands — the figure is in the same unit as `totalBytes`.
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('recovers from a failed attempt instead of failing the download', async () => {
    // The CDN is intermittently unreachable (measured), so one bad attempt must
    // not be the end of the download.
    const fs = createMemoryVaultFs(ROOT)
    const { fetch, urls } = serveFetch(PAYLOADS, { failFirst: 1 })

    await downloadOcrPacks({ fs, root: ROOT, packs: OCR_PACKS, fetch, attempts: 3, retryDelayMs: 1 })

    expect(urls.length).toBe(OCR_PACKS.length + 1)
    expect((await readOcrResourceStatus(fs, ROOT)).ready).toBe(true)
  })

  it('gives up after the attempt budget, names the pack, and cleans up', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const { fetch, urls } = serveFetch(PAYLOADS, { failFirst: 2 })

    const failure = await downloadOcrPacks({
      fs,
      root: ROOT,
      packs: OCR_PACKS,
      fetch,
      attempts: 2,
      retryDelayMs: 1,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(OcrDownloadError)
    expect(failure).toMatchObject({ code: 'failed' })
    expect((failure as Error).message).toContain('chi_sim')
    expect(urls.length).toBe(2)
    expect(await fs.listDir(ocrCacheDir(ROOT))).toEqual([])
  })

  it('deletes the packs it had already written when the user cancels', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const controller = new AbortController()
    const progress: number[] = []
    // Cancel while the *second* pack is in flight, so the first has already been
    // renamed into place and there is something for the cleanup to take back.
    const { fetch } = serveFetch(PAYLOADS, {
      onCall: index => {
        if (index === 1) controller.abort(new Error('已取消'))
      },
    })

    const failure = await downloadOcrPacks({
      fs,
      root: ROOT,
      packs: OCR_PACKS,
      fetch,
      signal: controller.signal,
      retryDelayMs: 1,
      onProgress: p => progress.push(p.downloadedBytes),
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(OcrDownloadError)
    expect(failure).toMatchObject({ code: 'cancelled' })
    // Proof that the first pack really landed before the cancel, so the cleanup
    // assertion below is not passing on an empty directory by accident.
    expect(progress).toContain(servedBytesOf('chi_sim'))
    expect(await fs.listDir(ocrCacheDir(ROOT))).toEqual([])
    expect((await readOcrResourceStatus(fs, ROOT)).ready).toBe(false)
  })
})

/** Poll a condition until it holds; fail rather than hang if it never does. */
async function until(holds: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!holds()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A gate a test can open once it has the download in the state it wants. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

describe('OcrResourceManager', () => {
  it('returns at once while running, then reports done with the packs ready', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const { fetch } = serveFetch(PAYLOADS)
    const manager = new OcrResourceManager({ fs, root: ROOT, fetch, retryDelayMs: 1 })

    const started = await manager.start()

    // Returning before the work is what makes polling possible: the channel is
    // request/response, so a call that awaited the download could not report it.
    expect(started.state).toBe('running')
    expect(started.totalBytes).toBe(gzipBytesOf('chi_sim') + gzipBytesOf('eng'))

    await until(() => manager.view().state !== 'running')

    expect(manager.view().state).toBe('done')
    expect(manager.view().message).toContain('已下载完成')
    expect((await manager.status()).ready).toBe(true)
  })

  it('does not re-fetch when the packs are already there', async () => {
    const fs = createMemoryVaultFs(ROOT)
    await fs.ensureDir(ocrCacheDir(ROOT))
    for (const pack of OCR_PACKS) {
      await fs.writeFile(path.join(ocrCacheDir(ROOT), pack.fileName), 'model')
    }
    const { fetch, urls } = serveFetch(PAYLOADS)
    const manager = new OcrResourceManager({ fs, root: ROOT, fetch })

    const view = await manager.start()

    expect(view.state).toBe('done')
    expect(view.message).toContain('无需下载')
    expect(urls).toEqual([])
  })

  it('ignores a second start while the first is still running', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const held = gate()
    const { fetch, urls } = serveFetch(PAYLOADS, { gate: held.promise })
    const manager = new OcrResourceManager({ fs, root: ROOT, fetch, retryDelayMs: 1 })

    const first = await manager.start()
    const second = await manager.start()
    expect(second).toBe(first)

    held.open()
    await until(() => manager.view().state !== 'running')

    expect(urls.length).toBe(OCR_PACKS.length)
    expect(manager.view().state).toBe('done')
  })

  it('cancels a running download and reports it as cancelled', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const held = gate()
    const { fetch } = serveFetch(PAYLOADS, { gate: held.promise })
    const manager = new OcrResourceManager({ fs, root: ROOT, fetch, retryDelayMs: 1 })

    await manager.start()
    expect(manager.cancel().state).toBe('running')

    held.open()
    await until(() => manager.view().state !== 'running')

    expect(manager.view().state).toBe('cancelled')
    expect(manager.view().message).toContain('已删除')
    expect(await fs.listDir(ocrCacheDir(ROOT))).toEqual([])
  })

  it('leaves the disk untouched when nothing was running to cancel', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const { fetch } = serveFetch(PAYLOADS)
    const manager = new OcrResourceManager({ fs, root: ROOT, fetch })

    expect(manager.cancel().state).toBe('idle')
    expect((await manager.status()).missing).toEqual(['chi_sim', 'eng'])
  })
})

/** A service over a fresh in-memory vault, with (or without) an OCR engine. */
async function freshService(
  engine: OcrEngine | undefined,
): Promise<{ service: KnowbaseService; fs: VaultFileSystem; kbId: string }> {
  const store = new MemoryStore()
  const fs = createMemoryVaultFs(ROOT)
  const service = new KnowbaseService(store, fs, ROOT, {
    now: () => 1_700_000_000_000,
    ...(engine === undefined ? {} : { ocr: engine }),
  })
  await service.initialize()
  const base = await service.createKnowledgeBase('产品资料')
  return { service, fs, kbId: base.id }
}

describe('KnowbaseService — the image branch', () => {
  it('indexes the words the engine reads out of a picture', async () => {
    const { service, kbId } = await freshService({ recognize: async () => '出厂默认波特率为 115200' })

    await service.addFiles(kbId, [{ name: '铭牌.png', data: PNG }])

    const material = service.getMaterial(kbId, '铭牌.png')!
    expect(material.indexed).toBe(true)
    expect(material.note).toBe('')
    expect(material.chunks.length).toBeGreaterThan(0)
    expect(service.retrieve('波特率', [kbId]).kind).toBe('hits')
  })

  it('lists the picture and says where the packs come from when no engine is wired', async () => {
    const { service, kbId } = await freshService(undefined)

    await service.addFiles(kbId, [{ name: '铭牌.png', data: PNG }])

    const material = service.getMaterial(kbId, '铭牌.png')!
    expect(material.indexed).toBe(false)
    expect(material.note).toContain('语言包')
    expect(service.retrieve('波特率', [kbId]).kind).toBe('not_ready')
  })

  it('turns a missing pack into the same sentence, not into a failure', async () => {
    // From the user's seat "not downloaded yet" and "no engine" are one
    // situation, so they must not produce two different wordings.
    const { service, kbId } = await freshService({
      recognize: async () => {
        throw new OcrError('resources-missing', '缺少语言包')
      },
    })

    await service.addFiles(kbId, [{ name: '铭牌.png', data: PNG }])

    const material = service.getMaterial(kbId, '铭牌.png')!
    expect(material.indexed).toBe(false)
    expect(material.note).toContain('语言包')
  })

  it('says a picture with no words in it has no words', async () => {
    const { service, kbId } = await freshService({ recognize: async () => '   ' })

    await service.addFiles(kbId, [{ name: '椅子.jpg', data: PNG }])

    const material = service.getMaterial(kbId, '椅子.jpg')!
    expect(material.indexed).toBe(false)
    expect(material.note).toContain('没有识别出文字')
  })

  it('reports a broken engine without leaking its message', async () => {
    const { service, kbId } = await freshService({
      recognize: async () => {
        throw new Error('wasm exploded at 0x1f')
      },
    })

    await service.addFiles(kbId, [{ name: '铭牌.jpeg', data: PNG }])

    const material = service.getMaterial(kbId, '铭牌.jpeg')!
    expect(material.note).toContain('识别失败')
    expect(material.note).not.toContain('wasm exploded')
  })
})
