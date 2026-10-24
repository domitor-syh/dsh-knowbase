import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { SessionSelectionRegistry } from '../src/core/session-scope.ts'
import { StatisticsRegistry } from '../src/core/statistics.ts'
import { installKnowledgeTools } from '../src/tools.ts'
import { createMemoryVaultFs } from '../src/vault-fs.ts'

/** Real Cordis and tool registry; no profile, live Host or actual disk vault. */
async function fixture() {
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  const vaultRoot = path.resolve('knowledge-registry-fixture')
  const service = new KnowbaseService(new MemoryStore(), createMemoryVaultFs(vaultRoot), vaultRoot)
  await service.initialize()
  const base = await service.createKnowledgeBase('Registry evidence')
  await service.addFiles(base.id, [{ name: 'evidence.txt', data: new TextEncoder().encode('registry evidence '.repeat(1200)) }])
  const selection = new SessionSelectionRegistry()
  await selection.set('session-a', { enabled: true, scope: [base.id] })
  const statistics = new StatisticsRegistry()
  await statistics.useStore({
    loadSettings: () => undefined, loadRecords: () => [],
    saveSettings: async () => {}, put: async () => {}, delete: async () => {},
  })
  const deps = { service: () => service, selection, statistics }
  const owner = root.plugin({
    name: 'knowledge-tools-registry-test-owner',
    inject: ['tools'],
    apply(ctx: Context) { installKnowledgeTools(ctx, deps) },
  })
  await owner.await()
  const tools = root.tools
  let calls = 0
  async function execute(name: string, args: unknown, agentId: string | undefined = 'session-a', signal = new AbortController().signal) {
    return tools.execute({
      callId: `registry-call-${++calls}`,
      name,
      arguments: args,
      signal,
      ...(agentId === undefined ? {} : { agent: { id: agentId } }),
    } as ToolExecutionInput)
  }
  return { root, owner, tools, service, selection, base, deps, execute }
}

function expectLosslessJson(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}

