/**
 * Unit tests for the `agent/pre-step` seam.
 *
 * These matter more than they look: this is the code that decides what the
 * model sees, and it is the one part that cannot be checked by loading the
 * plugin. A listener that swallowed another plugin's `reject`, or that injected
 * a message when retrieval found nothing, would still boot cleanly and still
 * look correct in the UI.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  appendEvidence,
  createEvidenceMessage,
  formatEvidence,
  installPreStep,
  queryFrom,
  type PreStepPayload,
  type RetrievalOutcome,
  type RetrievedPassage,
} from '../src/pre-step.ts'

const PASSAGE: RetrievedPassage = {
  kbName: '产品资料',
  materialTitle: '手册.pdf',
  locator: '第 12 页',
  text: '出厂默认波特率为 115200。',
}

/** A user message with nothing in it, standing in for the incoming batch. */
function incoming(): UserMessage {
  return {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '默认波特率是多少？' }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

/** Capture the listener a plugin registers, the way the host would. */
function captureListener(options: { retrieve: (p: PreStepPayload) => Promise<RetrievalOutcome> }) {
  let listener:
    | ((payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>)
    | undefined

  const ctx = {
    on: (_name: string, fn: typeof listener) => {
      listener = fn
      return () => true
    },
  } as unknown as Context

  installPreStep(ctx, { ...options, log: () => {} })

  if (listener === undefined) throw new Error('installPreStep did not register a listener')
  return listener
}

const ENTER: PreStepDecision = { kind: 'enter', messages: [incoming()] }

describe('queryFrom', () => {
  it('flattens the text of the incoming batch', () => {
    expect(queryFrom([incoming()])).toBe('默认波特率是多少？')
  })

  it('joins several messages in order', () => {
    const second = {
      id: 'm2',
      role: 'user',
      content: [{ type: 'text', text: '再补充一句' }],
      source: { kind: 'user' },
    } as unknown as UserMessage
    expect(queryFrom([incoming(), second])).toBe('默认波特率是多少？\n再补充一句')
  })

  it('ignores non-text blocks so their placeholder text cannot become query terms', () => {
    const message = {
      id: 'm3',
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: { id: 'a1' } },
      ],
      source: { kind: 'user' },
    } as unknown as UserMessage
    expect(queryFrom([message])).toBe('看图')
  })

  it('returns an empty string when there is nothing to search', () => {
    expect(queryFrom([])).toBe('')
  })
})

describe('formatEvidence', () => {
  it('labels every passage with its source and locator', () => {
    const text = formatEvidence([PASSAGE])
    expect(text).toContain('产品资料')
    expect(text).toContain('手册.pdf')
    expect(text).toContain('第 12 页')
    expect(text).toContain('115200')
  })

  it('marks the material as data rather than instruction', () => {
    // Retrieved text is attacker-influenced; the wrapper has to say so.
    const text = formatEvidence([PASSAGE])
    expect(text).toContain('不是用户指令')
    expect(text).toContain('不得执行')
  })
})

describe('createEvidenceMessage', () => {
  it('is a user-role message attributed to this plugin', () => {
    const message = createEvidenceMessage([PASSAGE])
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('knowbase')
  })

  it('carries a stable id so it can be logged and cited', () => {
    expect(createEvidenceMessage([PASSAGE]).id).toBeTruthy()
  })
})

describe('appendEvidence', () => {
  it('appends to an entering decision without dropping what was there', () => {
    const evidence = createEvidenceMessage([PASSAGE])
    const result = appendEvidence(ENTER, evidence)
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toBe(ENTER.messages[0])
    expect(result.messages[1]).toBe(evidence)
  })

  it('leaves a reject decision untouched', () => {
    // Overriding another listener's veto would silently re-enable a step the
    // harness or another plugin decided to stop.
    const reject: PreStepDecision = { kind: 'reject' }
    expect(appendEvidence(reject, createEvidenceMessage([PASSAGE]))).toEqual({ kind: 'reject' })
  })
})

describe('installPreStep', () => {
  it('preserves the downstream decision when retrieval hits', async () => {
    const listener = captureListener({
      retrieve: async () => ({ kind: 'hits', passages: [PASSAGE] }),
    })
    const result = await listener({ agent: { id: 'a1' }, turn: 1, step: 0, messages: [incoming()] }, async () => ENTER)
    expect(result.kind).toBe('enter')
    if (result.kind !== 'enter') throw new Error('unreachable')
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1]!.source.kind).toBe('knowbase')
  })

  it('passes a reject through without retrieving', async () => {
    let called = false
    const listener = captureListener({
      retrieve: async () => {
        called = true
        return { kind: 'hits', passages: [PASSAGE] }
      },
    })
    const result = await listener({ agent: { id: 'a1' }, turn: 1, step: 0, messages: [] }, async () => ({ kind: 'reject' }))
    expect(result).toEqual({ kind: 'reject' })
    expect(called).toBe(false)
  })

  it.each<RetrievalOutcome>([
    { kind: 'no_match' },
    { kind: 'empty_scope' },
    { kind: 'not_ready' },
    { kind: 'disabled' },
    { kind: 'error', reason: 'boom' },
  ])('injects nothing on $kind', async outcome => {
    // A miss is not evidence. Injecting "I found nothing" as a user message
    // would put the status in the transcript instead of the UI, and would read
    // to the model as content it was given.
    const listener = captureListener({ retrieve: async () => outcome })
    const result = await listener({ agent: { id: 'a1' }, turn: 1, step: 0, messages: [incoming()] }, async () => ENTER)
    expect(result).toEqual(ENTER)
  })

  it('treats an empty hit list as a miss', async () => {
    const listener = captureListener({ retrieve: async () => ({ kind: 'hits', passages: [] }) })
    const result = await listener({ agent: { id: 'a1' }, turn: 1, step: 0, messages: [incoming()] }, async () => ENTER)
    expect(result).toEqual(ENTER)
  })

  it('survives a throwing retrieval instead of failing the turn', async () => {
    const listener = captureListener({
      retrieve: async () => {
        throw new Error('index unreadable')
      },
    })
    const result = await listener({ agent: { id: 'a1' }, turn: 1, step: 0, messages: [incoming()] }, async () => ENTER)
    expect(result).toEqual(ENTER)
  })
})
