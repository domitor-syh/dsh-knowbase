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

/** Read the ordered nodes of a chat snapshot, or `undefined` when unusable. */
function orderedNodes(
  chat: unknown,
): ReadonlyArray<readonly [string, unknown]> | undefined {
  if (typeof chat !== 'object' || chat === null) return undefined
  const order = (chat as { order?: unknown }).order
  const nodes = (chat as { nodes?: unknown }).nodes
  if (!Array.isArray(order) || typeof (nodes as Map<string, unknown>)?.get !== 'function') {
    return undefined
  }
  return order.map(key => [key, (nodes as Map<string, unknown>).get(key)] as const)
}

/**
 * The 1-based turn a finalized assistant message belongs to.
 *
 * `assistant-actions` fires once per settled turn with its closing message id;
 * the closing assistant node carries it in `data.finalNode.messageId`.
 */
export function turnForMessageId(chat: unknown, messageId: string): number | undefined {
  for (const [, node] of orderedNodes(chat) ?? []) {
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
 * Every knowledge-base passage attached to one turn's context nodes.
 *
 * Empty when the turn has none — including turns answered before the plugin
 * started carrying passages in the source payload.
 */
export function passagesOfTurn(chat: unknown, turn: number): readonly SourcePassage[] {
  const result: SourcePassage[] = []
  for (const [, node] of orderedNodes(chat) ?? []) {
    if (turnNoOf((node as { location?: unknown }).location) !== turn) continue
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