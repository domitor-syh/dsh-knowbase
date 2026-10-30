/**
 * The page's inline icons.
 *
 * Drawn rather than imported: the host's icon set lives in
 * `@deepseek-ai/dsh-client-ui-primitives`, and the page needs fourteen glyphs —
 * not worth a runtime dependency, and the bundle contract forbids one anyway.
 * Paths follow the Lucide icon set, drawn at
 * `stroke-width: 1.5` on a 24-unit grid so they sit at the same weight as the
 * host's own chrome.
 *
 * @module @domitor-syh/dsh-knowbase/client/icons
 */

import * as React from 'react'

/** Every glyph the page draws, by the hand-off's own names. */
const PATHS = {
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'alert-triangle':
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'skip-circle': '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'more-horizontal':
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'folder-open':
    '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
  'knowledge-base':
    '<path d="M12 6C9.5 4.5 6.5 4 3 4v14c3.5 0 6.5.5 9 2"/><path d="M12 6c2.5-1.5 5.5-2 9-2v14c-3.5 0-6.5.5-9 2"/><path d="M12 6v14"/>',
} as const

/** One icon name. */
export type IconName = keyof typeof PATHS

/**
 * Render one icon.
 *
 * `dangerouslySetInnerHTML` rather than JSX children: the paths are a frozen
 * literal table in this file, never user input, and writing fourteen icons as
 * JSX would be fourteen opportunities to mistype a coordinate.
 *
 * `spinning` is for the three buttons that re-read something from the disk. The
 * class it adds is the whole animation; what keeps it up long enough to be seen
 * is `useSpin` (`./spin.ts`).
 */
export function Icon(props: {
  name: IconName
  size?: number
  spinning?: boolean
}): React.ReactElement {
  return (
    <svg
      className={props.spinning === true ? 'kb-icon-spin' : undefined}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: PATHS[props.name] }}
    />
  )
}
