/**
 * Installing the material reader into the host's right column.
 *
 * Three registrations, in the order the host's contracts require:
 *
 *   1. a `knowbase` resource protocol, so a `dsh-resource://knowbase/…` address
 *      is a real resource the host can pin;
 *   2. a tab type whose globs claim those addresses, with the `id` that the two
 *      keyed seats below are dispatched under;
 *   3. the body and title seats, keyed by that same `id`.
 *
 * ## Why the services are awaited rather than read once
 *
 * Measured on a live host: `sidebarRight` and `sidebarRightTabs` appear about
 * 510 ms *after* this plugin's client half is applied. A one-shot `ctx.get` at
 * apply time therefore reports them absent, which reads exactly like "this host
 * cannot do that" and is completely wrong. `ctx.inject` is the form that waits.
 *
 * `ctx.inject` also parks silently when a service never appears — the same
 * failure mode that made `remote.knowbase` need a bounded timeout — so the
 * registrations carry one too, and the reason is stored where the UI can show
 * it instead of a button that does nothing.
 *
 * ## What is deliberately absent
 *
 * The resource provider yields a metadata frame, not the material text. The
 * host's own `file` provider does the same (it yields a `stat`), and the reader
 * body needs `navigation.revision`-aware behaviour that a resource store does
 * not express, so the content travels over the plugin's typed Remote. The
 * provider exists so the address is well-formed to the host — pinned, with a
 * real status — not as the content channel.
 *
 * @module @domitor-syh/dsh-knowbase/client/reader
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only pulls: this package declares `ctx.sidebarRight` /
// `ctx.sidebarRightTabs` on the cordis Context and the two `sidebar.right.pane.*`
// seats on `SlotMap`, and a declaration merge only applies once its module is
// loaded by the type program. Erased at emit by `verbatimModuleSyntax`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { knowbaseResourceOfAddress, provisionalTitle, readerAddress } from './reader-address.ts'
import { ReaderPanel, ReaderTitle } from './reader-panel.tsx'

/** Resource type segment, and the key both the protocol and the params map use. */
const PROTOCOL = 'knowbase'
/** Tab type identity. Also the dispatch key of both keyed seats. */
const TAB_ID = 'knowbase-material'
/** Tab type discriminator. */
const TAB_KIND = 'knowbase-material'
/** How long to wait for the right-column services before saying so out loud. */
const AWAIT_MS = 15000

/** What the reader was asked to open. */
export interface ReaderTarget {
  readonly kbId: string
  readonly materialId: string
  /** Chunk ordinal to land on; absent opens at the top. */
  readonly chunk?: number
  /** Title the caller already knows, so the chip is right on the first frame. */
  readonly title?: string
}

let openTarget: ((target: ReaderTarget) => void) | undefined
let unavailable: string | undefined

/**
 * Why the reader cannot open anything, or `undefined` when it can.
 *
 * Surfaced by the citation panel: a source list whose "open" button silently
 * does nothing is the hardest kind of bug to report.
 */
export function readerUnavailableReason(): string | undefined {
  return openTarget === undefined ? (unavailable ?? '资料阅读器尚未就绪，请稍后重试。') : undefined
}

/**
 * Open one material in the right column.
 *
 * Re-opening the same material is idempotent at the tab level — the host keys a
 * resource tab by its address — and lands on the requested passage, because the
 * chunk rides in `params` and the body re-acts on `navigation.revision`.
 *
 * @param target - the material to open, and where to land in it.
 * @returns `undefined` on success, or a message explaining why nothing opened.
 */
export function openMaterialInReader(target: ReaderTarget): string | undefined {
  const open = openTarget
  if (open === undefined) return readerUnavailableReason()
  open(target)
  return undefined
}

/**
 * A malformed-address failure, without importing the protocol's error class.
 *
 * The protocol documents discrimination as "always by `code`, never by
 * `instanceof`", and `remoteErrorOf` identifies a failure by the structural
 * `isDSHRemoteError` marker — so a plain object satisfies the contract. The
 * class is not imported because the browser half deliberately requires nothing
 * beyond `react` and `react-dom`; adding a runtime `require` for
 * `@deepseek-ai/dsh-typert-protocol` to produce one diagnostic frame would
 * widen the bundle's module-table surface for no user-visible gain.
 */
function malformedAddress(address: string): { ok: false; error: never } {
  return {
    ok: false,
    error: {
      name: 'RemoteError',
      code: 'gateway/bad-request',
      message: `不是知识库资料地址：${address}`,
      details: {},
      isDSHRemoteError: true,
    },
  } as unknown as { ok: false; error: never }
}

/**
 * Register the reader with the host.
 *
 * @param ctx - the client root context.
 */
export function installReader(ctx: Context): void {
  const log = (line: string): void => {
    console.info(`[knowbase][reader] ${line}`)
  }

  ctx.inject(['resources'], scope => {
    scope.resources.register({
      protocol: PROTOCOL,
      // eslint-disable-next-line require-yield
      async *open(address: string, options: { signal: AbortSignal }) {
        const resource = knowbaseResourceOfAddress(address)
        if (resource === undefined) {
          // A failure is always a frame, never a throw: a throw inside the
          // stream is a programming error the host does not catch.
          yield malformedAddress(address)
          return
        }
        // A metadata frame, for the reason in the module doc: the host pins the
        // address and reports its status, and the body reads the text over the
        // Remote. Yielding content here would fetch every open twice.
        yield { ok: true as const, value: resource }
        // The material's content can change under an open tab (the editor in
        // the settings page writes it). Nothing here observes that, so the
        // stream ends after its first frame and the status stays `live` with
        // the last value — which is the contract for "ending the stream keeps
        // the last state".
        void options
      },
    })
    log(`resource protocol '${PROTOCOL}' registered`)
  })

  ctx.inject(['sidebarRightTabs', 'sidebarRight'], scope => {
    scope.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      title: provisionalTitle,
      // A `:` in the pattern matches the whole address, which is what a
      // `dsh-resource://` URI needs (see the tab registry's matcher).
      patterns: [`dsh-resource://${PROTOCOL}/**`],
    })

    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ReaderPanel as never),
    )
    scope.slots.inject('sidebar.right.pane.tab.title', () =>
      scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ReaderTitle as never),
    )

    openTarget = target => {
      scope.sidebarRight.openResource(readerAddress(target.kbId, target.materialId), {
        params: {
          ...(target.chunk === undefined ? {} : { chunk: target.chunk }),
          ...(target.title === undefined ? {} : { title: target.title }),
        },
      })
    }
    unavailable = undefined
    log('tab type and both keyed seats registered — reader ready')
  })

  globalThis.setTimeout(() => {
    if (openTarget !== undefined) return
    unavailable = `资料阅读器未能在 ${AWAIT_MS / 1000} 秒内就绪：宿主没有提供右侧栏服务（sidebarRight）。`
    console.warn(`[knowbase][reader] ${unavailable}`)
  }, AWAIT_MS)
}
