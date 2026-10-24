import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bm25Index } from '../src/core/bm25.ts'
import { OcrError, type OcrEngine } from '../src/core/ocr.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs, type VaultFileSystem } from '../src/vault-fs.ts'

const ROOT = path.resolve('C:/incremental-test-vault')
const file = (name: string, text: string) => ({ name, data: new TextEncoder().encode(text) })

async function fixture(options: { fixedMtime?: boolean; ocr?: OcrEngine } = {}) {
  const raw = createMemoryVaultFs(ROOT)
  const readText = vi.fn(raw.readText)
  const readBytes = vi.fn(raw.readBytes)
  let failWalk: string | undefined
  const fs: VaultFileSystem = {
    ...raw,
    readText,
    readBytes,
    async listDir(dir) {
      if (dir === failWalk) throw new Error('walk denied')
      const entries = await raw.listDir(dir)
      return options.fixedMtime ? entries.map(entry => ({ ...entry, mtimeMs: 100 })) : entries
    },
  }
  const store = new MemoryStore()
  let now = 0
  const service = new KnowbaseService(store, fs, ROOT, { now: () => ++now, ocr: options.ocr })
  await service.initialize()
  const base = await service.createKnowledgeBase('测试库')
  const dir = path.join(ROOT, base.folderName)
  return { raw, fs, service, store, readText, readBytes, base, dir,
    failWalkAt: (target?: string) => { failWalk = target } }
}

function hit(service: KnowbaseService, kbId: string, query: string) {
  const result = service.retrieve(query, [kbId])
  if (result.kind !== 'hits') throw new Error(`expected hits, got ${result.kind}`)
  return result.passages[0]!
}

afterEach(() => vi.restoreAllMocks())

