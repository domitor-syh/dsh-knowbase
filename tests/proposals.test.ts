import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProposalRegistry, type ProposalStore, type StoredProposal } from '../src/core/proposals.ts'
import { SessionSelectionRegistry } from '../src/core/session-scope.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import type { VaultFileSystem } from '../src/vault-fs.ts'

const ROOT = path.resolve('C:/proposal-vault')

interface Fixture {
  readonly service: KnowbaseService
  readonly fs: VaultFileSystem
  readonly kbId: string
  readonly baseDir: string
}

async function fixture(options: { readonly failingScan?: { readonly value: { value: boolean } } } = {}): Promise<Fixture> {
  const backing = createMemoryVaultFs(ROOT)
  const fs: VaultFileSystem = options.failingScan === undefined ? backing : {
    ...backing,
    listDir: async dir => {
      if (options.failingScan!.value.value && dir !== ROOT) throw new Error('scan failed')
      return backing.listDir(dir)
    },
  }
  const service = new KnowbaseService(new MemoryStore(), fs, ROOT, { now: () => 1_700_000_000_000 })
  await service.initialize()
  const base = await service.createKnowledgeBase('提案测试', '')
  return { service, fs, kbId: base.id, baseDir: path.join(ROOT, base.folderName) }
}

function registryFor(service: KnowbaseService, kbId: string, now: { value: number }): ProposalRegistry {
  const selection = new SessionSelectionRegistry({ now: () => now.value })
  void selection.set('session-a', { enabled: true, scope: [kbId] })
  return new ProposalRegistry({ service: () => service, selection, now: () => now.value })
}

class MemoryProposalStore implements ProposalStore {
  readonly values = new Map<string, StoredProposal>()
  loadAll(): readonly StoredProposal[] { return [...this.values.values()] }
  async save(proposal: StoredProposal): Promise<void> { this.values.set(proposal.id, proposal) }
}

describe('ProposalRegistry', () => {
  it('creates a session-bound proposal without writing a file, then applies it after approval', async () => {
    const now = { value: 1_700_000_000_000 }
    const { service, fs, kbId, baseDir } = await fixture()
    const registry = registryFor(service, kbId, now)
    const proposal = await registry.create('session-a', kbId, 'answer.md', '# Answer\n\n可检索内容。', '补充答案')

    expect(await fs.stat(path.join(baseDir, 'answer.md'))).toBeUndefined()
    expect(proposal.status).toBe('pending')
    expect(proposal.contentHash).toHaveLength(64)

    const applied = await registry.approve('session-a', proposal.id)
    expect(applied.status).toBe('approved')
    expect(applied.materialId).toBe('answer.md')
    expect((await fs.stat(path.join(baseDir, 'answer.md')))?.kind).toBe('file')
    expect((await registry.list('session-a'))[0]?.status).toBe('approved')
  })

  it('rejects stale revisions and never overwrites an existing same-name file', async () => {
    const now = { value: 1_700_000_000_000 }
    const { service, fs, kbId, baseDir } = await fixture()
    const registry = registryFor(service, kbId, now)
    const stale = await registry.create('session-a', kbId, 'stale.md', '提案内容', '')
    await service.addFiles(kbId, [{ name: 'other.md', data: new TextEncoder().encode('外部变更') }])
    await expect(registry.approve('session-a', stale.id)).rejects.toMatchObject({ code: 'stale' })
    expect((await registry.list('session-a'))[0]?.status).toBe('failed')

    await expect(registry.create('session-a', kbId, 'other.md', '不能覆盖', '')).rejects.toMatchObject({ code: 'duplicate' })
    expect(new TextDecoder().decode(await fs.readBytes(path.join(baseDir, 'other.md')))).toBe('外部变更')
  })

  it('expires proposals and rolls back the file when scanning fails', async () => {
    const now = { value: 1_700_000_000_000 }
    const { service, fs, kbId, baseDir } = await fixture()
    const registry = registryFor(service, kbId, now)
    const expiring = await registry.create('session-a', kbId, 'later.txt', '稍后处理', '')
    now.value += 30 * 60 * 1000
    expect((await registry.list('session-a'))[0]?.status).toBe('expired')
    await expect(registry.approve('session-a', expiring.id)).rejects.toMatchObject({ code: 'not-pending' })

    const failing = { value: false }
    const scanned = await fixture({ failingScan: { value: failing } })
    const rollbackRegistry = registryFor(scanned.service, scanned.kbId, now)
    const proposal = await rollbackRegistry.create('session-a', scanned.kbId, 'rollback.md', '扫描失败时删除', '')
    failing.value = true
    await expect(rollbackRegistry.approve('session-a', proposal.id)).rejects.toMatchObject({ code: 'apply-failed' })
    expect(await scanned.fs.stat(path.join(scanned.baseDir, 'rollback.md'))).toBeUndefined()
  })

  it('persists status transitions through the independent proposal store', async () => {
    const now = { value: 1_700_000_000_000 }
    const { service, kbId } = await fixture()
    const selection = new SessionSelectionRegistry()
    await selection.set('session-a', { enabled: true, scope: [kbId] })
    const first = new ProposalRegistry({ service: () => service, selection, now: () => now.value })
    const store = new MemoryProposalStore()
    await first.useStore(store)
    const proposal = await first.create('session-a', kbId, 'stored.md', '持久化', '')

    const second = new ProposalRegistry({ service: () => service, selection, now: () => now.value })
    await second.useStore(store)
    expect((await second.list('session-a'))[0]?.id).toBe(proposal.id)
    await second.reject('session-a', proposal.id)
    expect(store.values.get(proposal.id)?.status).toBe('rejected')
  })
})
