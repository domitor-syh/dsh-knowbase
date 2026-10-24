import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { SessionSelectionRegistry } from '../src/core/session-scope.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'
import { StatisticsRegistry } from '../src/core/statistics.ts'
import { runKnowledgeTool, type KnowledgeToolName } from '../src/knowledge-tools.ts'
import { installKnowledgeTools } from '../src/tools.ts'

type Def = Parameters<Context['tools']['register']>[0]
async function fixture() {
  const root = path.resolve('readonly-agent-fixture')
  const fs = createMemoryVaultFs(root)
  const service = new KnowbaseService(new MemoryStore(), fs, root)
  await service.initialize()
  const a = await service.createKnowledgeBase('公开资料', '项目资料')
  const b = await service.createKnowledgeBase('私有资料')
  const text = 'local evidence 中文知识库说明\n'.repeat(500)
  await service.addFiles(a.id, [
    { name: '说明.md', data: new TextEncoder().encode(text) },
    { name: '附件.zip', data: new Uint8Array([1, 2, 3]) },
  ])
  await service.addFiles(b.id, [{ name: 'secret.txt', data: new TextEncoder().encode('hidden secret local evidence') }])
  const selection = new SessionSelectionRegistry()
  await selection.set('a', { enabled: true, scope: [a.id] })
  await selection.set('b', { enabled: true, scope: [b.id] })
  const statistics = new StatisticsRegistry()
  await statistics.useStore({
    loadSettings: () => undefined, loadRecords: () => [],
    saveSettings: async () => {}, put: async () => {}, delete: async () => {},
  })
  const deps = { service: () => service, selection, statistics }
  const run = (name: KnowledgeToolName, args: unknown = {}, agentId: string | undefined = 'a') => runKnowledgeTool(name, args, agentId, deps)
  return { service, selection, deps, a, b, text, fs, run, root }
}

