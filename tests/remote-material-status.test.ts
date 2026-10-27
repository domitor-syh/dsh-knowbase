import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import { KnowbaseRemote } from '../src/remote.ts'

// Isolate Cordis construction only; the actual Remote methods and service run unchanged.
vi.mock('@deepseek-ai/dsh-typert-protocol', () => ({ TypertRemoteService: class {} }))

const encoded = (name: string, text: string) => ({ name, data: new TextEncoder().encode(text) })

async function fixture() {
  const root = path.resolve('C:/remote-material-status-test')
  const raw = createMemoryVaultFs(root)
  const fs = {
    ...raw,
    async listDir(dir: string) {
      return (await raw.listDir(dir)).map(entry => ({ ...entry, mtimeMs: 100 }))
    },
  }
  const service = new KnowbaseService(new MemoryStore(), fs, root)
  await service.initialize()
  const base = await service.createKnowledgeBase('远端状态测试')
  type RemoteArgs = ConstructorParameters<typeof KnowbaseRemote>
  const remote = new KnowbaseRemote({} as RemoteArgs[0], service, {} as RemoteArgs[2], {} as RemoteArgs[3], {} as RemoteArgs[4])
  return { raw, service, base, remote, dir: path.join(root, base.folderName) }
}

describe('Remote material status snapshots', () => {
  it('distinguishes supported empty text and extraction failures from unsupported formats', async () => {
    const { service, base, remote } = await fixture()
    await service.addFiles(base.id, [
      encoded('searchable.txt', 'actual searchable text'),
      encoded('empty.txt', ''),
      { name: 'invalid.txt', data: new Uint8Array([0xff]) },
      encoded('stored.docx', 'stored only'),
    ])
    const rows = new Map((await remote.listMaterials(base.id)).map(row => [row.fileName, row]))
    expect(rows.get('searchable.txt')).toMatchObject({ indexStatus: 'searchable', indexed: true, note: '' })
    expect(rows.get('empty.txt')).toMatchObject({ indexStatus: 'unsearchable', indexed: false, note: '' })
    expect(rows.get('invalid.txt')).toMatchObject({ indexStatus: 'unsearchable', indexed: false })
    expect(rows.get('invalid.txt')!.note).toContain('UTF-8')
    expect(rows.get('stored.docx')).toMatchObject({ indexStatus: 'unsupported', indexed: false, note: '' })
  })

  it('explicit Remote rescan forces same-fingerprint edits and returns refreshed snapshots', async () => {
    const { raw, service, base, remote, dir } = await fixture()
    await service.addFiles(base.id, [encoded('ready.txt', 'searchword')])
    await raw.writeFile(path.join(dir, 'ready.txt'), ' '.repeat('searchword'.length))
    expect((await remote.listMaterials(base.id))[0]!.indexStatus).toBe('searchable')
    expect(await remote.rescan(base.id)).toBe(true)
    expect((await remote.listMaterials(base.id))[0]).toMatchObject({ indexStatus: 'unsearchable', indexed: false, note: '' })
    expect(service.getLastScanReport(base.id)).toMatchObject({ mode: 'force', reused: 0, rebuilt: 1 })
    expect(service.retrieve('searchword', [base.id]).kind).not.toBe('hits')
  })
})
