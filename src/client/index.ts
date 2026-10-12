/**
 * dsh-knowbase — browser half.
 *
 * Mounts the Remote contribution, then registers the settings section. The
 * section is the plugin's primary surface: `/kb` exists only because the Host
 * half had to be provable before any of this could be built.
 *
 * The bundle is emitted as a lazy-CJS factory registered on
 * `window.__ModuleLoader__` (see `tsdown.config.ts`); `react` and
 * `@deepseek-ai/*` stay external so the host's single React copy is reused.
 *
 * @module @domitor-syh/dsh-knowbase/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  createKnowbaseApi,
  knowbaseApi,
  knowbaseChannelError,
  setChannelError,
  setKnowbaseApi,
} from './api.ts'
import { TYPERT_REMOTE } from './contribution.ts'
import { KnowbaseSettingsPage } from './settings-page.tsx'

export const name = 'knowbase'

/**
 * Required client services.
 *
 * The client loader builds this fiber's dependency set from THIS export —
 * `dsh.client.inject` in package.json only orders bundle arrival. A name here
 * that nothing provides parks the fiber in "pending" forever with no error, so
 * the list stays limited to what is actually used.
 */
export const inject = ['slots', 'locale', 'remote']

export function apply(ctx: Context): void {
  console.info('[knowbase] client half loaded')

  // Reported before the mount attempt so a missing or unexpected `remote`
  // service is distinguishable from a `$mount` that ran and failed.
  const remote = (ctx as unknown as { remote?: { $mount?: unknown } }).remote
  console.info(
    '[knowbase] remote service:',
    remote === undefined ? 'absent' : `present, $mount=${typeof remote.$mount}`,
  )

  void ctx.remote
    .$mount(TYPERT_REMOTE)
    .then(() => {
      // Reading `remote.knowbase` requires it in the inject list — cordis
      // refuses `ctx.a.b` otherwise, with exactly that error. It cannot go in
      // the static list above: the namespace is created by this very mount, so
      // a static dependency would deadlock, the fiber waiting forever on a
      // service only its own `apply` could produce. Acquiring it here, after
      // the mount resolves, is the dynamic form of the same declaration.
      ctx.inject(['remote.knowbase'], scope => {
        setKnowbaseApi(createKnowbaseApi(scope))
        setChannelError(undefined)
        console.info('[knowbase] remote channel mounted')
      })

      // `ctx.inject` parks silently when the service never appears, which would
      // put us straight back to a page whose buttons do nothing with no
      // explanation. A bounded wait turns that into a visible failure.
      globalThis.setTimeout(() => {
        if (knowbaseApi() === undefined && knowbaseChannelError() === undefined) {
          setChannelError('已挂载 Remote 贡献，但 remote.knowbase 服务未出现（等待 5 秒超时）。')
        }
      }, 5000)
    })
    .catch((error: unknown) => {
      // Without the channel the page can only render its empty state, so this
      // failure is both logged and shown in the page.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      setChannelError(detail)
      console.error('[knowbase] remote channel failed to mount:', error)
    })

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'knowbase',
        order: 50,
        label: () => '知识库',
      },
      KnowbaseSettingsPage,
    ),
  )
}
