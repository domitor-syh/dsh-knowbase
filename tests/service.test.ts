/**
 * Service tests — the file model.
 *
 * A knowledge base is a folder and a material is a file in it, so most of what
 * these cover is the consequence of that: the disk is the record, every listing
 * is a read of the folder, and anything that is not on disk is not knowledge.
 * That makes three families of behaviour worth pinning:
 *
 *   - **Naming.** Two files called 「说明书.pdf」 is ordinary, and losing one of
 *     them is not acceptable, so the second arrives as 「说明书 (2).pdf」.
 *   - **Reconciliation.** A file dropped in through Explorer must appear, a file
 *     deleted outside the app must disappear, and a folder renamed by hand must
 *     be followed rather than read as a deletion.
 *   - **Migration.** Text materials stored by the pre-vault build become `.txt`
 *     files once, without ever overwriting a file the user wrote.
 */

import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import type { LegacyMaterial } from '../src/core/model.ts'
import { RECYCLE_DIR_NAME } from '../src/core/vault.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import type { VaultFileSystem } from '../src/vault-fs.ts'

/** The vault root every fixture in this file reads and writes. */
const ROOT = path.resolve('C:/vault')

const MANUAL = [
  '# 设备手册',
  '',
  '出厂默认波特率为115200，可在配置文件中修改。',
  '',
  '修改后需要重启设备才能生效。',
].join('\n')

const NETWORK = '# 网络配置\n\n本产品支持USB与以太网两种连接方式。'

const encoder = new TextEncoder()

/** One file, as {@link KnowbaseService.addFiles} takes it. */
function file(name: string, text: string): { name: string; data: Uint8Array } {
  return { name, data: encoder.encode(text) }
}

interface Fixture {
  readonly store: MemoryStore
  readonly fs: VaultFileSystem
  readonly service: KnowbaseService
}

/** A service over a fresh in-memory store and vault, already initialized. */
async function freshService(): Promise<Fixture> {
  const store = new MemoryStore()
  const fs = createMemoryVaultFs(ROOT)
  const service = new KnowbaseService(store, fs, ROOT, { now: () => 1_700_000_000_000 })
  await service.initialize()
  return { store, fs, service }
}

/** Absolute path of a live base's folder. */
function baseDirOf(service: KnowbaseService, kbId: string): string {
  return path.join(ROOT, service.getKnowledgeBase(kbId)!.folderName)
}

/** Names of the base folders in the vault root, sorted; the recycle folder is not a base. */
async function baseFolders(fs: VaultFileSystem): Promise<string[]> {
  return (await fs.listDir(ROOT))
    .filter(entry => entry.name !== RECYCLE_DIR_NAME)
    .map(entry => entry.name)
    .sort()
}

