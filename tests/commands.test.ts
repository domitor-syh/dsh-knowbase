import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import { installCommands } from '../src/commands.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { SessionSelectionRegistry } from '../src/core/session-scope.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'

async function fixture() {
  const root = path.resolve('command-scan-fixture')
  const service = new KnowbaseService(new MemoryStore(), createMemoryVaultFs(root), root)
  await service.initialize()
  const base = await service.createKnowledgeBase('项目 资料')
  let definition: CommandDefinition | undefined
  const ctx = { commands: { register: (value: CommandDefinition) => { definition = value } } }
  installCommands(ctx as unknown as Context, { service: () => service, selection: new SessionSelectionRegistry() })
  const run = (rawInput: string) => definition!.handler({
    agent: { id: 'command-fixture' }, rawInput, attachments: [], signal: new AbortController().signal,
  } as unknown as CommandInvocation)
  return { service, base, run }
}

describe('/kb rescan', () => {
  it('uses incremental scanning by default', async () => {
    const { service, run } = await fixture()
    const scan = vi.spyOn(service, 'rescan')
    const result = await run('rescan')
    expect(scan).toHaveBeenCalledWith(undefined, { force: false })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('增量扫描')
  })

  it('accepts --force and a base name containing spaces', async () => {
    const { service, base, run } = await fixture()
    const scan = vi.spyOn(service, 'rescan')
    const result = await run('rescan --force 项目 资料')
    expect(scan).toHaveBeenCalledWith(base.id, { force: true })
    expect(result.text).toContain('强制重建：1 个知识库')
  })

  it('supports forcing every base', async () => {
    const { service, run } = await fixture()
    const scan = vi.spyOn(service, 'rescan')
    await run('rescan --force')
    expect(scan).toHaveBeenCalledWith(undefined, { force: true })
  })

  it('rejects an unknown name without accidentally scanning all bases', async () => {
    const { service, run } = await fixture()
    const scan = vi.spyOn(service, 'rescan')
    expect((await run('rescan 不存在')).kind).toBe('error')
    expect(scan).not.toHaveBeenCalled()
  })

  it('reports only the requested base and its reuse count', async () => {
    const { service, base, run } = await fixture()
    await service.createKnowledgeBase('另一个库')
    await service.addFiles(base.id, [{ name: '说明.txt', data: new TextEncoder().encode('本地检索说明') }])
    const result = await run('rescan 项目 资料')
    expect(result.text).toContain('1 个知识库、1 个文件，复用 1 个文件')
  })
})
