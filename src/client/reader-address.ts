/**
 * The `dsh-resource://knowbase/…` address grammar and its navigation parameters.
 *
 * ## Why the address carries no chunk number
 *
 * The host's tab system keys a resource tab by its whole address — two opens of
 * the same address are the same tab, which is what makes opening idempotent.
 * Putting the chunk in the address would therefore give one tab per passage,
 * which is the opposite of what a reader is for. The address names the
 * *material*; the passage to land on rides in the opener's `params`, and the
 * body re-acts on `navigation.revision` when the same material is opened again
 * at a different passage.
 *
 * ## Why the params map is augmented here
 *
 * `SidebarRightResourceParamsMap` is keyed by resource type — the segment after
 * `dsh-resource://` — and the package that owns that type is the one expected to
 * fill it. `knowbase` is ours, so this is where `knowbase: { chunk? }` is
 * declared. Nothing validates params at runtime (caller and body meet at a
 * typed same-process boundary), so the reader still narrows what it reads.
 *
 * @module @domitor-syh/dsh-knowbase/client/reader-address
 */

// A `declare module` augmentation only applies once the augmented module is part
// of the type program, so it is pulled in here. `verbatimModuleSyntax` erases
// this line at emit — the shipped bundle still imports nothing new.
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** Navigation parameters for a `dsh-resource://knowbase/…` address. */
    knowbase: {
      /** Chunk ordinal to scroll to and highlight; absent opens at the top. */
      readonly chunk?: number
      /**
       * The material's title, as the opener already knew it.
       *
       * The registry's `title(address)` is synchronous and only sees the
       * address, so the tab chip has nothing to show until the body has loaded
       * the material — and a chip that says `资料 3f2a1b` for a second is a chip
       * that looks broken. The citation knows the title already, so it carries
       * it. Restored tabs have no params; those fall back to the loaded title.
       */
      readonly title?: string
    }
  }
}

/**
 * What a `dsh-resource://knowbase/…` address resolves to.
 *
 * `ResourceProtocolMap` is the declaration-merged roster of protocol to value
 * type, and the package that owns a protocol is the one expected to fill its
 * member (`dsh-client-resources` says so in as many words). Declaring it is what
 * makes `useResource<'knowbase'>(address)` typed rather than `unknown` — and it
 * is a promise about what the provider yields, so
 * {@link knowbaseResourceOfAddress} is the only thing that builds one.
 */
export interface KnowbaseMaterialResource {
  /** Discriminator, so a frame's value is identifiable without the address. */
  readonly kind: 'knowbase-material'
  /** The address this value belongs to. */
  readonly address: string
  /** Owning knowledge base. */
  readonly kbId: string
  /** The material itself. */
  readonly materialId: string
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** One knowledge-base material, named by a `dsh-resource://knowbase/…` address. */
    knowbase: KnowbaseMaterialResource
  }
}

/** Scheme and type every reader address opens with. */
const READER_PREFIX = 'dsh-resource://knowbase/'

/** Address of one material inside one knowledge base. */
export function readerAddress(kbId: string, materialId: string): string {
  return `${READER_PREFIX}${encodeURIComponent(kbId)}/${encodeURIComponent(materialId)}`
}

/**
 * The resource value for one address, or `undefined` when it is not a reader
 * address.
 *
 * The resource provider's whole job: it validates the address and names the
 * material. The material's *text* is not in here on purpose — see the module doc
 * of `reader.ts` for why the content travels over the typed Remote instead.
 */
export function knowbaseResourceOfAddress(address: string): KnowbaseMaterialResource | undefined {
  const parts = parseReaderAddress(address)
  if (parts === undefined) return undefined
  return { kind: 'knowbase-material', address, kbId: parts.kbId, materialId: parts.materialId }
}

/** The two ids an address names, or `undefined` when it is not a reader address. */
export function parseReaderAddress(
  address: string,
): { readonly kbId: string; readonly materialId: string } | undefined {
  if (!address.startsWith(READER_PREFIX)) return undefined
  // A query or fragment is not part of the identity the tab system keys on, but
  // tolerating one costs nothing and keeps a hand-typed address working.
  const end = address.search(/[?#]/)
  const body = end === -1 ? address.slice(READER_PREFIX.length) : address.slice(READER_PREFIX.length, end)
  const slash = body.indexOf('/')
  if (slash <= 0) return undefined
  const kbId = decodeSegment(body.slice(0, slash))
  const materialId = decodeSegment(body.slice(slash + 1))
  if (kbId === undefined || materialId === undefined) return undefined
  return { kbId, materialId }
}

/** Decode one path segment, rejecting an empty one or malformed percent-encoding. */
function decodeSegment(segment: string): string | undefined {
  if (segment === '' || segment.includes('/')) return undefined
  try {
    const decoded = decodeURIComponent(segment)
    return decoded === '' ? undefined : decoded
  } catch {
    return undefined
  }
}

/**
 * The chunk ordinal a navigation asked for, if it asked for one.
 *
 * `params` crosses an untyped boundary, so this narrows rather than trusts:
 * a body that lands on a hand-written or future param shape opens at the top
 * instead of throwing.
 */
export function chunkOfParams(params: unknown): number | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const chunk = (params as { chunk?: unknown }).chunk
  return typeof chunk === 'number' && Number.isSafeInteger(chunk) && chunk >= 0 ? chunk : undefined
}

/** The title the opener carried, if it carried a usable one. */
export function titleOfParams(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const title = (params as { title?: unknown }).title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

/**
 * The chip's text when nothing better is known.
 *
 * Captured into the layout record at open time, so it is also what a restored
 * tab shows for the instant before its body loads. Deliberately short and
 * obviously provisional: a truncated id reads as "not loaded yet", where an
 * empty chip reads as a bug.
 */
export function provisionalTitle(address: string): string {
  const parts = parseReaderAddress(address)
  if (parts === undefined) return '知识库资料'
  return `资料 ${parts.materialId.slice(0, 6)}`
}
