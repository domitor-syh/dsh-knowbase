/**
 * Scanning the chat snapshot for this plugin's evidence nodes.
 *
 * The `assistant-actions` seat hands the component a message id; locating the
 * turn's knowledge-base evidence means walking the chat snapshot's ordered
 * nodes. That walk is pure data in / data out, so it lives here where it can
 * be unit-tested, and the component only renders the result.
 *
 * The snapshot shape (`order` + `nodes` map, `location.turn`, `data.source`)
 * is read defensively — `unknown` everywhere with runtime narrowing — because
 * the chat package publishes these nodes as loose views and the plugin must
 * degrade to "no panel" rather than throw on any shape it did not expect.
 *
 * @module @domitor-syh/dsh-knowbase/client/citation-scan
 */

import type { RetrievedPassage } from '../pre-step.ts'

/** The passages as they ride inside a knowbase message source. */
export type SourcePassage = Readonly<{
  kbName: string
  materialTitle: string
  locator: string
  text: string
}>

/** The turn number from a node's location (object form or bare number). */
export function turnNoOf(location: unknown): number | undefined {
  const turn = (location as { turn?: unknown } | undefined)?.turn
  const n =
    turn !== null && typeof turn === 'object'
      ? (turn as { turn?: unknown }).turn
      : turn
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? n : undefined
}

/**
 * Every node the snapshot holds, visible or not.
 *
 * The snapshot exposes two views: `order`, the *visible* transcript order, and
 * `nodes`, the full keyed store. Reading only `order` is why the panel never
 * appeared: the host hides plain injected-context rows from the transcript
 * (`buildViewNode`'s visibility rule keeps a `context` node only when it carries
 * tool-addition/tool-removal blocks), so this plugin's evidence node — a text
 * context message — is absent from `order` while still present in `nodes`.
 *
 * `values()` is the published accessor (the empty snapshot declares it too);
 * the `order` + `get` route stays as a fallback for any snapshot that lacks it.
 */
function allNodes(chat: unknown): readonly unknown[] {
  if (typeof chat !== 'object' || chat === null) return []
  const nodes = (chat as { nodes?: unknown }).nodes
  if (nodes === null || nodes === undefined) return []

  const values = (nodes as { values?: unknown }).values
  if (typeof values === 'function') {
    const list = (values as () => unknown).call(nodes)
    if (Array.isArray(list)) return list
    if (list !== null && typeof list === 'object' && Symbol.iterator in (list as object)) {
      return [...(list as Iterable<unknown>)]
    }
  }

  const order = (chat as { order?: unknown }).order
  const get = (nodes as { get?: unknown }).get
  if (Array.isArray(order) && typeof get === 'function') {
    return order.map(key => (get as (key: string) => unknown).call(nodes, String(key)))
  }
  return []
}

/** Transcript position of a node, used to keep passage numbering stable. */
function seqOf(node: unknown): number {
  const seq = (node as { data?: { seq?: unknown } } | undefined)?.data?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : Number.MAX_SAFE_INTEGER
}

/**
 * The 1-based turn a finalized assistant message belongs to.
 *
 * `assistant-actions` fires once per settled turn with its closing message id;
 * the closing assistant node carries it in `data.finalNode.messageId`.
 */
export function turnForMessageId(chat: unknown, messageId: string): number | undefined {
  for (const node of allNodes(chat)) {
    if ((node as { kind?: unknown } | undefined)?.kind !== 'assistant-step') continue
    const finalNode = (node as { data?: { finalNode?: { messageId?: unknown } } }).data
      ?.finalNode
    if (
      finalNode !== null &&
      finalNode !== undefined &&
      finalNode.messageId === messageId
    ) {
      return turnNoOf((node as { location?: unknown }).location)
    }
  }
  return undefined
}

/**
 * Whether a node is one of this plugin's evidence nodes carrying passages.
 *
 * The node's `source` is erased to `unknown` on the client, so every field is
 * narrowed at runtime; a node that merely resembles the shape is not accepted.
 */
function passagesOfNode(node: unknown): readonly SourcePassage[] | undefined {
  if ((node as { kind?: unknown } | undefined)?.kind !== 'context') return undefined
  const source = (node as { data?: { source?: unknown } }).data?.source
  if (typeof source !== 'object' || source === null) return undefined
  if ((source as { kind?: unknown }).kind !== 'knowbase') return undefined
  const passages = (source as { passages?: unknown }).passages
  if (!Array.isArray(passages)) return undefined

  const cleaned: SourcePassage[] = []
  for (const passage of passages) {
    if (typeof passage !== 'object' || passage === null) continue
    const kbName = (passage as { kbName?: unknown }).kbName
    const materialTitle = (passage as { materialTitle?: unknown }).materialTitle
    const locator = (passage as { locator?: unknown }).locator
    const text = (passage as { text?: unknown }).text
    if (
      typeof kbName !== 'string' ||
      typeof materialTitle !== 'string' ||
      typeof locator !== 'string' ||
      typeof text !== 'string'
    ) {
      continue
    }
    cleaned.push({ kbName, materialTitle, locator, text })
  }
  return cleaned
}

/**
 * Every knowledge-base passage attached to one turn's context nodes, in
 * transcript order so the numbering matches the answer's `[n]` markers.
 *
 * Empty when the turn has none — including turns answered before the plugin
 * started carrying passages in the source payload.
 */
export function passagesOfTurn(chat: unknown, turn: number): readonly SourcePassage[] {
  const matched: unknown[] = []
  for (const node of allNodes(chat)) {
    if (turnNoOf((node as { location?: unknown }).location) !== turn) continue
    if (passagesOfNode(node) === undefined) continue
    matched.push(node)
  }
  matched.sort((left, right) => seqOf(left) - seqOf(right))

  const result: SourcePassage[] = []
  for (const node of matched) {
    const passages = passagesOfNode(node)
    if (passages !== undefined) result.push(...passages)
  }
  return result
}

/**
 * The passages behind one answer, resolved from its closing message id.
 *
 * The single entry point the assistant-action component uses. Narrowed to the
 * view type the panel renders.
 */
export function passagesForAnswer(chat: unknown, messageId: string): readonly SourcePassage[] {
  const turn = turnForMessageId(chat, messageId)
  if (turn === undefined) return []
  return passagesOfTurn(chat, turn)
}

/** Re-export for the panel's prop typing; keeps one shape across the plugin. */
export type CitationPassage = RetrievedPassage