/**
 * The material reader's view and loader.
 *
 * Two things are being pinned here, and both have a failure mode that only shows
 * up in front of a user:
 *
 *   1. **The highlight lands on the right characters.** The reader shows the
 *      extracted text, so a hit has to be located inside it. Getting that wrong
 *      paints the wrong sentence as evidence, which is worse than no highlight.
 *   2. **The branch a broken file takes is the one that says so.** A file that is
 *      gone, a file the plugin cannot read, and an image all arrive with no text,
 *      and a panel that renders one grey box for all three is a panel that looks
 *      broken.
 *
 * `ReaderView` takes a loaded material, so every branch is reachable from a
 * render-to-string test; the async shell is covered separately through
 * `loadMaterial`, where the caching and the retry contract live.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowbaseApi } from '../src/client/api.ts'
import { setKnowbaseApi } from '../src/client/api.ts'
import {
  clearMaterialCache,
  isEmptyMaterial,
  loadMaterial,
  locateHit,
  ReaderTitle,
  ReaderView,
  resolveHit,
  type LoadedMaterial,
} from '../src/client/reader-panel.tsx'
import type { MaterialDetailView } from '../src/remote.ts'

const MATERIAL_ID = '手册/端口说明.txt'
const KB_ID = 'kb-1'

const CHUNKS = [
  { ordinal: 0, headingPath: '', locator: '第 1 段', text: '本设备默认端口号为 8080。' },
  { ordinal: 1, headingPath: '', locator: '第 2 段', text: '出厂默认波特率为 115200。' },
]

const TEXT = '本设备默认端口号为 8080。\n出厂默认波特率为 115200。\n'

const LOADED: LoadedMaterial = {
  title: '端口说明.txt',
  fileName: '手册/端口说明.txt',
  extension: 'txt',
  text: TEXT,
  chunks: CHUNKS,
  note: '',
}

/**
 * A material with no body, as a file the plugin cannot read arrives.
 *
 * `note` is what the Host says about *why* there is no text; it stays `''` here
 * because the panel's generic sentence is what these cases exercise.
 */
function withoutText(extension: string, title = '端口说明.txt', note = ''): LoadedMaterial {
  return { title, fileName: title, extension, text: '', chunks: [], note }
}

/** Render one element and return its HTML. */
function html(element: Parameters<typeof renderToString>[0]): string {
  return renderToString(element)
}

describe('locateHit', () => {
  it('finds an exact occurrence', () => {
    expect(locateHit(TEXT, CHUNKS[1].text)).toEqual({
      start: TEXT.indexOf(CHUNKS[1].text),
      end: TEXT.indexOf(CHUNKS[1].text) + CHUNKS[1].text.length,
    })
  })

  it('falls back to a whitespace-collapsed match and maps the range back', () => {
    // The index collapses whitespace when it chunks, so a chunk can differ from
    // the stored text by exactly that. The highlight must still land on the
    // stored characters, not on the chunk's.
    const stored = '第一行  有双空格\n第二行照旧。'
    const indexed = '第一行 有双空格 第二行照旧。'
    const range = locateHit(stored, indexed)
    expect(range).toBeDefined()
    expect(stored.slice(range!.start, range!.end)).toBe(stored)
  })

  it('keeps a collapsed match inside the stored text for a mid-material chunk', () => {
    const stored = '开头一句。\n\n\n出厂默认波特率为  115200。\n结尾一句。'
    const indexed = '出厂默认波特率为 115200。'
    const range = locateHit(stored, indexed)
    expect(range).toBeDefined()
    expect(stored.slice(range!.start, range!.end)).toBe('出厂默认波特率为  115200。')
  })

  it('declines rather than guessing when nothing matches', () => {
    expect(locateHit(TEXT, '这段文字根本不在文件里，而且足够长到不会被前缀命中。')).toBeUndefined()
  })

  it('declines an empty chunk', () => {
    expect(locateHit(TEXT, '')).toBeUndefined()
  })

  it('does not match an empty chunk at position zero', () => {
    // An empty needle would otherwise "match" everywhere and highlight nothing.
    expect(locateHit('abc', '')).toBeUndefined()
  })
})

