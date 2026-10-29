/**
 * dsh-knowbase — browser half.
 *
 * Mounts the Remote contribution, then registers the plugin's seats: the
 * knowledge base page (a sidebar row plus the centre panel it opens), the
 * composer control and the per-answer source button. `/kb` exists only because
 * the Host half had to be provable before any of this could be built.
 *
 * The bundle is emitted as a lazy-CJS factory registered on
 * `window.__ModuleLoader__` (see `tsdown.config.ts`); `react` and
 * `@deepseek-ai/*` stay external so the host's single React copy is reused.
 *
 * @module @domitor-syh/dsh-knowbase/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only pulls: these packages augment `SlotMap` by declaration merging, and
// an augmentation only applies when its module is loaded by the type-check
// program. `verbatimModuleSyntax` erases every one of them at emit, so the
// shipped bundle still imports nothing from the host beyond what `inject` names.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  createKnowbaseApi,
  knowbaseApi,
  knowbaseChannelError,
  setChannelError,
  setKnowbaseApi,
} from './api.ts'
import { KnowbaseSourceAction, KnowbaseSourceOverlay } from './citation-button.tsx'
import { closeSources } from './citation-dialog.ts'
import { installCitationLocale } from './citation-locale.ts'
import { ComposerKnowbaseToggle } from './composer-toggle.tsx'
import { TYPERT_REMOTE } from './contribution.ts'
import { KnowbasePanel, KnowbasePanelIcon, PANEL_ID } from './panel.tsx'
import { ProposalInbox } from './proposal-inbox.tsx'
import { installPageStyle } from './page-style.ts'
import { installSourceStyle } from './source-style.ts'
import { installReader } from './reader.ts'
import { installTheme } from './theme.ts'
import { installStatisticsSettings } from './statistics-settings.tsx'

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

  installCitationLocale(ctx)
  ctx.effect(() => () => closeSources())
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'knowbase-citations', order: 40 }, KnowbaseSourceOverlay),
  )

  // Follow the host's colour scheme before anything paints. Acquired through the
  // dynamic `ctx.inject` rather than the static list above on purpose: a host
  // without a `theme` service must leave the plugin on its light palette, not
  // park the whole client half waiting for a service that will never arrive.
  installTheme(ctx)

  // The page's stylesheet, injected once. In `apply` rather than from the page
  // component so the rules are in place before the first paint: a page that
  // renders unstyled for one frame and then jumps reads as a host bug.
  installPageStyle()
  installSourceStyle(ctx)
  installStatisticsSettings(ctx)

  // The material reader: a tab type in the host's right column, so a citation
  // opens the source beside the answer instead of in a modal over it.
  installReader(ctx)

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

  // The knowledge base page. Two seats, one id: the sidebar row the user clicks
  // and the centre panel it opens. The host wires the row's click straight to
  // `layout.selectPanel(id)`, so the panel must exist under the same key or the
  // click throws — the pair is not optional, which is why both registrations
  // sit here together rather than in separate places.
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, KnowbasePanel),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 11, label: () => '知识库' },
      KnowbasePanelIcon,
    ),
  )

  // The composer control — the switch that makes the feature reachable without
  // knowing `/kb` exists. `conversation.input.left` is a list slot, so this
  // sits beside the host's own compact controls instead of shadowing any of
  // them. The inject face hands the component the session id, which is the
  // identifier the Host keys every selection by.
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'knowbase',
        order: 40,
        inject: (sessionId: string) => ({ sessionId }),
      },
      ComposerKnowbaseToggle,
    ),
  )

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'knowbase-proposals',
        order: 45,
        inject: (sessionId: string) => ({ sessionId }),
      },
      ProposalInbox,
    ),
  )

  // buttons use. The markdown pipeline cannot turn `[1]` markers into links,
  // so the panel opens from here instead: the component scans the chat
  // snapshot for this plugin's evidence node and renders a button only when
  // the turn actually carried passages.
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'knowbase-sources', order: 50 },
      KnowbaseSourceAction,
    ),
  )
}
