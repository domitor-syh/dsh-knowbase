/**
 * The palette the plugin's own surfaces paint with, per host colour scheme.
 *
 * The host owns theming. `ctx.theme.getTheme()` returns a snapshot whose
 * `active.colorScheme` is `'light'` or `'dark'`, and `theme/change` re-emits on
 * every preference switch, registry update, and OS scheme flip. Reading it is
 * what keeps the composer control and its popover looking like part of the app
 * instead of a hardcoded light widget dropped into a dark shell — the plugin
 * used to carry one set of light colours and simply looked wrong in dark.
 *
 * The dark values are the design hand-off's, sampled out of the mockups rather
 * than eyeballed. The light values defer to the host's own tokens, so they
 * follow whatever the app's light palette is — including a third-party theme's
 * alias overrides — instead of being a second opinion about what light means.
 * The accent is the design's in both schemes: it is the one colour the hand-off
 * states outright, and the host has no token that equals it.
 *
 * @module @domitor-syh/dsh-knowbase/client/theme
 */

import type { Context } from '@deepseek-ai/cordis'
import * as React from 'react'

export type ColorScheme = 'light' | 'dark'

/** Everything the composer control and its popover paint with. */
export interface Palette {
  /** The accent: enabled pill's border and text, and every switch that is on. */
  readonly accent: string
  /** A 10% accent wash behind the enabled pill — the mock's tinted fill. */
  readonly accentWash: string
  readonly panel: string
  readonly panelBorder: string
  readonly divider: string
  /** The search field's fill. */
  readonly field: string
  readonly fieldBorder: string
  readonly text: string
  readonly muted: string
  /** Switch track and knob when off, and the knob when on. */
  readonly trackOff: string
  readonly trackOffBorder: string
  readonly knobOn: string
  readonly knobOff: string
  readonly shadow: string
  /** The pill when nothing is selected: quieter than the accent, still legible. */
  readonly idleText: string
  readonly idleBorder: string
}

/**
 * Dark: the hand-off's values verbatim.
 *
 * Sampled from the mockups' pixels — the panel is `#24262c`, the hairline that
 * serves as both panel border and section divider is `#34373e`, the search
 * field is `#2a2d33`, the off switch is `#131315` inside a `#2e3336` outline.
 */
const DARK: Palette = {
  accent: '#4285f4',
  accentWash: 'rgba(66, 133, 244, 0.10)',
  panel: '#24262c',
  panelBorder: '#34373e',
  divider: '#34373e',
  field: '#2a2d33',
  fieldBorder: '#34373e',
  text: '#f2f4f7',
  muted: '#9aa1ac',
  trackOff: '#131315',
  trackOffBorder: '#2e3336',
  knobOn: '#ffffff',
  knobOff: '#2e3336',
  shadow: '0 10px 28px rgba(0, 0, 0, 0.55)',
  idleText: '#9aa1ab',
  idleBorder: '#35383f',
}

/**
 * Light: the host's tokens, with a fallback each.
 *
 * The fallbacks matter because a `var()` that resolves to nothing makes the
 * property invalid rather than inherited, so a host that ships without these
 * tokens would paint a transparent panel instead of a white one.
 */
const LIGHT: Palette = {
  accent: '#4285f4',
  accentWash: 'rgba(66, 133, 244, 0.10)',
  panel: 'var(--dsw-alias-bg-layer-2, #ffffff)',
  panelBorder: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  divider: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  field: 'var(--dsw-static-neutral-bluish-75, #f1f3f5)',
  fieldBorder: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  muted: 'var(--dsw-alias-label-tertiary, #979da6)',
  trackOff: 'var(--dsw-static-neutral-bluish-100, #ebeef2)',
  trackOffBorder: 'var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  knobOn: '#ffffff',
  knobOff: '#ffffff',
  shadow: '0 10px 28px rgba(15, 23, 42, 0.16)',
  idleText: 'var(--dsw-alias-label-tertiary, #979da6)',
  idleBorder: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
}

const PALETTES: Record<ColorScheme, Palette> = { light: LIGHT, dark: DARK }

/** The snapshot shape the host's `theme` service publishes. */
interface ThemeSnapshot {
  readonly active: { readonly colorScheme: 'light' | 'dark' }
}

interface ThemeService {
  getTheme(): ThemeSnapshot
}

interface ThemeScope {
  readonly theme?: ThemeService
  on?(name: string, listener: () => void): unknown
}

// Module-level, like `api.ts`: the seat components are constructed by the host
// and never receive the plugin context, so the scheme has to reach them through
// a module the plugin's own `apply` writes to.
let current: ColorScheme = 'light'
const listeners = new Set<() => void>()

function publish(next: ColorScheme): void {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

/** The palette for the scheme the host is currently painting with. */
export function palette(): Palette {
  return PALETTES[current]
}

/**
 * The palette as a React value, re-read whenever the host switches scheme.
 *
 * Subscribing per component rather than threading a prop is what lets an *open*
 * popover repaint the moment the preference changes: the portal it renders into
 * is outside every tree the host re-renders on a theme switch.
 */
export function usePalette(): Palette {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const listener = (): void => bump(count => count + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return PALETTES[current]
}

/**
 * Follow the host's colour scheme.
 *
 * `ctx.inject` parks silently when a service never appears, which is the wanted
 * behaviour here rather than a hazard: a host without a `theme` service keeps
 * the light palette instead of parking the whole client half, and a service
 * that arrives late simply repaints through `publish`.
 */
export function installTheme(ctx: Context): void {
  ctx.inject(['theme'], scope => {
    const theme = (scope as unknown as ThemeScope).theme
    if (theme === undefined) return
    const read = (): void => {
      const scheme = theme.getTheme().active.colorScheme
      publish(scheme === 'dark' ? 'dark' : 'light')
    }
    read()
    ;(scope as unknown as ThemeScope).on?.('theme/change', read)
  })
}