describe('isEmptyMaterial', () => {
  it('is true exactly when a load found nothing at all', () => {
    // This is the payload a deleted file produces: no title, no name, no text,
    // no chunks. A title means the file exists, whatever its body says.
    expect(
      isEmptyMaterial({ title: '', fileName: '', extension: '', text: '', chunks: [], note: '' }),
    ).toBe(true)
    expect(isEmptyMaterial(withoutText('txt', ''))).toBe(true)
    expect(
      isEmptyMaterial({ title: 't', fileName: 't', extension: '', text: '', chunks: [], note: '' }),
    ).toBe(false)
    expect(isEmptyMaterial(LOADED)).toBe(false)
  })
})

describe('resolveHit', () => {
  it('resolves the chunk the navigation named', () => {
    const hit = resolveHit(LOADED, 1)
    expect(hit?.passage.text).toBe(CHUNKS[1].text)
    expect(hit?.range).toBeDefined()
  })

  it('reports a hit whose text it cannot locate, rather than dropping it', () => {
    const material: LoadedMaterial = {
      ...withoutText('txt', 't'),
      text: '完全不同的正文。',
      chunks: [{ ordinal: 0, headingPath: '', locator: '第 1 段', text: '索引里的旧文本。' }],
    }
    const hit = resolveHit(material, 0)
    expect(hit?.passage.text).toBe('索引里的旧文本。')
    expect(hit?.range).toBeUndefined()
  })

  it('has nothing to resolve when the navigation named no chunk', () => {
    expect(resolveHit(LOADED, undefined)).toBeUndefined()
  })

  it('has nothing to resolve when the ordinal is not in the material', () => {
    expect(resolveHit(LOADED, 99)).toBeUndefined()
  })
})

describe('ReaderView', () => {
  /** Render one material with the two props the image branch needs. */
  function view(material: LoadedMaterial, chunk: number | undefined = undefined): string {
    return html(
      createElement(ReaderView, {
        heading: '端口说明',
        material,
        hit: resolveHit(material, chunk),
        revision: 1,
        kbId: KB_ID,
        materialId: material.fileName,
      }),
    )
  }

  it('renders the whole text with the hit marked', () => {
    const out = view(LOADED, 1)
    expect(out).toContain('data-kb-reader-hit')
    expect(out).toContain('<mark')
    // The rest of the file is still shown — this is a reader, not a snippet.
    expect(out).toContain('本设备默认端口号为 8080。')
    expect(out).toContain('已定位到片段')
    expect(out).not.toContain('data-kb-reader-callout')
  })

  it('shows the passage in a callout when it cannot be located inline', () => {
    const material: LoadedMaterial = {
      ...withoutText('txt', 't'),
      text: '完全不同的正文。',
      chunks: [{ ordinal: 0, headingPath: '', locator: '第 7 段', text: '索引里的旧文本。' }],
    }
    const out = view(material, 0)
    expect(out).toContain('data-kb-reader-callout')
    expect(out).toContain('未能精确定位')
    expect(out).toContain('索引里的旧文本。')
    expect(out).not.toContain('data-kb-reader-hit')
    // The callout must not claim a location it did not find.
    expect(out).not.toContain('已定位到片段')
  })

  it('renders the plain text when the navigation named no passage', () => {
    const out = view(LOADED)
    expect(out).toContain('本设备默认端口号为 8080。')
    expect(out).not.toContain('data-kb-reader-hit')
    expect(out).not.toContain('data-kb-reader-callout')
  })

  it('says a file is gone instead of rendering an empty box', () => {
    const out = view(withoutText('', ''))
    expect(out).toContain('这份文件已经不存在了')
    expect(out).not.toContain('data-kb-reader-text')
  })

  it('says it cannot preview a file it cannot read, without calling it deleted', () => {
    // A pdf exists and is listed; the plugin has simply not learned to render or
    // read it yet. Saying "deleted" here would send the user looking for a file
    // that is sitting right where they left it.
    const out = view(withoutText('pdf', '图纸.pdf'))
    expect(out).toContain('暂时无法在应用内预览')
    expect(out).toContain('.pdf')
    expect(out).not.toContain('已经不存在了')
    expect(out).not.toContain('data-kb-reader-text')
  })

  it('shows an image file as an image rather than as text', () => {
    // Effects do not run under `renderToString`, so the placeholder is what this
    // reaches — which is enough to prove the branch was taken instead of the
    // text branch.
    const out = view(withoutText('png', '封面.png'))
    expect(out).toContain('正在读取图片')
    expect(out).not.toContain('暂时无法在应用内预览')
    expect(out).not.toContain('data-kb-reader-text')
  })
})

