/**
 * dsh-knowbase — Host half.
 *
 * Native, local-first knowledge base for DeepSeek Harness: materials are stored
 * locally, retrieved with Chinese n-gram BM25, and the hits are attached to the
 * model request as plugin-sourced evidence.
 *
 * ## Shape
 *
 * - `./store.ts`     persistence through the host's `storageDomain`
 * - `./core/*`       chunking, BM25 and the domain logic — host-free and tested
 * - `./pre-step.ts`  the `agent/pre-step` waterfall that attaches evidence
 * - `./commands.ts`  the `/kb` surface
 *
 * ## Why `inject` is empty
 *
 * A name in `inject` that no build provides parks the whole host half in
 * "pending" forever: no apply, no error, nothing in any log. `agent/pre-step`
 * is an EVENT and needs no service at all, and both services this plugin does
 * need are acquired with `ctx.inject([...], scope => ...)`, so a host without
 * one of them loses a feature instead of losing the plugin.
 *
 * @module @domitor-syh/dsh-knowbase
 */

import type { Context } from '@deepseek-ai/cordis'
import { installCommands } from './commands.ts'
import { resolveScope, SessionSelectionRegistry } from './core/session-scope.ts'
import { KnowbaseService } from './core/service.ts'
import { installPreStep, queryFrom } from './pre-step.ts'
import { KnowbaseRemote } from './remote.ts'
import { openSessionScopeStore, openStorageDomainStore, type OpenedSessionStore } from './store.ts'

export const name = 'knowbase'

/** Required host services — see the module note above before adding a name. */
export const inject: string[] = []

export function apply(ctx: Context): void {
  console.info('[knowbase] host half loaded')

  const selection = new SessionSelectionRegistry()
  let service: KnowbaseService | undefined
  let disposed = false

  // The retrieval seam. It exists from the first moment and answers `not_ready`
  // until storage finishes opening, so a turn that arrives during startup
  // degrades honestly instead of failing.
  installPreStep(ctx, {
    retrieve: async payload => {
      const current = service
      if (current === undefined) return { kind: 'not_ready' }

      const scope = resolveScope(selection.get(payload.agent.id), current)
      if (scope === null) return { kind: 'disabled' }

      const query = queryFrom(payload.messages)
      if (query === '') return { kind: 'no_match' }

      return current.retrieve(query, scope)
    },
  })

  // Commands are registered as soon as the host offers the service; until
  // storage is ready they answer with "still initializing" rather than being
  // undiscoverable.
  ctx.inject(['commands'], commandScope => {
    installCommands(commandScope, { service: () => service, selection })
  })

  ctx.inject(['storageDomain'], storageScope => {
    void (async () => {
      try {
        const opened = await openStorageDomainStore(storageScope.storageDomain)

        // The session selections open separately so the knowledge domain keeps
        // its version-1 schema (see `./store.ts`). If the second open fails,
        // release the first rather than leaking an open unit nobody will close.
        let openedScopes: OpenedSessionStore
        try {
          openedScopes = await openSessionScopeStore(storageScope.storageDomain)
        } catch (error) {
          await opened.close()
          throw error
        }

        if (disposed) {
          // The plugin was disabled while storage was still opening; release
          // both units rather than leaking what nobody will close.
          await opened.close()
          await openedScopes.close()
          return
        }

        const ready = new KnowbaseService(opened.store)
        await ready.initialize()
        service = ready
        await selection.useStore(openedScopes.store)

        // Publishing the Remote service is what makes the settings page able to
        // reach the Host at all. It is created only once storage is open, so a
        // call that arrives earlier fails loudly instead of reading a service
        // that has nothing behind it.
        new KnowbaseRemote(ctx, ready, selection)

        ctx.effect(() => () => {
          void opened.close()
          void openedScopes.close()
        })

        const bases = ready.listKnowledgeBases()
        const materials = ready.listMaterials()
        console.info(
          `[knowbase] 已加载 ${bases.length} 个知识库、${materials.length} 份资料`,
        )
      } catch (error) {
        console.error('[knowbase] 知识库存储初始化失败：', error)
      }
    })()
  })

  ctx.effect(() => () => {
    disposed = true
    service = undefined
    console.info('[knowbase] host half disposed')
  })
}
