/**
 * Citation scan tests.
 *
 * The panel's and the badge's data path is a pure walk over the chat snapshot;
 * these tests pin the walk itself — which node is the closing message of a
 * turn, where the payload rides, and every way a malformed node must degrade to
 * "nothing to show" instead of throwing.
 *
 * The distinction the scan has to preserve is `undefined` versus "a node with
 * an empty payload": the first means no badge at all, the second means a badge
 * that reports an outcome. Several of these tests exist only to hold that line.
 */

import { describe, expect, it } from 'vitest'
import {
  outcomeForAnswer,
  outcomeOfTurn,
  turnForMessageId,
  turnNoOf,
} from '../src/client/citation-scan.ts'

const PASSAGE = {
  kbName: '产品资料',
  materialTitle: '设备手册',
  locator: '第 1 段',
  text: '出厂默认波特率为115200。',
}

const STATUS = { outcome: 'hits', passageCount: 1, reason: '' }

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

/** The passages of a turn, with "no node" flattened to an empty list. */
function passagesOf(chat: unknown, turn: number): readonly { locator: string }[] {
  return outcomeOfTurn(chat, turn)?.passages ?? []
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

describe('outcomeOfTurn — passages', () => {
  it('collects passages from the knowbase context nodes of a turn', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [PASSAGE], status: STATUS }),
      { kind: 'user', location: { turn: 1 }, data: { content: [] } },
      contextNode({ turn: 2 }, { kind: 'knowbase', passages: [{ ...PASSAGE, locator: '第 2 段' }] }),
    )
    expect(passagesOf(chat, 1)).toEqual([PASSAGE])
    expect(passagesOf(chat, 2)).toHaveLength(1)
  })

  it('ignores other sources, other turns, and malformed payloads', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'time-context' }),
      contextNode({ turn: 1 }, undefined),
      contextNode({ turn: 1 }, { kind: 'knowbase' }),
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: 'nope' }),
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [{ kbName: 1 }] }),
    )
    expect(passagesOf(chat, 1)).toEqual([])
    expect(outcomeOfTurn(undefined, 1)).toBeUndefined()
  })

  it('drops only the malformed entries, keeping valid ones', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [{ kbName: 1 }, PASSAGE] }),
    )
    expect(passagesOf(chat, 1)).toEqual([PASSAGE])
  })

  it('numbers passages in transcript order, not store order', () => {
    // Two nodes in one turn: the answer's `[n]` markers follow the transcript,
    // so the panel must too, whatever order the store holds them in.
    const nodes = new Map<string, unknown>([
      [
        'late',
        { kind: 'context', location: { turn: 4 }, data: { seq: 90, source: { kind: 'knowbase', passages: [{ ...PASSAGE, locator: '第二段' }] } } },
      ],
      [
        'early',
        { kind: 'context', location: { turn: 4 }, data: { seq: 40, source: { kind: 'knowbase', passages: [PASSAGE] } } },
      ],
    ])
    const chat = { order: [], nodes }
    expect(passagesOf(chat, 4).map(passage => passage.locator)).toEqual(['第 1 段', '第二段'])
  })
})

