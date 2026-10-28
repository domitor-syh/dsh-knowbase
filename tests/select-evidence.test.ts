import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../src/core/bm25.ts'
import { selectEvidence, type EvidenceSource } from '../src/core/select-evidence.ts'

function fixture(rows: { source: string; score: number; text: string; coverage?: number }[]) {
  const sources = new Map<string, EvidenceSource>()
  const hits: SearchHit[] = rows.map((row, i) => {
    sources.set(String(i), { key: row.source, text: row.text, ordinal: i })
    return { id: String(i), score: row.score, coverage: row.coverage ?? 1, matchedTerms: ['设备', '维护'] }
  })
  return { hits, select: (limit: number) => selectEvidence(hits, limit, id => sources.get(id)!) }
}

describe('relevance-constrained evidence selection', () => {
  it('reaches a competitive source beyond 200 similar chunks without a fetch window', () => {
    const f = fixture([...Array.from({ length: 200 }, (_, i) => ({ source: 'new', score: 10, text: `设备维护周期，计划章节 ${i}` })),
      { source: 'old', score: 8, text: '设备维护周期为七个月' }])
    const selected = f.select(6)
    expect(selected).toHaveLength(6)
    expect(selected[0]).toBe(f.hits[0])
    expect(selected.map(hit => hit.id)).toContain('200')
    expect(selected[1]).toBe(f.hits[200])
  })
  it('does not trade a strong answer for weak noise or low coverage', () => {
    const f = fixture([...Array.from({ length: 8 }, (_, i) => ({ source: 'answer', score: 10, text: `设备维护周期 ${i}` })),
      { source: 'weak', score: 2, text: '设备' },
      { source: 'low-coverage', score: 9, coverage: 0.2, text: '维护 维护' }])
    expect(f.select(6).map(hit => hit.id)).toEqual(['0', '1', '2', '3', '4', '5'])
  })
  it('uses body novelty when ranking equally strong passages from the same source', () => {
    const f = fixture([
      { source: 'manual', score: 10, text: '恢复出厂设置之前备份配置网络参数设备' },
      { source: 'manual', score: 10, text: '恢复出厂设置之前备份配置网络参数设备。' },
      { source: 'manual', score: 10, text: '重启之后检查日志确认结果并保留记录' },
    ])
    expect(f.select(2).map(hit => hit.id)).toEqual(['0', '2'])
    // Similar text is deprioritized, never permanently removed unless equivalent.
    expect(f.select(3).map(hit => hit.id)).toContain('1')
  })
  it('deduplicates only equivalent bodies within one source and keeps independent provenance', () => {
    const f = fixture([
      { source: 'kb1/file', score: 5, text: '恢复 ＡＢＣ' },
      { source: 'kb1/file', score: 5, text: '恢复   ABC' },
      { source: 'kb2/file', score: 5, text: '恢复 ABC' },
    ])
    expect(f.select(6).map(hit => hit.id)).toEqual(['0', '2'])
  })
  it('preserves first-hit, raw diagnostics and empty limit behavior', () => {
    const f = fixture([
      { source: 'a', score: 10, text: '设备甲' },
      { source: 'a', score: 9, text: '设备乙' },
      { source: 'b', score: 8, text: '设备丙' },
    ])
    expect(f.select(1)).toEqual([f.hits[0]])
    expect(f.select(0)).toEqual([])
    expect(f.select(-1)).toEqual([])
    for (const hit of f.select(3)) expect(hit).toBe(f.hits.find(candidate => candidate.id === hit.id))
  })
})