describe('KnowbaseService — knowledge bases', () => {
  let service: KnowbaseService
  let fs: VaultFileSystem

  beforeEach(async () => {
    const fixture = await freshService()
    service = fixture.service
    fs = fixture.fs
  })

  it('creates a base and the folder that holds its files', async () => {
    const created = await service.createKnowledgeBase('产品资料')

    expect(created.name).toBe('产品资料')
    expect(created.folderName).toBe(`产品资料--${created.id}`)
    // The folder is real: a record whose folder did not exist would be dropped
    // by the next sync, which reads to the user as "I made a base and it vanished".
    const root = await fs.listDir(ROOT)
    expect(await baseFolders(fs)).toEqual([created.folderName])
    expect(root.find(entry => entry.name === created.folderName)?.kind).toBe('directory')
    expect(service.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
  })

  it('trims and collapses the name', async () => {
    const created = await service.createKnowledgeBase('  产品   资料  ')
    expect(created.name).toBe('产品 资料')
  })

  it('rejects an empty name', async () => {
    await expect(service.createKnowledgeBase('   ')).rejects.toMatchObject({ code: 'invalid-name' })
  })

  it('rejects a duplicate name instead of silently making a second one', async () => {
    await service.createKnowledgeBase('产品资料')
    await expect(service.createKnowledgeBase('产品资料')).rejects.toMatchObject({
      code: 'duplicate-name',
    })
  })

  it('renames without changing identity, and takes the folder with it', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    const renamed = await service.renameKnowledgeBase(created.id, '设备资料')

    expect(renamed.id).toBe(created.id)
    expect(renamed.folderName).toBe(`设备资料--${created.id}`)
    // The id rides in the folder name, which is what keeps a citation recorded
    // before the rename still resolvable after it.
    expect(await baseFolders(fs)).toEqual([`设备资料--${created.id}`])
  })

  it('keeps the files when the base is renamed', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await service.addFiles(created.id, [file('手册.txt', MANUAL)])
    await service.renameKnowledgeBase(created.id, '设备资料')

    expect(service.listMaterials(created.id).map(material => material.fileName)).toEqual(['手册.txt'])
    expect(await fs.readText(path.join(baseDirOf(service, created.id), '手册.txt'))).toBe(MANUAL)
  })

  it('renames a base to the name it already has without moving anything', async () => {
    // The folder name does not change, so a move would be pointless work — and
    // renaming a path onto itself is an error on the real filesystem.
    const created = await service.createKnowledgeBase('产品资料')
    await service.renameKnowledgeBase(created.id, '产品资料')
    expect(await baseFolders(fs)).toEqual([created.folderName])
  })

  it('refuses a rename onto an existing name', async () => {
    const first = await service.createKnowledgeBase('甲')
    await service.createKnowledgeBase('乙')
    await expect(service.renameKnowledgeBase(first.id, '乙')).rejects.toMatchObject({
      code: 'duplicate-name',
    })
  })

  it('updates a description', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    const updated = await service.updateDescription(created.id, '  出厂资料  ')
    expect(updated.description).toBe('出厂资料')
  })

  it('rejects operations naming a base that is not there', async () => {
    await expect(service.renameKnowledgeBase('kb_missing', '甲')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.updateDescription('kb_missing', '描述')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.addFiles('kb_missing', [file('a.txt', 'x')])).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('answers false when deleting a base that is not there', async () => {
    expect(await service.deleteKnowledgeBase('kb_missing')).toBe(false)
  })
})

