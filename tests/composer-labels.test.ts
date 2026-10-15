/**
 * Composer label tests.
 *
 * The label, the count behind it, and the invalid-scope detection are what the
 * user actually reads off the control. The hand-off replaced the old prose
 * label with a count, which moves two requirements into the arithmetic:
 *
 *   - the number is a promise about *retrieval*, so an id whose base no longer
 *     exists must not inflate it; and
 *   - nothing ticked and switched off are the same statement now, so both have
 *     to read as the bare 「知识库」 rather than as two different labels.
 *
 * The plan's hard line still stands and is still asserted below: a selection
 * whose base was deleted reads as invalid, never as "off" and never as "all".
 */

import { describe, expect, it } from 'vitest'
import {
  allSelected,
  isBaseSelected,
  matchesQuery,
  missingBaseIds,
  scopeCount,
  scopeLabel,
  toggleBaseSelection,
} from '../src/client/labels.ts'
import type { KnowledgeBaseView } from '../src/remote.ts'

const BASES: readonly KnowledgeBaseView[] = [
  {
    id: 'kb_a',
    name: '产品资料',
    description: '',
    folderName: '产品资料--kb_a',
    materialCount: 3,
    indexedCount: 2,
    bytes: 2048,
    updatedAt: 0,
  },
  {
    id: 'kb_b',
    name: '技术资料',
    description: '',
    folderName: '技术资料--kb_b',
    materialCount: 0,
    indexedCount: 0,
    bytes: 0,
    updatedAt: 0,
  },
]

describe('scopeCount', () => {
  it('is zero while the control is still loading', () => {
    expect(scopeCount(undefined, BASES)).toBe(0)
  })

  it('is zero when the session is off', () => {
    expect(scopeCount({ enabled: false, all: true, kbIds: [] }, BASES)).toBe(0)
  })

  it('is zero when enabled but nothing is ticked', () => {
    expect(scopeCount({ enabled: true, all: false, kbIds: [] }, BASES)).toBe(0)
  })

  it('counts every base for the dynamic all-scope', () => {
    expect(scopeCount({ enabled: true, all: true, kbIds: [] }, BASES)).toBe(2)
  })

  it('counts only the ticked bases', () => {
    expect(scopeCount({ enabled: true, all: false, kbIds: ['kb_a'] }, BASES)).toBe(1)
  })

  it('does not count a base that no longer exists', () => {
    // The count promises what will be searched; a deleted base cannot answer.
    expect(scopeCount({ enabled: true, all: false, kbIds: ['kb_a', 'kb_gone'] }, BASES)).toBe(1)
  })
})

describe('scopeLabel', () => {
  it('shows the bare name until the scope has loaded', () => {
    expect(scopeLabel(undefined, BASES)).toBe('知识库')
  })

  it('reads the same switched off as it does with nothing ticked', () => {
    // The hand-off's rule: no switch on means the knowledge base is not used,
    // so the two must not read as two different states.
    expect(scopeLabel({ enabled: false, all: true, kbIds: [] }, BASES)).toBe('知识库')
    expect(scopeLabel({ enabled: true, all: false, kbIds: [] }, BASES)).toBe('知识库')
  })

  it('counts the bases when the scope is everything', () => {
    expect(scopeLabel({ enabled: true, all: true, kbIds: [] }, BASES)).toBe('知识库 · 2')
  })

  it('counts a specific selection without naming it', () => {
    expect(scopeLabel({ enabled: true, all: false, kbIds: ['kb_a'] }, BASES)).toBe('知识库 · 1')
  })

  it('counts a stale selection by what is still searchable', () => {
    expect(scopeLabel({ enabled: true, all: false, kbIds: ['kb_a', 'kb_gone'] }, BASES)).toBe(
      '知识库 · 1',
    )
  })

  it('reads as nothing selected when every ticked base is gone', () => {
    expect(scopeLabel({ enabled: true, all: false, kbIds: ['kb_gone'] }, BASES)).toBe('知识库')
  })
})