describe('outcomeOfTurn — status', () => {
  it('reads the status off a hit', () => {
    const chat = chatWith(
      contextNode({ turn: 1 }, { kind: 'knowbase', passages: [PASSAGE], status: STATUS }),
    )
    expect(outcomeOfTurn(chat, 1)?.status).toEqual(STATUS)
  })

  it('reports a status with no passages — the whole point of the badge', () => {
    const chat = chatWith(
      contextNode({ turn: 2 }, {
        kind: 'knowbase',
        passages: [],
        status: { outcome: 'no_match', passageCount: 0, reason: '' },
      }),
    )
    const outcome = outcomeOfTurn(chat, 2)
    expect(outcome?.status?.outcome).toBe('no_match')
    expect(outcome?.passages).toEqual([])
  })

  it('keeps "no node" apart from "a node with nothing in it"', () => {
    // `undefined` renders nothing; an empty payload still renders a badge.
    // Collapsing the two is how a miss would become invisible.
    expect(outcomeOfTurn(chatWith(), 3)).toBeUndefined()
    expect(
      outcomeOfTurn(chatWith(contextNode({ turn: 3 }, { kind: 'knowbase' })), 3),
    ).toBeDefined()
  })

  it('takes the last status when a turn somehow carries two nodes', () => {
    const chat = chatWith(
      {
        kind: 'context',
        location: { turn: 5 },
        data: { seq: 10, source: { kind: 'knowbase', passages: [PASSAGE], status: STATUS } },
      },
      {
        kind: 'context',
        location: { turn: 5 },
        data: {
          seq: 20,
          source: {
            kind: 'knowbase',
            passages: [],
            status: { outcome: 'error', passageCount: 0, reason: 'boom' },
          },
        },
      },
    )
    const outcome = outcomeOfTurn(chat, 5)
    expect(outcome?.status?.outcome).toBe('error')
    // Passages from both are kept: half the sources would be worse than all.
    expect(outcome?.passages).toHaveLength(1)
  })

  it('drops a status that is not the declared shape', () => {
    const chat = chatWith(
      contextNode({ turn: 6 }, { kind: 'knowbase', passages: [PASSAGE], status: { outcome: 7 } }),
    )
    expect(outcomeOfTurn(chat, 6)?.status).toBeUndefined()
    expect(outcomeOfTurn(chat, 6)?.passages).toHaveLength(1)
  })

  it('defaults a missing passageCount and reason instead of rejecting the status', () => {
    // A newer Host that renamed a field should still get a badge, not silence.
    const chat = chatWith(
      contextNode({ turn: 8 }, { kind: 'knowbase', status: { outcome: 'not_ready' } }),
    )
    expect(outcomeOfTurn(chat, 8)?.status).toEqual({
      outcome: 'not_ready',
      passageCount: 0,
      reason: '',
    })
  })
})

describe('outcomeForAnswer', () => {
  it('resolves the turn from the closing message and returns its outcome', () => {
    const chat = chatWith(
      contextNode({ turn: 7 }, { kind: 'knowbase', passages: [PASSAGE], status: STATUS }),
      { kind: 'assistant-step', location: { turn: { turn: 7 } }, data: { finalNode: { messageId: 'm-9' } } },
    )
    const outcome = outcomeForAnswer(chat, 'm-9')
    expect(outcome?.passages).toEqual([PASSAGE])
    expect(outcome?.status?.outcome).toBe('hits')
  })

  it('answers undefined for answers without a node or unresolvable ids', () => {
    const chat = chatWith(
      { kind: 'assistant-step', location: { turn: { turn: 7 } }, data: { finalNode: { messageId: 'm-9' } } },
    )
    expect(outcomeForAnswer(chat, 'm-9')).toBeUndefined()
    expect(outcomeForAnswer(chat, 'm-other')).toBeUndefined()
  })

  /**
   * The shape the host actually ships, and the reason the panel stayed empty
   * for so long: `order` is the VISIBLE transcript order, and the host hides
   * plain injected-context rows from it. The plugin's node is therefore absent
   * from `order` while still living in `nodes`.
   */
  it('finds the node the visible order omits', () => {
    const nodes = new Map<string, unknown>([
      ['c0', contextNode({ turn: 3 }, { kind: 'knowbase', passages: [PASSAGE], status: STATUS })],
      [
        'a0',
        {
          kind: 'assistant-step',
          location: { turn: { turn: 3 } },
          data: { finalNode: { messageId: 'm-3' } },
        },
      ],
    ])
    const chat = { order: ['a0'], nodes }
    expect(outcomeForAnswer(chat, 'm-3')?.passages).toEqual([PASSAGE])
  })

  it('finds a status-only node the visible order omits', () => {
    const nodes = new Map<string, unknown>([
      [
        'c0',
        contextNode({ turn: 3 }, {
          kind: 'knowbase',
          passages: [],
          status: { outcome: 'not_ready', passageCount: 0, reason: '' },
        }),
      ],
      [
        'a0',
        {
          kind: 'assistant-step',
          location: { turn: { turn: 3 } },
          data: { finalNode: { messageId: 'm-3' } },
        },
      ],
    ])
    const chat = { order: ['a0'], nodes }
    expect(outcomeForAnswer(chat, 'm-3')?.status?.outcome).toBe('not_ready')
  })

  it('falls back to order + get when the snapshot exposes no values()', () => {
    const store: Record<string, unknown> = {
      c0: contextNode({ turn: 3 }, { kind: 'knowbase', passages: [PASSAGE], status: STATUS }),
      a0: {
        kind: 'assistant-step',
        location: { turn: { turn: 3 } },
        data: { finalNode: { messageId: 'm-3' } },
      },
    }
    const chat = { order: ['c0', 'a0'], nodes: { get: (key: string) => store[key] } }
    expect(outcomeForAnswer(chat, 'm-3')?.passages).toEqual([PASSAGE])
  })
})
