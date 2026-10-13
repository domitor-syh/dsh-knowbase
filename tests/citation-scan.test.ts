/**
 * Citation scan tests.
 *
 * The panel's data path is a pure walk over the chat snapshot; these tests
 * pin the walk itself — which node is the closing message of a turn, where
 * the evidence rides, and every way a malformed node must degrade to "no
 * panel" instead of throwing.
 */

import { describe, expect, it } from 'vitest'
import {
  passagesForAnswer,
  passagesOfTurn,
  turnForMessageId,
  turnNoOf,
} from '../src/client/citation-scan.ts'

const PASSAGE = {
  kbName: '产品资料',
  materialTitle: '设备手册',
  locator: '第 1 段',
  text: '出厂默认波特率为115200。',
}

/** Build a minimal chat snapshot with the shapes the client actually ships. */
function chatWith(...nodes: ReadonlyArray<Record<string, unknown>>): unknown {
  const map = new Map<string, unknown>()
  const order: string[] = []
  nodes.forEach((node, index) => {
    const key = `n${index}`
    order.push(key)
    map.set(key, node)
  })
  return { order, nodes: map }
}

function contextNode(turn: number | unknown, source: unknown): Record<string, unknown> {
  return { kind: 'context', location: { turn }, data: { source } }
}

describe('turnNoOf', () => {
  it('reads object and bare number locations', () => {
    expect(turnNoOf({ turn: { turn: 3 } })).toBe(3)
    expect(turnNoOf({ turn: 2 })).toBe(2)
  })

  it('rejects unusable locations', () => {
    expect(turnNoOf(undefined)).toBeUndefined()
    expect(turnNoOf({ turn: 0 })).toBeUndefined()
    expect(turnNoOf({ turn: '2' })).toBeUndefined()
  })
})

describe('turnForMessageId', () => {
  it('finds the turn whose closing node carries the message id', () => {
    const chat = chatWith(
      { kind: 'assistant-step', location: { turn: { turn: 4 } }, data: { finalNode: { messageId: 'm-1' } } },
      { kind: 'assistant-step', location: { turn: { turn: 5 } }, data: { finalNode: { messageId: 'm-2' } } },
    )
    expect(turnForMessageId(chat, 'm-2')).toBe(5)
  })

  it('answers undefined when no node closes with the id, or the snapshot is unusable', () => {
    expect(turnForMessageId(chatWith(), 'm-1')).toBeUndefined()
    expect(turnForMessageId(undefined, 'm-1')).toBeUndefined()
    expect(turnForMessageId({ order: 'nope' }, 'm-1')).toBeUndefined()
  })
})

describe('passagesOfTurn', () => {
  it('collects passages from the knowbase context nodes of a turn', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [PASSAGE] }),
      { kind: 'user', location: { turn: 1 }, data: { content: [] } },
      contextNode({ turn: 2 }, { kind: 'knowbase', passages: [{ ...PASSAGE, locator: '第 2 段' }] }),
    )
    expect(passagesOfTurn(chat, 1)).toEqual([PASSAGE])
    expect(passagesOfTurn(chat, 2)).toHaveLength(1)
  })

  it('ignores other sources, other turns, and malformed payloads', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'time-context' }),
      contextNode({ turn: 1 }, undefined),
      contextNode({ turn: 1 }, { kind: 'knowbase' }),
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: 'nope' }),
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [{ kbName: 1 }] }),
    )
    expect(passagesOfTurn(chat, 1)).toEqual([])
    expect(passagesOfTurn(undefined, 1)).toEqual([])
  })

  it('drops only the malformed entries, keeping valid ones', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [{ kbName: 1 }, PASSAGE] }),
    )
    expect(passagesOfTurn(chat, 1)).toEqual([PASSAGE])
  })
})

describe('passagesForAnswer', () => {
  it('resolves the turn from the closing message and returns its passages', () => {
    const chat = chatWith(
      contextNode({ turn: 7 }, { kind: 'knowbase', passages: [PASSAGE] }),
      { kind: 'assistant-step', location: { turn: { turn: 7 } }, data: { finalNode: { messageId: 'm-9' } } },
    )
    expect(passagesForAnswer(chat, 'm-9')).toEqual([PASSAGE])
  })

  it('answers empty for answers without evidence or unresolvable ids', () => {
    const chat = chatWith(
      { kind: 'assistant-step', location: { turn: { turn: 7 } }, data: { finalNode: { messageId: 'm-9' } } },
    )
    expect(passagesForAnswer(chat, 'm-9')).toEqual([])
    expect(passagesForAnswer(chat, 'm-other')).toEqual([])
  })
})