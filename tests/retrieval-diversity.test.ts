import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'

const file = (name: string, text: string) => ({ name, data: new TextEncoder().encode(text) })
const label = (index: number) => `s${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`

async function fixture() {
  const root = path.resolve('C:/synthetic-retrieval-diversity')
  const service = new KnowbaseService(new MemoryStore(), createMemoryVaultFs(root), root, {
    now: () => 1, chunk: { targetChars: 1, maxChars: 256 },
  })
  await service.initialize()
  const base = await service.createKnowledgeBase('资料')
  return { service, kbId: base.id }
}

function retrieve(service: KnowbaseService, kbIds: readonly string[], query: string, limit?: number) {
  const result = service.retrieve(query, kbIds, limit === undefined ? {} : { limit })
  expect(result.kind).toBe('hits')
  if (result.kind !== 'hits') throw new Error(`Expected hits for ${query}, got ${result.kind}`)
  for (const passage of result.passages) {
    const material = service.getMaterial(passage.kbId!, passage.materialId!)!
    const chunk = material.chunks.find(candidate => candidate.ordinal === passage.ordinal)!
    expect(chunk.text).toBe(passage.text)
    expect(chunk.locator).toBe(passage.locator)
    expect(Number.isFinite(passage.score)).toBe(true)
    expect(passage.score).toBeGreaterThan(0)
    expect(passage.coverage).toBeGreaterThan(0)
    expect(passage.coverage).toBeLessThanOrEqual(1)
  }
  return result.passages
}

const snapshot = (passages: ReturnType<typeof retrieve>) => passages.map(passage => ({
  kbId: passage.kbId, materialId: passage.materialId, ordinal: passage.ordinal,
  text: passage.text, locator: passage.locator, citationId: passage.citationId,
  score: passage.score, coverage: passage.coverage,
}))

describe('KnowbaseService — source diversity with relevance safeguards', () => {
  it('retains a competitive old source after adding 200 distinct higher-scoring chunks', async () => {
    const { service, kbId } = await fixture()
    await service.addFiles(kbId, [file('old.txt', 'reset backup legacy note')])
    expect(retrieve(service, [kbId], 'reset backup').map(hit => hit.materialId)).toEqual(['old.txt'])
    const bodies = Array.from({ length: 200 }, (_, index) => `reset backup reset backup ${label(index)}`)
    await service.addFiles(kbId, [file('new.txt', bodies.join('\n\n'))])
    const material = service.getMaterial(kbId, 'new.txt')!
    expect(material.chunks).toHaveLength(200)
    expect(new Set(material.chunks.map(chunk => chunk.text)).size).toBe(200)
    // No explicit limit: exercise the actual six-passage application budget.
    const passages = retrieve(service, [kbId], 'reset backup')
    expect(passages).toHaveLength(6)
    expect(new Set(passages.map(hit => hit.materialId))).toEqual(new Set(['old.txt', 'new.txt']))
    const old = passages.find(hit => hit.materialId === 'old.txt')!
    expect(passages.filter(hit => hit.materialId === 'new.txt').every(hit => hit.score! > old.score!)).toBe(true)
    expect(old.coverage).toBe(1)
    expect(retrieve(service, [kbId], 'reset backup', 1)[0]!.materialId).toBe('new.txt')
  })

  it('does not spend a slot on weak common-word noise merely to add another source', async () => {
    const { service, kbId } = await fixture()
    const bodies = Array.from({ length: 10 }, (_, index) => `reset backup restore firmware ${label(index)}`)
    await service.addFiles(kbId, [
      file('manual.txt', bodies.join('\n\n')),
      file('noise.txt', `reset ${'gardening soil watering flowers '.repeat(40)}`),
    ])
    // The noise really is recalled when space is available; scope does not exclude it.
    expect(retrieve(service, [kbId], 'reset backup restore firmware', 20).some(hit => hit.materialId === 'noise.txt')).toBe(true)
    const passages = retrieve(service, [kbId], 'reset backup restore firmware')
    expect(passages).toHaveLength(6)
    expect(passages.every(hit => hit.materialId === 'manual.txt')).toBe(true)
    expect(passages.every(hit => hit.coverage === 1)).toBe(true)
  })

  it('fills all six slots with different useful bodies when one file supplies the evidence', async () => {
    const { service, kbId } = await fixture()
    const bodies = Array.from({ length: 8 }, (_, index) => `reset backup procedure ${label(index)}`)
    await service.addFiles(kbId, [file('manual.txt', bodies.join('\n\n'))])
    const passages = retrieve(service, [kbId], 'reset backup')
    expect(passages).toHaveLength(6)
    expect(passages.every(hit => hit.materialId === 'manual.txt')).toBe(true)
    expect(new Set(passages.map(hit => hit.text)).size).toBe(6)
  })

  it('retains title-only recall when bodies contain none of the query terms', async () => {
    const { service, kbId } = await fixture()
    await service.addFiles(kbId, [
      file('刘一江的电话.txt', '13363537216'),
      file('刘一江的地址.txt', '北京市海淀区'),
    ])
    const passages = retrieve(service, [kbId], '刘一江')
    expect(new Set(passages.map(hit => hit.materialId))).toEqual(new Set(['刘一江的电话.txt', '刘一江的地址.txt']))
    expect(passages.every(hit => !hit.text.includes('刘一江'))).toBe(true)
    expect(retrieve(service, [kbId], '6353')[0]!.text).toBe('13363537216')
  })

  it('preserves selected-scope scores and deterministic citations through hidden changes and forced rebuild', async () => {
    const { service, kbId } = await fixture()
    const bodies = Array.from({ length: 12 }, (_, index) => `reset backup procedure ${label(index)}`)
    await service.addFiles(kbId, [file('alpha.txt', bodies.join('\n\n')), file('beta.txt', 'reset backup procedure other')])
    const before = snapshot(retrieve(service, [kbId], 'reset backup'))
    const hidden = await service.createKnowledgeBase('未选择')
    await service.addFiles(hidden.id, [file('alpha.txt', bodies.join('\n\n'))])
    expect(snapshot(retrieve(service, [kbId], 'reset backup'))).toEqual(before)
    await service.rescan(hidden.id, { force: true })
    expect(snapshot(retrieve(service, [kbId], 'reset backup'))).toEqual(before)
    await service.rescan(kbId, { force: true })
    expect(snapshot(retrieve(service, [kbId], 'reset backup'))).toEqual(before)
    expect(retrieve(service, [kbId], 'reset backup').every(hit => hit.kbId === kbId)).toBe(true)
  })

  it('keeps differing identifier values and negation as separate citable evidence', async () => {
    const { service, kbId } = await fixture()
    const bodies = [
      '型号ZX2048 支持恢复出厂设置，执行前必须备份。',
      '型号ZX2099 不支持恢复出厂设置，执行前必须备份。',
    ]
    await service.addFiles(kbId, [file('models.txt', bodies.join('\n\n'))])
    const passages = retrieve(service, [kbId], '型号 恢复出厂设置')
    expect(passages).toHaveLength(2)
    expect(new Set(passages.map(hit => hit.text))).toEqual(new Set(bodies))
    // Preserve existing contiguous identifier behavior without inventing a mixed-query ranking rule.
    expect(retrieve(service, [kbId], 'ＺＸ２０４８').map(hit => hit.text)).toEqual([bodies[0]])
    expect(service.retrieve('ZX2049', [kbId]).kind).toBe('no_match')
  })
})
