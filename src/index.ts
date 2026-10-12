/**
 * dsh-knowbase — Host half.
 *
 * Native, local-first knowledge base for DeepSeek Harness. Retrieval itself is
 * not implemented yet; what exists is the seam it will plug into, wired and
 * verified against the real host so the risky part is settled before any
 * storage or ranking code is written.
 *
 * ## The conversation half
 *
 * `agent/pre-step` is a waterfall dispatched after `systemPrompt.assemble()`
 * and before the model request. Its decision is
 * `{ kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }`, so
 * retrieval results ride along by appending a plugin-owned `UserMessage` to the
 * messages `next()` handed back — no host core change, no DOM injection, no
 * dependence on prompt-assembly timing. See `./pre-step.ts` for the contract
 * and `./source.ts` for how the message is attributed to this plugin.
 *
 * ## Why `inject` is empty
 *
 * A name in `inject` that no build provides parks the whole host half in
 * "pending" forever: no apply, no error, nothing in any log. `agent/pre-step`
 * is an EVENT, not a service, so it needs no entry here at all. Every service
 * this plugin eventually needs (storage, web) will be acquired dynamically with
 * `ctx.inject([...], scope => ...)` so a missing one degrades a feature instead
 * of killing the plugin.
 *
 * @module @domitor-syh/dsh-knowbase
 */

import type { Context } from '@deepseek-ai/cordis'
import { installPreStep, type RetrievalOutcome } from './pre-step.ts'

export const name = 'knowbase'

/** Required host services — see the module note above before adding a name. */
export const inject: string[] = []

/**
 * Self-test retrieval, enabled with `DSH_KNOWBASE_SELFTEST=1`.
 *
 * Exists so the injection path can be proven end-to-end against a live host
 * before any index exists: it returns one fixed passage, which must then show
 * up in the conversation as plugin-sourced evidence. Off by default, because a
 * plugin that injects a fake passage into every turn by default would be a bug
 * pretending to be a feature.
 */
function selfTestRetrieve(): Promise<RetrievalOutcome> {
  return Promise.resolve({
    kind: 'hits',
    passages: [
      {
        kbName: '自检库',
        materialTitle: 'pre-step 注入自检',
        locator: '固定片段',
        text: '这是 dsh-knowbase 的 pre-step 注入自检片段。看到它说明插件已成功在模型请求前注入了证据消息。',
      },
    ],
  })
}

export function apply(ctx: Context): void {
  console.info('[knowbase] host half loaded')

  const selfTest = process.env.DSH_KNOWBASE_SELFTEST === '1'
  if (selfTest) console.info('[knowbase] 自检模式已开启：每轮都会注入一条测试证据')

  installPreStep(ctx, {
    retrieve: async () => (selfTest ? selfTestRetrieve() : { kind: 'no_match' }),
  })

  ctx.effect(() => () => {
    console.info('[knowbase] host half disposed')
  })
}
