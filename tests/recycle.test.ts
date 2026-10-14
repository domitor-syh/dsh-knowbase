/**
 * Deleting, which is a move and never a destroy.
 *
 * There is no recycle-bin UI and there never will be one: the plan's rule is
 * that a deleted base or file lands in `<root>/_回收站/` and the user drags it
 * back out with their own explorer if they want it. That makes the property
 * worth pinning unusual — a deletion has to leave the bytes *exactly* where a
 * person can find them, under a name they still recognise, while removing the
 * entry from every list and from retrieval.
 *
 * A second property falls out of the same design: the folder is authoritative,
 * so a deletion cannot be undone by a restart. Nothing records that the entry
 * used to exist, which is why a record without a folder is dropped rather than
 * resurrected as an empty base.
 */

import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { RECYCLE_DIR_NAME } from '../src/core/vault.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import type { VaultFileSystem } from '../src/vault-fs.ts'

/** The vault root every fixture in this file reads and writes. */
const ROOT = path.resolve('C:/vault')
/** Where deletions land. */
const BIN = path.join(ROOT, RECYCLE_DIR_NAME)

const MANUAL = '# 设备手册\n\n出厂默认波特率为115200，可在配置文件中修改。'

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

async function freshService(): Promise<Fixture> {
  const store = new MemoryStore()
  const fs = createMemoryVaultFs(ROOT)
  const service = new KnowbaseService(store, fs, ROOT, { now: () => 1_700_000_000_000 })
  await service.initialize()
  return { store, fs, service }
}

/** Names currently sitting in the recycle folder, in code-point order. */
async function binNames(fs: VaultFileSystem): Promise<string[]> {
  return (await fs.listDir(BIN)).map(entry => entry.name).sort()
}

describe('recycling a file', () => {
  let service: KnowbaseService
  let fs: VaultFileSystem
  let kbId: string

  beforeEach(async () => {
    const fixture = await freshService()
    service = fixture.service
    fs = fixture.fs
    kbId = (await service.createKnowledgeBase('产品资料')).id
  })

  it('moves the file into the recycle folder instead of destroying it', async () => {
    await service.addFiles(kbId, [file('手册.txt', MANUAL)])

    expect(await service.deleteMaterial(kbId, '手册.txt')).toBe(true)

    // Same name, same bytes, one folder over — so dragging it back is a restore
    // with no export/import step in between.
    expect(await fs.readText(path.join(BIN, '手册.txt'))).toBe(MANUAL)
    expect(service.listMaterials(kbId)).toHaveLength(0)
    expect(service.retrieve('波特率', [kbId]).kind).toBe('not_ready')
  })

  it('numbers a second deletion rather than overwriting the first', async () => {
    const other = await service.createKnowledgeBase('另一库')
    await service.addFiles(kbId, [file('手册.txt', '甲库的手册')])
    await service.addFiles(other.id, [file('手册.txt', '乙库的手册')])

    await service.deleteMaterial(kbId, '手册.txt')
    await service.deleteMaterial(other.id, '手册.txt')

    expect(await fs.readText(path.join(BIN, '手册.txt'))).toBe('甲库的手册')
    expect(await fs.readText(path.join(BIN, '手册 (2).txt'))).toBe('乙库的手册')
  })

  it('keeps the file out of the index after a restart', async () => {
    // A restart must not resurrect it: the folder is authoritative, and the file
    // is no longer in it.
    const store = new MemoryStore()
    const vault = createMemoryVaultFs(ROOT)
    const first = new KnowbaseService(store, vault, ROOT, { now: () => 1 })
    await first.initialize()
    const id = (await first.createKnowledgeBase('产品资料')).id
    await first.addFiles(id, [file('手册.txt', MANUAL)])
    await first.deleteMaterial(id, '手册.txt')

    const second = new KnowbaseService(store, vault, ROOT, { now: () => 2 })
    await second.initialize()

    expect(second.listMaterials(id)).toHaveLength(0)
    expect(second.retrieve('波特率', [id]).kind).toBe('not_ready')
  })

  it('does not read the recycle folder back as content', async () => {
    await service.addFiles(kbId, [file('手册.txt', MANUAL)])
    await service.deleteMaterial(kbId, '手册.txt')

    await service.rescan()

    expect(await binNames(fs)).toEqual(['手册.txt'])
    expect(service.listMaterials(kbId)).toHaveLength(0)
    expect(service.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
  })

  it('answers false for a file the base does not hold', async () => {
    expect(await service.deleteMaterial(kbId, '不存在.txt')).toBe(false)
    expect(await binNames(fs)).toEqual([])
  })
})

describe('recycling a knowledge base', () => {
  let service: KnowbaseService
  let fs: VaultFileSystem

  beforeEach(async () => {
    const fixture = await freshService()
    service = fixture.service
    fs = fixture.fs
  })

  it('moves the whole folder, files and all, into the recycle folder', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await service.addFiles(created.id, [file('手册.txt', MANUAL)])

    expect(await service.deleteKnowledgeBase(created.id)).toBe(true)

    // Every file survives, and the folder keeps its name so the id it carries is
    // still readable — that is what makes dragging it back meaningful.
    expect(await fs.readText(path.join(BIN, created.folderName, '手册.txt'))).toBe(MANUAL)
    expect(service.listKnowledgeBases()).toHaveLength(0)
    expect(service.getKnowledgeBase(created.id)).toBeUndefined()
    expect(service.retrieve('波特率', [created.id]).kind).toBe('empty_scope')
  })

  it('drops the record, so the next start does not bring the base back', async () => {
    const store = new MemoryStore()
    const vault = createMemoryVaultFs(ROOT)
    const first = new KnowbaseService(store, vault, ROOT, { now: () => 1 })
    await first.initialize()
    const created = await first.createKnowledgeBase('产品资料')
    await first.addFiles(created.id, [file('手册.txt', MANUAL)])
    await first.deleteKnowledgeBase(created.id)

    const second = new KnowbaseService(store, vault, ROOT, { now: () => 2 })
    await second.initialize()

    expect(second.listKnowledgeBases()).toHaveLength(0)
    expect(second.listMaterials()).toHaveLength(0)
  })

  it('recycles a base once; a second delete answers false', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    expect(await service.deleteKnowledgeBase(created.id)).toBe(true)
    expect(await service.deleteKnowledgeBase(created.id)).toBe(false)
    expect(await binNames(fs)).toEqual([created.folderName])
  })

  it('rejects writes into a base that has been recycled', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await service.deleteKnowledgeBase(created.id)

    await expect(service.addFiles(created.id, [file('a.txt', 'x')])).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.renameKnowledgeBase(created.id, '改名')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.updateDescription(created.id, '描述')).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('hides a recycled base from name lookup', async () => {
    await service.createKnowledgeBase('产品资料')
    const created = await service.createKnowledgeBase('技术资料')
    await service.deleteKnowledgeBase(created.id)

    expect(service.findKnowledgeBaseByName('技术资料')).toBeUndefined()
    expect(service.listKnowledgeBases().map(kb => kb.name)).toEqual(['产品资料'])
  })

  it('does not adopt a recycled folder as a base again', async () => {
    // The folder name is a valid base name — `<name>--<id>` — so the only thing
    // stopping a rescan from adopting it is that it sits inside the recycle
    // folder. Without that rule a deletion would undo itself on the next scan.
    const created = await service.createKnowledgeBase('产品资料')
    await service.deleteKnowledgeBase(created.id)

    await service.rescan()

    expect(service.listKnowledgeBases()).toHaveLength(0)
    expect(await binNames(fs)).toEqual([created.folderName])
  })
})
