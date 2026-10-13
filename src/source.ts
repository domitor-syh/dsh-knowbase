/**
 * Plugin-owned conversation message source.
 *
 * `MessageSourceMap` is merge-extensible on 0.2.0-rc.2, which is what lets a
 * plugin attribute a message it injects to itself instead of impersonating the
 * user. `@deepseek-ai/dsh-time-context` is the shipped precedent for this
 * pattern.
 *
 * The structured payload rides along so the browser half can render a
 * per-answer source panel and status badge without parsing the model-facing
 * text: the same data the model sees, structured, frozen with the message and
 * persisted with the transcript. `passages` is absent on messages written
 * before it existed — those answers simply offer no source panel.
 *
 * This declaration is type-only and erased at build time; it is picked up
 * because `tsconfig.json` includes `src/**\/*.ts`.
 *
 * @module @domitor-syh/dsh-knowbase/source
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { RetrievalStatus, RetrievedPassage } from './pre-step.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Retrieved knowledge-base evidence attached to the current turn. */
    knowbase: {
      kind: 'knowbase'
      /** The passages behind the `[1] …` markers, for the client's source panel. */
      readonly passages?: readonly RetrievedPassage[]
      /**
       * What the retrieval attempt produced, for the client's status badge.
       *
       * Separate from `passages` because the two answer different questions:
       * an empty `passages` says nothing about *why*, and 「未命中」,
       * 「还没有资料」 and 「检索暂不可用」 are three different things to tell a
       * user. Absent on messages written before this field existed.
       */
      readonly status?: RetrievalStatus
    } & ContextFormed
  }
}
