import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import { commandLanguage } from '../src/command-locale.ts'
import { installCommands } from '../src/commands.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { SessionSelectionRegistry } from '../src/core/session-scope.ts'
import { localizeDiagnostic, localizePosition } from '../src/diagnostic-locale.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'

async function fixture(initialPreference: string | undefined = 'en') {
  const root = path.resolve('command-locale-fixture')
  const service = new KnowbaseService(new MemoryStore(), createMemoryVaultFs(root), root)
  await service.initialize()
  const name = '用户资料 $& {count}'
  const base = await service.createKnowledgeBase(name)
  let preference: string | undefined = initialPreference
  let definition: CommandDefinition | undefined
  const describeSettings = vi.fn(() => [
    { ns: 'unrelated', value: { preference: 'zh' } },
    { ns: 'custom-language-row', value: { preference } },
  ])
  const ctx = {
    get(key: string) {
      if (key === 'configEditor') return { entries: () => [
        { options: { id: 'unrelated', name: 'another-plugin' } },
        { options: { id: 'custom-language-row', name: '@deepseek-ai/dsh-client-locale' } },
      ] }
      if (key === 'settings') return { describe: describeSettings }
      return undefined
    },
    commands: { register(value: CommandDefinition) { definition = value } },
  } as unknown as Context
  installCommands(ctx, { service: () => service, selection: new SessionSelectionRegistry() })
  const run = (rawInput: string) => definition!.handler({
    agent: { id: 'command-locale' }, rawInput, attachments: [], signal: new AbortController().signal,
  } as unknown as CommandInvocation)
  return { ctx, service, name, base, run, describeSettings, definition: () => definition!, switchTo(value: string | undefined) { preference = value } }
}

describe('Host command language discovery', () => {
  it('discovers the locale package by name and its custom settings namespace', async () => {
    const f = await fixture()
    expect(commandLanguage(f.ctx)).toBe('en')
    expect(f.describeSettings).toHaveBeenCalledWith({ redactSecrets: true })
    f.switchTo('zh-CN')
    expect(commandLanguage(f.ctx)).toBe('zh')
  })

  it('retains legacy Chinese without a saved preference or settings service', async () => {
    const f = await fixture(undefined)
    f.switchTo(undefined)
    expect(commandLanguage(f.ctx)).toBe('zh')
    expect(commandLanguage({} as Context)).toBe('zh')
    expect(commandLanguage({ get: () => undefined } as unknown as Context)).toBe('zh')
  })

  it('does not guess among multiple locale owners or read settings failures as English', () => {
    const ctx = { get(key: string) {
      if (key === 'configEditor') return { entries: () => [1, 2].map(n => ({ options: { id: String(n), name: '@deepseek-ai/dsh-client-locale' } })) }
      return { describe() { throw new Error('unavailable') } }
    } } as unknown as Context
    expect(commandLanguage(ctx)).toBe('zh')
  })
})

describe('localized /kb commands', () => {
  it('switches help and later invocations en → zh → en without re-registration', async () => {
    const f = await fixture()
    expect((await f.run('help')).text).toContain('Knowledge base commands:')
    expect((await f.run('list')).text).toContain(`${f.name} (0 files / 0 searchable)`)
    f.switchTo('zh')
    expect((await f.run('help')).text).toContain('知识库命令：')
    expect((await f.run('list')).text).toContain(`${f.name}（0 个文件 / 0 个可检索）`)
    f.switchTo('en')
    expect((await f.run('help')).text).toContain('Knowledge base commands:')
    expect(f.definition().description).toBe('Knowledge base: manage local files and set this session’s search scope')
    expect(f.definition().input?.hint).toContain('<base>')
  })

  it('preserves names and paths in action responses and translates domain errors', async () => {
    const f = await fixture()
    expect((await f.run('root')).text).toBe(`Knowledge base root: ${f.service.root}`)
    expect((await f.run(`create ${f.name}`)).text).toBe(`A knowledge base named “${f.name}” already exists.`)
    expect((await f.run('create')).text).toBe('The knowledge base name cannot be empty.')
    expect((await f.run(`files ${f.name}`)).text).toContain(`${f.service.root}\\${f.base.folderName}`)
    expect((await f.run('files 不存在 $& {count}')).text).toBe('No knowledge base named “不存在 $& {count}” exists.')
    expect((await f.run('rename')).text).toBe('Usage: /kb rename <old> :: <new>')
  })

  it('localizes scan counts and known failure reasons while preserving file names', async () => {
    const f = await fixture()
    const filename = '空文件 $& {count}.txt'
    await f.service.addFiles(f.base.id, [{ name: filename, data: new Uint8Array() }])
    const result = await f.run(`rescan ${f.name}`)
    expect(result.text).toContain('Incremental scan complete: 1 knowledge base, 1 file.')
    expect(result.text).toContain('Unsearchable files')
    expect(result.text).toContain(`${f.name} / ${filename}`)
    expect(result.text).toContain('No searchable text was extracted.')
    expect(result.text).not.toContain('command-locale-fixture')
    vi.spyOn(f.service, 'rescan').mockRejectedValueOnce(new Error('EACCES C:\\private\\secret'))
    const failed = await f.run('rescan')
    expect(failed.text).toContain('Incomplete bases retain their last successful snapshot')
    expect(failed.text).not.toContain('private')
  })

  it('keeps retrieved document text verbatim and translates only generated locators', async () => {
    const f = await fixture()
    const document = '中文检索说明 $& {count}'
    await f.service.addFiles(f.base.id, [{ name: '说明.txt', data: new TextEncoder().encode(document) }])
    await f.run('use all')
    const result = await f.run('search 中文检索')
    expect(result.text).toContain(document)
    expect(result.text).toContain(f.name)
    expect(result.text).toContain('Line 1')
    expect((await f.run('use off')).text).toBe('Knowledge bases are now disabled for this session.')
    expect((await f.run('search 中文')).text).toContain('Knowledge bases are disabled')
  })
})

describe('shared pure diagnostic translations', () => {
  it('passes the selected language through recursive known diagnostics', () => {
    const error = 'PDF 解析失败：连接超时'
    expect(localizeDiagnostic(error, 'en')).toBe('PDF parsing failed: Connection timed out')
    expect(localizeDiagnostic(error, 'zh')).toBe(error)
    expect(localizeDiagnostic('用户原文 $& {count}', 'en')).toBe('用户原文 $& {count}')
  })

  it('translates complete generated locator syntax and preserves headings', () => {
    expect(localizePosition('第 2 页 · 第 3-5 行', 'en')).toBe('Page 2 · Lines 3-5')
    expect(localizePosition('用户标题 第 2 页', 'en')).toBe('用户标题 第 2 页')
    expect(localizePosition('第 2 页 · 第 3-5 行', 'zh')).toBe('第 2 页 · 第 3-5 行')
  })
})
