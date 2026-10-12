/**
 * The `/kb` command surface.
 *
 * The plan's final surface for this is the settings page, but the settings page
 * is presentation over plumbing that has to be correct first. Host commands are
 * the proven path in this ecosystem (the reference plugin's only trigger
 * surface is a command) and they need no client work at all, so the whole data
 * path — create a base, ingest text, retrieve, cite — becomes testable now
 * instead of after the UI lands.
 *
 * Grammar, deliberately explicit because a slash line has no structure to lean
 * on:
 *
 * ```
 * /kb list
 * /kb create <名称>
 * /kb rename <旧名> :: <新名>
 * /kb delete <名称>
 * /kb add <库名> :: <标题> :: <正文>
 * /kb rm <标题>
 * /kb use <库名|全部|关闭>
 * /kb search <问题>
 * ```
 *
 * @module @domitor-syh/dsh-knowbase/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { KnowbaseError, type KnowbaseService } from './core/service.ts'

/** Per-session retrieval selection. */
export interface SessionSelection {
  readonly enabled: boolean
  /** `'all'` or an explicit set of knowledge base ids. */
  readonly scope: 'all' | readonly string[]
}

/**
 * In-memory session selections.
 *
 * Not persisted yet, so a host restart resets every session to the default
 * (off). The plan wants this persisted per session and defaulted off for new
 * sessions, which this already does; only the persistence is missing, and it
 * belongs with the settings UI rather than here.
 */
export class SessionSelectionRegistry {
  readonly #selections = new Map<string, SessionSelection>()

  /** The selection for a session, defaulting to disabled. */
  get(agentId: string): SessionSelection {
    return this.#selections.get(agentId) ?? { enabled: false, scope: 'all' }
  }

  /** Replace a session's selection. */
  set(agentId: string, selection: SessionSelection): void {
    this.#selections.set(agentId, selection)
  }
}

/** Dependencies the command surface needs. */
export interface CommandDeps {
  /**
   * The service, or `undefined` while the storage domain is still opening.
   *
   * A getter rather than a value: the command is registered as soon as the host
   * offers the service, which can be before storage finishes loading. Reporting
   * "still initializing" is better than registering late and leaving the command
   * undiscoverable until a restart.
   */
  readonly service: () => KnowbaseService | undefined
  readonly selection: SessionSelectionRegistry
}

/** Split on `::`, trimming each part. */
function segments(raw: string): string[] {
  return raw.split('::').map(part => part.trim())
}

/** Render one outcome as command text. */
function describeOutcome(outcome: ReturnType<KnowbaseService['retrieve']>): string {
  switch (outcome.kind) {
    case 'hits':
      return outcome.passages
        .map(
          (passage, index) =>
            `[${index + 1}] ${passage.kbName} / ${passage.materialTitle} · ${passage.locator}\n${passage.text}`,
        )
        .join('\n\n')
    case 'no_match':
      return '未命中：所选知识库中没有与该问题相关的片段。'
    case 'empty_scope':
      return '所选知识库不存在或为空，本次没有可检索的范围。'
    case 'not_ready':
      return '知识库中还没有任何已索引的资料。'
    case 'disabled':
      return '本会话未开启知识库。'
    case 'error':
      return `检索失败：${outcome.reason}`
  }
}

const HELP = [
  '知识库命令：',
  '  /kb list                              列出知识库与资料数',
  '  /kb create <名称>                      新建知识库',
  '  /kb rename <旧名> :: <新名>            重命名',
  '  /kb delete <名称>                      删除知识库及其资料',
  '  /kb add <库名> :: <标题> :: <正文>      添加文本资料',
  '  /kb rm <标题>                          删除资料',
  '  /kb use <库名|全部|关闭>               设置本会话的检索范围',
  '  /kb search <问题>                      检索测试（不调用模型）',
].join('\n')

