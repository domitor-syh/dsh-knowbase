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

  it('shows unsearchable reasons separately from unsupported formats', async () => {
    const { service, base, run } = await fixture()
    await service.addFiles(base.id, [
      { name: 'empty.txt', data: new Uint8Array() },
      { name: 'archive.zip', data: new Uint8Array([1, 2, 3]) },
    ])
    const result = await run('rescan 项目 资料')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('扫描 2')
    expect(result.text).toContain('复用 1')
    expect(result.text).toContain('格式跳过 1')
    expect(result.text).toContain('重建尝试 1')
    expect(result.text).toContain('不可检索 1')
    expect(result.text).toContain('empty.txt')
    expect(result.text).toContain('未提取到可检索文字')
    expect(result.text).not.toContain('command-scan-fixture')
  })

  it('does not surface raw paths or OS messages after an interrupted scan', async () => {
    const { service, run } = await fixture()
    vi.spyOn(service, 'rescan').mockRejectedValueOnce(new Error('EACCES C:\\private\\vault ENCODED_SECRET'))
    const result = await run('rescan')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('保留上次成功快照')
    expect(result.text).not.toMatch(/private|ENCODED_SECRET|EACCES/u)
  })

  it('reports only the requested base and its reuse count', async () => {
    const { service, base, run } = await fixture()
    await service.createKnowledgeBase('另一个库')
    await service.addFiles(base.id, [{ name: '说明.txt', data: new TextEncoder().encode('本地检索说明') }])
    const result = await run('rescan 项目 资料')
    expect(result.text).toContain('1 个知识库、1 个文件。')
    expect(result.text).toContain('复用 1')
    expect(result.text).toContain('新增 0')
    expect(result.text).toContain('删除 0')
    expect(result.text).toContain('重建尝试 0')
  })
})