describe('KnowbaseService — materials', () => {
  let service: KnowbaseService
  let fs: VaultFileSystem
  let kbId: string
  let baseDir: string

  beforeEach(async () => {
    const fixture = await freshService()
    service = fixture.service
    fs = fixture.fs
    kbId = (await service.createKnowledgeBase('产品资料')).id
    baseDir = baseDirOf(service, kbId)
  })

  it('writes an incoming file into the base folder and indexes it', async () => {
    const created = await service.addFiles(kbId, [file('设备手册.txt', MANUAL)])

    expect(created.map(material => material.fileName)).toEqual(['设备手册.txt'])
    expect(await fs.readText(path.join(baseDir, '设备手册.txt'))).toBe(MANUAL)

    const material = service.getMaterial(kbId, '设备手册.txt')!
    expect(material.indexed).toBe(true)
    expect(material.chunks.length).toBeGreaterThan(0)
    expect(material.bytes).toBe(encoder.encode(MANUAL).byteLength)
    expect(service.listMaterials(kbId)).toHaveLength(1)
  })

  it('keeps both files when two arrivals carry the same name', async () => {
    await service.addFiles(kbId, [file('说明书.pdf', '第一份')])
    await service.addFiles(kbId, [file('说明书.pdf', '第二份')])

    // Nobody would accept silently losing one of two documents called
    // 「说明书.pdf」, so the second is numbered instead.
    expect(service.listMaterials(kbId).map(material => material.fileName).sort()).toEqual([
      '说明书 (2).pdf',
      '说明书.pdf',
    ])
    expect(await fs.readText(path.join(baseDir, '说明书.pdf'))).toBe('第一份')
    expect(await fs.readText(path.join(baseDir, '说明书 (2).pdf'))).toBe('第二份')
  })

  it('replaces a same-named file when the caller asks it to', async () => {
    await service.addFiles(kbId, [file('手册.txt', '旧内容')])
    const written = await service.addFiles(kbId, [file('手册.txt', '新内容')], { overwrite: true })

    expect(written.map(material => material.fileName)).toEqual(['手册.txt'])
    expect(await fs.readText(path.join(baseDir, '手册.txt'))).toBe('新内容')
    expect(service.listMaterials(kbId)).toHaveLength(1)
  })

  it('sanitises a name that no filesystem would accept', async () => {
    const created = await service.addFiles(kbId, [file('报告:2026/终稿.txt', 'x')])
    expect(created.map(material => material.fileName)).toEqual(['报告_2026_终稿.txt'])
  })

  it('adds nothing and writes nothing when handed no files', async () => {
    expect(await service.addFiles(kbId, [])).toEqual([])
    expect(await fs.listDir(baseDir)).toEqual([])
  })

  it('lists a file it cannot index without pretending to index it', async () => {
    await service.addFiles(kbId, [file('图纸.png', 'not really a png')])

    const material = service.getMaterial(kbId, '图纸.png')!
    expect(material.indexed).toBe(false)
    expect(material.chunks).toEqual([])
    expect(material.extractedText).toBeUndefined()
    // Stored and listed, just not searchable — and the base says so instead of
    // answering a question about it with an empty result.
    expect(service.listMaterials(kbId)).toHaveLength(1)
    expect(service.retrieve('图纸', [kbId]).kind).toBe('not_ready')
  })

  it('extracts text from markdown too', async () => {
    await service.addFiles(kbId, [file('说明.md', '# 说明\n\n端口号是 8080。')])
    expect(service.getMaterial(kbId, '说明.md')!.indexed).toBe(true)
    expect(service.retrieve('8080', [kbId]).kind).toBe('hits')
  })

  it('finds a file the user dropped into the folder themselves', async () => {
    // The point of the file model: the folder is the input, so a file copied in
    // through Explorer is knowledge on the next scan, with no import step.
    await fs.writeFile(path.join(baseDir, '外部丢入.txt'), '接头型号是 XT60。')
    await service.rescan(kbId)

    expect(service.listMaterials(kbId).map(material => material.fileName)).toEqual(['外部丢入.txt'])
    expect(service.retrieve('接头型号', [kbId]).kind).toBe('hits')
  })

  it('reads a file in a sub-folder as a path relative to the base', async () => {
    await fs.writeFile(path.join(baseDir, '手册', '封面.txt'), '封面用的是深蓝色。')
    await service.rescan(kbId)

    const material = service.getMaterial(kbId, '手册/封面.txt')
    expect(material?.fileName).toBe('手册/封面.txt')
    expect(service.materialPath(kbId, '手册/封面.txt')).toBe(
      path.join(baseDir, '手册', '封面.txt'),
    )
  })

  it('ignores dot-entries, which are the user\u2019s own bookkeeping', async () => {
    await fs.writeFile(path.join(baseDir, '.DS_Store'), 'junk')
    await fs.writeFile(path.join(baseDir, '.手册.txt.swp'), 'junk')
    await service.rescan(kbId)
    expect(service.listMaterials(kbId)).toHaveLength(0)
  })

  it('drops a file that disappeared from the disk', async () => {
    await service.addFiles(kbId, [file('手册.txt', MANUAL)])
    await fs.remove(path.join(baseDir, '手册.txt'))
    await service.rescan(kbId)

    expect(service.listMaterials(kbId)).toHaveLength(0)
    expect(service.retrieve('波特率', [kbId]).kind).toBe('not_ready')
  })

  it('bumps the index revision when the content changes', async () => {
    const before = service.getKnowledgeBase(kbId)!.indexRevision
    await service.addFiles(kbId, [file('手册.txt', MANUAL)])
    expect(service.getKnowledgeBase(kbId)!.indexRevision).toBe(before + 1)

    await service.deleteMaterial(kbId, '手册.txt')
    expect(service.getKnowledgeBase(kbId)!.indexRevision).toBe(before + 2)
  })

  it('answers false when deleting a file the base does not hold', async () => {
    expect(await service.deleteMaterial(kbId, '不存在.txt')).toBe(false)
  })

  it('reads one file\u2019s bytes and refuses one over the caller\u2019s ceiling', async () => {
    await service.addFiles(kbId, [file('手册.txt', MANUAL)])

    const bytes = await service.readMaterialBytes(kbId, '手册.txt', 1024)
    expect(new TextDecoder().decode(bytes)).toBe(MANUAL)

    // The size is judged from the scan, so an oversized preview costs a map
    // lookup rather than a read.
    expect(await service.readMaterialBytes(kbId, '手册.txt', 4)).toBeUndefined()
    expect(await service.readMaterialBytes(kbId, '不存在.txt', 1024)).toBeUndefined()
  })
})

