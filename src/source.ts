/**
 * Plugin-owned conversation message source.
 *
 * `MessageSourceMap` is merge-extensible on 0.2.0-rc.2, which is what lets a
 * plugin attribute a message it injects to itself instead of impersonating the
 * user. `@deepseek-ai/dsh-time-context` is the shipped precedent for this
 * pattern.
 *
 * This declaration is type-only and erased at build time; it is picked up
 * because `tsconfig.json` includes `src/**\/*.ts`.
 *
 * @module @domitor-syh/dsh-knowbase/source
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Retrieved knowledge-base evidence attached to the current turn. */
    knowbase: { kind: 'knowbase' } & ContextFormed
  }
}
