/**
 * Recycle bin tests.
 *
 * The plan's rule is that a delete is reversible and that permanent deletion
 * only happens from the bin, with the contents spelled out. These tests hold
 * the line: soft delete keeps the record and empties the index, restore puts
 * it back exactly as it was, and purge is reachable only through the bin.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  KnowbaseService,
  MemoryStore,
} from '../src/core/service.ts'

const MANUAL = '# 设备手册\n\n出厂默认波特率为115200，可在配置文件中修改。'

async function freshService(): Promise<KnowbaseService> {
  const service = new KnowbaseService(new MemoryStore(), { now: () => 1_700_000_000_000 })
  await service.initialize()
  return service
}

describe('soft-deleted materials', () => {
  let service: KnowbaseService
  let kbId: string
  let materialId: string

  beforeEach(async () => {
    service = await freshService()
    kbId = (await service.createKnowledgeBase('产品资料')).id
    materialId = (await service.addText(kbId, '手册', MANUAL)).id
  })

  it('hides the material from lists and from retrieval', async () => {
    expect(await service.deleteMaterial(materialId)).toBe(true)
    expect(service.listMaterials(kbId)).toHaveLength(0)
    expect(service.listDeletedMaterials()).toHaveLength(1)
    expect(service.retrieve('波特率', [kbId]).kind).toBe('not_ready')
  })

  it('restores the material exactly as it was', async () => {
    await service.deleteMaterial(materialId)
    expect(await service.restoreMaterial(materialId)).toBe(true)
    expect(service.listMaterials(kbId)).toHaveLength(1)
    expect(service.getMaterial(materialId)?.deletedAt).toBeUndefined()
    const outcome = service.retrieve('波特率', [kbId])
    expect(outcome.kind).toBe('hits')
  })

  it('brings the base back when restoring a material of a deleted base', async () => {
    await service.deleteKnowledgeBase(kbId)
    // The base is in the bin and its material is NOT listed separately.
    expect(service.listDeletedMaterials()).toHaveLength(0)

    // Delete a material from a DIFFERENT base, then also delete that base.
    const other = await service.createKnowledgeBase('另一库')
    const otherMaterial = await service.addText(other.id, '其它', MANUAL)
    await service.deleteMaterial(otherMaterial.id)
    await service.deleteKnowledgeBase(other.id)
    expect(service.listDeletedMaterials()).toHaveLength(1)

    // Restoring the material resurrects its base too, or the material would
    // exist but be visible nowhere.
    expect(await service.restoreMaterial(otherMaterial.id)).toBe(true)
    expect(service.listKnowledgeBases().map(base => base.name)).toContain('另一库')
    expect(service.listMaterials(other.id)).toHaveLength(1)
  })

  it('refuses to purge a live material', async () => {
    await expect(service.purgeMaterial(materialId)).resolves.toBe(false)
    expect(service.listMaterials(kbId)).toHaveLength(1)
  })

  it('purges a binned material for good', async () => {
    await service.deleteMaterial(materialId)
    expect(await service.purgeMaterial(materialId)).toBe(true)
    expect(service.listDeletedMaterials()).toHaveLength(0)
    expect(service.getMaterial(materialId)).toBeUndefined()
    expect(await service.restoreMaterial(materialId)).toBe(false)
  })

  it('rejects editing and re-adding through the bin', async () => {
    await service.deleteMaterial(materialId)
    await expect(service.updateMaterialText(materialId, '新内容')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.addText(kbId, '新资料', MANUAL)).resolves.toBeTruthy()
  })

  it('survives a restart of the service', async () => {
    // Two services over ONE store model a host restart: the records come back
    // from disk still marked deleted, and stay out of the index until restored.
    const store = new MemoryStore()
    const first = new KnowbaseService(store, { now: () => 1_700_000_000_000 })
    await first.initialize()
    const restartKb = (await first.createKnowledgeBase('重启库')).id
    const restartMaterial = (await first.addText(restartKb, '手册', MANUAL)).id
    await first.deleteMaterial(restartMaterial)

    const second = new KnowbaseService(store, { now: () => 1_700_000_000_001 })
    await second.initialize()
    expect(second.listMaterials(restartKb)).toHaveLength(0)
    expect(second.listDeletedMaterials()).toHaveLength(1)
    expect(second.retrieve('波特率', [restartKb]).kind).toBe('not_ready')

    // Restoring after the restart re-indexes from the persisted record.
    expect(await second.restoreMaterial(restartMaterial)).toBe(true)
    expect(second.retrieve('波特率', [restartKb]).kind).toBe('hits')
  })
})

describe('soft-deleted knowledge bases', () => {
  let service: KnowbaseService

  beforeEach(async () => {
    service = await freshService()
  })

  it('rejects writes into a binned base', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await service.deleteKnowledgeBase(created.id)
    await expect(service.addText(created.id, '手册', MANUAL)).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.renameKnowledgeBase(created.id, '改名')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(service.updateDescription(created.id, '描述')).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('hides a binned base from name lookup and scope resolution', async () => {
    await service.createKnowledgeBase('产品资料')
    const created = await service.createKnowledgeBase('技术资料')
    await service.deleteKnowledgeBase(created.id)
    expect(service.findKnowledgeBaseByName('技术资料')).toBeUndefined()
    // `resolveScope` with an `all` selection walks listKnowledgeBases(), so the
    // binned base is out of every live scope without extra code.
    expect(service.listKnowledgeBases().map(base => base.name)).toEqual(['产品资料'])
  })

  it('purges a binned base together with all its materials', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    const live = (await service.addText(created.id, '活资料', MANUAL)).id
    // Different text from `live` on purpose: two identical materials in one base
    // are refused now, and this test is about purge cascading, not duplicates.
    const binned = (await service.addText(created.id, '已删资料', '另一份内容不同的资料。')).id
    await service.deleteMaterial(binned)
    await service.deleteKnowledgeBase(created.id)

    expect(await service.purgeKnowledgeBase(created.id)).toBe(true)
    expect(service.getMaterial(live)).toBeUndefined()
    expect(service.getMaterial(binned)).toBeUndefined()
    expect(service.getKnowledgeBase(created.id)).toBeUndefined()
    expect(service.listDeletedKnowledgeBases()).toHaveLength(0)
    expect(await service.restoreKnowledgeBase(created.id)).toBe(false)
  })

  it('refuses to purge a live base', async () => {
    const created = await service.createKnowledgeBase('产品资料')
    await expect(service.purgeKnowledgeBase(created.id)).resolves.toBe(false)
    expect(service.listKnowledgeBases()).toHaveLength(1)
  })

  it('answers false for unknown or duplicate delete/restore', async () => {
    expect(await service.deleteKnowledgeBase('kb_missing')).toBe(false)
    const created = await service.createKnowledgeBase('产品资料')
    expect(await service.deleteKnowledgeBase(created.id)).toBe(true)
    expect(await service.deleteKnowledgeBase(created.id)).toBe(false)
    expect(await service.restoreKnowledgeBase(created.id)).toBe(true)
    expect(await service.restoreKnowledgeBase(created.id)).toBe(false)
  })
})