/** Register the `/kb` command. */
export function installCommands(ctx: Context, deps: CommandDeps): void {
  const { service, selection } = deps

  ctx.commands.register({
    name: 'kb',
    description: '知识库：管理库与资料、设置本会话检索范围 / Knowledge base',
    input: { hint: 'list | create <名称> | add <库名> :: <标题> :: <正文> | use <库名|全部|关闭>' },
    async handler(invocation): Promise<CommandResult> {
      const agentId = invocation.agent.id
      const raw = invocation.rawInput.trim()
      const [verb = ''] = raw.split(/\s+/)
      const argument = raw.slice(verb.length).trim()

      const service = deps.service()
      if (service === undefined) {
        return { kind: 'error', text: '知识库正在初始化，请稍后再试。' }
      }

      try {
        switch (verb) {
          case '':
          case 'help': {
            const current = selection.get(agentId)
            const status = current.enabled
              ? `本会话：已开启（${current.scope === 'all' ? '全部知识库' : `${current.scope.length} 个库`}）`
              : '本会话：关闭'
            return { kind: 'success', text: `${HELP}\n\n${status}` }
          }

          case 'list': {
            const bases = service.listKnowledgeBases()
            if (bases.length === 0) {
              return { kind: 'success', text: '还没有知识库。用 /kb create <名称> 新建一个。' }
            }
            const lines = bases.map(knowledgeBase => {
              const materials = service.listMaterials(knowledgeBase.id)
              const chunks = materials.reduce((sum, material) => sum + material.chunks.length, 0)
              return `- ${knowledgeBase.name}（${materials.length} 份资料 / ${chunks} 个片段）`
            })
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'create': {
            const created = await service.createKnowledgeBase(argument)
            return { kind: 'success', text: `已创建知识库「${created.name}」。` }
          }

          case 'rename': {
            const [from, to] = segments(argument)
            if (from === undefined || to === undefined || from === '' || to === '') {
              return { kind: 'error', text: '用法：/kb rename <旧名> :: <新名>' }
            }
            const target = service.findKnowledgeBaseByName(from)
            if (target === undefined) return { kind: 'error', text: `没有名为「${from}」的知识库。` }
            const renamed = await service.renameKnowledgeBase(target.id, to)
            return { kind: 'success', text: `已重命名为「${renamed.name}」。` }
          }

          case 'delete': {
            const target = service.findKnowledgeBaseByName(argument)
            if (target === undefined) {
              return { kind: 'error', text: `没有名为「${argument}」的知识库。` }
            }
            const materials = service.listMaterials(target.id).length
            await service.deleteKnowledgeBase(target.id)
            return {
              kind: 'success',
              text: `已删除知识库「${target.name}」及其 ${materials} 份资料。`,
            }
          }

          case 'add': {
            const [kbName, title, ...body] = segments(argument)
            const text = body.join('::').trim()
            if (kbName === undefined || title === undefined || text === '') {
              return { kind: 'error', text: '用法：/kb add <库名> :: <标题> :: <正文>' }
            }
            const target = service.findKnowledgeBaseByName(kbName)
            if (target === undefined) return { kind: 'error', text: `没有名为「${kbName}」的知识库。` }
            const material = await service.addText(target.id, title, text)
            return {
              kind: 'success',
              text: `已加入「${target.name}」：${material.title}（${material.chunks.length} 个片段）。`,
            }
          }

          case 'rm': {
            const materials = service.listMaterials()
            const matches = materials.filter(material => material.title === argument.trim())
            if (matches.length === 0) return { kind: 'error', text: `没有标题为「${argument}」的资料。` }
            for (const material of matches) await service.deleteMaterial(material.id)
            return { kind: 'success', text: `已删除 ${matches.length} 份资料。` }
          }

          case 'use': {
            const wanted = argument.trim()
            if (wanted === '关闭' || wanted === 'off') {
              selection.set(agentId, { enabled: false, scope: 'all' })
              return { kind: 'success', text: '本会话已关闭知识库。' }
            }
            if (wanted === '全部' || wanted === 'all') {
              selection.set(agentId, { enabled: true, scope: 'all' })
              return { kind: 'success', text: '本会话使用全部知识库。' }
            }
            const target = service.findKnowledgeBaseByName(wanted)
            if (target === undefined) return { kind: 'error', text: `没有名为「${wanted}」的知识库。` }
            selection.set(agentId, { enabled: true, scope: [target.id] })
            return { kind: 'success', text: `本会话只使用「${target.name}」。` }
          }

          case 'search': {
            if (argument === '') return { kind: 'error', text: '用法：/kb search <问题>' }
            const scope = resolveScope(selection.get(agentId), service)
            if (scope === null) {
              return { kind: 'error', text: '本会话尚未开启知识库。先用 /kb use <库名|全部>。' }
            }
            return { kind: 'success', text: describeOutcome(service.retrieve(argument, scope)) }
          }

          default:
            return { kind: 'error', text: `未知子命令「${verb}」。\n\n${HELP}` }
        }
      } catch (error) {
        // A domain error carries a message written for a person; anything else
        // is a bug and should still not take the conversation down.
        if (error instanceof KnowbaseError) return { kind: 'error', text: error.message }
        return { kind: 'error', text: `知识库操作失败：${String(error)}` }
      }
    },
  })
}

/**
 * Resolve a session selection into the concrete ids to search.
 *
 * @returns the ids, or `null` when the session has the feature switched off —
 *   which is not the same as an empty scope and must not be treated as one.
 */
export function resolveScope(
  selection: SessionSelection,
  service: KnowbaseService,
): string[] | null {
  if (!selection.enabled) return null
  if (selection.scope === 'all') {
    return service.listKnowledgeBases().map(knowledgeBase => knowledgeBase.id)
  }
  return [...selection.scope]
}
