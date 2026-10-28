import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCitationId } from '../src/core/citation-id.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import { ReferenceBm25Index } from './fixtures/bm25-reference.ts'

/** Reconstruct the pre-optimization recall path from the service's actual chunks. */
function checkRecall(service: KnowbaseService, scopes: readonly (readonly string[])[]) {
  const reference = new ReferenceBm25Index()
  const contexts = new Map(service.listMaterials().flatMap(material => material.chunks.map(chunk => {
    reference.add(chunk.id, `${material.title}\n${chunk.text}`)
    return [chunk.id, { material, chunk }] as const
  })))
  for (const scope of scopes) for (const query of ['设备参数', '税', '𠀀', 'ethernet', 'ZX2048', 'ZX2099', 'unfindableword']) {
    const allowed = new Set(scope)
    const hits = reference.search(query, {
      limit: Number.MAX_SAFE_INTEGER,
      accept: id => allowed.has(contexts.get(id)!.material.kbId),
    })
    const evidenceKey = (kbId: string, materialId: string, text: string) =>
      JSON.stringify([kbId, materialId, text.normalize('NFKC').replace(/\s+/gu, ' ').trim()])
    const expected = new Map(hits.map(hit => {
      const { material, chunk } = contexts.get(hit.id)!
      return [evidenceKey(material.kbId, material.id, chunk.text), { score: hit.score, coverage: hit.coverage }] as const
    }))
    // This fixture has fewer than six distinct bodies. Selection must preserve
    // all evidence and frozen-reference scores, while order may now diversify.
    expect(expected.size).toBeLessThanOrEqual(6)
    const result = service.retrieve(query, scope)
    const actual = new Map((result.kind === 'hits' ? result.passages : []).map(passage => {
      const material = service.getMaterial(passage.kbId!, passage.materialId!)!
      const chunk = material.chunks.find(candidate => candidate.ordinal === passage.ordinal)!
      expect(passage.text).toBe(chunk.text)
      expect(passage.locator).toBe(chunk.locator)
      expect(passage.citationId).toBe(createCitationId({ kbId: material.kbId, materialId: material.id,
        ordinal: chunk.ordinal, locator: chunk.locator, text: chunk.text }))
      return [evidenceKey(material.kbId, material.id, chunk.text), { score: passage.score, coverage: passage.coverage }] as const
    }))
    expect(actual, `${scope.join(',')}/${query}`).toStrictEqual(expected)
  }
}

describe('KnowbaseService grouped index — legacy recall parity', () => {
  it('preserves scores, citations and empty-range states across rescans, renames and deletion', async () => {
    const root = path.resolve('synthetic-service-scope')
    const fs = createMemoryVaultFs(root)
    const service = new KnowbaseService(new MemoryStore(), fs, root, { chunk: { targetChars: 90, maxChars: 160 } })
    await service.initialize()
    const selected = await service.createKnowledgeBase('选中库')
    const hidden = await service.createKnowledgeBase('未选中库')
    const empty = await service.createKnowledgeBase('空库')
    const data = (text: string) => new TextEncoder().encode(text)
    await service.addFiles(selected.id, [
      { name: '设备.txt', data: data('设备参数 ZX2048 支持 Ethernet。增值税发票。古文字𠀀说明。') },
      { name: '重复.txt', data: data(Array.from({ length: 8 }, () => '设备参数恢复之后，请先检查设备参数并保存配置。').join('\n\n')) },
    ])
    await service.addFiles(hidden.id, [{ name: '隐藏.txt', data: data('设备参数 ZX2048 ethernet，税与𠀀仅供对照。') }])
    const scopes = [[selected.id], [hidden.id], [selected.id, hidden.id], [hidden.id, selected.id, selected.id], [empty.id]]
    checkRecall(service, scopes)
    expect(service.retrieve('设备参数', []).kind).toBe('empty_scope')
    expect(service.retrieve('设备参数', [empty.id]).kind).toBe('not_ready')
    const beforeHidden = service.retrieve('设备参数', [selected.id])
    await service.addFiles(hidden.id, [{ name: '无关.txt', data: data('无关长资料。'.repeat(80)) }])
    expect(service.retrieve('设备参数', [selected.id])).toStrictEqual(beforeHidden)
    checkRecall(service, scopes)
    await service.rescan()
    checkRecall(service, scopes)
    await service.renameKnowledgeBase(selected.id, '重命名后的库')
    checkRecall(service, scopes)
    const base = service.getKnowledgeBase(selected.id)!
    await fs.writeFile(path.join(root, base.folderName, '设备.txt'), '园艺与土壤，无设备编号。')
    await service.rescan(selected.id)
    checkRecall(service, scopes)
    await service.rescan(selected.id, { force: true })
    checkRecall(service, scopes)
    for (const material of service.listMaterials(selected.id)) await service.deleteMaterial(selected.id, material.id)
    expect(service.retrieve('设备参数', [selected.id]).kind).toBe('not_ready')
    checkRecall(service, scopes)
    await service.deleteKnowledgeBase(hidden.id)
    expect(service.retrieve('设备参数', [hidden.id]).kind).toBe('empty_scope')
    await service.initialize()
    expect(service.retrieve('设备参数', [selected.id]).kind).toBe('not_ready')
    await service.addFiles(selected.id, [{ name: '新.txt', data: data('设备参数 ZX2048') }])
    checkRecall(service, [[selected.id], [selected.id, empty.id]])
  })
})
