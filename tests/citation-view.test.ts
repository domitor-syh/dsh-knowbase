import { describe, expect, it, vi } from 'vitest'
import { citationCopyText, citationLabel, copyCitation, sourceGroups, validCitationId } from '../src/client/citation-view.ts'
import type { SourcePassage } from '../src/client/citation-scan.ts'

const labels = { base: '知识库', file: '文件', location: '位置', id: '引用 ID', legacy: '旧消息无稳定引用 ID', hidden: '路径已隐藏' }
const old: SourcePassage = { kbName: '库', materialTitle: '手册', locator: '第 2 页', text: 'private source body' }
const current = { ...old, kbId: 'a', materialId: 'folder/manual.pdf', ordinal: 2, citationId: 'kb-cite-v1-' + 'a'.repeat(64), filePath: 'C:\\private\\manual.pdf' }

describe('citation grouping', () => {
  it('groups by material identity while keeping original answer indexes', () => {
    const groups = sourceGroups([current, { ...current, materialId: 'other.pdf' }, { ...current, locator: '第 3 页' }])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.entries.map(entry => entry.index)).toEqual([0, 2])
    expect(groups.filter(group => group.key === groups[1]!.key)[0]!.entries[0]!.index).toBe(1)
  })
  it('keeps same-named files in separate bases/materials and legacy separate', () => {
    const groups = sourceGroups([current, { ...current, kbId: 'b' }, { ...current, materialId: 'other.pdf' }, old, { ...old }])
    expect(groups).toHaveLength(4)
    expect(groups[3]!.entries).toHaveLength(2)
  })
  it('does not collide at delimiter boundaries or mutate its input', () => {
    const input = Object.freeze([Object.freeze({ ...current, kbId: 'a|b', materialId: 'c' }), Object.freeze({ ...current, kbId: 'a', materialId: 'b|c' })])
    expect(sourceGroups(input)).toHaveLength(2)
    expect(sourceGroups([])).toEqual([])
  })
})

describe('safe citation copy', () => {
  it('copies library, file, locator and stable ID, never payload fields or body', () => {
    const text = citationCopyText(current, 4, labels)
    expect(text).toBe(`[5]\n知识库: 库\n文件: 手册\n位置: 第 2 页\n引用 ID: ${current.citationId}`)
    for (const value of [current.filePath, current.materialId, current.text]) expect(text).not.toContain(value)
  })
  it('supports legacy sources without inventing a stable identifier', () => {
    expect(citationCopyText(old, 0, labels)).toBe('[1]\n知识库: 库\n文件: 手册\n位置: 第 2 页\n旧消息无稳定引用 ID')
  })
  it.each(['C:\\secret\\file.txt', 'D:/secret/file.txt', '\\\\server\\secret', '/Users/private/file.txt', 'file:///C:/secret.txt', '位置 C:\\secret.txt'])('hides recognizable paths in metadata: %s', value => {
    expect(citationLabel(value, labels.hidden)).toBe(labels.hidden)
    expect(citationCopyText({ ...current, kbName: value, materialTitle: value, locator: value }, 0, labels)).not.toContain(value)
  })
  it('flattens controls and bounds labels', () => {
    expect(citationLabel('库\n名\u0000', labels.hidden)).toBe('库 名')
    expect(citationLabel('x'.repeat(999), labels.hidden)).toHaveLength(500)
  })
  it.each([undefined, null, 1, 'x', current.citationId + '\n', current.citationId.toUpperCase()])('rejects malformed IDs %#', value => {
    expect(validCitationId(value)).toBe(false)
  })
  it('writes exactly once using the clipboard receiver', async () => {
    const clipboard = { writes: [] as string[], async writeText(text: string) { this.writes.push(text) } }
    expect(await copyCitation('citation', clipboard)).toBe('copied')
    expect(clipboard.writes).toEqual(['citation'])
  })
  it('reports absence and rejects without exposing raw errors or reading clipboard', async () => {
    expect(await copyCitation('citation')).toBe('unavailable')
    const writeText = vi.fn().mockRejectedValue(new Error('C:\\private\\failure'))
    expect(await copyCitation('citation', { writeText })).toBe('failed')
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
