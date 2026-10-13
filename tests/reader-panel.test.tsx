/**
 * The material reader's view and loader.
 *
 * Two things are being pinned here, and both have a failure mode that only shows
 * up in front of a user:
 *
 *   1. **The highlight lands on the right characters.** The reader shows the
 *      stored text, so a hit has to be located inside it. Getting that wrong
 *      paints the wrong sentence as evidence, which is worse than no highlight.
 *   2. **The branch a broken material takes is the one that says so.** A deleted
 *      material and an empty one look identical in the payload, and a panel that
 *      renders an empty box for either is a panel that looks broken.
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

const MATERIAL_ID = 'mat-1'
const KB_ID = 'kb-1'

const CHUNKS = [
  { ordinal: 0, headingPath: '', locator: '第 1 段', text: '本设备默认端口号为 8080。' },
  { ordinal: 1, headingPath: '', locator: '第 2 段', text: '出厂默认波特率为 115200。' },
]

const TEXT = '本设备默认端口号为 8080。\n出厂默认波特率为 115200。\n'

const LOADED: LoadedMaterial = { title: '端口说明', text: TEXT, chunks: CHUNKS }

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
    expect(locateHit(TEXT, '这段文字根本不在资料里，而且足够长到不会被前缀命中。')).toBeUndefined()
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
  it('is true exactly when there is neither text nor chunks', () => {
    expect(isEmptyMaterial({ title: '', text: '', chunks: [] })).toBe(true)
    // A title but no body is still an empty material — the title is not content.
    expect(isEmptyMaterial({ title: 't', text: '', chunks: [] })).toBe(true)
    expect(isEmptyMaterial({ title: '', text: 'x', chunks: [] })).toBe(false)
    expect(isEmptyMaterial({ title: '', text: '', chunks: CHUNKS })).toBe(false)
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
      title: 't',
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
  it('renders the whole text with the hit marked', () => {
    const out = html(
      createElement(ReaderView, {
        heading: '端口说明',
        material: LOADED,
        hit: resolveHit(LOADED, 1),
        revision: 1,
      }),
    )
    expect(out).toContain('data-kb-reader-hit')
    expect(out).toContain('<mark')
    // The rest of the material is still shown — this is a reader, not a snippet.
    expect(out).toContain('本设备默认端口号为 8080。')
    expect(out).toContain('已定位到片段')
    expect(out).not.toContain('data-kb-reader-callout')
  })

  it('shows the passage in a callout when it cannot be located inline', () => {
    const material: LoadedMaterial = {
      title: 't',
      text: '完全不同的正文。',
      chunks: [{ ordinal: 0, headingPath: '', locator: '第 7 段', text: '索引里的旧文本。' }],
    }
    const out = html(
      createElement(ReaderView, {
        heading: '端口说明',
        material,
        hit: resolveHit(material, 0),
        revision: 1,
      }),
    )
    expect(out).toContain('data-kb-reader-callout')
    expect(out).toContain('未能精确定位')
    expect(out).toContain('索引里的旧文本。')
    expect(out).not.toContain('data-kb-reader-hit')
    // The callout must not claim a location it did not find.
    expect(out).not.toContain('已定位到片段')
  })

  it('renders the plain text when the navigation named no passage', () => {
    const out = html(
      createElement(ReaderView, { heading: '端口说明', material: LOADED, hit: undefined, revision: 0 }),
    )
    expect(out).toContain('本设备默认端口号为 8080。')
    expect(out).not.toContain('data-kb-reader-hit')
    expect(out).not.toContain('data-kb-reader-callout')
  })

  it('says a material is gone instead of rendering an empty box', () => {
    const out = html(
      createElement(ReaderView, {
        heading: '端口说明',
        material: { title: '', text: '', chunks: [] },
        hit: undefined,
        revision: 0,
      }),
    )
    expect(out).toContain('这份资料已经不存在了')
    expect(out).not.toContain('data-kb-reader-text')
  })

  it('does not call an empty material deleted', () => {
    // Same payload as the deleted case — no text, no chunks — and the title is
    // the only thing that tells them apart. Telling a user their material was
    // deleted right after they saved it empty is the failure this guards.
    const out = html(
      createElement(ReaderView, {
        heading: '端口说明',
        material: { title: '端口说明', text: '', chunks: [] },
        hit: undefined,
        revision: 0,
      }),
    )
    expect(out).toContain('这份资料还没有正文')
    expect(out).not.toContain('已经不存在了')
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
    expect(out).not.toContain('资料 mat-1')
  })

  it('falls back to a provisional label when the tab was restored without params', () => {
    const out = html(
      createElement(ReaderTitle, {
        useTabInfo: () => ({
          tab: { contentId: 'dsh-resource://knowbase/kb-1/mat-1', navigation: { revision: 0 } },
        }),
      }),
    )
    expect(out).toContain('资料 mat-1')
  })

  it('survives a seat that hands it no hook at all', () => {
    // A seat whose hook context is missing is a wiring fault, not a crash: the
    // chip degrades to its generic label.
    const out = html(createElement(ReaderTitle, {}))
    expect(out).toContain('知识库资料')
  })
})

describe('loadMaterial', () => {
  /** The smallest API the reader touches. */
  function api(overrides: Partial<KnowbaseApi> = {}): KnowbaseApi {
    return {
      listMaterials: async () => [{ id: MATERIAL_ID, title: '端口说明' }],
      readMaterialText: async () => TEXT,
      readMaterialChunks: async () => CHUNKS,
      ...overrides,
    } as unknown as KnowbaseApi
  }

  beforeEach(() => {
    clearMaterialCache()
  })

  afterEach(() => {
    setKnowbaseApi(undefined)
    clearMaterialCache()
  })

  it('reads text, chunks and title in one load', async () => {
    setKnowbaseApi(api())
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).resolves.toEqual({
      title: '端口说明',
      text: TEXT,
      chunks: CHUNKS,
    })
  })

  it('shares one request between the body and the title', async () => {
    const readMaterialText = vi.fn(async () => TEXT)
    setKnowbaseApi(api({ readMaterialText }))
    const [first, second] = await Promise.all([
      loadMaterial(KB_ID, MATERIAL_ID),
      loadMaterial(KB_ID, MATERIAL_ID),
    ])
    expect(first).toBe(second)
    expect(readMaterialText).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by knowledge base as well as material', async () => {
    const readMaterialText = vi.fn(async () => TEXT)
    setKnowbaseApi(api({ readMaterialText }))
    await loadMaterial('kb-a', MATERIAL_ID)
    await loadMaterial('kb-b', MATERIAL_ID)
    expect(readMaterialText).toHaveBeenCalledTimes(2)
  })

  it('still reads the text when the knowledge base cannot be listed', async () => {
    // A knowledge base that vanished must not take the material with it; the
    // title is the only thing that lookup provides.
    setKnowbaseApi(
      api({
        listMaterials: async () => {
          throw new Error('知识库不存在')
        },
      }),
    )
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).resolves.toEqual({
      title: '',
      text: TEXT,
      chunks: CHUNKS,
    })
  })

  it('reports a channel that is not mounted instead of hanging', async () => {
    setKnowbaseApi(undefined)
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).rejects.toThrow('知识库通道尚未就绪')
  })

  it('does not cache a failure, so a retry actually retries', async () => {
    const readMaterialText = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('第一次失败'))
      .mockResolvedValue(TEXT)
    setKnowbaseApi(api({ readMaterialText }))

    await expect(loadMaterial(KB_ID, MATERIAL_ID)).rejects.toThrow('第一次失败')
    await expect(loadMaterial(KB_ID, MATERIAL_ID)).resolves.toMatchObject({ text: TEXT })
    expect(readMaterialText).toHaveBeenCalledTimes(2)
  })
})
