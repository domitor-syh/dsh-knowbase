/**
 * Scanning the chat snapshot for this plugin's message nodes.
 *
 * The `assistant-actions` seat hands the component a message id; locating the
 * turn's knowledge-base node means walking the chat snapshot's node store. That
 * walk is pure data in / data out, so it lives here where it can be
 * unit-tested, and the component only renders the result.
 *
 * The snapshot shape (`order` + `nodes` map, `location.turn`, `data.source`)
 * is read defensively — `unknown` everywhere with runtime narrowing — because
 * the chat package publishes these nodes as loose views and the plugin must
 * degrade to "nothing to show" rather than throw on any shape it did not
 * expect.
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
  /**
   * Identity of the material, present only on answers produced after the
   * reader existed.
   *
   * Optional rather than required on purpose: `readPassage` drops anything it
   * cannot narrow, so making these required would silently empty the source
   * panel of every older answer. Absent ids cost the reader action and nothing
   * else.
   */
  kbId?: string
  materialId?: string
  /** Chunk position inside the material — where the reader lands. */
  ordinal?: number
}>

/** The retrieval status as it rides inside a knowbase message source. */
export type SourceStatus = Readonly<{
  outcome: string
  passageCount: number
  reason: string
}>

/**
 * What one answer's knowledge-base node says.
 *
 * Both halves are optional because each was added at a different time: an
 * answer from before the status existed still has passages, and one from
 * before passages existed has neither.
 */
export interface AnswerOutcome {
  readonly status?: SourceStatus
  readonly passages: readonly SourcePassage[]
}

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
 * tool-addition/tool-removal blocks), so this plugin's node — a text context
 * message — is absent from `order` while still present in `nodes`.
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

/** Narrow one passage, rejecting anything that is not the declared shape. */
function readPassage(passage: unknown): SourcePassage | undefined {
  if (typeof passage !== 'object' || passage === null) return undefined
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
    return undefined
  }
  // Identity is optional and read leniently: a malformed id drops the reader
  // action, never the passage.
  const kbId = (passage as { kbId?: unknown }).kbId
  const materialId = (passage as { materialId?: unknown }).materialId
  const ordinal = (passage as { ordinal?: unknown }).ordinal
  return {
    kbName,
    materialTitle,
    locator,
    text,
    ...(typeof kbId === 'string' && kbId !== '' ? { kbId } : {}),
    ...(typeof materialId === 'string' && materialId !== '' ? { materialId } : {}),
    ...(typeof ordinal === 'number' && Number.isSafeInteger(ordinal) && ordinal >= 0
      ? { ordinal }
      : {}),
  }
}

/** Narrow the status, rejecting anything that is not the declared shape. */
function readStatus(status: unknown): SourceStatus | undefined {
  if (typeof status !== 'object' || status === null) return undefined
  const outcome = (status as { outcome?: unknown }).outcome
  if (typeof outcome !== 'string' || outcome === '') return undefined
  const passageCount = (status as { passageCount?: unknown }).passageCount
  const reason = (status as { reason?: unknown }).reason
  return {
    outcome,
    passageCount:
      typeof passageCount === 'number' && Number.isSafeInteger(passageCount) ? passageCount : 0,
    reason: typeof reason === 'string' ? reason : '',
  }
}

/**
 * What one node says, or `undefined` when it is not this plugin's node.
 *
 * `undefined` and "a node with nothing in it" are different answers, and the
 * caller depends on the difference: the first means no badge at all, the second
 * means a badge that reports an outcome. So the node's identity is established
 * before its payload is read, never inferred from the payload being non-empty.
 */
function outcomeOfNode(node: unknown): AnswerOutcome | undefined {
  if ((node as { kind?: unknown } | undefined)?.kind !== 'context') return undefined
  const source = (node as { data?: { source?: unknown } }).data?.source
  if (typeof source !== 'object' || source === null) return undefined
  if ((source as { kind?: unknown }).kind !== 'knowbase') return undefined

  const passages: SourcePassage[] = []
  const rawPassages = (source as { passages?: unknown }).passages
  if (Array.isArray(rawPassages)) {
    for (const passage of rawPassages) {
      const cleaned = readPassage(passage)
      if (cleaned !== undefined) passages.push(cleaned)
    }
  }

  const status = readStatus((source as { status?: unknown }).status)
  return { status, passages }
}

/**
 * What one turn's knowledge-base node says, or `undefined` when the turn has
 * none — including turns answered before the plugin carried any payload.
 *
 * Nodes are walked in transcript order so passage numbering matches the
 * answer's `[n]` markers. Several matching nodes are merged rather than the
 * first being taken: a guard upstream keeps one node per input, but a turn that
 * somehow carries two should show all of its sources rather than half of them.
 */
export function outcomeOfTurn(chat: unknown, turn: number): AnswerOutcome | undefined {
  const matched: unknown[] = []
  for (const node of allNodes(chat)) {
    if (turnNoOf((node as { location?: unknown }).location) !== turn) continue
    if (outcomeOfNode(node) === undefined) continue
    matched.push(node)
  }
  if (matched.length === 0) return undefined
  matched.sort((left, right) => seqOf(left) - seqOf(right))

  const passages: SourcePassage[] = []
  let status: SourceStatus | undefined
  for (const node of matched) {
    const outcome = outcomeOfNode(node)
    if (outcome === undefined) continue
    passages.push(...outcome.passages)
    if (outcome.status !== undefined) status = outcome.status
  }
  return { status, passages }
}

/**
 * What the node behind one answer says, resolved from its closing message id.
 *
 * The single entry point the assistant-action component uses.
 */
export function outcomeForAnswer(chat: unknown, messageId: string): AnswerOutcome | undefined {
  const turn = turnForMessageId(chat, messageId)
  if (turn === undefined) return undefined
  return outcomeOfTurn(chat, turn)
}

/** Re-export for the panel's prop typing; keeps one shape across the plugin. */
export type CitationPassage = RetrievedPassage