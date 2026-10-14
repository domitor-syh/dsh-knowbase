/**
 * PDF extraction, driven through the real worker.
 *
 * The worker is the riskiest part of this feature — a thread that imports pdfjs
 * by absolute path from a script rather than from a module — so these tests run
 * it for real rather than stubbing it. They are the only place in the suite that
 * spawns a thread, which is why the fixture is deliberately tiny: three pages of
 * a few words each, built by `tests/fixtures/pdf.ts`.
 *
 * @module tests/pdf
 */

import { describe, expect, it } from 'vitest'
import { PdfError, extractPdfPages } from '../src/core/pdf.ts'
import { buildPdf } from './fixtures/pdf.ts'

/** The failure code of a rejected extraction, or `'none'` when it resolved. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  return await promise.then(
    () => 'none',
    (error: unknown) => (error instanceof PdfError ? error.code : `not-a-PdfError:${String(error)}`),
  )
}

describe('extractPdfPages', () => {
  it('returns one string per page, in document order', async () => {
    const pages = await extractPdfPages(buildPdf(['Port 8080', 'Baud 115200', 'Done']))

    expect(pages).toEqual(['Port 8080', 'Baud 115200', 'Done'])
  })

  it('reads a page with no text layer as empty rather than as a failure', async () => {
    // This is what a scan looks like from here: the page exists, the text does
    // not. Reporting it as an error would be wrong — the caller decides whether
    // "no page had text" is worth saying out loud.
    const pages = await extractPdfPages(buildPdf(['', 'Filled in later']))

    expect(pages).toEqual(['', 'Filled in later'])
  })

  it('refuses a document with more pages than the cap', async () => {
    const many = Array.from({ length: 5 }, (_, index) => `Page ${index + 1}`)

    expect(await codeOf(extractPdfPages(buildPdf(many), { maxPages: 3 }))).toBe('too-many-pages')
  })

  it('fails cleanly on bytes that are not a PDF', async () => {
    // A `.pdf` extension is a claim, not a guarantee: a renamed `.txt` or a
    // half-downloaded file has to produce an error, never a crash and never
    // silently "no text".
    const code = await codeOf(extractPdfPages(new TextEncoder().encode('this is not a pdf')))

    expect(['unsupported', 'parse-failed']).toContain(code)
  })

  it('gives up on an already-aborted signal without parsing', async () => {
    const controller = new AbortController()
    controller.abort()

    expect(await codeOf(extractPdfPages(buildPdf(['Never read']), { signal: controller.signal }))).toBe(
      'cancelled',
    )
  })

  it('stops a running parse when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = extractPdfPages(buildPdf(Array.from({ length: 20 }, () => 'Slow page')), {
      signal: controller.signal,
    })
    controller.abort()

    expect(await codeOf(pending)).toBe('cancelled')
  })

  it('gives up on a document that takes longer than the timeout', async () => {
    // Not a stress test: the point is that a bound exists at all, so one hung
    // file cannot hold a scan open forever. Spawning the worker takes tens of
    // milliseconds, so a zero budget always loses the race — that is the check.
    const code = await codeOf(extractPdfPages(buildPdf(['Too slow']), { timeoutMs: 0 }))

    expect(code).toBe('parse-failed')
  })
})
