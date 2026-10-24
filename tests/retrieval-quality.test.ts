import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import type { RetrievedPassage } from '../src/pre-step.ts'
import { chunkOfParams, parseReaderAddress, readerAddress } from '../src/client/reader-address.ts'
import { createQualityFixture, measureQuality, qualityCases } from './fixtures/retrieval-quality.ts'

const file = (name: string, text: string) => ({ name, data: new TextEncoder().encode(text) })
const normalizedText = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
const evidenceKey = (passage: RetrievedPassage) => JSON.stringify([
  passage.kbId, passage.materialId, normalizedText(passage.text),
])

function hits(service: KnowbaseService, query: string, kbIds: readonly string[], limit = 20) {
  const result = service.retrieve(query, kbIds, { limit })
  expect(result.kind).toBe('hits')
  if (result.kind !== 'hits') throw new Error(`Expected hits for ${query}, got ${result.kind}`)
  return result.passages
}

/** Verify the original source address and location, not a regenerated chunk UUID. */
function expectResolvableCitation(service: KnowbaseService, passage: RetrievedPassage) {
  const { kbId, materialId, ordinal } = passage
  if (kbId === undefined || materialId === undefined || ordinal === undefined) {
    throw new Error('Expected a current citation with ids and ordinal')
  }
  const material = service.getMaterial(kbId, materialId)
  expect(material).toBeDefined()
  if (material === undefined) throw new Error(`Missing material ${passage.materialId}`)
  const chunk = material.chunks.find(candidate => candidate.ordinal === ordinal)
  expect(chunk).toBeDefined()
  if (chunk === undefined) throw new Error(`Missing chunk ${passage.ordinal}`)
  expect(chunk.text).toBe(passage.text)
  expect(chunk.locator).toBe(passage.locator)
  expect(parseReaderAddress(readerAddress(kbId, materialId))).toEqual({
    kbId, materialId,
  })
  expect(chunkOfParams({ chunk: ordinal })).toBe(ordinal)
  const location = /^第 (\d+)(?:-(\d+))? 行$/u.exec(passage.locator)
  expect(location).not.toBeNull()
  const start = Number(location![1])
  const end = Number(location![2] ?? location![1])
  const sourceLines = material.extractedText!.replace(/\r\n?/gu, '\n').split('\n')
  expect(start).toBeGreaterThanOrEqual(1)
  expect(end).toBeGreaterThanOrEqual(start)
  expect(end).toBeLessThanOrEqual(sourceLines.length)
  // Chunking drops blank separator lines; the locator still spans the original
  // source lines. Compare content modulo existing whitespace normalization.
  expect(normalizedText(sourceLines.slice(start - 1, end).join('\n'))).toBe(normalizedText(passage.text))
  expect(Number.isFinite(passage.score)).toBe(true)
  expect(passage.score).toBeGreaterThan(0)
  expect(passage.coverage).toBeGreaterThan(0)
  expect(passage.coverage).toBeLessThanOrEqual(1)
}

async function smallFixture() {
  // A deliberately small target flushes every paragraph separately. The vault
  // implementation is wholly in memory; this path is never created on disk.
  const root = path.resolve('C:/synthetic-retrieval-quality-regression')
  const service = new KnowbaseService(new MemoryStore(), createMemoryVaultFs(root), root, {
    now: () => 1, chunk: { targetChars: 1, maxChars: 64 },
  })
  await service.initialize()
  const base = await service.createKnowledgeBase('主资料')
  return { service, kbId: base.id }
}

/** Stable quality measurements deliberately exclude random opaque chunk ids. */
function qualitySnapshot(service: KnowbaseService, kbId: string) {
  const cases = qualityCases.map(test => {
    const result = service.retrieve(test.query, [kbId], { limit: 3 })
    const passages = result.kind === 'hits' ? result.passages : []
    const titles = passages.map(passage => passage.materialTitle)
    const expected: readonly string[] = test.expected
    const rank = titles.findIndex(title => expected.includes(title)) + 1
    const recall = expected.length === 0 ? null : expected.filter(title => titles.includes(title)).length / expected.length
    const unique = new Set(passages.map(evidenceKey)).size === passages.length
    const passed = expected.length === 0 ? result.kind === 'no_match' :
      rank === 1 && recall === 1 && (!('distinct' in test) || unique)
    for (const passage of passages) expectResolvableCitation(service, passage)
    return { id: test.id, kind: result.kind, reciprocalRank: rank === 0 ? 0 : 1 / rank, recall, unique, passed }
  })
  const positives = cases.filter(test => test.recall !== null)
  const negatives = cases.filter(test => test.recall === null)
  return {
    cases,
    metrics: {
      passed: cases.filter(test => test.passed).length,
      total: cases.length,
      mrrAt3: positives.reduce((sum, test) => sum + test.reciprocalRank, 0) / positives.length,
      meanRecallAt3: positives.reduce((sum, test) => sum + (test.recall ?? 0), 0) / positives.length,
      negativeAccuracy: negatives.filter(test => test.kind === 'no_match').length / negatives.length,
    },
  }
}

