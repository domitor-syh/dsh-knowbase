import type { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import { StatisticsPanel } from './statistics-panel.tsx'

/** Current live Plugin Manager contract; the project's older SDK lacks this slot. */
interface BundleConfigSlots {
  inject(name: 'plugins.bundle.config', effect: () => () => void): () => void
  register(options: { name: 'plugins.bundle.config'; key: string }, component: typeof KnowbaseDiagnostics): () => void
}

/** Diagnostics belong to plugin details, not the everyday document manager. */
export function KnowbaseDiagnostics({ view }: { readonly view: 'summary' | 'page' }): React.ReactElement | null {
  return view === 'page' ? <StatisticsPanel /> : null
}

export function installStatisticsSettings(ctx: Context): void {
  // Inspected plugins.bundle.config: keyed, root scope, owner view=summary|page.
  // Wait on its declaration; no static dependency on Plugin Manager is needed.
  const slots = ctx.slots as unknown as BundleConfigSlots
  slots.inject('plugins.bundle.config', () => slots.register(
    { name: 'plugins.bundle.config', key: '@domitor-syh/dsh-knowbase' },
    KnowbaseDiagnostics,
  ))
}
