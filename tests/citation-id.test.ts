import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCitationId, type CitationIdentity } from '../src/core/citation-id.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import { outcomeOfTurn } from '../src/client/citation-scan.ts'
import type { RetrievedPassage } from '../src/pre-step.ts'

const EVIDENCE: CitationIdentity = {
  kbId: 'kb_00000001',
  materialId: 'manual.txt',
  ordinal: 0,
  locator: '第 1 行',
  text: 'private evidence 明文',
}
const ID_PATTERN = /^kb-cite-v1-[a-f0-9]{64}$/
const LEGACY: RetrievedPassage = {
  kbName: '资料库',
  materialTitle: '手册',
  locator: '第 1 行',
  text: '旧内容',
}

function scan(passages: readonly unknown[]) {
  return outcomeOfTurn({
    order: [],
    nodes: new Map([
      ['context', {
        kind: 'context',
        location: { turn: 1 },
        data: { source: { kind: 'knowbase', passages } },
      }],
    ]),
  }, 1)!.passages
}

function hits(service: KnowbaseService, query = 'alpha', ids: readonly string[]) {
  const result = service.retrieve(query, ids)
  if (result.kind !== 'hits') throw new Error(`Expected hits, got ${result.kind}`)
  return result.passages
}

async function fixture(root: string) {
  const store = new MemoryStore()
  store.seedKnowledgeBase({ id: 'kb_00000001', name: '资料库', description: '', folderName: '资料库--kb_00000001', createdAt: 1, updatedAt: 1, indexRevision: 0 })
  const fs = createMemoryVaultFs(root)
  const service = new KnowbaseService(store, fs, root, { now: () => 100 })
  await service.initialize()
  const base = service.listKnowledgeBases()[0]!
  return { service, fs, root, base }
}

const file = (name: string, text: string) => ({ name, data: new TextEncoder().encode(text) })

describe('citation identity v1', () => {
  it('uses the exact UTF-8 JSON tuple and deterministic SHA-256 output', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(['kb_00000001', 'manual.txt', 0, '第 1 行', 'private evidence 明文']), 'utf8')
      .digest('hex')
    expect(createCitationId(EVIDENCE)).toBe(`kb-cite-v1-${expected}`)
    expect(createCitationId({ ...EVIDENCE })).toBe(createCitationId(EVIDENCE))
    expect(createCitationId(EVIDENCE)).toMatch(ID_PATTERN)
    expect(createCitationId(EVIDENCE)).toHaveLength(75)
  })

  it.each([
    ['base', { kbId: 'kb_00000002' }],
    ['file', { materialId: 'other.txt' }],
    ['chunk ordinal', { ordinal: 1 }],
    ['locator', { locator: '第 2 行' }],
    ['text', { text: 'changed evidence' }],
    ['exact whitespace', { text: `${EVIDENCE.text} ` }],
  ])('changes when %s changes', (_label, change) => {
    expect(createCitationId({ ...EVIDENCE, ...change })).not.toBe(createCitationId(EVIDENCE))
  })

  it('separates tuple fields containing delimiters, quotes, escapes and nulls', () => {
    const pairs: [CitationIdentity, CitationIdentity][] = [
      [{ ...EVIDENCE, kbId: 'a|b', materialId: 'c' }, { ...EVIDENCE, kbId: 'a', materialId: 'b|c' }],
      [{ ...EVIDENCE, kbId: 'a\u0000b', materialId: 'c' }, { ...EVIDENCE, kbId: 'a', materialId: 'b\u0000c' }],
      [{ ...EVIDENCE, locator: 'x","y', text: 'z' }, { ...EVIDENCE, locator: 'x', text: 'y","z' }],
    ]
    for (const [left, right] of pairs) expect(createCitationId(left)).not.toBe(createCitationId(right))
  })

  it('ignores paths, display names, ranks and revisions', () => {
    const first = {
      ...EVIDENCE,
      filePath: 'C:\\private\\vault\\manual.txt', kbName: 'old', materialTitle: 'old',
      score: 1, coverage: 0.5, rank: 0, indexRevision: 1, id: 'random-chunk-a',
    }
    const second = {
      ...first,
      filePath: 'D:\\other\\manual.txt', kbName: 'new', materialTitle: 'new',
      score: 99, coverage: 1, rank: 5, indexRevision: 999, id: 'random-chunk-b',
    }
    const id = createCitationId(first)
    expect(createCitationId(second)).toBe(id)
    expect(id).not.toContain('private')
    expect(id).not.toContain(EVIDENCE.text)
  })
})

