/**
 * Composer label tests.
 *
 * The label and the invalid-scope detection are what the user actually reads
 * off the control, and the plan draws a hard line around one case in
 * particular: a selection whose base was deleted must read as invalid, never
 * as "off" and never as "all".
 */

import { describe, expect, it } from 'vitest'
import { missingBaseIds, scopeLabel } from '../src/client/labels.ts'
import type { KnowledgeBaseView } from '../src/remote.ts'

const BASES: readonly KnowledgeBaseView[] = [
  { id: 'kb_a', name: '产品资料', description: '', materialCount: 3, chunkCount: 9, updatedAt: 0 },
  { id: 'kb_b', name: '技术资料', description: '', materialCount: 0, chunkCount: 0, updatedAt: 0 },
]

describe('scopeLabel', () => {
  it('shows the bare name until the scope has loaded', () => {
    expect(scopeLabel(undefined, BASES)).toBe('知识库')
  })

  it('shows 关闭 when the session switched it off', () => {
    expect(scopeLabel({ enabled: false, all: true, kbIds: [] }, BASES)).toBe('知识库：关闭')
  })

  it('counts the bases when the scope is everything', () => {
    expect(scopeLabel({ enabled: true, all: true, kbIds: [] }, BASES)).toBe('知识库：全部（2）')
  })

  it('names a specific base', () => {
    expect(scopeLabel({ enabled: true, all: false, kbIds: ['kb_a'] }, BASES)).toBe(
      '知识库：产品资料',
    )
  })

  it('marks a deleted base instead of falling back to anything', () => {
    expect(scopeLabel({ enabled: true, all: false, kbIds: ['kb_gone'] }, BASES)).toBe(
      '知识库：已删除',
    )
  })

  it('reads 未选择 when enabled without a scope', () => {
    expect(scopeLabel({ enabled: true, all: false, kbIds: [] }, BASES)).toBe('知识库：未选择')
  })
})

describe('missingBaseIds', () => {
  it('is empty while the control is still loading', () => {
    expect(missingBaseIds(undefined, BASES)).toEqual([])
  })

  it('is empty when the session is off', () => {
    expect(missingBaseIds({ enabled: false, all: false, kbIds: ['kb_gone'] }, BASES)).toEqual([])
  })

  it('is empty for the all-scope', () => {
    expect(missingBaseIds({ enabled: true, all: true, kbIds: [] }, BASES)).toEqual([])
  })

  it('reports only the ids that no longer exist', () => {
    expect(
      missingBaseIds({ enabled: true, all: false, kbIds: ['kb_a', 'kb_gone'] }, BASES),
    ).toEqual(['kb_gone'])
  })
})