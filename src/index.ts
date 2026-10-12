/**
 * dsh-knowbase — Host half.
 *
 * Native, local-first knowledge base for DeepSeek Harness. This file is
 * deliberately a skeleton: it loads, declares its identity, and holds the
 * extension points the real implementation will fill in. Nothing here reads,
 * writes, indexes or retrieves anything yet.
 *
 * ## How the conversation half is meant to work (verified against 0.2.0-rc.2)
 *
 * `agent/pre-step` is a waterfall dispatched on every proposed step, after
 * `systemPrompt.assemble()` has already run and before the model request is
 * made. Its decision shape is
 * `{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`, so
 * retrieval results ride along by appending a plugin-owned `UserMessage` to the
 * messages `next()` handed back — no host core change, no DOM injection.
 *
 * The plugin declares its own message source kind (see `./source.ts`) so the
 * evidence message is attributed to the knowledge base instead of masquerading
 * as the user's own words.
 *
 * ## Why `inject` is empty
 *
 * A name in `inject` that no build provides parks the whole host half in
 * "pending" forever: no apply, no error, nothing in any log. Every service this
 * plugin needs is therefore acquired as late as possible, and named here only
 * once the exact service id has been observed on the target host.
 *
 * @module @domitor-syh/dsh-knowbase
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'knowbase'

/** Required host services — see the module note above before adding a name. */
export const inject: string[] = []

export function apply(ctx: Context): void {
  console.info('[knowbase] host half loaded')

  ctx.effect(() => () => {
    console.info('[knowbase] host half disposed')
  })
}