describe('runtime incremental scans', () => {
  it('reuses unchanged material without reads, index.add/remove or revision changes', async () => {
    const { service, base, readText } = await fixture()
    await service.addFiles(base.id, [file('stable.txt', 'stable-content')])
    const prior = service.getMaterial(base.id, 'stable.txt')!
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    readText.mockClear()
    const add = vi.spyOn(Bm25Index.prototype, 'add')
    const remove = vi.spyOn(Bm25Index.prototype, 'remove')
    await service.rescan(base.id)
    expect(readText).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(service.getMaterial(base.id, 'stable.txt')).toBe(prior)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision)
    expect(service.getLastScanReport(base.id)).toEqual({ added: 0, reused: 1, changed: 0, deleted: 0, unsearchable: 0 })
  })

  it('commits only changed/deleted/new materials and bumps external changes once', async () => {
    const { service, base, raw, dir, readText } = await fixture()
    await service.addFiles(base.id, [file('same.txt', 'constantword'), file('change.txt', 'oldword'), file('delete.txt', 'deletedword')])
    const same = service.getMaterial(base.id, 'same.txt')!
    const changed = service.getMaterial(base.id, 'change.txt')!
    const deleted = service.getMaterial(base.id, 'delete.txt')!
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    await raw.writeFile(path.join(dir, 'change.txt'), 'newword updated')
    await raw.remove(path.join(dir, 'delete.txt'))
    await raw.writeFile(path.join(dir, 'new.txt'), 'freshword')
    readText.mockClear()
    const remove = vi.spyOn(Bm25Index.prototype, 'remove')
    const add = vi.spyOn(Bm25Index.prototype, 'add')
    await service.rescan(base.id)
    expect(readText).toHaveBeenCalledTimes(2)
    expect(service.getMaterial(base.id, 'same.txt')).toBe(same)
    expect(remove.mock.calls.map(([id]) => id).sort()).toEqual([...changed.chunks, ...deleted.chunks].map(chunk => chunk.id).sort())
    expect(add).toHaveBeenCalledTimes(2)
    expect(service.retrieve('deletedword', [base.id]).kind).toBe('no_match')
    expect(hit(service, base.id, 'freshword').materialId).toBe('new.txt')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
    expect(service.getLastScanReport(base.id)).toEqual({ added: 1, reused: 1, changed: 1, deleted: 1, unsearchable: 0 })
    await service.rescan(base.id)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
  })

  it('force re-reads/rebuilds same fingerprints and repairs hidden same-size/mtime edits', async () => {
    const { service, base, raw, dir, readText } = await fixture({ fixedMtime: true })
    await service.addFiles(base.id, [file('a.txt', 'alpha')])
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    readText.mockClear()
    const add = vi.spyOn(Bm25Index.prototype, 'add')
    await service.rescan(base.id, { force: true })
    expect(readText).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledTimes(1)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision)
    await raw.writeFile(path.join(dir, 'a.txt'), 'bravo')
    await service.rescan(base.id)
    expect(hit(service, base.id, 'alpha').text).toBe('alpha')
    await service.rescan(base.id, { force: true })
    expect(hit(service, base.id, 'bravo').text).toBe('bravo')
    expect(service.retrieve('alpha', [base.id]).kind).toBe('no_match')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
  })

  it('always re-reads uploads even with identical size/mtime and preserves default duplicate names', async () => {
    const { service, base, readText } = await fixture({ fixedMtime: true })
    await service.addFiles(base.id, [file('a.txt', 'alpha')])
    readText.mockClear()
    await service.addFiles(base.id, [file('a.txt', 'bravo')], { overwrite: true })
    expect(readText).toHaveBeenCalledTimes(1)
    expect(hit(service, base.id, 'bravo').text).toBe('bravo')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(2)
    await service.addFiles(base.id, [file('a.txt', 'other')])
    expect(service.listMaterials(base.id).map(material => material.id)).toEqual(['a (2).txt', 'a.txt'])
  })

  it('retries OCR failures after packs become ready, but not successful OCR', async () => {
    let ready = false
    const recognize = vi.fn(async () => {
      if (!ready) throw new OcrError('resources-missing', 'missing')
      return 'ocrword'
    })
    const { service, base, readBytes } = await fixture({ ocr: { recognize } })
    await service.addFiles(base.id, [file('image.png', 'synthetic')])
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    expect(service.getLastScanReport(base.id)!.unsearchable).toBe(1)
    await service.rescan(base.id)
    expect(recognize).toHaveBeenCalledTimes(2)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision)
    ready = true
    await service.rescan(base.id)
    expect(hit(service, base.id, 'ocrword').text).toBe('ocrword')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
    readBytes.mockClear()
    await service.rescan(base.id)
    expect(recognize).toHaveBeenCalledTimes(3)
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('serializes OCR calls within a concurrent extraction batch', async () => {
    let active = 0
    let maxActive = 0
    const recognize = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => setTimeout(resolve, 1))
      active -= 1
      return 'recognizedword'
    })
    const { service, base } = await fixture({ ocr: { recognize } })
    await service.addFiles(base.id, [file('a.png', 'fake'), file('b.png', 'fake'), file('c.png', 'fake')])
    expect(recognize).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1)
  })

  it('retries empty/unreadable indexable text while reusing unsupported formats', async () => {
    const { service, base, readText } = await fixture()
    readText.mockRejectedValueOnce(new Error('locked'))
    await service.addFiles(base.id, [file('a.txt', 'recoveredword'), file('blank.txt', ''), file('a.zip', 'fakezip')])
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    expect(service.getMaterial(base.id, 'blank.txt')!.indexed).toBe(false)
    readText.mockClear()
    await service.rescan(base.id)
    expect(readText).toHaveBeenCalledTimes(2)
    expect(hit(service, base.id, 'recoveredword').text).toBe('recoveredword')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
    await service.rescan(base.id)
    expect(readText).toHaveBeenCalledTimes(3)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
  })

  it('adopts and indexes externally added base files on the first global rescan', async () => {
    const { service, raw } = await fixture()
    const id = 'kb_aabbccdd11'
    await raw.writeFile(path.join(ROOT, `外来库--${id}`, 'a.txt'), 'adoptedword')
    await service.rescan()
    expect(hit(service, id, 'adoptedword').filePath).toBe(path.join(ROOT, `外来库--${id}`, 'a.txt'))
    expect(service.getKnowledgeBase(id)!.indexRevision).toBe(1)
  })

  it('updates citation name and nested path on both internal/external rename without reindexing', async () => {
    const { service, base, raw, dir, readText } = await fixture()
    await raw.writeFile(path.join(dir, 'nested', 'a.txt'), 'renameword')
    await service.rescan(base.id)
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    readText.mockClear()
    const add = vi.spyOn(Bm25Index.prototype, 'add')
    const renamed = await service.renameKnowledgeBase(base.id, '新库')
    expect(hit(service, base.id, 'renameword')).toMatchObject({ kbName: '新库', filePath: path.join(ROOT, renamed.folderName, 'nested', 'a.txt') })
    expect(renamed.indexRevision).toBe(revision + 1)
    await service.renameKnowledgeBase(base.id, '新库')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
    const external = `外部重命名--${base.id}`
    await raw.move(path.join(ROOT, renamed.folderName), path.join(ROOT, external))
    await service.rescan()
    expect(hit(service, base.id, 'renameword')).toMatchObject({ kbName: '外部重命名', filePath: path.join(ROOT, external, 'nested', 'a.txt') })
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 2)
    expect(readText).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it('keeps old material/index/revision/report if a nested walk fails', async () => {
    const { service, base, raw, dir, failWalkAt } = await fixture()
    await service.addFiles(base.id, [file('a.txt', 'oldword')])
    const prior = service.getMaterial(base.id, 'a.txt')!
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    const report = service.getLastScanReport(base.id)
    await raw.writeFile(path.join(dir, 'a.txt'), 'changedword')
    await raw.ensureDir(path.join(dir, 'nested'))
    failWalkAt(path.join(dir, 'nested'))
    await expect(service.rescan(base.id)).rejects.toThrow('walk denied')
    expect(service.getMaterial(base.id, 'a.txt')).toBe(prior)
    expect(hit(service, base.id, 'oldword').text).toBe('oldword')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision)
    expect(service.getLastScanReport(base.id)).toBe(report)
    failWalkAt()
    await service.rescan(base.id)
    expect(hit(service, base.id, 'changedword').text).toBe('changedword')
  })

  it('retains same-fingerprint upload invalidation when its scan fails', async () => {
    const { service, base, raw, dir, failWalkAt } = await fixture({ fixedMtime: true })
    await service.addFiles(base.id, [file('a.txt', 'alpha')])
    await raw.ensureDir(path.join(dir, 'nested'))
    failWalkAt(path.join(dir, 'nested'))
    await expect(service.addFiles(base.id, [file('a.txt', 'bravo')], { overwrite: true })).rejects.toThrow('walk denied')
    expect(hit(service, base.id, 'alpha').text).toBe('alpha')
    failWalkAt()
    await service.rescan(base.id)
    expect(hit(service, base.id, 'bravo').text).toBe('bravo')
  })

  it('stages asynchronous extraction before replacing the index and serializes rename/delete', async () => {
    const { service, base, raw, dir, readText } = await fixture()
    await service.addFiles(base.id, [file('a.txt', 'oldword')])
    await raw.writeFile(path.join(dir, 'a.txt'), 'newword')
    let release!: (text: string) => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    readText.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve }) })
    const scan = service.rescan(base.id)
    await entered
    const rename = service.renameKnowledgeBase(base.id, '串行库')
    const deletion = service.deleteMaterial(base.id, 'a.txt')
    expect(hit(service, base.id, 'oldword').text).toBe('oldword')
    expect(service.getKnowledgeBase(base.id)!.name).toBe('测试库')
    release('newword')
    await scan
    await rename
    expect(await deletion).toBe(true)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(4)
    expect(service.listMaterials(base.id)).toHaveLength(0)
    expect(service.retrieve('newword', [base.id]).kind).toBe('not_ready')
  })

  it('retries a failed revision save without double-bumping and restart keeps it', async () => {
    const { service, base, raw, dir, store } = await fixture()
    await service.addFiles(base.id, [file('a.txt', 'oldword')])
    const priorRevision = service.getKnowledgeBase(base.id)!.indexRevision
    await raw.writeFile(path.join(dir, 'a.txt'), 'newword')
    const save = vi.spyOn(store, 'saveKnowledgeBase')
    save.mockRejectedValueOnce(new Error('save denied'))
    await expect(service.rescan(base.id)).rejects.toThrow('save denied')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(priorRevision)
    expect(hit(service, base.id, 'oldword').text).toBe('oldword')
    expect(service.getLastScanReport(base.id)).toBeDefined()

    await service.rescan(base.id)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(priorRevision + 1)
    expect(hit(service, base.id, 'newword').text).toBe('newword')
    expect(save).toHaveBeenCalledTimes(2)

    const restarted = new KnowbaseService(store, raw, ROOT)
    await restarted.initialize()
    expect(restarted.getKnowledgeBase(base.id)!.indexRevision).toBe(priorRevision + 1)
    expect(hit(restarted, base.id, 'newword').text).toBe('newword')
  })

  it('keeps the prior snapshot when an external rename is followed by a failed walk', async () => {
    const { service, base, raw, dir, failWalkAt } = await fixture()
    await service.addFiles(base.id, [file('a.txt', 'renameword')])
    const old = service.getKnowledgeBase(base.id)!
    const report = service.getLastScanReport(base.id)
    const external = `外部失败重命名--${base.id}`
    await raw.move(dir, path.join(ROOT, external))
    failWalkAt(path.join(ROOT, external))

    await expect(service.rescan()).rejects.toThrow('walk denied')
    expect(service.getKnowledgeBase(base.id)).toMatchObject({
      name: '外部失败重命名',
      folderName: external,
      indexRevision: old.indexRevision + 1,
    })
    expect(service.getLastScanReport(base.id)).toBe(report)
    expect(hit(service, base.id, 'renameword').filePath).toBe(path.join(ROOT, external, 'a.txt'))

    failWalkAt()
    await service.rescan()
    expect(service.getKnowledgeBase(base.id)!.name).toBe('外部失败重命名')
    expect(hit(service, base.id, 'renameword').filePath).toBe(path.join(ROOT, external, 'a.txt'))
  })

  it('does not double-bump add/delete or lose the newest revision; rebuilds after restart', async () => {
    const { service, base, fs, store, readText } = await fixture()
    await service.addFiles(base.id, [file('a.txt', 'firstword')])
    await service.addFiles(base.id, [file('b.txt', 'secondword')])
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(2)
    await service.deleteMaterial(base.id, 'a.txt')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(3)
    await service.rescan(base.id)
    await service.rescan(base.id, { force: true })
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(3)
    readText.mockClear()
    const restarted = new KnowbaseService(store, fs, ROOT)
    await restarted.initialize()
    expect(readText).toHaveBeenCalledTimes(1)
    expect(hit(restarted, base.id, 'secondword').text).toBe('secondword')
    expect(restarted.getKnowledgeBase(base.id)!.indexRevision).toBe(3)
  })
})
