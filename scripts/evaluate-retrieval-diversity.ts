/** Reproducible synthetic quality/latency comparison; no user vault or model. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Bm25Index } from '../src/core/bm25.ts'
import { selectEvidence, type EvidenceSource } from '../src/core/select-evidence.ts'

interface Row { id: string; source: string; text: string; title?: string; group?: string }
function build(rows: Row[]) {
  const index = new Bm25Index()
  const sources = new Map<string, EvidenceSource>()
  rows.forEach((row, ordinal) => {
    index.add(row.id, `${row.title ?? ''}\n${row.text}`, row.group ?? 'kb')
    sources.set(row.id, { key: row.source, ordinal, text: row.text })
  })
  const search = (query: string, diverse: boolean, groups = ['kb']) => index.search(query, {
    groups, limit: 6,
    distinctKey: id => JSON.stringify([sources.get(id)!.key, sources.get(id)!.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()]),
    ...(diverse ? { select: (hits: Parameters<typeof selectEvidence>[0], limit: number) => selectEvidence(hits, limit, id => sources.get(id)!) } : {}),
  })
  return { search, sources }
}
const topic = '蓝鲸设备的维护周期为七个月。'
const query = '蓝鲸设备的维护周期是什么'
const old: Row = { id: 'old', source: 'old.txt', text: topic + '旧文档背景信息说明。'.repeat(50) }
const crowd: Row[] = Array.from({ length: 200 }, (_, i) => ({ id: `new-${i}`, source: 'new.txt', title: '蓝鲸设备维护周期',
  text: `蓝鲸设备的维护周期有专门安排，参见新计划第${i}项。` + '运行参数说明。'.repeat(85) }))
const cases = [
  { name: 'old-only', rows: [old], query, expected: ['old.txt'] },
  { name: 'after-200-competing-chunks', rows: [old, ...crowd], query, expected: ['old.txt', 'new.txt'] },
  { name: 'single-source-six-passages', rows: crowd, query, expected: ['new.txt'] },
  { name: 'weak-noise-not-forced', rows: [...crowd, { id: 'noise', source: 'noise.txt', text: '设备' }], query, expected: ['new.txt'] },
  { name: 'old-exclusive-keyword', rows: [old, ...crowd], query: '七个月', expected: ['old.txt'] },
  { name: 'title-only-contact', rows: [{ id: 'contact', source: 'contact.txt', title: '刘一江的电话.txt', text: '13363531234' }], query: '刘一江', expected: ['contact.txt'] },
  { name: 'exact-identifier', rows: [
    { id: 'exact', source: 'exact.txt', text: 'ZX2048的维护周期为七个月。' },
    { id: 'other', source: 'other.txt', text: 'ZX2099的维护周期为九个月。' },
  ], query: 'ZX2048', expected: ['exact.txt'] },
]
const quality = cases.map(test => {
  const f = build(test.rows)
  const run = (diverse: boolean) => {
    const hits = f.search(test.query, diverse)
    const files = [...new Set(hits.map(hit => f.sources.get(hit.id)!.key))]
    return { files, passages: hits.length,
      sourceRecall: test.expected.filter(key => files.includes(key)).length / test.expected.length,
      unexpectedSources: files.filter(key => !test.expected.includes(key)) }
  }
  const baseline = run(false), improved = run(true)
  assert.equal(improved.sourceRecall, 1, test.name)
  assert.equal(improved.unexpectedSources.length, 0, test.name)
  if (test.name === 'single-source-six-passages') assert.equal(improved.passages, 6)
  return { name: test.name, baseline, improved }
})

// 1,000 sources / 8,000 actual index entries, divided into two KB scopes.
const rows = Array.from({ length: 8000 }, (_, i): Row => ({ id: `chunk-${i}`, source: `kb${Math.floor(i / 8) % 2}/file-${Math.floor(i / 8)}`,
  group: `kb${Math.floor(i / 8) % 2}`, text: `设备配置需要检查网络连接和运行状态。型号QZID${String(Math.floor(i / 8)).padStart(7, '0')}，资料段落${i}。` + '记录参数并确认操作结果。'.repeat(40) }))
const f = build(rows)
const latency = []
for (const groups of [['kb0'], ['kb0', 'kb1']]) for (const q of ['设备配置', 'QZID0000000', 'ZXQNOHIT987654321']) {
  const measure = (diverse: boolean) => {
    for (let i = 0; i < 3; i++) f.search(q, diverse, groups)
    const times: number[] = []
    for (let i = 0; i < 30; i++) {
      const start = performance.now(); f.search(q, diverse, groups); times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    return { medianMs: times[15], p95Ms: times[28] }
  }
  latency.push({ groups, query: q, baseline: measure(false), improved: measure(true) })
}
const crowded = build([old, ...crowd])
const crowdedLatency = [false, true].map(diverse => {
  for (let i = 0; i < 3; i++) crowded.search(query, diverse)
  const times: number[] = []
  for (let i = 0; i < 30; i++) {
    const start = performance.now(); crowded.search(query, diverse); times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return { diverse, medianMs: times[15], p95Ms: times[28] }
})
const report = { generatedAt: new Date().toISOString(), node: process.version,
  method: 'Same BM25 index and scope; baseline exact per-source dedup + top6 vs relevance-constrained source/body diversification. Synthetic fixtures, no claim about user corpus or semantic retrieval.',
  parameters: { relativeScoreFloor: 0.65, relativeCoverageFloor: 0.8, sourcePenalty: 0.5, bodyRedundancyPenalty: 0.25 },
  quality, performance: { entries: rows.length, samples: 30, warmups: 3, latency, crowdedSource: { entries: 201, latency: crowdedLatency } } }
await writeFile(new URL('../outputs/retrieval-diversity-evaluation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
