/**
 * Render-level reproduction for the source-panel action and its status badge.
 *
 * The browser saw `slot entry crashed … Cannot read properties of undefined
 * (reading 'length')` whose visible stack was entirely inside the host's error
 * boundary — i.e. possibly a SECONDARY error raised while the boundary was
 * formatting the original one. This test renders the component directly, so
 * whatever the original render error is, it surfaces here unmasked.
 *
 * The badge half is here for the same reason the panel half is: the rule that
 * a miss must be reported by the plugin rather than remembered by the model
 * (`「未命中提示不能只交给模型"记得说"」`) is only satisfied if the component
 * actually renders something for a non-hit outcome. A test that stopped at the
 * scanner would pass while the UI stayed silent.
 */

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KnowbaseSourceAction, KnowbaseSourceOverlay } from '../src/client/citation-button.tsx'
import { closeSources, showSources } from '../src/client/citation-dialog.ts'

const PASSAGE = {
  kbName: '产品资料1',
  materialTitle: '端口说明',
  locator: '第 1 段',
  text: '本设备默认端口号为 8080。',
}

/** Build a chat snapshot carrying exactly one context node for turn 1. */
function chatWith(source: Record<string, unknown>): Record<string, unknown> {
  return {
    // `order` mirrors the host: the visible transcript lists the assistant node
    // only, because a plain injected-context row is hidden from it. The evidence
    // node lives solely in `nodes` — reading `order` alone is what kept this
    // button from ever rendering.
    order: ['a0'],
    nodes: new Map<string, unknown>([
      ['c0', { kind: 'context', location: { turn: { turn: 1 } }, data: { seq: 12, source } }],
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
}

const HIT_SOURCE = { kind: 'knowbase', form: 'recall', passages: [PASSAGE] }
const CHAT = chatWith(HIT_SOURCE)

/** The kit as this host composes it: `useChat` carries the slice. */
function kitFor(chat: unknown): Record<string, unknown> {
  const fakeSession = ((selector: unknown) => {
    void selector
    return { chat }
  }) as unknown
  const fakeChat = ((selector: (state: unknown) => unknown) => selector(chat)) as unknown
  return { useSession: fakeSession, useChat: fakeChat }
}

const liveKit = kitFor(CHAT)

describe('KnowbaseSourceAction render', () => {
  it('renders the action button when the turn carries passages', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', ...liveKit }),
    )
    expect(html).toContain('知识库来源')
    expect(html).toContain('data-kb-source-icon')
    expect(html).toContain('width="24" height="24"')
    expect(html).toContain('data-kb-source-count')
    expect(html).toContain('class="kb-source-action"')
    expect(html).toContain('aria-label="知识库来源 1"')
  })

  it('numbers the button with the passage count', () => {
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', ...liveKit }),
    )
    expect(html).toContain('>1<')
  })

  it('renders null for an unknown message id', () => {
    // No assistant node closes `m-none`, so the turn cannot be resolved. This is
    // "not this plugin's answer", which must stay silent — distinct from "this
    // answer searched and found nothing", which must speak.
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-none', ...liveKit }),
    )
    expect(html).toBe('')
  })

  it('falls back to the session snapshot when the kit has no useChat', () => {
    // The older route: `chat` rode on the session snapshot.
    const html = renderToString(
      createElement(KnowbaseSourceAction, { messageId: 'm-1', useSession: kitFor(CHAT).useSession }),
    )
    expect(html).toContain('知识库来源')
  })

  it('renders null when the session kit is absent', () => {
    const html = renderToString(createElement(KnowbaseSourceAction, { messageId: 'm-1' }))
    expect(html).toBe('')
  })
})

describe('KnowbaseSourceAction status badge', () => {
  /** Render one answer whose node carries only the given status. */
  function renderStatus(status: Record<string, unknown>): string {
    const kit = kitFor(chatWith({ kind: 'knowbase', form: 'recall', passages: [], status }))
    return renderToString(createElement(KnowbaseSourceAction, { messageId: 'm-1', ...kit }))
  }

  it('reports a miss with a fixed sentence the plugin owns', () => {
    const html = renderStatus({ outcome: 'no_match', passageCount: 0, reason: '' })
    expect(html).toContain('未检索到相关知识')
    // The badge is a label, not an action: there is nothing to open.
    expect(html).not.toContain('知识库来源')
  })

  it('distinguishes "no material yet" from "no match"', () => {
    const html = renderStatus({ outcome: 'not_ready', passageCount: 0, reason: '' })
    expect(html).toContain('知识库还没有资料')
    expect(html).not.toContain('未检索到相关知识')
  })

  it('reports a vanished scope and a broken retrieval separately', () => {
    expect(renderStatus({ outcome: 'empty_scope', passageCount: 0, reason: '' })).toContain(
      '所选知识库已失效',
    )
    expect(
      renderStatus({ outcome: 'error', passageCount: 0, reason: 'boom' }),
    ).toContain('知识库检索暂不可用')
  })

  it('carries the failure reason in the hover hint', () => {
    const html = renderStatus({ outcome: 'error', passageCount: 0, reason: 'boom' })
    expect(html).toContain('知识库检索失败')
    expect(html).toContain('boom')
  })

  it('renders the raw token for an outcome this build does not know', () => {
    // A newer Host may add a state. Hiding it would turn that state into "no
    // status at all", which is the one reading that lies; showing the token is
    // ugly but honest.
    const html = renderStatus({ outcome: 'rate_limited', passageCount: 0, reason: '' })
    expect(html).toContain('rate_limited')
  })

  it('stays silent when the node carries neither passages nor status', () => {
    // An answer written before either field existed. A node with an empty
    // payload is not an outcome, so there is nothing to report.
    const kit = kitFor(chatWith({ kind: 'knowbase', form: 'recall' }))
    const html = renderToString(createElement(KnowbaseSourceAction, { messageId: 'm-1', ...kit }))
    expect(html).toBe('')
  })

  it('prefers the button over the badge when passages exist alongside a status', () => {
    // `hits` is the one outcome with something to open; the badge must not
    // shadow it.
    const kit = kitFor(
      chatWith({
        kind: 'knowbase',
        form: 'recall',
        passages: [PASSAGE],
        status: { outcome: 'hits', passageCount: 1, reason: '' },
      }),
    )
    const html = renderToString(createElement(KnowbaseSourceAction, { messageId: 'm-1', ...kit }))
    expect(html).toContain('知识库来源')
    expect(html).not.toContain('未检索到相关知识')
  })
})

describe('KnowbaseSourceOverlay layout', () => {
  it('uses the compact official-style surface and omits redundant citation metadata', () => {
    const owner = {}
    showSources({ owner, passages: [
      PASSAGE,
      { ...PASSAGE, materialTitle: '安装手册', locator: '第 2 段', text: '请先断开电源。' },
    ], restoreFocus: null })
    try {
      const html = renderToString(createElement(KnowbaseSourceOverlay))
      expect(html).toContain('data-kb-source-dialog')
      expect(html).toContain('data-kb-source-filter')
      expect(html).toContain('border-radius:24px')
      expect(html).toContain('aria-haspopup="listbox"')
      expect(html).not.toContain('<select')
      expect(html).not.toContain('引用 ID:')
      expect(html).not.toContain('编号与回答中的')
    } finally {
      closeSources(owner)
    }
  })
})
