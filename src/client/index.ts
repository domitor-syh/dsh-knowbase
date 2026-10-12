/**
 * dsh-knowbase — browser half.
 *
 * Skeleton stage: registers one `settings.section` entry so the plugin is
 * visibly present in the host UI and the client half is proven to load, mount
 * and dispose. Document management, the conversation toggle and the retrieval
 * status badge are not wired yet.
 *
 * The bundle is emitted as a lazy-CJS factory registered on
 * `window.__ModuleLoader__` (see `tsdown.config.ts`); `react` and
 * `@deepseek-ai/*` stay external so the host's single React copy is reused
 * instead of shipping a second one.
 *
 * The two `import type {}` lines below are not dead imports: they pull in the
 * declaration merging that puts `ctx.slots` (`SlotRegistry`) on the cordis
 * `Context`, and that declares `settings.section` in `SlotMap`. Without them
 * the slot key is not a known key and the service is not a known service.
 *
 * @module @domitor-syh/dsh-knowbase/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import * as React from 'react'

export const name = 'knowbase'

/**
 * Required client services.
 *
 * The client loader builds this fiber's dependency set from THIS export —
 * `dsh.client.inject` in package.json only orders bundle arrival. A name here
 * that nothing provides parks the fiber in "pending" forever with no error, so
 * the list stays limited to what is actually used.
 */
export const inject = ['slots']

/**
 * The settings page. Placeholder body: it exists to prove the section mounts
 * and unmounts with the plugin, not to manage knowledge bases yet.
 *
 * Locale is deliberately not used yet — the nav label is a plain thunk, which
 * the shell re-reads on locale change. A proper locale namespace arrives with
 * the real UI.
 */
function KnowbaseSettingsSection(): React.ReactElement {
  return React.createElement(
    'div',
    { style: { padding: '16px' } },
    React.createElement('h2', { style: { margin: '0 0 8px' } }, '知识库'),
    React.createElement(
      'p',
      { style: { margin: 0, color: '#526176' } },
      '骨架阶段：设置分区已注册。资料管理、检索测试与对话选库尚未接入。',
    ),
  )
}

export function apply(ctx: Context): void {
  console.info('[knowbase] client half loaded')

  // `inject` waits for the slot to be declared by its owner (ui-settings), then
  // registers inside the declaring call. The contribution is disposed with this
  // fiber, so unloading the plugin removes the page.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'knowbase',
        order: 50,
        label: () => '知识库',
      },
      KnowbaseSettingsSection,
    ),
  )
}
