/**
 * Plugin-owned conversation message source.
 *
 * `MessageSourceMap` is merge-extensible on 0.2.0-rc.2, which is what lets a
 * plugin attribute a message it injects to itself instead of impersonating the
 * user. `@deepseek-ai/dsh-time-context` is the shipped precedent for this
 * pattern.
 *
 * The optional `passages` payload rides along so the browser half can render a
 * per-answer source panel without parsing the evidence text: the same data the
 * model sees as `[1] …` markers, structured, frozen with the message and
 * persisted with the transcript. Absent on messages written before this field
 * existed — those answers simply offer no source panel.
 *
 * This declaration is type-only and erased at build time; it is picked up
 * because `tsconfig.json` includes `src/**\/*.ts`.
 *
 * @module @domitor-syh/dsh-knowbase/source
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { RetrievedPassage } from './pre-step.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Retrieved knowledge-base evidence attached to the current turn. */
    knowbase: {
      kind: 'knowbase'
      /** The passages behind the `[1] …` markers, for the client's source panel. */
      readonly passages?: readonly RetrievedPassage[]
    } & ContextFormed
  }
}
