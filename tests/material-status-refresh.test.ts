import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createNodeVaultFs } from '../src/vault-fs.ts'

const fixtures: string[] = []
const encoded = (name: string, text: string) => ({ name, data: new TextEncoder().encode(text) })

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'knowbase-status-refresh-'))
  fixtures.push(root)
  const service = new KnowbaseService(new MemoryStore(), createNodeVaultFs(root), root)
  await service.initialize()
  const base = await service.createKnowledgeBase('状态测试')
  return { root, service, base, dir: path.join(root, base.folderName) }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    // Only remove directories produced by this file's mkdtemp, never a real vault.
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('knowbase-status-refresh-')) {
      throw new Error('Refusing to remove an unexpected fixture path')
    }
    await rm(root, { recursive: true, force: true })
  }
})

describe('material status refresh on a temporary real filesystem', () => {
  it('returns uploads and approved new text only after their searchable state is committed', async () => {
    const { service, base } = await fixture()
    const uploaded = await service.addFiles(base.id, [
      encoded('ready.txt', '蓝鲸ZX2048的维护周期为七个月。'),
      encoded('empty.txt', ''),
      { name: 'invalid.txt', data: new Uint8Array([0xff, 0xfe, 0xff]) },
      encoded('stored.docx', '这不是可解析的Office文档。'),
    ])
    const byName = new Map(uploaded.map(material => [material.fileName, material]))
    expect(byName.get('ready.txt')).toMatchObject({ indexed: true, note: '' })
    expect(byName.get('empty.txt')).toMatchObject({ indexed: false, note: '', chunks: [] })
    expect(byName.get('invalid.txt')).toMatchObject({ indexed: false, chunks: [] })
    expect(byName.get('invalid.txt')!.note).toContain('UTF-8')
    expect(byName.get('stored.docx')).toMatchObject({ extension: 'docx', indexed: false, note: '', chunks: [] })
    for (const material of uploaded) {
      expect(service.getMaterial(base.id, material.id)).toBe(material)
    }
    expect(service.retrieve('ZX2048', [base.id]).kind).toBe('hits')

    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    const approved = await service.addTextAtomically(base.id, 'approved.md', '雪豹AC7631的保修期为九年。', revision)
    expect(approved).toMatchObject({ indexed: true, note: '' })
    expect(service.getMaterial(base.id, 'approved.md')).toBe(approved)
    expect(service.retrieve('AC7631', [base.id]).kind).toBe('hits')
  })

  it('force rescans same-size edits with preserved modification time instead of reusing searchable text', async () => {
    const { service, base, dir } = await fixture()
    const target = path.join(dir, 'ready.txt')
    await service.addFiles(base.id, [encoded('ready.txt', 'fingerprintword')])
    // Use a whole-second timestamp so utimes round trips exactly on every fixture filesystem.
    const stamp = new Date('2025-01-01T00:00:00Z')
    await utimes(target, stamp, stamp)
    await service.rescan(base.id)
    const before = service.getMaterial(base.id, 'ready.txt')!
    expect(before.indexed).toBe(true)
    await writeFile(target, ' '.repeat(before.bytes))
    await utimes(target, stamp, stamp)
    await service.rescan(base.id)
    expect(service.getMaterial(base.id, 'ready.txt')).toBe(before)
    expect(service.getLastScanReport(base.id)).toMatchObject({ reused: 1, rebuilt: 0 })

    await service.rescan(base.id, { force: true })
    expect(service.getMaterial(base.id, 'ready.txt')).toMatchObject({
      bytes: before.bytes, mtimeMs: before.mtimeMs, indexed: false, note: '', chunks: [],
    })
    expect(service.getLastScanReport(base.id)).toMatchObject({ mode: 'force', reused: 0, rebuilt: 1 })
    expect(service.retrieve('fingerprintword', [base.id]).kind).not.toBe('hits')
  })

  it('refreshes success, empty, failed and unsupported files across all bases after external edits', async () => {
    const { root, service, base, dir } = await fixture()
    const other = await service.createKnowledgeBase('另一个状态测试库')
    const otherDir = path.join(root, other.folderName)
    await service.addFiles(base.id, [
      encoded('ready.txt', '旧型号PQ9271对应两年保修期。'),
      encoded('empty.txt', ''),
      encoded('stored.bin', 'stored'),
    ])
    await service.addFiles(other.id, [encoded('changed.txt', '原有可搜索文字。')])
    const old = service.getMaterial(base.id, 'ready.txt')!

    // Changed lengths make incremental invalidation deterministic even on coarse mtime filesystems.
    await writeFile(path.join(dir, 'ready.txt'), '')
    await writeFile(path.join(dir, 'empty.txt'), new Uint8Array([0xff, 0xfe, 0xff]))
    await writeFile(path.join(dir, 'stored.bin'), 'changed unsupported bytes')
    await writeFile(path.join(otherDir, 'changed.txt'), '新型号LM8349对应十三年保修期，外部编辑后立即重扫。')
    expect(service.getMaterial(base.id, 'ready.txt')).toBe(old)
    await service.rescan()

    expect(service.getMaterial(base.id, 'ready.txt')).toMatchObject({ bytes: 0, indexed: false, note: '', chunks: [] })
    expect(service.getMaterial(base.id, 'empty.txt')!.note).toContain('UTF-8')
    expect(service.getMaterial(base.id, 'empty.txt')!.indexed).toBe(false)
    expect(service.getMaterial(base.id, 'stored.bin')).toMatchObject({
      bytes: new TextEncoder().encode('changed unsupported bytes').byteLength,
      extension: 'bin', indexed: false, note: '', chunks: [],
    })
    expect(service.getMaterial(other.id, 'changed.txt')).toMatchObject({ indexed: true, note: '' })
    expect(service.retrieve('PQ9271', [base.id]).kind).not.toBe('hits')
    expect(service.retrieve('LM8349', [other.id]).kind).toBe('hits')

    // A later rescan replaces failure/empty outcomes and reconciles extension changes.
    await writeFile(path.join(dir, 'ready.txt'), '恢复型号RT6157的维护周期为六个月。')
    await writeFile(path.join(dir, 'empty.txt'), '修复编码后型号UV4782可以正常检索。')
    await rename(path.join(dir, 'stored.bin'), path.join(dir, 'stored.txt'))
    await service.rescan()
    for (const name of ['ready.txt', 'empty.txt', 'stored.txt']) {
      expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: true, note: '' })
    }
    expect(service.getMaterial(base.id, 'stored.bin')).toBeUndefined()
    expect(service.retrieve('RT6157', [base.id]).kind).toBe('hits')
    expect(service.retrieve('UV4782', [base.id]).kind).toBe('hits')
    expect(service.getLastScanReport(base.id)).toMatchObject({ scanned: 3, unsearchable: 0, skipped: 0, failures: [] })
  })
})
