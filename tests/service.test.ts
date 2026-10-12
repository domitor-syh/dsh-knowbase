/**
 * Service tests.
 *
 * These cover the properties that make the index trustworthy over time: a
 * deleted or edited material must stop being retrievable, a renamed base must
 * change what citations say, and scope filtering must not silently shrink the
 * result set.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  KnowbaseError,
  KnowbaseService,
  MemoryStore,
} from '../src/core/service.ts'

const MANUAL = [
  '# 设备手册',
  '',
  '出厂默认波特率为115200，可在配置文件中修改。',
  '',
  '修改后需要重启设备才能生效。',
].join('\n')

const NETWORK = '# 网络配置\n\n本产品支持USB与以太网两种连接方式。'

async function freshService(): Promise<KnowbaseService> {
  const service = new KnowbaseService(new MemoryStore(), { now: () => 1_700_000_000_000 })
  await service.initialize()
  return service
}

describe('KnowbaseService — knowledge bases', () => {
  let service: KnowbaseService

  beforeEach(async () => {
    service = await freshService()
  })

  it('creates and lists a base', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    expect(created.name).toBe('产品资料')
    expect(service.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
  })

  it('trims and collapses the name', async () => {
    const created = await service.createKnowledgeBase('  产品   资料  ')
    expect(created.name).toBe('产品 资料')
  })

  it('rejects an empty name', async () => {
    await expect(service.createKnowledgeBase('   ')).rejects.toBeInstanceOf(KnowbaseError)
  })

  it('rejects a duplicate name instead of silently making a second one', async () => {
    await service.createKnowledgeBase('产品资料')
    await expect(service.createKnowledgeBase('产品资料')).rejects.toMatchObject({
      code: 'duplicate-name',
    })
  })

  it('renames without changing identity', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    const renamed = await service.renameKnowledgeBase(created.id, '设备资料')
    expect(renamed.id).toBe(created.id)
    expect(service.listKnowledgeBases()[0]!.name).toBe('设备资料')
  })

  it('refuses a rename onto an existing name', async () => {
    const first = await service.createKnowledgeBase('甲')
    await service.createKnowledgeBase('乙')
    await expect(service.renameKnowledgeBase(first.id, '乙')).rejects.toMatchObject({
      code: 'duplicate-name',
    })
  })

  it('deletes a base together with its materials', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await service.addText(created.id, '手册', MANUAL)

    expect(await service.deleteKnowledgeBase(created.id)).toBe(true)
    expect(service.listKnowledgeBases()).toHaveLength(0)
    expect(service.listMaterials()).toHaveLength(0)
    expect(service.retrieve('波特率', [created.id]).kind).toBe('empty_scope')
  })
})

describe('KnowbaseService — materials', () => {
  let service: KnowbaseService
  let kbId: string

  beforeEach(async () => {
    service = await freshService()
    kbId = (await service.createKnowledgeBase('产品资料')).id
  })

  it('chunks and stores a text material', async () => {
    const material = await service.addText(kbId, '手册', MANUAL)
    expect(material.chunks.length).toBeGreaterThan(0)
    expect(material.revision).toBe(1)
    expect(service.listMaterials(kbId)).toHaveLength(1)
  })

  it('rejects empty content rather than storing an unsearchable material', async () => {
    await expect(service.addText(kbId, '空', '   ')).rejects.toBeInstanceOf(KnowbaseError)
  })

  it('rejects a material for an unknown base', async () => {
    await expect(service.addText('kb_missing', '手册', MANUAL)).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('bumps the base index revision when content changes', async () => {
    const before = service.getKnowledgeBase(kbId)!.indexRevision
    await service.addText(kbId, '手册', MANUAL)
    expect(service.getKnowledgeBase(kbId)!.indexRevision).toBe(before + 1)
  })

  it('stops returning a deleted material', async () => {
    const material = await service.addText(kbId, '手册', MANUAL)
    expect(service.retrieve('波特率', [kbId]).kind).toBe('hits')

    expect(await service.deleteMaterial(material.id)).toBe(true)
    expect(service.retrieve('波特率', [kbId]).kind).toBe('not_ready')
  })

  it('stops returning the old text after an edit', async () => {
    const material = await service.addText(kbId, '手册', MANUAL)
    await service.updateMaterialText(material.id, NETWORK)

    expect(service.retrieve('波特率', [kbId]).kind).toBe('no_match')
    expect(service.retrieve('以太网', [kbId]).kind).toBe('hits')
    expect(service.getMaterial(material.id)!.revision).toBe(2)
  })
})

describe('KnowbaseService — retrieval', () => {
  let service: KnowbaseService
  let manualId: string
  let networkId: string

  beforeEach(async () => {
    service = await freshService()
    manualId = (await service.createKnowledgeBase('产品资料')).id
    networkId = (await service.createKnowledgeBase('网络资料')).id
    await service.addText(manualId, '设备手册', MANUAL)
    await service.addText(networkId, '网络配置', NETWORK)
  })

  it('finds the passage that answers a Chinese question', () => {
    const outcome = service.retrieve('默认波特率是多少', [manualId])
    expect(outcome.kind).toBe('hits')
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    expect(outcome.passages[0]!.materialTitle).toBe('设备手册')
    expect(outcome.passages[0]!.text).toContain('115200')
  })

  it('reports no_match rather than an empty list when nothing relates', () => {
    expect(service.retrieve('如何申请差旅报销', [manualId]).kind).toBe('no_match')
  })

  it('reports empty_scope when no selected base exists', () => {
    expect(service.retrieve('波特率', ['kb_missing']).kind).toBe('empty_scope')
    expect(service.retrieve('波特率', []).kind).toBe('empty_scope')
  })

  it('reports not_ready when nothing is indexed yet', async () => {
    const empty = await freshService()
    const id = (await empty.createKnowledgeBase('空的')).id
    expect(empty.retrieve('波特率', [id]).kind).toBe('not_ready')
  })

  it('reports an empty base inside a populated install as not_ready, not as a miss', async () => {
    // Global emptiness is the wrong test. With other bases populated the index
    // is non-empty, so an empty base would be searched, find nothing, and come
    // back as `no_match` — which tells the user to rephrase their question
    // instead of telling them there is no material to search.
    const empty = await service.createKnowledgeBase('空库')
    expect(service.retrieve('波特率', [empty.id]).kind).toBe('not_ready')
  })

  it('still reports a genuine miss when the base has material', () => {
    // The counterpart: material exists in scope, so `no_match` is the honest
    // answer and must not be swallowed by the emptiness check.
    expect(service.retrieve('如何申请差旅报销', [manualId]).kind).toBe('no_match')
  })

  it('never returns a passage from an unselected base', () => {
    const outcome = service.retrieve('以太网', [manualId])
    expect(outcome.kind).toBe('no_match')
  })

  it('searches only the selected bases when several exist', () => {
    const outcome = service.retrieve('连接方式', [networkId])
    expect(outcome.kind).toBe('hits')
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    for (const passage of outcome.passages) expect(passage.kbName).toBe('网络资料')
  })

  it('does not let an out-of-scope hit consume the result limit', () => {
    // The network base matches "连接" far better; if scope filtering happened
    // after the cutoff, the manual's weaker hits would be cut away entirely.
    const outcome = service.retrieve('连接方式', [manualId, networkId], { limit: 1 })
    expect(outcome.kind).toBe('hits')
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    expect(outcome.passages).toHaveLength(1)
  })

  it('cites the current base name after a rename', async () => {
    await service.renameKnowledgeBase(manualId, '设备资料')
    const outcome = service.retrieve('波特率', [manualId])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    expect(outcome.passages[0]!.kbName).toBe('设备资料')
  })

  it('finds a material by words in its title, not only in its body', async () => {
    // The reported failure: a base 「刘一江的信息」 holding a material
    // 「刘一江的电话」 whose body is only the number. Searching the name found
    // nothing, because the title was metadata rather than indexed content.
    const people = await service.createKnowledgeBase('刘一江的信息')
    await service.addText(people.id, '刘一江的电话', '13363537216')

    const byTitle = service.retrieve('刘一江', [people.id])
    expect(byTitle.kind).toBe('hits')
    if (byTitle.kind !== 'hits') throw new Error('unreachable')
    expect(byTitle.passages[0]!.materialTitle).toBe('刘一江的电话')

    // And the body still works, so indexing the title did not replace it.
    expect(service.retrieve('13363537216', [people.id]).kind).toBe('hits')
  })

  it('finds a stored number from a prefix of it', async () => {
    // The second half of the same report: with the number kept whole as one
    // term, a partial number found nothing.
    const people = await service.createKnowledgeBase('联系方式')
    await service.addText(people.id, '值班电话', '13363537216')
    expect(service.retrieve('133', [people.id]).kind).toBe('hits')
  })

  it('does not index the knowledge base name', () => {
    // The name labels a container; indexing it would make every chunk in a base
    // match a query for that base's name.
    expect(service.retrieve('产品资料', [manualId]).kind).toBe('no_match')
  })

  it('cites the chunk text without the indexed title prefix', async () => {
    const people = await service.createKnowledgeBase('刘一江的信息')
    await service.addText(people.id, '刘一江的电话', '13363537216')

    const outcome = service.retrieve('刘一江', [people.id])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    // The title is searchable, but the passage shown to the model stays the
    // chunk text: the citation already carries the title as its source label,
    // and repeating it inside the body would read as part of the material.
    expect(outcome.passages[0]!.text).toBe('13363537216')
  })

  it('honours the limit', () => {
    const outcome = service.retrieve('设备 波特率 配置 连接 修改', [manualId, networkId], {
      limit: 1,
    })
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    expect(outcome.passages).toHaveLength(1)
  })
})

describe('KnowbaseService — persistence round trip', () => {
  it('rebuilds the index from the store on initialize', async () => {
    const store = new MemoryStore()
    const first = new KnowbaseService(store, { now: () => 1 })
    await first.initialize()
    const kbId = (await first.createKnowledgeBase('产品资料')).id
    await first.addText(kbId, '设备手册', MANUAL)

    // A fresh instance stands in for a host restart.
    const second = new KnowbaseService(store, { now: () => 2 })
    await second.initialize()

    expect(second.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
    expect(second.retrieve('波特率', [kbId]).kind).toBe('hits')
  })
})
