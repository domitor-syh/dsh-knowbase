/** Cordis registration kept separate from the host-free operations and tests. */
import type { Context } from '@deepseek-ai/cordis'
import {
  knowledgeDescriptions,
  runKnowledgeTool,
  type KnowledgeToolDeps,
  type KnowledgeToolName,
} from './knowledge-tools.ts'

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
const kbId = { type: 'string', description: 'Knowledge-base id from kb_list. For list/search, omit to use the conversation selection.' }
const offset = { type: 'integer', description: 'Zero-based offset; default 0. List counts entries; read counts UTF-16 code units. Continue with nextOffset.' }
const schemas = {
  kb_list: {
    type: 'object', properties: { kbId, offset, limit: { type: 'integer', description: 'Maximum entries; default 50, range 1–100.' } }, additionalProperties: false,
  },
  kb_search: {
    type: 'object', properties: { kbId, query: { type: 'string', description: 'Nonempty search query, at most 2000 characters.' }, limit: { type: 'integer', description: 'Maximum evidence passages; default 6, range 1–8.' } }, required: ['query'], additionalProperties: false,
  },
  kb_read: {
    type: 'object', properties: { kbId, materialId: { type: 'string', description: 'Material id from kb_list or kb_search; not an arbitrary file path.' }, offset, limit: { type: 'integer', description: 'Maximum UTF-16 code units; default 4000, range 1–8000.' } }, required: ['kbId', 'materialId'], additionalProperties: false,
  },
} as const

export function installKnowledgeTools(ctx: Context, deps: KnowledgeToolDeps): void {
  for (const name of Object.keys(schemas) as KnowledgeToolName[]) {
    ctx.tools.register({
      name,
      description: knowledgeDescriptions[name],
      parameters: schemas[name],
      output: {
        schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        // Snapshot metadata can omit optional fields; canonical tool values cannot.
        return JSON.parse(JSON.stringify(runKnowledgeTool(name, args, exec.agent?.id, deps)))
      },
      isConcurrencySafe: () => true,
    } satisfies ToolDefinition)
  }
}
