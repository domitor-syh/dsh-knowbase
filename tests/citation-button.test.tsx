/**
 * Render-level reproduction for the source-panel action.
 *
 * The browser saw `slot entry crashed … Cannot read properties of undefined
 * (reading 'length')` whose visible stack was entirely inside the host's error
 * boundary — i.e. possibly a SECONDARY error raised while the boundary was
 * formatting the original one. This test renders the component directly, so
 * whatever the original render error is, it surfaces here unmasked.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KnowbaseSourceAction } from '../src/client/citation-button.tsx'

const PASSAGE = {
  kbName: '产品资料1',
  materialTitle: '端口说明',
  locator: '第 1 段',
  text: '本设备默认端口号为 8080。',
}

const CHAT = {
  order: ['c0', 'a0'],
  nodes: new Map<string, unknown>([
    [
      'c0',
      {
        kind: 'context',
        location: { turn: { turn: 1 } },
        data: { source: { kind: 'knowbase', form: 'recall', passages: [PASSAGE] } },
      },
    ],
    [
      'a0',
      {
        kind: 'assistant-step',
        location: { turn: { turn: 1 } },
        data: { finalNode: { messageId: 'm-1' } },
      },
    ],
  ]),
}

describe('KnowbaseSourceAction render', () => {
  // The component reads the chat slice from the SESSION snapshot (the stable
  // route — see the hook-discipline note in the component); the fake kit
  // mirrors that shape.
  const fakeSession = ((selector: unknown) => {
    void selector
    return { chat: CHAT }
  }) as unknown

  it('renders the action button when the turn carries passages', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', useSession: fakeSession }),
    )
    expect(html).toContain('知识库来源')
  })

  it('renders null for a turn without passages', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-none', useSession: fakeSession }),
    )
    expect(html).toBe('')
  })

  it('renders null when the session kit is absent', () => {
    const html = renderToString(createElement(KnowbaseSourceAction, { messageId: 'm-1' }))
    expect(html).toBe('')
  })
})