describe('KnowbaseService — retrieval', () => {
  let service: KnowbaseService
  let manualId: string
  let networkId: string

  beforeEach(async () => {
    const fixture = await freshService()
    service = fixture.service
    manualId = (await service.createKnowledgeBase('产品资料')).id
    networkId = (await service.createKnowledgeBase('网络资料')).id
    await service.addFiles(manualId, [file('设备手册.txt', MANUAL)])
    await service.addFiles(networkId, [file('网络配置.txt', NETWORK)])
  })

  it('finds the passage that answers a Chinese question', () => {
    const outcome = service.retrieve('默认波特率是多少', [manualId])
    if (outcome.kind !== 'hits') throw new Error(`expected hits, got ${outcome.kind}`)
    expect(outcome.passages[0]!.materialTitle).toBe('设备手册.txt')
    expect(outcome.passages[0]!.text).toContain('115200')
  })

  it('carries every id and path a citation needs', () => {
    // The reader opens a disk file, so a citation that cannot say which file is
    // a citation that cannot be opened. The ids ride in the same payload because
    // matching on titles would not be unique.
    const outcome = service.retrieve('默认波特率', [manualId])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    const first = outcome.passages[0]!
    const folderName = service.getKnowledgeBase(manualId)!.folderName

    expect(first.kbId).toBe(manualId)
    expect(first.materialId).toBe('设备手册.txt')
    expect(first.filePath).toBe(path.join(ROOT, folderName, '设备手册.txt'))
    expect(first.ordinal).toBeTypeOf('number')
  })

  it('carries the ranking signal the retrieval-test panel shows', () => {
    const outcome = service.retrieve('连接方式', [networkId])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    const first = outcome.passages[0]!
    expect(first.score).toBeGreaterThan(0)
    expect(first.coverage).toBeGreaterThan(0)
    expect(first.coverage).toBeLessThanOrEqual(1)
  })

  it('reports no_match rather than an empty list when nothing relates', () => {
    expect(service.retrieve('如何申请差旅报销', [manualId]).kind).toBe('no_match')
  })

  it('reports empty_scope when no selected base exists', () => {
    expect(service.retrieve('波特率', ['kb_missing']).kind).toBe('empty_scope')
    // An empty id list reaching the service means every id handed over is gone.
    // "Nothing was ticked" never gets this far — `resolveScope` answers it
    // before the call, so the two do not have to share a sentence here.
    expect(service.retrieve('波特率', []).kind).toBe('empty_scope')
  })

  it('reports not_ready when nothing is indexed yet', async () => {
    const empty = await freshService()
    const id = (await empty.service.createKnowledgeBase('空的')).id
    expect(empty.service.retrieve('波特率', [id]).kind).toBe('not_ready')
  })

  it('reports an empty base inside a populated install as not_ready, not as a miss', async () => {
    // Global emptiness is the wrong test. With other bases populated the index
    // is non-empty, so an empty base would be searched, find nothing, and come
    // back as `no_match` — which tells the user to rephrase their question
    // instead of telling them there is nothing there to search.
    const empty = await service.createKnowledgeBase('空库')
    expect(service.retrieve('波特率', [empty.id]).kind).toBe('not_ready')
  })

  it('still reports a genuine miss when the base has material', () => {
    expect(service.retrieve('如何申请差旅报销', [manualId]).kind).toBe('no_match')
  })

  it('never returns a passage from an unselected base', () => {
    expect(service.retrieve('以太网', [manualId]).kind).toBe('no_match')
  })

  it('searches only the selected bases when several exist', () => {
    const outcome = service.retrieve('连接方式', [networkId])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    for (const passage of outcome.passages) expect(passage.kbName).toBe('网络资料')
  })

  it('honours the limit', () => {
    const outcome = service.retrieve('设备 波特率 配置 连接 修改', [manualId, networkId], {
      limit: 1,
    })
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    expect(outcome.passages).toHaveLength(1)
  })

  it('cites the current base name after a rename', async () => {
    await service.renameKnowledgeBase(manualId, '设备资料')
    const outcome = service.retrieve('波特率', [manualId])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    expect(outcome.passages[0]!.kbName).toBe('设备资料')
  })

  it('finds a file by words in its name, not only in its body', async () => {
    // The reported failure: a base 「刘一江的信息」 holding a file
    // 「刘一江的电话.txt」 whose body is only the number. Searching the name found
    // nothing, because the name was metadata rather than indexed content.
    const people = await service.createKnowledgeBase('刘一江的信息')
    await service.addFiles(people.id, [file('刘一江的电话.txt', '13363537216')])

    const byName = service.retrieve('刘一江', [people.id])
    if (byName.kind !== 'hits') throw new Error('unreachable')
    expect(byName.passages[0]!.materialTitle).toBe('刘一江的电话.txt')

    // And the body still works, so indexing the name did not replace it.
    expect(service.retrieve('13363537216', [people.id]).kind).toBe('hits')
  })

  it('finds a stored number from a prefix of it', async () => {
    const people = await service.createKnowledgeBase('联系方式')
    await service.addFiles(people.id, [file('值班电话.txt', '13363537216')])
    expect(service.retrieve('133', [people.id]).kind).toBe('hits')
  })

  it('does not index the knowledge base name', () => {
    // The name labels a container; indexing it would make every chunk in a base
    // match a query for that base's own name.
    expect(service.retrieve('产品资料', [manualId]).kind).toBe('no_match')
  })

  it('cites the chunk text without the indexed name prefix', () => {
    const outcome = service.retrieve('默认波特率', [manualId])
    if (outcome.kind !== 'hits') throw new Error('unreachable')
    // The name is searchable, but the passage shown to the model stays the chunk
    // text: the citation already carries the name as its label, and repeating it
    // inside the body would read as part of the material.
    expect(outcome.passages[0]!.text).not.toContain('设备手册.txt')
  })
})