describe('read-only Agent knowledge tools', () => {
  it('lists only selected bases and paginates their material ids', async () => {
    const { run, a, b } = await fixture()
    const bases = run('kb_list')
    expect(bases).toMatchObject({ status: 'ok', kind: 'bases', total: 1, entries: [{ kbId: a.id }] })
    expect(JSON.stringify(bases)).not.toContain(b.id)
    const first = run('kb_list', { kbId: a.id, limit: 1 })
    expect(first).toMatchObject({ kind: 'materials', total: 2, nextOffset: 1, truncated: true })
    const second = run('kb_list', { kbId: a.id, offset: first.nextOffset, limit: 1 })
    expect(second).toMatchObject({ nextOffset: null, truncated: false })
    expect(second.entries).not.toEqual(first.entries)
  })

  it('searches and returns bounded evidence, locators, revision and internal source addresses', async () => {
    const { run, a, root } = await fixture()
    const result = run('kb_search', { query: 'local evidence', limit: 2 })
    expect(result).toMatchObject({ status: 'ok', kind: 'passages' })
    const hits = result.passages as Record<string, unknown>[]
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(2)
    for (const hit of hits) {
      expect(hit.kbId).toBe(a.id)
      expect(String(hit.text).length).toBeLessThanOrEqual(1200)
      expect(hit).toHaveProperty('locator')
      expect(hit).toHaveProperty('indexRevision')
      expect(hit.source).toContain('dsh-resource://knowbase/')
      expect(hit).not.toHaveProperty('filePath')
    }
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('hidden secret')
  })

  it('reads successive bounded text segments without losing content', async () => {
    const { run, a, text } = await fixture()
    const first = run('kb_read', { kbId: a.id, materialId: '说明.md', limit: 100 })
    const second = run('kb_read', { kbId: a.id, materialId: '说明.md', offset: first.nextOffset, limit: 100 })
    expect(first).toMatchObject({ status: 'ok', offset: 0, nextOffset: 100, truncated: true })
    expect(String(first.text) + String(second.text)).toBe(text.slice(0, 200))
    expect(String(run('kb_read', { kbId: a.id, materialId: '说明.md' }).text).length).toBe(4000)
    expect(run('kb_read', { kbId: a.id, materialId: '说明.md', offset: text.length + 50 })).toMatchObject({ text: '', locator: '正文结束', nextOffset: null, offset: text.length })
  })

  it.each(['kb_list', 'kb_search', 'kb_read', 'kb_stats'] as const)('%s cannot widen scope with a guessed id', async name => {
    const { run, b } = await fixture()
    expect(run(name, { kbId: b.id, ...(name === 'kb_search' ? { query: 'secret' } : {}), ...(name === 'kb_read' ? { materialId: 'secret.txt' } : {}) })).toMatchObject({ status: 'out_of_scope' })
  })

  it('resolves current selection on each call and never borrows another session', async () => {
    const { run, selection, a, b } = await fixture()
    expect(run('kb_list', {}, 'unknown')).toMatchObject({ status: 'disabled' })
    expect(runKnowledgeTool('kb_list', {}, undefined, { service: () => undefined, selection })).toMatchObject({ status: 'no_agent' })
    await selection.set('a', { enabled: true, scope: [b.id] })
    expect(run('kb_list')).toMatchObject({ entries: [{ kbId: b.id }] })
    expect(run('kb_read', { kbId: a.id, materialId: '说明.md' }).status).toBe('out_of_scope')
    await selection.set('a', { enabled: false, scope: 'all' })
    expect(run('kb_list').status).toBe('disabled')
    await selection.set('a', { enabled: true, scope: [] })
    expect(run('kb_list').status).toBe('no_selection')
    await selection.set('a', { enabled: true, scope: ['deleted'] })
    expect(run('kb_list').status).toBe('empty_scope')
  })

  it('reports startup, empty installation and an unindexed selected base honestly', async () => {
    const { selection, run, deps, service } = await fixture()
    expect(runKnowledgeTool('kb_list', {}, 'a', { ...deps, service: () => undefined }).status).toBe('not_ready')
    const empty = new KnowbaseService(new MemoryStore(), createMemoryVaultFs('/empty-tools'), '/empty-tools')
    await empty.initialize()
    await selection.set('a', { enabled: true, scope: 'all' })
    expect(runKnowledgeTool('kb_list', {}, 'a', { ...deps, service: () => empty }).status).toBe('no_bases')
    const base = await service.createKnowledgeBase('空库')
    await selection.set('a', { enabled: true, scope: [base.id] })
    expect(run('kb_search', { query: 'evidence' }).status).toBe('not_ready')
  })

  it('rejects arbitrary paths, binary reads and absent material keys without filesystem access', async () => {
    const { run, a, fs } = await fixture()
    const readText = vi.spyOn(fs, 'readText')
    const readBytes = vi.spyOn(fs, 'readBytes')
    for (const materialId of ['../secret.txt', 'C:\\Windows\\win.ini', '/etc/passwd', 'not-here.txt']) {
      expect(run('kb_read', { kbId: a.id, materialId }).status).toBe('not_found')
    }
    expect(run('kb_read', { kbId: a.id, materialId: '附件.zip' }).status).toBe('unreadable')
    expect(readText).not.toHaveBeenCalled()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it.each([
    ['kb_stats', { offset: -1 }], ['kb_stats', { offset: 0.5 }], ['kb_stats', { offset: Number.MAX_SAFE_INTEGER + 1 }],
    ['kb_stats', { limit: 0 }], ['kb_stats', { limit: 51 }], ['kb_stats', { limit: 1.5 }], ['kb_stats', { kbId: '' }],
    ['kb_stats', { enabled: true }], ['kb_stats', { clear: true }], ['kb_stats', { path: '/private' }], ['kb_stats', null],
    ['kb_list', { limit: 101 }], ['kb_list', { offset: -1 }], ['kb_list', { offset: 1.5 }],
    ['kb_search', { query: ' ' }], ['kb_search', { query: 'x'.repeat(2001) }], ['kb_search', { query: 'x', limit: 9 }],
    ['kb_read', { kbId: 'x', materialId: 'y', limit: 8001 }], ['kb_read', { kbId: 'x', materialId: 'y', limit: 0 }],
    ['kb_list', { agentId: 'b' }], ['kb_list', { path: 'C:\\private.txt' }], ['kb_list', null],
  ] as const)('validates %s input %j', async (name, args) => {
    const { run } = await fixture()
    expect(run(name, args).status).toBe('invalid_arguments')
  })

  it('returns no_match and reads the committed snapshot without refreshing the disk', async () => {
    const { run, service, a, fs, text } = await fixture()
    expect(run('kb_search', { query: 'qzxunfindabletoken' }).status).toBe('no_match')
    const absolute = service.materialPath(a.id, '说明.md')!
    await fs.writeFile(absolute, 'external replacement')
    expect(run('kb_read', { kbId: a.id, materialId: '说明.md', limit: 100 }).text).toBe(text.slice(0, 100))
    await service.rescan(a.id, { force: true })
    expect(run('kb_read', { kbId: a.id, materialId: '说明.md' }).text).toBe('external replacement')
  })

  it('does not leak thrown errors or raw internal retrieval errors', async () => {
    const { run, service } = await fixture()
    const spy = vi.spyOn(service, 'retrieve').mockImplementation(() => { throw new Error('C:\\private\\secret') })
    expect(run('kb_search', { query: 'x' })).toEqual({ status: 'error', message: '知识库操作失败，未获得可靠结果。' })
    spy.mockReturnValue({ kind: 'error', reason: 'C:\\private\\secret' })
    expect(JSON.stringify(run('kb_search', { query: 'x' }))).not.toContain('private')
  })

  it('reads default-off statistics synchronously and reports missing storage consistently', async () => {
    const { run, deps, selection } = await fixture()
    const view = run('kb_stats')
    expect(view).toMatchObject({ status: 'ok', kind: 'statistics', enabled: false, available: true, retentionDays: 30, counters: { requests: 0 }, entries: [], hitRate: null, offset: 0, nextOffset: null })
    expect(view).not.toBeInstanceOf(Promise)
    expect(runKnowledgeTool('kb_stats', {}, 'a', { service: deps.service, selection }).status).toBe('not_ready')
    expect(runKnowledgeTool('kb_stats', {}, 'a', { ...deps, statistics: new StatisticsRegistry() })).toMatchObject({ status: 'not_ready', kind: 'statistics', available: false })
    expect(runKnowledgeTool('kb_stats', {}, undefined, deps).status).toBe('no_agent')
    expect(runKnowledgeTool('kb_stats', {}, 'a', { ...deps, service: () => undefined }).status).toBe('not_ready')
    expect(run('kb_stats', {}, 'unknown').status).toBe('disabled')
    await selection.set('a', { enabled: true, scope: [] })
    expect(run('kb_stats').status).toBe('no_selection')
    await selection.set('a', { enabled: true, scope: ['deleted'] })
    expect(run('kb_stats').status).toBe('empty_scope')
  })

  it('filters live statistics and counts historical requests only within the complete allowed scope', async () => {
    const { run, deps, service, selection, a, b } = await fixture()
    await deps.statistics.setEnabled(true)
    const record = (turn: number, scopeIds: string[], outcome: Parameters<StatisticsRegistry['record']>[0]['outcome']) => deps.statistics.record({ sessionId: 'a', turn, inputKey: `input-${turn}`, scopeIds, outcome })
    record(1, [a.id], { kind: 'hits', passages: [
      { kbId: a.id, materialId: '说明.md', kbName: a.name, materialTitle: '说明.md', text: 'evidence', locator: 'one' },
      { kbId: a.id, materialId: '附件.zip', kbName: a.name, materialTitle: '附件.zip', text: 'evidence', locator: 'two' },
    ] })
    record(2, [b.id], { kind: 'hits', passages: [{ kbId: b.id, materialId: 'secret.txt', kbName: b.name, materialTitle: 'secret.txt', text: 'private', locator: 'three' }] })
    record(3, [a.id, b.id], { kind: 'no_match' })
    const snapshot = vi.spyOn(deps.statistics, 'snapshot')
    expect(run('kb_stats', { limit: 1 })).toMatchObject({ status: 'ok', counters: { requests: 1, hits: 1, noMatch: 0 }, total: 2, nextOffset: 1, entries: [{ kbId: a.id, recallTurns: 1 }] })
    expect(snapshot.mock.calls[0]![1]).toEqual([a.id])
    expect(snapshot.mock.calls[0]![0]).toHaveLength(2)
    expect(snapshot.mock.calls[0]![0].every(material => material.kbId === a.id)).toBe(true)
    expect(run('kb_stats', { offset: 1, limit: 1 })).toMatchObject({ total: 2, offset: 1, nextOffset: null })
    expect(run('kb_stats', { offset: 100 })).toMatchObject({ entries: [], nextOffset: null })
    expect(JSON.stringify(run('kb_stats'))).not.toContain(b.id)
    await selection.set('a', { enabled: true, scope: 'all' })
    expect(run('kb_stats')).toMatchObject({ counters: { requests: 3, hits: 2, noMatch: 1 }, total: 3, hitRate: 2 / 3 })
    expect(run('kb_stats', { kbId: a.id })).toMatchObject({ counters: { requests: 1 }, total: 2 })
    await service.deleteMaterial(a.id, '附件.zip')
    expect(run('kb_stats', { kbId: a.id })).toMatchObject({ total: 1, entries: [{ materialId: '说明.md' }] })
    await deps.statistics.flush()
  })

  it('sanitizes statistics display metadata and never reads the vault or records manual tool use', async () => {
    const { run, deps, service, fs, a, root } = await fixture()
    await deps.statistics.setEnabled(true)
    deps.statistics.record({ sessionId: 'a', turn: 1, inputKey: 'evidence', scopeIds: [a.id], outcome: { kind: 'hits', passages: [{ kbId: a.id, materialId: '说明.md', kbName: a.name, materialTitle: '说明.md', text: 'evidence', locator: 'one' }] } })
    const original = service.listMaterials.bind(service)
    vi.spyOn(service, 'listKnowledgeBases').mockReturnValue([{ ...a, name: `${root}\\private` }])
    vi.spyOn(service, 'listMaterials').mockImplementation(id => original(id).map(material => ({ ...material, title: 'C:\\private\\secret.md' })))
    const reads = [vi.spyOn(fs, 'readText'), vi.spyOn(fs, 'readBytes')]
    const record = vi.spyOn(deps.statistics, 'record')
    expect(run('kb_stats')).toMatchObject({ entries: [{ kbName: '路径已隐藏', title: '路径已隐藏' }] })
    expect(JSON.stringify(run('kb_stats'))).not.toContain(root)
    run('kb_list')
    run('kb_search', { query: 'evidence' })
    run('kb_read', { kbId: a.id, materialId: '说明.md' })
    for (const read of reads) expect(read).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    vi.spyOn(deps.statistics, 'snapshot').mockImplementation(() => { throw new Error('C:\\private\\secret') })
    expect(run('kb_stats')).toEqual({ status: 'error', message: '知识库操作失败，未获得可靠结果。' })
    await deps.statistics.flush()
  })

  it('registers canonical JSON output, checks cancellation and leaves mutations untouched', async () => {
    const { deps, service } = await fixture()
    const definitions: Def[] = []
    installKnowledgeTools({ tools: { register: (def: Def) => { definitions.push(def); return () => {} } } } as unknown as Context, deps)
    expect(definitions.map(def => def.name)).toEqual(['kb_list', 'kb_search', 'kb_read', 'kb_stats', 'kb_propose_text'])
    const mutations = [vi.spyOn(service, 'rescan'), vi.spyOn(service, 'addFiles'), vi.spyOn(service, 'deleteMaterial')]
    const execution = { agent: { id: 'a' }, signal: new AbortController().signal } as Parameters<Def['execute']>[1]
    for (const definition of definitions) {
      expect(definition.isConcurrencySafe?.({})).toBe(true)
      const args = definition.name === 'kb_search' ? { query: 'evidence' } : definition.name === 'kb_read' ? { kbId: service.listKnowledgeBases()[0]!.id, materialId: '说明.md' } : {}
      const value = await definition.execute(args, execution)
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
      expect(definition.output.render(args, value as never)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    }
    for (const spy of mutations) expect(spy).not.toHaveBeenCalled()
    const controller = new AbortController()
    controller.abort()
    await expect(definitions[0]!.execute({}, { ...execution, signal: controller.signal })).rejects.toThrow()
    expect(await definitions[0]!.execute({}, { ...execution, agent: undefined })).toMatchObject({ status: 'no_agent' })
  })
})
