/**
 * The knowledge base's own page in the host's centre column.
 *
 * ## Why this seat
 *
 * The page used to be a `settings.section`, which put it behind the host's
 * settings shell. It now takes two slots the host reserves for exactly this
 * shape of feature — the same pair `client-ui-plugin-manager` and
 * `client-ui-schedule` use:
 *
 * - `sidebar.panellist` renders one row in the sidebar rail, beside 插件管理 and
 *   定时任务, ordered by `order`. The sidebar owns the button; clicking it calls
 *   `layout.selectPanel(id)`. That binding is the sidebar's, not ours, which is
 *   why the id and the main key must be the same string — see below.
 * - `main` (keyed) is the centre column. The host renders
 *   `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`, so
 *   only the selected key is mounted and a fresh key is an *added* seat, not a
 *   replacement of the shipped `conversation` one.
 *
 * ## The one thing that cannot be done
 *
 * A `sidebar.panellist` row whose click opened a modal of our own is not
 * possible: the host hard-wires that row's `onClick` to `selectPanel(id)`, and
 * `selectPanel` throws when no `main` panel carries the key. Icon and panel are
 * a pair, so `PANEL_ID` is shared and both registrations exist together.
 *
 * @module @domitor-syh/dsh-knowbase/client/panel
 */

import * as React from 'react'
import { KnowbasePage } from './knowbase-page.tsx'

/**
 * The id shared by the sidebar entry and the main panel it opens.
 *
 * One value, two registrations — see the module doc. Changing it here changes
 * both seats at once, which is the only way they can stay in step.
 */
export const PANEL_ID = 'knowbase'

/**
 * The sidebar row's glyph.
 *
 * Drawn here rather than imported: the host's icon set lives in
 * `@deepseek-ai/dsh-client-ui-primitives`, and one glyph is not worth a new
 * runtime dependency. `currentColor` lets the sidebar's own selected/unselected
 * styling reach it — the `active` share it passes is therefore unused, and that
 * is deliberate rather than an oversight.
 */
export function KnowbasePanelIcon(props: { size: number }): React.ReactElement {
  return (
    <svg
      data-kb-panel-icon
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 6.5C10 5 7.5 4.5 5 4.5v13c2.5 0 5 .5 7 2" />
      <path d="M12 6.5c2-1.5 4.5-2 7-2v13c-2.5 0-5 .5-7 2" />
      <path d="M12 6.5v13" />
    </svg>
  )
}

/**
 * The centre-column page.
 *
 * The frame gives this column a definite height, so the scroll container is
 * ours: the page must not grow the frame, it must scroll inside it. The width
 * cap and the centring belong to the page itself (`#kb-settings-page` carries
 * the hand-off's `max-width: 1320px`), so this wrapper adds nothing but the
 * height and the overflow — a second cap here would silently squeeze the
 * two-column layout the hand-off draws.
 */
export function KnowbasePanel(): React.ReactElement {
  return (
    <div data-kb-panel-page style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <KnowbasePage />
    </div>
  )
}