describe('O-04 isolated retrieval quality corpus', () => {
  let measurement: Awaited<ReturnType<typeof measureQuality>>
  beforeAll(async () => { measurement = await measureQuality() })

  it.each(qualityCases)('$id — $group: $query', test => {
    const actual = measurement.cases.find(candidate => candidate.id === test.id)!
    expect(actual, JSON.stringify(actual)).toBeDefined()
    expect(actual.passed, JSON.stringify(actual)).toBe(true)
    if (test.expected.length === 0) {
      expect(actual.kind).toBe('no_match')
      expect(actual.actual).toEqual([])
    } else {
      expect(actual.reciprocalRank).toBe(1)
      expect(actual.recallAt3).toBe(1)
      expect(actual.actual.length).toBeLessThanOrEqual(3)
      if ('distinct' in test) expect(actual.uniqueText).toBe(true)
    }
  })

  it('keeps all 26 cases and citation locations stable after a forced rebuild', async () => {
    const { service, kbId } = await createQualityFixture()
    const before = qualitySnapshot(service, kbId)
    expect(before.metrics).toEqual({ passed: 26, total: 26, mrrAt3: 1, meanRecallAt3: 1, negativeAccuracy: 1 })
    await service.rescan(kbId, { force: true })
    const after = qualitySnapshot(service, kbId)
    expect(after).toEqual(before)
    expect(after.metrics).toEqual(measurement.metrics)
  })
})

describe('O-04 duplicate evidence and source boundaries', () => {
  const query = '恢复出厂设置'
  const repeated = '恢复出厂设置。'

  it('deduplicates more than eight identical chunks before limit and fills from a lower-ranked source', async () => {
    const { service, kbId } = await smallFixture()
    await service.addFiles(kbId, [
      file('重复.txt', Array.from({ length: 12 }, () => repeated).join('\n\n')),
      file('补充.txt', '恢复出厂设置之前先备份配置，随后重新检查连接和参数。'),
    ])
    const material = service.getMaterial(kbId, '重复.txt')!
    expect(material.chunks.length).toBeGreaterThan(8)
    expect(material.chunks.every(chunk => chunk.text === repeated)).toBe(true)
    const passages = hits(service, query, [kbId], 2)
    expect(passages).toHaveLength(2)
    expect(passages[0]!.materialId).toBe('重复.txt')
    expect(passages[1]!.materialId).toBe('补充.txt')
    expect(new Set(passages.map(evidenceKey)).size).toBe(2)
    for (const passage of passages) expectResolvableCitation(service, passage)
    await service.rescan(kbId, { force: true })
    const rebuilt = hits(service, query, [kbId], 2)
    expect(rebuilt.map(passage => passage.materialId)).toEqual(['重复.txt', '补充.txt'])
    for (const passage of rebuilt) expectResolvableCitation(service, passage)
  })

  it('keeps differing bodies in one material instead of imposing a per-document cap', async () => {
    const { service, kbId } = await smallFixture()
    const bodies = [repeated, '恢复出厂设置之前先备份配置。', '恢复出厂设置之后重新连接设备。']
    await service.addFiles(kbId, [file('步骤.txt', bodies.join('\n\n'))])
    const passages = hits(service, query, [kbId])
    expect(passages).toHaveLength(3)
    expect(passages.every(passage => passage.materialId === '步骤.txt')).toBe(true)
    expect(passages.map(passage => passage.text).sort()).toEqual([...bodies].sort())
    for (const passage of passages) expectResolvableCitation(service, passage)
  })

  it('preserves identical bodies from separate materials', async () => {
    const { service, kbId } = await smallFixture()
    await service.addFiles(kbId, [file('甲.txt', repeated), file('乙.txt', repeated)])
    const passages = hits(service, query, [kbId])
    expect(passages).toHaveLength(2)
    expect(passages.map(passage => passage.materialId).sort()).toEqual(['乙.txt', '甲.txt'])
    expect(passages.every(passage => passage.text === repeated)).toBe(true)
    for (const passage of passages) expectResolvableCitation(service, passage)
  })

  it('preserves same-name identical sources across bases while honoring scope', async () => {
    const { service, kbId } = await smallFixture()
    const other = await service.createKnowledgeBase('另一资料')
    await service.addFiles(kbId, [file('相同.txt', repeated)])
    await service.addFiles(other.id, [file('相同.txt', repeated)])
    const passages = hits(service, query, [kbId, other.id])
    expect(passages).toHaveLength(2)
    expect(new Set(passages.map(passage => passage.kbId))).toEqual(new Set([kbId, other.id]))
    expect(passages.every(passage => passage.materialId === '相同.txt' && passage.text === repeated)).toBe(true)
    for (const passage of passages) expectResolvableCitation(service, passage)
    const scoped = hits(service, query, [kbId])
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.kbId).toBe(kbId)
  })

  it('keeps scoped scores and ranking unchanged when an unselected base changes', async () => {
    const { service, kbId } = await smallFixture()
    await service.addFiles(kbId, [file('甲.txt', '税务申报 alpha'), file('乙.txt', '申报 alpha alpha')])
    const other = await service.createKnowledgeBase('范围外')
    const snapshot = () => ['申报', '税', '税 alpha'].map(query => hits(service, query, [kbId]).map(
      passage => ({ materialId: passage.materialId, text: passage.text, score: passage.score, coverage: passage.coverage }),
    ))
    const before = snapshot()
    await service.addFiles(other.id, [file('干扰.txt', '税 申报 alpha '.repeat(50))])
    expect(snapshot()).toEqual(before)
    await service.rescan(other.id, { force: true })
    expect(snapshot()).toEqual(before)
  })

  it('collapses NFKC/whitespace-equivalent bodies without rewriting the cited original', async () => {
    const { service, kbId } = await smallFixture()
    const bodies = ['恢复出厂设置 ＡＢＣ。', '恢复出厂设置   ABC。', '恢复出厂设置 ABC。']
    await service.addFiles(kbId, [file('格式.txt', bodies.join('\n\n'))])
    expect(service.getMaterial(kbId, '格式.txt')!.chunks).toHaveLength(3)
    const passages = hits(service, query, [kbId])
    expect(passages).toHaveLength(1)
    expect(bodies).toContain(passages[0]!.text)
    expectResolvableCitation(service, passages[0]!)
  })
})
