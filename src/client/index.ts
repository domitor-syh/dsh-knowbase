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
import { createKnowbaseApi, setKnowbaseApi } from './api.ts'
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

  void ctx.remote
    .$mount(TYPERT_REMOTE)
    .then(() => {
      setKnowbaseApi(createKnowbaseApi(ctx))
      console.info('[knowbase] remote channel mounted')
    })
    .catch((error: unknown) => {
      // Without the channel the page can only render its empty state, so this
      // failure has to be visible rather than silent.
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