describe('allSelected', () => {
  it('is false while loading, off, or with no bases at all', () => {
    expect(allSelected(undefined, BASES)).toBe(false)
    expect(allSelected({ enabled: false, all: true, kbIds: [] }, BASES)).toBe(false)
    expect(allSelected({ enabled: true, all: true, kbIds: [] }, [])).toBe(false)
  })

  it('is true for the dynamic all-scope', () => {
    expect(allSelected({ enabled: true, all: true, kbIds: [] }, BASES)).toBe(true)
  })

  it('is true when the explicit list covers every base', () => {
    expect(allSelected({ enabled: true, all: false, kbIds: ['kb_b', 'kb_a'] }, BASES)).toBe(true)
  })

  it('is false when one base is left out', () => {
    expect(allSelected({ enabled: true, all: false, kbIds: ['kb_a'] }, BASES)).toBe(false)
  })

  it('is false when the only coverage is a deleted base', () => {
    expect(allSelected({ enabled: true, all: false, kbIds: ['kb_a', 'kb_gone'] }, BASES)).toBe(
      false,
    )
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

describe('isBaseSelected', () => {
  it('is off while the control is still loading', () => {
    expect(isBaseSelected(undefined, 'kb_a')).toBe(false)
  })

  it('is on for every base under the all-scope', () => {
    expect(isBaseSelected({ enabled: true, all: true, kbIds: [] }, 'kb_a')).toBe(true)
    expect(isBaseSelected({ enabled: true, all: true, kbIds: [] }, 'kb_b')).toBe(true)
  })

  it('follows the explicit list when the scope is a list', () => {
    const scope = { enabled: true, all: false, kbIds: ['kb_b'] }
    expect(isBaseSelected(scope, 'kb_a')).toBe(false)
    expect(isBaseSelected(scope, 'kb_b')).toBe(true)
  })

  it('is off for every base when the session is switched off, even with all remembered', () => {
    // The Host's default for a session that has never chosen is
    // `{ enabled: false, all: true }`. Reading `all` without `enabled` drew every
    // switch on while the button said the knowledge base was not in use.
    expect(isBaseSelected({ enabled: false, all: true, kbIds: [] }, 'kb_a')).toBe(false)
    expect(isBaseSelected({ enabled: false, all: false, kbIds: ['kb_a'] }, 'kb_a')).toBe(false)
  })
})

describe('toggleBaseSelection', () => {
  it('starts a list from nothing', () => {
    expect(toggleBaseSelection(undefined, BASES, 'kb_a')).toEqual(['kb_a'])
  })

  it('selects only the clicked base when the session was switched off', () => {
    // A switched-off scope still remembers `all: true`. Expanding that to every
    // id and then dropping the clicked one inverted the first thing a user does:
    // asking for A selected B.
    expect(toggleBaseSelection({ enabled: false, all: true, kbIds: [] }, BASES, 'kb_a')).toEqual([
      'kb_a',
    ])
  })

  it('ignores a remembered list while the session is switched off', () => {
    expect(
      toggleBaseSelection({ enabled: false, all: false, kbIds: ['kb_a'] }, BASES, 'kb_b'),
    ).toEqual(['kb_b'])
  })

  it('appends a second base rather than replacing the first', () => {
    // The whole point of the change: ticking a base must not clear the others.
    expect(toggleBaseSelection({ enabled: true, all: false, kbIds: ['kb_a'] }, BASES, 'kb_b'))
      .toEqual(['kb_a', 'kb_b'])
  })

  it('keeps selection order so the list never reshuffles under the pointer', () => {
    expect(toggleBaseSelection({ enabled: true, all: false, kbIds: ['kb_b'] }, BASES, 'kb_a'))
      .toEqual(['kb_b', 'kb_a'])
  })

  it('removes an unticked base', () => {
    expect(
      toggleBaseSelection({ enabled: true, all: false, kbIds: ['kb_a', 'kb_b'] }, BASES, 'kb_a'),
    ).toEqual(['kb_b'])
  })

  it('reaches the empty list that the control now writes as switched off', () => {
    expect(toggleBaseSelection({ enabled: true, all: false, kbIds: ['kb_a'] }, BASES, 'kb_a'))
      .toEqual([])
  })

  it('materialises the dynamic all-scope before dropping one base', () => {
    // `all: true` stores no ids, so unticking one has to be turned into the
    // explicit list the user was looking at — otherwise the untick would appear
    // to do nothing.
    expect(toggleBaseSelection({ enabled: true, all: true, kbIds: [] }, BASES, 'kb_a')).toEqual([
      'kb_b',
    ])
  })

  it('keeps a deleted base in the list instead of silently shrinking to valid', () => {
    // Dropping it would turn a stale selection into a valid one with no
    // explanation; the panel's warning is what makes it visible.
    expect(
      toggleBaseSelection({ enabled: true, all: false, kbIds: ['kb_a', 'kb_gone'] }, BASES, 'kb_a'),
    ).toEqual(['kb_gone'])
  })
})

describe('matchesQuery', () => {
  it('matches everything on an empty or blank query', () => {
    expect(matchesQuery('产品资料', '')).toBe(true)
    expect(matchesQuery('产品资料', '   ')).toBe(true)
  })

  it('matches a substring anywhere in the name', () => {
    expect(matchesQuery('产品需求文档', '需求')).toBe(true)
    expect(matchesQuery('产品需求文档', '产品')).toBe(true)
  })

  it('ignores case for latin names', () => {
    expect(matchesQuery('API 参考手册', 'api')).toBe(true)
  })

  it('ignores full-width versus half-width spelling', () => {
    expect(matchesQuery('ＡＰＩ 手册', 'api')).toBe(true)
  })

  it('rejects a name that does not contain the query', () => {
    expect(matchesQuery('产品资料', '会议')).toBe(false)
  })
})
