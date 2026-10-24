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
 * /kb use <库名[,库名]|全部|关闭>
 * /kb search <问题>
 * ```
 *
 * @module @domitor-syh/dsh-knowbase/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { resolveScope, type SessionSelectionRegistry } from './core/session-scope.ts'
import { KnowbaseError, type KnowbaseService } from './core/service.ts'
import { formatScanFailures, formatScanSummary } from './scan-summary.ts'

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
  '  /kb list                              列出知识库与文件数',
  '  /kb files <库名>                       列出库内的文件',
  '  /kb create <名称>                      新建知识库（同时建好它的文件夹）',
  '  /kb rename <旧名> :: <新名>            重命名（文件夹一起改名）',
  '  /kb delete <名称>                      删除知识库（文件夹移入 _回收站，不销毁）',
  '  /kb rm <库名> :: <文件名>               删除文件（移入 _回收站，不销毁）',
  '  /kb rescan [--force] [库名]            增量重扫；--force 强制重新解析全部文件',
  '  /kb use <库名[,库名]|全部|关闭>        设置本会话的检索范围',
  '  /kb search <问题>                      检索测试（不调用模型）',
  '  /kb root                               显示知识库根目录（你的文件实际存放的位置）',
].join('\n')

/** Register the `/kb` command. */
export function installCommands(ctx: Context, deps: CommandDeps): void {
  const { selection } = deps

  ctx.commands.register({
    name: 'kb',
    description: '知识库：管理库与文件、设置本会话检索范围 / Knowledge base',
    input: { hint: 'list | files <库名> | create <名称> | rescan [--force] [库名] | use <库名[,库名]|全部|关闭>' },
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

          case 'root':
            return { kind: 'success', text: `知识库根目录：${service.root}` }

          case 'list': {
            const bases = service.listKnowledgeBases()
            if (bases.length === 0) {
              return { kind: 'success', text: '还没有知识库。用 /kb create <名称> 新建一个。' }
            }
            const lines = bases.map(knowledgeBase => {
              const materials = service.listMaterials(knowledgeBase.id)
              const indexed = materials.filter(material => material.indexed).length
              return `- ${knowledgeBase.name}（${materials.length} 个文件 / ${indexed} 个可检索）/ ${knowledgeBase.folderName}`
            })
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'files': {
            const target = service.findKnowledgeBaseByName(argument)
            if (target === undefined) return { kind: 'error', text: `没有名为「${argument}」的知识库。` }
            const materials = service.listMaterials(target.id)
            if (materials.length === 0) {
              return {
                kind: 'success',
                text: `「${target.name}」里还没有文件。把文件放进 ${service.root}\\${target.folderName}，再 /kb rescan。`,
              }
            }
            const lines = materials.map(
              material =>
                `- ${material.fileName}（${formatBytes(material.bytes)}${material.indexed ? '' : '，不可检索'}）`,
            )
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'create': {
            const created = await service.createKnowledgeBase(argument)
            return { kind: 'success', text: `已创建知识库「${created.name}」，文件夹：${created.folderName}` }
          }

          case 'rename': {
            const [from, to] = segments(argument)
            if (from === undefined || to === undefined || from === '' || to === '') {
              return { kind: 'error', text: '用法：/kb rename <旧名> :: <新名>' }
            }
            const target = service.findKnowledgeBaseByName(from)
            if (target === undefined) return { kind: 'error', text: `没有名为「${from}」的知识库。` }
            const renamed = await service.renameKnowledgeBase(target.id, to)
            return { kind: 'success', text: `已重命名为「${renamed.name}」，文件夹：${renamed.folderName}` }
          }

          case 'delete': {
            const target = service.findKnowledgeBaseByName(argument)
            if (target === undefined) {
              return { kind: 'error', text: `没有名为「${argument}」的知识库。` }
            }
            const files = service.listMaterials(target.id).length
            await service.deleteKnowledgeBase(target.id)
            return {
              kind: 'success',
              text: `已把「${target.name}」（${files} 个文件）的文件夹移入 _回收站。它没有被销毁，需要时可以自己拖回来。`,
            }
          }

          case 'rm': {
            const [kbName, fileName] = segments(argument)
            if (kbName === undefined || fileName === undefined || fileName === '') {
              return { kind: 'error', text: '用法：/kb rm <库名> :: <文件名>' }
            }
            const target = service.findKnowledgeBaseByName(kbName)
            if (target === undefined) return { kind: 'error', text: `没有名为「${kbName}」的知识库。` }
            const matches = service
              .listMaterials(target.id)
              .filter(material => material.fileName === fileName || material.title === fileName)
            if (matches.length === 0) {
              return { kind: 'error', text: `「${target.name}」里没有文件「${fileName}」。` }
            }
            for (const material of matches) await service.deleteMaterial(target.id, material.id)
            return { kind: 'success', text: `已把 ${matches.length} 个文件移入 _回收站。` }
          }

          case 'rescan': {
            const force = /^--force(?:\s|$)/.test(argument)
            const name = force ? argument.slice('--force'.length).trim() : argument
            const target = name === '' ? undefined : service.findKnowledgeBaseByName(name)
            if (name !== '' && target === undefined) {
              return { kind: 'error', text: `没有名为「${name}」的知识库。` }
            }
            try {
              await service.rescan(target?.id, { force })
            } catch {
              return { kind: 'error', text: '扫描未完成，请检查资料读取权限后重试。未完成库保留上次成功快照；扫描多个库时，先完成的库可能已更新。' }
            }
            const bases = target === undefined ? service.listKnowledgeBases() : [target]
            const files = bases.reduce((sum, base) => sum + service.listMaterials(base.id).length, 0)
            const items = bases.flatMap(base => {
              const report = service.getLastScanReport(base.id)
              return report === undefined ? [] : [{ name: base.name, report }]
            })
            return {
              kind: 'success',
              text: `已${force ? '强制重建' : '增量扫描'}：${bases.length} 个知识库、${files} 个文件。` +
                formatScanSummary(items.map(item => item.report)) + formatScanFailures(items),
            }
          }

          case 'use': {
            const wanted = argument.trim()
            if (wanted === '关闭' || wanted === 'off') {
              await selection.set(agentId, { enabled: false, scope: 'all' })
              return { kind: 'success', text: '本会话已关闭知识库。' }
            }
            if (wanted === '全部' || wanted === 'all') {
              await selection.set(agentId, { enabled: true, scope: 'all' })
              return { kind: 'success', text: '本会话使用全部知识库。' }
            }
            // A list, so the command can express everything the picker can:
            // half-width and full-width commas both, because a Chinese keyboard
            // produces the latter without the user noticing which they typed.
            const names = wanted
              .split(/[,，]/)
              .map(name => name.trim())
              .filter(name => name !== '')
            const targets: { id: string; name: string }[] = []
            for (const name of names) {
              const target = service.findKnowledgeBaseByName(name)
              if (target === undefined) return { kind: 'error', text: `没有名为「${name}」的知识库。` }
              targets.push({ id: target.id, name: target.name })
            }
            if (targets.length === 0) {
              return { kind: 'error', text: '用法：/kb use <库名>[,<库名>…] | 全部 | 关闭' }
            }
            await selection.set(agentId, { enabled: true, scope: targets.map(t => t.id) })
            return {
              kind: 'success',
              text: `本会话只使用：${targets.map(t => t.name).join('、')}。`,
            }
          }

          case 'search': {
            if (argument === '') return { kind: 'error', text: '用法：/kb search <问题>' }
            // Resolved before the call so the three ways a selection can come up
            // empty each get their own sentence. `service.retrieve` only ever
            // sees a non-empty id list.
            const scope = resolveScope(selection.get(agentId), service)
            switch (scope.kind) {
              case 'disabled':
                return { kind: 'error', text: '本会话尚未开启知识库。先用 /kb use <库名|全部>。' }
              case 'nothing-selected':
                return {
                  kind: 'error',
                  text: '本会话已开启知识库，但一个库都没有勾选。请在输入区的面板里勾选，或用 /kb use <库名|全部>。',
                }
              case 'no-bases':
                return { kind: 'success', text: '还没有知识库。用 /kb create <名称> 新建一个。' }
              case 'bases':
                return {
                  kind: 'success',
                  text: describeOutcome(service.retrieve(argument, scope.ids)),
                }
            }
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

/** Human-readable file size. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