describe('knowledge tools with the real Host tool registry', () => {
  it('registers all raw input/output schemas, including integer and open output properties', async () => {
    const f = await fixture()
    try {
      expect(f.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['kb_list', 'kb_search', 'kb_read', 'kb_stats', 'kb_propose_text']))
      expect(f.tools.schemas()).toHaveLength(5)
      for (const name of ['kb_list', 'kb_search', 'kb_read', 'kb_stats', 'kb_propose_text']) {
        const def = f.tools.get(name)!
        expect(def).toBeDefined()
        expect(() => assertObjectJsonSchema(def.parameters)).not.toThrow()
        expect(() => assertSupportedJsonSchema(def.output.schema)).not.toThrow()
        expect(def.output.schema.additionalProperties).toBe(true)
        expect(validateJsonSchemaValue(def.output.schema, { status: 'ok', entries: [{ id: 'x' }], optional: null })).toEqual([])
      }
      const input = f.tools.get('kb_read')!.parameters
      expect(validateJsonSchemaValue(input, { kbId: f.base.id, materialId: 'evidence.txt', offset: 0, limit: 8000 })).toEqual([])
      expect(validateJsonSchemaValue(input, { kbId: f.base.id, materialId: 'evidence.txt', offset: 0.5 })).not.toEqual([])
      const stats = f.tools.get('kb_stats')!.parameters
      expect(validateJsonSchemaValue(stats, {})).toEqual([])
      expect(validateJsonSchemaValue(stats, { kbId: f.base.id, offset: 0, limit: 50 })).toEqual([])
      expect(validateJsonSchemaValue(stats, { offset: 0.5 })).not.toEqual([])
      expect(validateJsonSchemaValue(stats, { enabled: true })).not.toEqual([])
    } finally { await f.root.fiber.dispose() }
  })

  it('dispatches canonical values and renders native text through the actual pipeline', async () => {
    const f = await fixture()
    try {
      const inputs = [
        ['kb_stats', {}],
        ['kb_stats', { kbId: f.base.id, offset: 0, limit: 50 }],
        ['kb_list', {}],
        ['kb_list', { kbId: f.base.id, limit: 1 }],
        ['kb_search', { query: 'registry evidence', limit: 8 }],
        ['kb_read', { kbId: f.base.id, materialId: 'evidence.txt', limit: 8000 }],
      ] as const
      for (const [name, args] of inputs) {
        const result = await f.execute(name, args)
        expect(result.isError).toBe(false)
        if (result.isError) throw new Error(`Unexpected registry failure: ${JSON.stringify(result)}`)
        expect(result.value).toMatchObject({ status: 'ok' })
        expectLosslessJson(result.value)
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
      }
      const read = await f.execute('kb_read', { kbId: f.base.id, materialId: 'evidence.txt', limit: 8000 })
      if (read.isError) throw new Error('Unexpected read failure')
      expect(String((read.value as Record<string, unknown>).text).length).toBe(8000)
    } finally { await f.root.fiber.dispose() }
  })

  it('strips undefined optional passage metadata before the registry JSON boundary', async () => {
    const f = await fixture()
    try {
      vi.spyOn(f.service, 'retrieve').mockReturnValue({
        kind: 'hits', passages: [{ kbName: 'Registry evidence', materialTitle: 'evidence.txt', locator: 'section', text: 'evidence' }],
      })
      const result = await f.execute('kb_search', { query: 'evidence' })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('Registry rejected cleaned optional metadata')
      expectLosslessJson(result.value)
      expect(result.value).toMatchObject({ status: 'ok', passages: [{ text: 'evidence' }] })
      expect((result.value as { passages: object[] }).passages[0]).not.toHaveProperty('ordinal')
      expect((result.value as { passages: object[] }).passages[0]).not.toHaveProperty('source')
    } finally { await f.root.fiber.dispose() }
  })

  it('fails closed without an agent, rejects extra arguments and reflects changed selection', async () => {
    const f = await fixture()
    try {
      const noAgent = await f.tools.execute({ callId: 'no-agent', name: 'kb_list', arguments: {}, signal: new AbortController().signal } as ToolExecutionInput)
      expect(noAgent.isError).toBe(false)
      if (!noAgent.isError) expect(noAgent.value).toMatchObject({ status: 'no_agent' })
      const invalid = await f.execute('kb_list', { agentId: 'session-a' })
      expect(invalid.isError).toBe(false)
      if (!invalid.isError) expect(invalid.value).toMatchObject({ status: 'invalid_arguments' })
      await f.selection.set('session-a', { enabled: false, scope: 'all' })
      const disabled = await f.execute('kb_read', { kbId: f.base.id, materialId: 'evidence.txt' })
      if (disabled.isError) throw new Error('Unexpected disabled registry failure')
      expect(disabled.value).toMatchObject({ status: 'disabled' })
      const controller = new AbortController()
      controller.abort()
      expect((await f.execute('kb_list', {}, 'session-a', controller.signal)).isError).toBe(true)
    } finally { await f.root.fiber.dispose() }
  })

  it('owns registration effects on the plugin context and permits clean HMR restart', async () => {
    const f = await fixture()
    try {
      const before = f.tools.get('kb_list')
      expect(before).toBeDefined()
      await f.owner.restart()
      expect(f.tools.get('kb_list')).toBeDefined()
      expect(f.tools.get('kb_list')).not.toBe(before)
      await f.owner.dispose()
      expect(f.tools.schemas()).toEqual([])
      expect(f.tools.get('kb_list')).toBeUndefined()
      installKnowledgeTools(f.root, f.deps)
      expect(f.tools.schemas()).toHaveLength(5)
      await f.root.fiber.dispose()
      expect(f.tools.get('kb_list')).toBeUndefined()
      expect(f.tools.schemas()).toEqual([])
    } finally { await f.root.fiber.dispose() }
  })
})
