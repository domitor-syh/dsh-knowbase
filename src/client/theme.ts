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
 * Composer surfaces use the host's neutral aliases in both schemes. Fallbacks
 * only apply when an older host does not provide a token. The accent remains
 * the existing blue used to communicate selection.
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
  /** The pill's hover/press fills — the host's own interaction washes. */
  readonly interactiveHover: string
  readonly interactiveActive: string
  /** The enabled pill's hover: the accent wash, deepened. */
  readonly accentWashHover: string
  /** The idle pill's hover: the border firms up and the label comes forward. */
  readonly idleBorderHover: string
  readonly idleTextHover: string
}

/** Host-owned neutral surfaces; selection accent and existing interaction washes remain. */
const DARK: Palette = {
  accent: '#4285f4',
  accentWash: 'rgba(66, 133, 244, 0.10)',
  panel: 'var(--dsw-alias-bg-layer-1, #2b2b2b)',
  panelBorder: 'var(--dsw-alias-border-l1, #3a3a3a)',
  divider: 'var(--dsw-alias-border-l1, #3a3a3a)',
  field: 'var(--dsw-alias-bg-layer-2, #333333)',
  fieldBorder: 'var(--dsw-alias-border-l1, #3a3a3a)',
  text: 'var(--dsw-alias-label-primary, #f2f2f2)',
  muted: 'var(--dsw-alias-label-secondary, #a0a0a0)',
  trackOff: 'var(--dsw-alias-bg-base, #212121)',
  trackOffBorder: 'var(--dsw-alias-border-l2, #444444)',
  knobOn: '#ffffff',
  knobOff: 'var(--dsw-alias-label-secondary, #a0a0a0)',
  shadow: '0 10px 28px rgba(0, 0, 0, 0.55)',
  idleText: '#9aa1ab',
  idleBorder: '#35383f',
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))',
  interactiveActive: 'var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.14))',
  accentWashHover: 'rgba(66, 133, 244, 0.18)',
  idleBorderHover: 'var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.16))',
  idleTextHover: 'var(--dsw-alias-label-secondary, #cfd3d6)',
}

/**
 * Light: the host's tokens, with a fallback each.
 *
 * The fallbacks matter because a `var()` that resolves to nothing makes the
 * property invalid rather than inherited, so a host that ships without these
 * tokens would paint a transparent panel instead of a white one.
 *
 * The off switch is the one place the hand-off cannot be copied literally. Its
 * dark reading is *recessed*: an interior darker than the panel, a hairline
 * lighter than the panel, a thumb the colour of that hairline. On white there is
 * nothing lighter than the panel to draw the frame with, so the translation
 * inverts — a near-white interior, a mid-grey frame, a solid grey thumb — which
 * is what keeps the state reading as the hand-off's 「粗线条框 + 小圆球」 rather
 * than as the filled light-grey pill it used to be.
 */
const LIGHT: Palette = {
  accent: '#4285f4',
  accentWash: 'rgba(66, 133, 244, 0.10)',
  panel: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  panelBorder: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  divider: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  field: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
  fieldBorder: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  text: 'var(--dsw-alias-label-primary, #0f1115)',
  muted: 'var(--dsw-alias-label-tertiary, #979da6)',
  trackOff: 'var(--dsw-static-neutral-bluish-50, #f9fafb)',
  trackOffBorder: 'var(--dsw-static-neutral-bluish-300, #cfd3d6)',
  knobOn: '#ffffff',
  knobOff: 'var(--dsw-static-neutral-bluish-400, #adb2b8)',
  shadow: '0 10px 28px rgba(15, 23, 42, 0.16)',
  idleText: 'var(--dsw-alias-label-tertiary, #979da6)',
  idleBorder: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10))',
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))',
  interactiveActive: 'var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, 0.10))',
  accentWashHover: 'rgba(66, 133, 244, 0.16)',
  idleBorderHover: 'var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  idleTextHover: 'var(--dsw-alias-label-secondary, #61666b)',
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
 * The scheme itself, for surfaces that carry their own tokens.
 *
 * The page is a stylesheet rather than a set of inline styles (see
 * `./page-style.ts`), so what it needs from here is not a palette object but the
 * answer to "which one", and the same subscription the palette hook uses.
 */
export function colorScheme(): ColorScheme {
  return current
}

/** The scheme as a React value, re-read whenever the host switches scheme. */
export function useColorScheme(): ColorScheme {
  const [, bump] = React.useState(0)
  React.useEffect(() => {
    const listener = (): void => bump(count => count + 1)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return current
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
