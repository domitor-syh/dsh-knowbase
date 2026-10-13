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
  // `order` mirrors the host: the visible transcript lists the assistant node
  // only, because a plain injected-context row is hidden from it. The evidence
  // node lives solely in `nodes` — reading `order` alone is what kept this
  // button from ever rendering.
  order: ['a0'],
  nodes: new Map<string, unknown>([
    [
      'c0',
      {
        kind: 'context',
        location: { turn: { turn: 1 } },
        data: { seq: 12, source: { kind: 'knowbase', form: 'recall', passages: [PASSAGE] } },
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
  // This host publishes the chat slice through the session kit's `useChat` hook
  // (ui-chat registers a `chat` source; the renderer turns it into a `useChat`
  // prop). The session snapshot no longer carries `chat`, which is exactly why
  // the button never rendered: the seat was fine and the data was on the other
  // route. The fake kit mirrors both routes so either regression is caught.
  const fakeSession = ((selector: unknown) => {
    void selector
    return { chat: CHAT }
  }) as unknown

  const fakeChat = ((selector: (state: unknown) => unknown) =>
    selector(CHAT)) as unknown

  /** The kit as this host composes it: `useChat` carries the slice. */
  const liveKit = { useSession: fakeSession, useChat: fakeChat }

  it('renders the action button when the turn carries passages', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', ...liveKit }),
    )
    expect(html).toContain('知识库来源')
  })

  it('numbers the button with the passage count', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', ...liveKit }),
    )
    expect(html).toContain('>1<')
  })

  it('renders null for a turn without passages', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-none', ...liveKit }),
    )
    expect(html).toBe('')
  })

  it('falls back to the session snapshot when the kit has no useChat', () => {
    // The older route: `chat` rode on the session snapshot.
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', useSession: fakeSession }),
    )
    expect(html).toContain('知识库来源')
  })

  it('renders null when the session kit is absent', () => {
    const html = renderToString(createElement(KnowbaseSourceAction, { messageId: 'm-1' }))
    expect(html).toBe('')
  })
})