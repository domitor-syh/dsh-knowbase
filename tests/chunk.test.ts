/**
 * Chunking tests.
 *
 * Boundaries decide what retrieval can ever return, so the properties that
 * matter are: nothing is lost, nothing exceeds the budget, and a chunk knows
 * where it came from.
 */

import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/core/chunk.ts'

describe('chunkText — structure', () => {
  it('returns nothing for empty or whitespace-only input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  \t ')).toEqual([])
  })

  it('keeps a short document in one chunk', () => {
    const chunks = chunkText('# 设备手册\n\n出厂默认波特率为115200。\n\n修改方法见配置章节。')
    expect(chunks).toHaveLength(1)
  })

  it('carries the heading path so a passage stays findable by its heading', () => {
    const chunks = chunkText('# 设备手册\n\n出厂默认波特率为115200。')
    expect(chunks[0]!.headingPath).toBe('设备手册')
    // The heading text itself is in the chunk, so its words are searchable.
    expect(chunks[0]!.text).toContain('设备手册')
  })

  it('nests heading levels into a path', () => {
    const chunks = chunkText('# 手册\n\n## 串口\n\n### 波特率\n\n默认 115200。')
    expect(chunks.at(-1)!.headingPath).toBe('手册 > 串口 > 波特率')
  })

  it('drops a heading level that a shallower heading replaced', () => {
    const chunks = chunkText('# 手册\n\n## 串口\n\n正文一。\n\n# 附录\n\n正文二。')
    expect(chunks.at(-1)!.headingPath).toBe('附录')
  })

  it('reports a line-range locator', () => {
    const chunks = chunkText('第一行。\n\n第二段。')
    expect(chunks[0]!.locator).toBe('第 1-3 行')
  })

  it('numbers chunks in document order', () => {
    const chunks = chunkText('甲。\n\n乙。\n\n丙。', { targetChars: 3, maxChars: 6 })
    expect(chunks.map(chunk => chunk.ordinal)).toEqual(chunks.map((_, index) => index))
  })

  it('gives every chunk a distinct id', () => {
    const chunks = chunkText('甲。\n\n乙。\n\n丙。', { targetChars: 3, maxChars: 6 })
    expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(chunks.length)
  })
})

describe('chunkText — budget', () => {
  it('splits a long document into several chunks', () => {
    const paragraph = '这是一段用于测试的中文内容。'
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n')
    const chunks = chunkText(text, { targetChars: 100, maxChars: 150 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(150)
  })

  it('never exceeds the ceiling even when one paragraph is far too large', () => {
    const huge = '这是一句很长的中文。'.repeat(40)
    const chunks = chunkText(huge, { targetChars: 100, maxChars: 150 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(150)
  })

  it('does not lose text when splitting', () => {
    const sentences = Array.from({ length: 30 }, (_, index) => `第${index}句内容。`)
    const chunks = chunkText(sentences.join(''), { targetChars: 40, maxChars: 60 })
    const joined = chunks.map(chunk => chunk.text).join('')
    for (const sentence of sentences) expect(joined).toContain(sentence)
  })

  it('treats maxChars below targetChars as the target, not as a contradiction', () => {
    const chunks = chunkText('甲。\n\n乙。', { targetChars: 100, maxChars: 10 })
    expect(chunks.length).toBeGreaterThan(0)
  })
})

describe('chunkText — overlap', () => {
  it('does not duplicate text by default', () => {
    const text = '甲段内容。\n\n乙段内容。'
    const chunks = chunkText(text, { targetChars: 4, maxChars: 8 })
    const total = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
    expect(total).toBeLessThanOrEqual(text.replace(/\n+/g, '').length + chunks.length)
  })

  it('carries the previous tail forward when asked', () => {
    const chunks = chunkText('甲段内容。\n\n乙段内容。', {
      targetChars: 4,
      maxChars: 8,
      overlapChars: 3,
    })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[1]!.text.startsWith(chunks[0]!.text.slice(-3))).toBe(true)
  })
})
