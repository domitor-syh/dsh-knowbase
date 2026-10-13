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

  it('soft-deletes a base: hidden, unretrievable, restorable', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await service.addText(created.id, '手册', MANUAL)
    expect(await service.deleteKnowledgeBase(created.id)).toBe(true)
    expect(service.listKnowledgeBases()).toHaveLength(0)
    expect(service.listDeletedKnowledgeBases()).toHaveLength(1)
    // The materials follow their base into the bin, so nothing lists them
    // separately — restoring the base brings them all back.
    expect(service.listDeletedMaterials()).toHaveLength(0)
    expect(service.retrieve('波特率', [created.id]).kind).toBe('not_ready')

    expect(await service.restoreKnowledgeBase(created.id)).toBe(true)
    expect(service.listKnowledgeBases()).toHaveLength(1)
    expect(service.retrieve('波特率', [created.id]).kind).toBe('hits')
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

describe('KnowbaseService — same-base duplicate detection', () => {
  let service: KnowbaseService
  let kbId: string

  beforeEach(async () => {
    service = await freshService()
    kbId = (await service.createKnowledgeBase('产品资料')).id
  })

  it('refuses the same content twice in one base', async () => {
    await service.addText(kbId, '端口说明', MANUAL)
    await expect(service.addText(kbId, '端口说明（副本）', MANUAL)).rejects.toMatchObject({
      code: 'duplicate-material',
    })
  })

  it('names the material it collided with, so the warning can be specific', async () => {
    await service.addText(kbId, '端口说明', MANUAL)
    await expect(service.addText(kbId, '另一个标题', MANUAL)).rejects.toThrow(/端口说明/)
  })

  it('ignores whitespace-only differences, which are the same document', async () => {
    await service.addText(kbId, '端口说明', MANUAL)
    await expect(
      service.addText(kbId, '端口说明', MANUAL.replace(/\n/g, '\n\n')),
    ).rejects.toMatchObject({ code: 'duplicate-material' })
  })

  it('allows the same content in a different base — the same paragraph can belong twice', async () => {
    const other = await service.createKnowledgeBase('另一个库')
    await service.addText(kbId, '端口说明', MANUAL)
    await expect(service.addText(other.id, '端口说明', MANUAL)).resolves.toBeDefined()
  })

  it('adds the copy when the caller insists', async () => {
    await service.addText(kbId, '端口说明', MANUAL)
    const second = await service.addText(kbId, '端口说明', MANUAL, { allowDuplicate: true })
    expect(second.id).toBeDefined()
    expect(service.listMaterials(kbId)).toHaveLength(2)
  })

  it('reports the duplicate without throwing, for the pre-submit check', async () => {
    const first = await service.addText(kbId, '端口说明', MANUAL)
    expect(service.findDuplicateMaterial(kbId, MANUAL)?.id).toBe(first.id)
    expect(service.findDuplicateMaterial(kbId, '完全不同的内容')).toBeUndefined()
  })

  it('stops seeing a duplicate once it is deleted', async () => {
    const first = await service.addText(kbId, '端口说明', MANUAL)
    await service.deleteMaterial(first.id)
    // A recycled material is not in the way: the user removed it on purpose.
    expect(service.findDuplicateMaterial(kbId, MANUAL)).toBeUndefined()
    await expect(service.addText(kbId, '端口说明', MANUAL)).resolves.toBeDefined()
  })

  it('hashes a record that predates fingerprints, rather than exempting it', async () => {
    // Simulates a material stored before duplicate detection existed: no
    // `contentHash`. Absence must not read as "nothing to compare against".
    const store = new MemoryStore()
    await store.saveKnowledgeBase({
      id: 'kb_legacy',
      name: '旧库',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      indexRevision: 1,
    })
    await store.saveMaterial({
      id: 'mat_legacy',
      kbId: 'kb_legacy',
      title: '旧资料',
      source: 'text',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      text: MANUAL,
      chunks: [
        { id: 'chunk_legacy', ordinal: 0, text: MANUAL, headingPath: '', locator: '第 1 行' },
      ],
    })

    const loaded = new KnowbaseService(store, { now: () => 5 })
    await loaded.initialize()

    expect(loaded.findDuplicateMaterial('kb_legacy', MANUAL)?.id).toBe('mat_legacy')
    await expect(loaded.addText('kb_legacy', '再来一份', MANUAL)).rejects.toMatchObject({
      code: 'duplicate-material',
    })
  })
})

describe('KnowbaseService — backup export and restore', () => {
  it('restores a library onto a fresh profile exactly', async () => {
    const source = await freshService()
    const kbId = (await source.createKnowledgeBase('产品资料', '出厂资料')).id
    await source.addText(kbId, '设备手册', MANUAL)
    await source.addText(kbId, '网络配置', NETWORK)

    const document = source.exportBackup(9_000)

    const target = await freshService()
    const summary = await target.importBackup(document)

    expect(summary).toMatchObject({ bases: 1, materials: 2, skippedMaterials: 0 })
    const restored = target.listKnowledgeBases()
    expect(restored.map(kb => kb.name)).toEqual(['产品资料'])
    // The id is kept, so a session selection that pointed at the original base
    // still points at something after a restore.
    expect(restored[0]!.id).toBe(kbId)
    expect(restored[0]!.description).toBe('出厂资料')
    expect(target.retrieve('波特率', [restored[0]!.id]).kind).toBe('hits')
  })

  it('does not overwrite an existing base when the id is taken', async () => {
    const source = await freshService()
    const kbId = (await source.createKnowledgeBase('产品资料')).id
    await source.addText(kbId, '设备手册', MANUAL)
    const document = source.exportBackup(9_000)

    // The target already holds a base under the very id the file carries — the
    // collision a restore onto a populated profile hits. Forcing the id through
    // `restore` is the only way to construct it, since a normal create invents
    // one.
    const target = await freshService()
    await target.createKnowledgeBase('产品资料', '', { id: kbId })
    await target.addText(kbId, '原有资料', '这是原有的内容，不该被覆盖。')

    const summary = await target.importBackup(document)

    expect(summary.reallocatedBases).toBe(1)
    expect(summary.baseNames).toEqual(['产品资料（导入 2）'])
    expect(target.listKnowledgeBases().map(kb => kb.name)).toEqual([
      '产品资料',
      '产品资料（导入 2）',
    ])
    // The base that was already there is untouched, id and content both.
    expect(target.retrieve('原有的内容', [kbId]).kind).toBe('hits')
    expect(target.retrieve('波特率', [kbId]).kind).toBe('no_match')
  })

  it('imports the same file twice as two separate libraries', async () => {
    const source = await freshService()
    const kbId = (await source.createKnowledgeBase('产品资料')).id
    await source.addText(kbId, '设备手册', MANUAL)
    const document = source.exportBackup(9_000)

    const target = await freshService()
    await target.importBackup(document)
    const second = await target.importBackup(document)

    expect(second.baseNames).toEqual(['产品资料（导入 2）'])
    expect(second.reallocatedBases).toBe(1)
    expect(target.listKnowledgeBases()).toHaveLength(2)
    expect(target.listMaterials()).toHaveLength(2)
  })

  it('keeps two identical materials from a file instead of collapsing them', async () => {
    const source = await freshService()
    const kbId = (await source.createKnowledgeBase('产品资料')).id
    await source.addText(kbId, '设备手册', MANUAL, { allowDuplicate: true })
    await source.addText(kbId, '设备手册', MANUAL, { allowDuplicate: true })

    const target = await freshService()
    const summary = await target.importBackup(source.exportBackup(9_000))

    // The file is the source of truth about its own contents: duplicate
    // detection guards ingestion, it does not get to rewrite a backup.
    expect(summary.materials).toBe(2)
    expect(target.listMaterials()).toHaveLength(2)
  })

  it('exports only live records — the recycle bin is not a snapshot', async () => {
    const service = await freshService()
    const kbId = (await service.createKnowledgeBase('产品资料')).id
    const material = await service.addText(kbId, '设备手册', MANUAL)
    await service.deleteMaterial(material.id)

    const document = service.exportBackup(9_000)
    expect(document.bases[0]!.materials).toHaveLength(0)
  })

  it('carries the source text, not the chunks it was split into', async () => {
    const service = await freshService()
    const kbId = (await service.createKnowledgeBase('产品资料')).id
    await service.addText(kbId, '设备手册', MANUAL)

    const document = service.exportBackup(9_000)
    expect(document.bases[0]!.materials[0]!.text).toBe(MANUAL)
  })
})