describe('Host retrieval citation IDs', () => {
  it('stays stable across ranking and forced/reused scans', async () => {
    const { service, base } = await fixture(path.resolve('citation-memory-stable'))
    await service.addFiles(base.id, [
      file('a.txt', 'shared alpha alpha alpha beta'),
      file('b.txt', 'shared beta beta beta alpha'),
    ])
    const alpha = hits(service, 'alpha', [base.id])
    const byMaterial = new Map(alpha.map(passage => [passage.materialId, passage.citationId]))
    const beta = hits(service, 'beta', [base.id])
    expect(beta.map(passage => passage.materialId)).not.toEqual(alpha.map(passage => passage.materialId))
    for (const passage of beta) expect(passage.citationId).toBe(byMaterial.get(passage.materialId))
    await service.rescan(base.id)
    await service.rescan(base.id, { force: true })
    for (const passage of hits(service, 'alpha', [base.id])) {
      expect(passage.citationId).toMatch(ID_PATTERN)
      expect(passage.citationId).toBe(byMaterial.get(passage.materialId))
    }
  })

  it('is independent of the absolute vault location and display name', async () => {
    const first = await fixture(path.resolve('citation-memory-one'))
    const second = await fixture(path.resolve('citation-memory-two'))
    await first.service.addFiles(first.base.id, [file('manual.txt', 'alpha evidence')])
    await second.service.addFiles(second.base.id, [file('manual.txt', 'alpha evidence')])
    const before = hits(first.service, 'alpha', [first.base.id])[0]!
    const other = hits(second.service, 'alpha', [second.base.id])[0]!
    expect(other.citationId).toBe(before.citationId)
    expect(other.filePath).not.toBe(before.filePath)
    await first.service.renameKnowledgeBase(first.base.id, '新名字')
    const after = hits(first.service, 'alpha', [first.base.id])[0]!
    expect(after.citationId).toBe(before.citationId)
    expect(after.kbName).toBe('新名字')
  })
})

describe('scanner old and malformed payload compatibility', () => {
  it('keeps legacy passages and existing reader fields', () => {
    expect(scan([LEGACY])).toEqual([LEGACY])
    const reader = {
      ...LEGACY,
      kbId: 'kb_00000001', materialId: 'manual.txt',
      filePath: 'C:\\vault\\manual.txt', ordinal: 0,
    }
    expect(scan([reader])).toEqual([reader])
  })

  it('keeps a valid citation ID beside legacy display and reader fields', () => {
    const passage = { ...LEGACY, citationId: createCitationId(EVIDENCE) }
    expect(scan([passage])).toEqual([passage])
  })

  it.each([
    undefined, null, 123, {}, '',
    `kb-cite-v1-${'a'.repeat(63)}`,
    `kb-cite-v1-${'a'.repeat(65)}`,
    `kb-cite-v1-${'A'.repeat(64)}`,
    `kb-cite-v1-${'g'.repeat(64)}`,
    `kb-cite-v2-${'a'.repeat(64)}`,
    ` kb-cite-v1-${'a'.repeat(64)}`,
    `kb-cite-v1-${'a'.repeat(64)}\n`,
    `kb-cite-v1-${'a'.repeat(64)}\r\n`,
  ])('drops malformed ID %# without dropping evidence', citationId => {
    expect(scan([{ ...LEGACY, citationId }])).toEqual([LEGACY])
  })

  it('does not let a valid ID rescue malformed display fields', () => {
    expect(scan([{ ...LEGACY, text: 123, citationId: createCitationId(EVIDENCE) }])).toEqual([])
  })
})
