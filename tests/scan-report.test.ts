import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs, type VaultFileSystem } from '../src/vault-fs.ts'

const ROOT = path.resolve('C:/scan-report-test-vault')
const textFile = (name: string, text: string) => ({
  name,
  data: new TextEncoder().encode(text),
})

async function fixture() {
  const raw = createMemoryVaultFs(ROOT)
  const readText = vi.fn(raw.readText)
  const readBytes = vi.fn(raw.readBytes)
  let failedWalk: string | undefined
  let clock = 0
  let nowSequence: number[] | undefined
  const fs: VaultFileSystem = {
    ...raw,
    readText,
    readBytes,
    async listDir(dir) {
      if (dir === failedWalk) throw new Error('walk denied')
      return raw.listDir(dir)
    },
  }
  const store = new MemoryStore()
  const service = new KnowbaseService(store, fs, ROOT, {
    now: () => nowSequence?.length ? nowSequence.shift()! : ++clock,
  })
  await service.initialize()
  const base = await service.createKnowledgeBase('报告测试库')
  const dir = path.join(ROOT, base.folderName)
  return {
    raw,
    fs,
    store,
    service,
    base,
    dir,
    readText,
    failWalkAt: (target?: string) => { failedWalk = target },
    setNowSequence: (...values: number[]) => { nowSequence = [...values] },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('ScanReport', () => {
  it('reports added, reused, changed, and deleted materials', async () => {
    const { service, base, raw, dir } = await fixture()
    await service.addFiles(base.id, [
      textFile('same.txt', 'same-word'),
      textFile('changed.txt', 'zzoldword'),
      textFile('deleted.txt', 'deleted-word'),
    ])

    await raw.writeFile(path.join(dir, 'changed.txt'), 'zznewword')
    await raw.remove(path.join(dir, 'deleted.txt'))
    await raw.writeFile(path.join(dir, 'added.txt'), 'added-word')
    await service.rescan(base.id)

    expect(service.getLastScanReport(base.id)).toMatchObject({
      mode: 'incremental',
      scanned: 3,
      rebuilt: 2,
      skipped: 0,
      added: 1,
      reused: 1,
      changed: 1,
      deleted: 1,
      unsearchable: 0,
      failures: [],
      omittedFailures: 0,
    })
  })

  it('reports unsupported files as skipped while reusing them on the next scan', async () => {
    const { service, base, readText } = await fixture()
    await service.addFiles(base.id, [
      textFile('guide.zip', 'not-indexed'),
      textFile('guide.txt', 'searchable-word'),
    ])
    readText.mockClear()

    await service.rescan(base.id)

    expect(readText).not.toHaveBeenCalled()
    expect(service.getLastScanReport(base.id)).toMatchObject({
      mode: 'incremental',
      scanned: 2,
      rebuilt: 0,
      skipped: 1,
      added: 0,
      reused: 2,
      changed: 0,
      deleted: 0,
      unsearchable: 0,
      failures: [],
      omittedFailures: 0,
    })
  })

  it('reports force mode and counts every indexable rebuild attempt', async () => {
    const { service, base, readText } = await fixture()
    await service.addFiles(base.id, [
      textFile('stable.txt', 'stable-word'),
      textFile('empty.txt', ''),
    ])
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    readText.mockClear()

    await service.rescan(base.id, { force: true })
    const report = service.getLastScanReport(base.id)!

    expect(readText).toHaveBeenCalledTimes(2)
    expect(report).toMatchObject({
      mode: 'force',
      scanned: 2,
      rebuilt: 2,
      skipped: 0,
      added: 0,
      reused: 0,
      changed: 0,
      deleted: 0,
      unsearchable: 1,
      omittedFailures: 0,
    })
    expect(report.failures).toEqual([{ fileName: 'empty.txt', reason: '未提取到可检索文字。' }])
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision)
  })

  it('classifies empty, read failures, and OCR-not-ready files with relative authored failures', async () => {
    const { service, base, readText, raw } = await fixture()
    readText.mockImplementation(async filePath => {
      if (filePath.endsWith('failed.txt')) {
        throw new Error(`${ROOT}/raw-secret-error`)
      }
      return raw.readText(filePath)
    })

    await service.addFiles(base.id, [
      textFile('empty.txt', ''),
      textFile('failed.txt', 'unreadable'),
      textFile('photo.png', 'image-bytes'),
    ])
    const report = service.getLastScanReport(base.id)!

    expect(report).toMatchObject({
      scanned: 3,
      rebuilt: 3,
      skipped: 0,
      added: 3,
      reused: 0,
      changed: 0,
      deleted: 0,
      unsearchable: 3,
      omittedFailures: 0,
    })
    expect(report.failures).toEqual([
      { fileName: 'empty.txt', reason: '未提取到可检索文字。' },
      { fileName: 'failed.txt', reason: '文件无法读取，可能已被其他程序占用或删除。' },
      {
        fileName: 'photo.png',
        reason: '图片文字识别需要 OCR 语言包（约 4.5 MB）：在上方「图片文字识别」里点「下载语言包」，下载后重扫即可检索。',
      },
    ])
    expect(report.failures.every(failure => !path.isAbsolute(failure.fileName))).toBe(true)
    expect(JSON.stringify(report.failures)).not.toContain(ROOT)
    expect(JSON.stringify(report.failures)).not.toContain('raw-secret-error')
  })

  it('caps failure details at 100 entries and reports omitted failures', async () => {
    const { service, base } = await fixture()
    const files = Array.from({ length: 101 }, (_, index) =>
      textFile(`${String(index).padStart(3, '0')}.txt`, ''),
    )

    await service.addFiles(base.id, files)
    const report = service.getLastScanReport(base.id)!

    expect(report).toMatchObject({
      scanned: 101,
      rebuilt: 101,
      skipped: 0,
      added: 101,
      reused: 0,
      changed: 0,
      deleted: 0,
      unsearchable: 101,
      omittedFailures: 1,
    })
    expect(report.failures).toHaveLength(100)
    expect(report.failures[0]).toEqual({ fileName: '000.txt', reason: '未提取到可检索文字。' })
    expect(report.failures[99]).toEqual({ fileName: '099.txt', reason: '未提取到可检索文字。' })
  })

  it('keeps start/end times and clamps a backwards clock to zero elapsed time', async () => {
    const { service, base, setNowSequence } = await fixture()
    await service.addFiles(base.id, [textFile('timed.txt', 'timed-word')])

    service.getLastScanReport(base.id)
    setNowSequence(100, 90)
    await service.rescan(base.id)
    expect(service.getLastScanReport(base.id)).toMatchObject({
      startedAt: 100,
      completedAt: 90,
      elapsedMs: 0,
    })

    setNowSequence(200, 245)
    await service.rescan(base.id)
    expect(service.getLastScanReport(base.id)).toMatchObject({
      startedAt: 200,
      completedAt: 245,
      elapsedMs: 45,
    })
  })

  it('keeps the old report and index when the walk fails', async () => {
    const { service, base, raw, dir, failWalkAt } = await fixture()
    await service.addFiles(base.id, [textFile('old.txt', 'zzoldword')])
    const oldReport = service.getLastScanReport(base.id)!
    const oldMaterial = service.getMaterial(base.id, 'old.txt')!
    await raw.writeFile(path.join(dir, 'old.txt'), 'zznewword')
    await raw.ensureDir(path.join(dir, 'nested'))
    failWalkAt(path.join(dir, 'nested'))

    await expect(service.rescan(base.id)).rejects.toThrow('walk denied')

    expect(service.getLastScanReport(base.id)).toBe(oldReport)
    expect(service.getMaterial(base.id, 'old.txt')).toBe(oldMaterial)
    expect(service.retrieve('zzoldword', [base.id]).kind).toBe('hits')
    expect(service.retrieve('zznewword', [base.id]).kind).toBe('no_match')
  })

  it('keeps the old report and index when revision persistence fails', async () => {
    const { service, base, raw, dir, store } = await fixture()
    await service.addFiles(base.id, [textFile('old.txt', 'zzoldword')])
    const oldReport = service.getLastScanReport(base.id)!
    const oldRevision = service.getKnowledgeBase(base.id)!.indexRevision
    await raw.writeFile(path.join(dir, 'old.txt'), 'zznewword')
    vi.spyOn(store, 'saveKnowledgeBase').mockRejectedValueOnce(new Error('revision denied'))

    await expect(service.rescan(base.id)).rejects.toThrow('revision denied')

    expect(service.getLastScanReport(base.id)).toBe(oldReport)
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(oldRevision)
    expect(service.retrieve('zzoldword', [base.id]).kind).toBe('hits')
    expect(service.retrieve('zznewword', [base.id]).kind).toBe('no_match')
  })

  it('freezes the report, failure list, and individual failure entries', async () => {
    const { service, base } = await fixture()
    await service.addFiles(base.id, [textFile('empty.txt', '')])
    const report = service.getLastScanReport(base.id)!

    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.failures)).toBe(true)
    expect(Object.isFrozen(report.failures[0])).toBe(true)
  })
})