describe('ReaderTitle', () => {
  it('prefers the title the opener carried, so the chip is right on frame one', () => {
    const out = html(
      createElement(ReaderTitle, {
        useTabInfo: () => ({
          tab: {
            contentId: 'dsh-resource://knowbase/kb-1/mat-1',
            navigation: { params: { title: '端口说明' }, revision: 1 },
          },
        }),
      }),
    )
    expect(out).toContain('端口说明')
    expect(out).not.toContain('mat-1')
  })

  it('falls back to the file name from the address when the tab carries no params', () => {
    const out = html(
      createElement(ReaderTitle, {
        useTabInfo: () => ({
          tab: { contentId: 'dsh-resource://knowbase/kb-1/mat-1', navigation: { revision: 0 } },
        }),
      }),
    )
    expect(out).toContain('mat-1')
  })

  it('survives a seat that hands it no hook at all', () => {
    // A seat whose hook context is missing is a wiring fault, not a crash: the
    // chip degrades to its generic label.
    const out = html(createElement(ReaderTitle, {}))
    expect(out).toContain('知识库文件')
  })
})

describe('loadMaterial', () => {
  /** One material, as the Host describes it. */
  function detail(overrides: Partial<MaterialDetailView> = {}): MaterialDetailView {
    return {
      id: MATERIAL_ID,
      kbId: KB_ID,
      fileName: '手册/端口说明.txt',
      title: '端口说明.txt',
      bytes: 128,
      extension: 'txt',
      indexed: true,
      text: TEXT,
      chunks: CHUNKS,
      note: '',
      ...overrides,
    }
  }

  /** The smallest API the reader touches. */
  function api(overrides: Partial<KnowbaseApi> = {}): KnowbaseApi {
    return { readMaterial: async () => detail(), ...overrides } as unknown as KnowbaseApi
  }

  beforeEach(() => {
    clearMaterialCache()
  })

  afterEach(() => {
    setKnowbaseApi(undefined)
    clearMaterialCache()
  })

  it('reads the name, text and chunks in one call', async () => {
    setKnowbaseApi(api())
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).resolves.toEqual({
      title: '端口说明.txt',
      fileName: '手册/端口说明.txt',
      extension: 'txt',
      text: TEXT,
      chunks: CHUNKS,
      note: '',
    })
  })

  it('shares one request between the body and the title', async () => {
    const readMaterial = vi.fn(async () => detail())
    setKnowbaseApi(api({ readMaterial }))

    const [first, second] = await Promise.all([
      loadMaterial(KB_ID, MATERIAL_ID),
      loadMaterial(KB_ID, MATERIAL_ID),
    ])

    expect(first).toBe(second)
    expect(readMaterial).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by knowledge base as well as file', async () => {
    // A file path is only unique inside its base, so two bases both holding
    // 「手册/端口说明.txt」 are two different files.
    const readMaterial = vi.fn(async () => detail())
    setKnowbaseApi(api({ readMaterial }))

    await loadMaterial('kb-a', MATERIAL_ID)
    await loadMaterial('kb-b', MATERIAL_ID)

    expect(readMaterial).toHaveBeenCalledTimes(2)
  })

  it('reads a file that is gone as an empty load rather than as a failure', async () => {
    // A citation to a file the user deleted afterwards is ordinary, not a bug:
    // the panel says the file is gone instead of showing a retry that will never
    // succeed.
    setKnowbaseApi(api({ readMaterial: async () => null }))

    const loaded = await loadMaterial(KB_ID, MATERIAL_ID)
    expect(isEmptyMaterial(loaded)).toBe(true)
    expect(loaded.fileName).toBe(MATERIAL_ID)
  })

  it('reports a channel that is not mounted instead of hanging', async () => {
    setKnowbaseApi(undefined)
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).rejects.toThrow('知识库通道尚未就绪')
  })

  it('does not cache a failure, so a retry actually retries', async () => {
    const readMaterial = vi
      .fn<() => Promise<MaterialDetailView | null>>()
      .mockRejectedValueOnce(new Error('第一次失败'))
      .mockResolvedValue(detail())
    setKnowbaseApi(api({ readMaterial }))

    await expect(loadMaterial(KB_ID, MATERIAL_ID)).rejects.toThrow('第一次失败')
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).resolves.toMatchObject({ text: TEXT })
    expect(readMaterial).toHaveBeenCalledTimes(2)
  })
})