describe('KnowbaseService — restart', () => {
  it('rebuilds the index from the folders on the next start', async () => {
    const store = new MemoryStore()
    const fs = createMemoryVaultFs(ROOT)
    const first = new KnowbaseService(store, fs, ROOT, { now: () => 1 })
    await first.initialize()
    const kbId = (await first.createKnowledgeBase('产品资料')).id
    await first.addFiles(kbId, [file('设备手册.txt', MANUAL)])

    // A fresh instance over the same store and vault stands in for a restart.
    const second = new KnowbaseService(store, fs, ROOT, { now: () => 2 })
    await second.initialize()

    expect(second.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
    expect(second.listMaterials(kbId).map(material => material.fileName)).toEqual(['设备手册.txt'])
    expect(second.retrieve('波特率', [kbId]).kind).toBe('hits')
  })

  it('restores a base from the disk alone when the metadata was lost', async () => {
    // The folder is the record of record: a profile whose metadata went missing
    // still has the user's files, and adopting the folder brings the base back
    // under the very id its folder carries.
    const fs = createMemoryVaultFs(ROOT)
    const seeded = new KnowbaseService(new MemoryStore(), fs, ROOT, { now: () => 1 })
    await seeded.initialize()
    const kbId = (await seeded.createKnowledgeBase('产品资料')).id
    await seeded.addFiles(kbId, [file('设备手册.txt', MANUAL)])

    const fresh = new KnowbaseService(new MemoryStore(), fs, ROOT, { now: () => 1 })
    await fresh.initialize()

    expect(fresh.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
    expect(fresh.retrieve('波特率', [kbId]).kind).toBe('hits')
  })
})

describe('KnowbaseService — legacy text migration', () => {
  const LEGACY_ID = 'kb_1a2b3c4d5e6f'

  /** A store holding one pre-vault base and one text material. */
  function legacyStore(deletedAt?: number): MemoryStore {
    const store = new MemoryStore()
    store.seedKnowledgeBase({
      id: LEGACY_ID,
      name: '旧库',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      indexRevision: 1,
    })
    store.seedLegacyMaterial({
      id: 'mat_legacy',
      kbId: LEGACY_ID,
      title: '旧资料',
      source: 'text',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      text: MANUAL,
      deletedAt,
      chunks: [],
    })
    return store
  }

  it('writes a text material out as a .txt file, once', async () => {
    const store = legacyStore()
    const fs = createMemoryVaultFs(ROOT)
    const service = new KnowbaseService(store, fs, ROOT, { now: () => 1 })
    const summary = await service.initialize()

    expect(summary.migrated).toBe(1)
    expect(service.listMaterials(LEGACY_ID).map(material => material.fileName)).toEqual(['旧资料.txt'])
    expect(await fs.readText(path.join(ROOT, `旧库--${LEGACY_ID}`, '旧资料.txt'))).toBe(MANUAL)
    expect(service.retrieve('波特率', [LEGACY_ID]).kind).toBe('hits')
    // The record is deleted as its file is written, so there is nothing left to
    // do twice — which is what makes the migration safe to re-run.
    expect(store.loadLegacyMaterials()).toHaveLength(0)
  })

  it('is idempotent across a restart', async () => {
    const store = legacyStore()
    const fs = createMemoryVaultFs(ROOT)
    await new KnowbaseService(store, fs, ROOT, { now: () => 1 }).initialize()

    const again = await new KnowbaseService(store, fs, ROOT, { now: () => 2 }).initialize()
    expect(again.migrated).toBe(0)
    expect(again.knowledgeBases).toBe(1)
    expect(again.materials).toBe(1)
  })

  it('never overwrites a file the user wrote under that name', async () => {
    const store = legacyStore()
    const fs = createMemoryVaultFs(ROOT)
    const baseDir = path.join(ROOT, `旧库--${LEGACY_ID}`)
    await fs.writeFile(path.join(baseDir, '旧资料.txt'), '用户自己写的')

    const service = new KnowbaseService(store, fs, ROOT, { now: () => 1 })
    await service.initialize()

    expect(service.listMaterials(LEGACY_ID).map(material => material.fileName).sort()).toEqual([
      '旧资料 (2).txt',
      '旧资料.txt',
    ])
    expect(await fs.readText(path.join(baseDir, '旧资料.txt'))).toBe('用户自己写的')
  })

  it('uses the stored chunks when a material has no text field', async () => {
    const store = legacyStore()
    const material: LegacyMaterial = {
      id: 'mat_legacy',
      kbId: LEGACY_ID,
      title: '旧片段',
      source: 'text',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      chunks: [{ id: 'chunk_1', ordinal: 0, text: '旧的片段正文。', headingPath: '', locator: '第 1 行' }],
    }
    store.seedLegacyMaterial(material)
    const fs = createMemoryVaultFs(ROOT)

    const service = new KnowbaseService(store, fs, ROOT, { now: () => 1 })
    await service.initialize()

    expect(await fs.readText(path.join(ROOT, `旧库--${LEGACY_ID}`, '旧片段.txt'))).toBe(
      '旧的片段正文。',
    )
  })

  it('drops a legacy material whose base is gone', async () => {
    const store = new MemoryStore()
    store.seedLegacyMaterial({
      id: 'mat_orphan',
      kbId: 'kb_missing',
      title: '孤儿',
      source: 'text',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      text: MANUAL,
      chunks: [],
    })

    const service = new KnowbaseService(store, createMemoryVaultFs(ROOT), ROOT, { now: () => 1 })
    const summary = await service.initialize()

    expect(summary.migrated).toBe(0)
    expect(store.loadLegacyMaterials()).toHaveLength(0)
  })

  it('drops a legacy material that was already deleted, instead of resurrecting it', async () => {
    const store = legacyStore(5)
    const service = new KnowbaseService(store, createMemoryVaultFs(ROOT), ROOT, { now: () => 1 })
    const summary = await service.initialize()

    expect(summary.migrated).toBe(0)
    expect(service.listMaterials(LEGACY_ID)).toHaveLength(0)
    expect(store.loadLegacyMaterials()).toHaveLength(0)
  })

  it('drops a base record that was deleted in the text era', async () => {
    const store = new MemoryStore()
    store.seedKnowledgeBase({
      id: LEGACY_ID,
      name: '旧库',
      description: '',
      createdAt: 1,
      updatedAt: 1,
      indexRevision: 1,
      deletedAt: 9,
    })

    const service = new KnowbaseService(store, createMemoryVaultFs(ROOT), ROOT, { now: () => 1 })
    const summary = await service.initialize()

    expect(summary.knowledgeBases).toBe(0)
    expect(store.loadKnowledgeBases()).toHaveLength(0)
  })
})

describe('KnowbaseService — reconciling with the disk', () => {
  it('adopts a base folder dropped into the vault', async () => {
    const { fs, service } = await freshService()
    await fs.ensureDir(path.join(ROOT, '临时资料--kb_aabbccdd11'))

    await service.rescan()

    expect(service.listKnowledgeBases().map(kb => kb.name)).toEqual(['临时资料'])
    expect(service.getKnowledgeBase('kb_aabbccdd11')?.folderName).toBe('临时资料--kb_aabbccdd11')
  })

  it('follows a folder the user renamed in their own explorer', async () => {
    const { fs, service } = await freshService()
    const created = await service.createKnowledgeBase('产品资料')
    await fs.move(path.join(ROOT, created.folderName), path.join(ROOT, `对外资料--${created.id}`))

    await service.rescan()

    const live = service.getKnowledgeBase(created.id)!
    expect(live.name).toBe('对外资料')
    expect(live.folderName).toBe(`对外资料--${created.id}`)
    // The id never changed, so an external rename is not a deletion plus a new
    // base — and a citation recorded before it still resolves.
    expect(service.listKnowledgeBases()).toHaveLength(1)
  })

  it('drops a base whose folder is gone', async () => {
    const { fs, service } = await freshService()
    const created = await service.createKnowledgeBase('产品资料')
    await fs.remove(path.join(ROOT, created.folderName))

    await service.rescan()

    expect(service.listKnowledgeBases()).toHaveLength(0)
    expect(service.getKnowledgeBase(created.id)).toBeUndefined()
  })

  it('ignores folders that are not bases', async () => {
    const { fs, service } = await freshService()
    await fs.ensureDir(path.join(ROOT, '我的笔记'))
    // A folder a user made that happens to carry `--` and a year must not become
    // a base: its "id" is not one this plugin generates.
    await fs.ensureDir(path.join(ROOT, '会议记录--2026'))
    await fs.ensureDir(path.join(ROOT, RECYCLE_DIR_NAME))

    await service.rescan()

    expect(service.listKnowledgeBases()).toHaveLength(0)
  })

  it('rescans only the base it was asked for', async () => {
    const { fs, service } = await freshService()
    const first = await service.createKnowledgeBase('产品资料')
    const second = await service.createKnowledgeBase('网络资料')
    await fs.writeFile(path.join(ROOT, second.folderName, '后来放的.txt'), '后来放的')

    await service.rescan(first.id)
    expect(service.listMaterials(second.id)).toHaveLength(0)

    await service.rescan(second.id)
    expect(service.listMaterials(second.id).map(material => material.fileName)).toEqual([
      '后来放的.txt',
    ])
  })
})
