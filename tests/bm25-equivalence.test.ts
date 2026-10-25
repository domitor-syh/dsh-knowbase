import { describe, expect, it } from 'vitest'
import { Bm25Index, type Bm25Options, type SearchOptions } from '../src/core/bm25.ts'
import { ReferenceBm25Index } from './fixtures/bm25-reference.ts'

/** The oracle knows only the old API; group membership lives outside both indexes. */
function pairedIndexes(options: Bm25Options = {}) {
  const actual = new Bm25Index(options)
  const reference = new ReferenceBm25Index(options)
  const groups = new Map<string, string | undefined>()
  const evidence = new Map<string, string>()

  function add(id: string, text: string, group?: string): void {
    // Keep the legacy two-argument path exercised for ungrouped documents.
    if (group === undefined) actual.add(id, text)
    else actual.add(id, text, group)
    reference.add(id, text)
    groups.set(id, group)
    evidence.set(id, text.normalize('NFKC').toLowerCase())
  }

  function remove(id: string): void {
    expect(actual.remove(id)).toBe(reference.remove(id))
    groups.delete(id)
    evidence.delete(id)
    expect(actual.has(id)).toBe(reference.has(id))
  }

  function clear(): void {
    actual.clear()
    reference.clear()
    groups.clear()
    evidence.clear()
  }

  function referenceSearch(query: string, options: SearchOptions = {}) {
    const { groups: selected, accept, ...legacy } = options
    const selectedGroups = selected === undefined ? undefined : new Set(selected)
    return reference.search(query, {
      ...legacy,
      accept: selectedGroups === undefined ? accept : id => {
        const group = groups.get(id)
        return group !== undefined && selectedGroups.has(group) && (accept?.(id) ?? true)
      },
    })
  }

  function check(query: string, options: SearchOptions = {}) {
    const expected = referenceSearch(query, options)
    // Strict comparison checks all numeric values exactly, hit order, coverage,
    // and the complete matchedTerms arrays. No tolerances or score rounding.
    expect(actual.search(query, options), JSON.stringify({ query, ...options }))
      .toStrictEqual(expected)
    expect(actual.size).toBe(reference.size)
    expect(actual.averageLength).toBe(reference.averageLength)
    return expected
  }

  return { actual, reference, groups, evidence, add, remove, clear, check, referenceSearch }
}

type Pair = ReturnType<typeof pairedIndexes>

/** Fixed PRNG and input vocabulary keep failures reproducible across runtimes. */
function seededCorpus(pair: Pair): void {
  const fixed: readonly [string, string, string?][] = [
    ['tie-z', '默认波特率 alpha usb 115200', 'red'],
    ['tie-a', '默认波特率 alpha usb 115200', 'red'],
    ['tie-A', '默认波特率 alpha usb 115200', 'blue'],
    ['tie-é', '默认波特率 alpha usb 115200', 'blue'],
    ['tie-𠀀', '默认波特率 alpha usb 115200', 'green'],
    ['ungrouped', '默认波特率 alpha usb 115200'],
    ['han-red', '中', 'red'],
    ['han-blue', '中 中 中', 'blue'],
    ['han-green', '文', 'green'],
    ['astral', '𠀀𠀁设备 𠀀 alpha', 'red'],
    ['astral-only', '𠀀', 'blue'],
    ['empty', '', 'red'],
    ['punctuation', '…！？---🙂\t\n', 'blue'],
    ['fullwidth', 'ＡＬＰＨＡ ＵＳＢ ＸＹ１２３４５６ 默认波特率１１５２００', 'green'],
    ['identifier-exact', 'XY123456 13363538888', 'red'],
    ['identifier-collision', 'XY123 234 345 456 133 336 363 635 353 538 388 888', 'red'],
    ['identifier-separators', 'XY12-3456 1336 3538 888', 'blue'],
    ['identifier-han-boundary', 'XY12中3456 115200设备 USB与以太网', 'green'],
    ['long', 'alpha '.repeat(23) + '默认波特率为115200，通信失败。', 'red'],
    ['mixed-single-han', '中 alpha 文 usb 𠀀 115200', 'blue'],
  ]
  for (const [id, text, group] of fixed) pair.add(id, text, group)

  const fragments = [
    '默认波特率', '通信失败', '设备出厂', '以太网 USB', 'alpha', 'beta', 'gamma',
    '中', '文', '𠀀', '𠀀𠀁', 'XY123456', 'XY123 234 345 456', '１１５２００',
    '13363538888', '133 635 353 888', 'ＡＬＰＨＡ', '…！？🙂', '', ' ',
  ]
  const separators = [' ', '，', '\n', ' / ', '中', '']
  const groupIds = ['red', 'blue', 'green', undefined] as const
  let state = 0x13b25
  const next = (maximum: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % maximum
  }
  for (let document = 0; document < 64; document += 1) {
    const parts: string[] = []
    const count = 1 + next(7)
    for (let part = 0; part < count; part += 1) parts.push(fragments[next(fragments.length)]!)
    pair.add(`seed-${document.toString().padStart(2, '0')}`, parts.join(separators[next(separators.length)]!), groupIds[next(groupIds.length)])
  }
}

const queries = [
  '默认波特率是多少', 'alpha usb', 'ALPHA alpha beta', '中', '文', '𠀀', '𠀀𠀁',
  '中 alpha 𠀀', 'XY123456', '１２３４５６', '6353', '13363538888', '12', '123',
  'XY12-3456', '115200设备', '…！？🙂', '', ' \t\n ', 'nothingmatches',
] as const

const scopes: readonly (readonly string[] | undefined)[] = [
  undefined, [], ['red'], ['blue'], ['green'], ['red', 'blue'], ['blue', 'red'],
  ['red', 'red', 'blue'], ['missing'], ['missing', 'green', 'red'],
]

function optionCases(pair: Pair): SearchOptions[] {
  const accept = (id: string) => !id.includes('collision') && !id.endsWith('3') && id !== 'tie-a'
  const distinctKey = (id: string) => pair.evidence.get(id) ?? id
  return [
    {}, { limit: 1 }, { limit: 4 }, { limit: 200 }, { limit: 0 }, { limit: -1 },
    { minScore: 0.75, minCoverage: 0.4, limit: 7 },
    { minCoverage: 1, limit: 200 },
    { accept, limit: 11 },
    { distinctKey, limit: 5 },
    { accept, distinctKey, minCoverage: 0.2, minScore: 0.1, limit: 3 },
    { accept: () => false, distinctKey, limit: 200 },
  ]
}

function checkHotScopes(pair: Pair): void {
  // Repeat equivalent scope selections before every mutation. A cached result
  // must remain correct when the next search changes scope, query or options.
  for (let repetition = 0; repetition < 3; repetition += 1) {
    for (const groups of scopes) {
      for (const query of ['alpha 默认波特率', '中', '𠀀', 'XY123456', '']) {
        pair.check(query, { groups, limit: 200 })
        pair.check(query, { groups, limit: 2, distinctKey: id => pair.evidence.get(id) ?? id })
        pair.check(query, { groups, accept: id => id !== 'tie-a', minCoverage: 0.4, limit: 7 })
      }
    }
  }
}

describe('Bm25Index — exact equivalence to frozen af82a01 baseline', () => {
  it.each([
    { name: 'default tokenizer and scoring', options: {} },
    { name: 'custom scoring', options: { k1: 1.9, b: 0.35 } },
    { name: 'bigrams only', options: { trigrams: false } },
    { name: 'trigrams only', options: { bigrams: false } },
    { name: 'whole words and single Han only', options: { bigrams: false, trigrams: false } },
  ])('$name across seeded text, scopes, filters and distinct evidence', ({ options }) => {
    const pair = pairedIndexes(options)
    seededCorpus(pair)
    for (const groups of scopes) {
      for (const query of queries) {
        for (const filters of optionCases(pair)) pair.check(query, { ...filters, groups })
      }
    }
  })

  it('preserves exact score/coverage threshold boundaries and distinct-before-limit', () => {
    const pair = pairedIndexes()
    seededCorpus(pair)
    for (const groups of scopes) {
      for (const query of ['alpha usb', '默认波特率', '中', 'XY123456']) {
        const hits = pair.check(query, { groups, limit: 200 })
        const pivot = hits[Math.floor(hits.length / 2)]
        if (pivot === undefined) continue
        for (const minScore of [pivot.score, pivot.score - Number.EPSILON, pivot.score + Number.EPSILON]) {
          pair.check(query, { groups, minScore, limit: 200 })
        }
        for (const minCoverage of [pivot.coverage, pivot.coverage + Number.EPSILON]) {
          pair.check(query, { groups, minCoverage, limit: 200 })
        }
        for (const limit of [1, 2, 6, 200]) {
          pair.check(query, { groups, limit, distinctKey: id => pair.evidence.get(id) ?? id })
        }
      }
    }
    const ties = pair.check('alpha usb 115200', {
      groups: ['red', 'blue', 'green'], limit: 200, accept: id => id.startsWith('tie-'),
    })
    expect(ties.map(hit => hit.id)).toStrictEqual(['tie-A', 'tie-a', 'tie-z', 'tie-é', 'tie-𠀀'])
    const distinct = pair.check('alpha usb 115200', {
      groups: ['red', 'blue', 'green'], limit: 2,
      accept: id => id.startsWith('tie-') || id === 'long',
      distinctKey: id => pair.evidence.get(id) ?? id,
    })
    expect(distinct).toHaveLength(2)
  })

  it('invalidates hot scopes after text replacement, group reassignment, removal and clear', () => {
    const pair = pairedIndexes()
    seededCorpus(pair)
    const mutations: (() => void)[] = [
      () => pair.add('tie-a', 'beta 文 𠀀 XY123456', 'red'),
      () => pair.add('tie-A', '默认波特率 alpha usb 115200', 'green'),
      () => pair.add('tie-z', '默认波特率 alpha usb 115200'),
      () => pair.add('ungrouped', '默认波特率 alpha usb 115200', 'blue'),
      () => pair.add('empty', 'alpha 中 𠀀', 'green'),
      () => pair.add('long', '', 'red'),
      () => pair.add('new-hidden', 'alpha '.repeat(40) + '中 𠀀', 'hidden'),
      () => pair.remove('tie-é'),
      () => pair.remove('identifier-exact'),
      () => pair.remove('not-present'),
      () => pair.clear(),
      () => pair.add('after-clear', 'alpha 默认波特率 中 𠀀 XY123456', 'red'),
      () => pair.add('after-clear-2', 'alpha 默认波特率 中 𠀀 XY123456', 'blue'),
    ]
    for (const mutate of mutations) {
      checkHotScopes(pair)
      mutate()
      for (const term of ['alpha', '默认', '115200', 'xy123456', '𠀀𠀁']) {
        expect(pair.actual.documentFrequency(term)).toBe(pair.reference.documentFrequency(term))
      }
    }
    checkHotScopes(pair)
    expect(pair.actual.has('tie-a')).toBe(false)
    expect(pair.actual.has('after-clear')).toBe(true)
  })

  it('keeps groupSize equal to external membership after replacements, moves, removals and clear', () => {
    const pair = pairedIndexes()
    const knownGroups = ['red', 'blue', '', 'missing']
    const mutations: (() => void)[] = [
      () => pair.add('a', 'alpha 中 𠀀', 'red'),
      () => pair.add('b', '中', 'red'),
      () => pair.add('empty', '', 'blue'),
      () => pair.add('unassigned', 'alpha 中 𠀀'),
      () => pair.add('empty-name', 'alpha 中 𠀀', ''),
      () => pair.add('a', 'alpha alpha 中 𠀀', 'red'),
      () => pair.add('a', 'alpha alpha 中 𠀀', 'blue'),
      () => pair.add('b', '中'),
      () => pair.add('unassigned', 'alpha 中 𠀀', 'red'),
      () => pair.remove('unassigned'),
      () => pair.remove('empty'),
      () => pair.remove('a'),
      () => pair.remove('empty-name'),
      () => pair.remove('missing'),
      () => pair.clear(),
      () => pair.clear(),
      () => pair.add('a', 'alpha 中 𠀀', 'red'),
    ]
    const checkCounts = () => {
      expect(pair.actual.size).toBe(pair.groups.size)
      for (const group of knownGroups) {
        const expected = [...pair.groups.values()].filter(value => value === group).length
        expect(pair.actual.groupSize(group), JSON.stringify({ group })).toBe(expected)
        for (const query of ['alpha', '中', '𠀀']) {
          pair.check(query, { groups: [group], limit: 200 })
        }
      }
      pair.check('alpha 中 𠀀', { limit: 200 })
    }
    checkCounts()
    for (const mutate of mutations) {
      mutate()
      checkCounts()
    }
  })

  it('keeps selected-scope scores identical through unrelated hidden updates', () => {
    const pair = pairedIndexes()
    pair.add('visible-a', 'alpha 默认波特率 115200 中 𠀀', 'visible')
    pair.add('visible-b', 'alpha alpha USB 通信', 'visible')
    pair.add('visible-han', '中', 'visible')
    pair.add('hidden', 'alpha 中', 'hidden')
    const selected = { groups: ['visible'], limit: 200 } as const
    const before = queries.map(query => pair.check(query, selected))
    const changes = [
      () => pair.add('hidden', 'alpha '.repeat(100) + '默认波特率 中 𠀀 115200', 'hidden'),
      () => pair.add('hidden-new', '中 𠀀', 'hidden'),
      () => pair.add('hidden-empty', '', 'hidden'),
      () => pair.remove('hidden'),
      () => pair.remove('hidden-new'),
    ]
    for (const change of changes) {
      for (let repetition = 0; repetition < 3; repetition += 1) {
        queries.forEach((query, index) => expect(pair.check(query, selected)).toStrictEqual(before[index]))
      }
      change()
      queries.forEach((query, index) => expect(pair.check(query, selected)).toStrictEqual(before[index]))
    }
  })

  it('matches the oracle for a scope containing only Han code points and empty documents', () => {
    const pair = pairedIndexes()
    pair.add('han-one', '中', 'han-only')
    pair.add('han-repeated', '中 中 中', 'han-only')
    pair.add('han-other', '文', 'han-only')
    pair.add('astral-one', '𠀀', 'han-only')
    pair.add('empty', '', 'han-only')
    pair.add('punctuation', '！？🙂', 'han-only')
    pair.add('ordinary-hidden', 'alpha beta 默认波特率 中 𠀀', 'other')
    for (const groups of [['han-only'], ['han-only', 'han-only'], ['missing', 'han-only']]) {
      expect(pair.check('中', { groups, limit: 200 })).toHaveLength(2)
      expect(pair.check('𠀀', { groups, limit: 200 })).toHaveLength(1)
      expect(pair.check('alpha', { groups, limit: 200 })).toStrictEqual([])
      for (const query of ['中 文', '中 𠀀', '中', '𠀀']) {
        pair.check(query, { groups, minCoverage: 0.5, distinctKey: id => id, limit: 200 })
        pair.check(query, { groups, accept: id => id !== 'empty', limit: 200 })
      }
    }
    pair.remove('ordinary-hidden')
    expect(pair.actual.averageLength).toBe(0)
    expect(pair.check('中', { groups: ['han-only'], limit: 200 })).toHaveLength(2)
    pair.add('han-one', 'alpha 中', 'han-only')
    pair.check('中', { groups: ['han-only'], limit: 200 })
    pair.add('han-one', '中', 'han-only')
    expect(pair.actual.averageLength).toBe(0)
    pair.check('中', { groups: ['han-only'], limit: 200 })
  })

  it('uses all accepted documents for Han IDF and only ordinary documents for length statistics', () => {
    const pair = pairedIndexes()
    pair.add('ordinary', 'alpha beta 中 𠀀', 'selected')
    pair.add('han', '中', 'selected')
    pair.add('astral', '𠀀', 'selected')
    pair.add('hidden', 'alpha beta 中 𠀀', 'hidden')
    const groups = ['selected']
    const ordinaryBefore = pair.check('alpha beta', { groups, limit: 200 })
    const hanBefore = pair.check('中', { groups, limit: 200 })
    const astralBefore = pair.check('𠀀', { groups, limit: 200 })
    expect(ordinaryBefore).toHaveLength(1)
    expect(hanBefore).toHaveLength(2)
    expect(astralBefore).toHaveLength(2)

    // Empty and Han-only documents contribute to the single-Han corpus size,
    // but must not dilute ordinary IDF or the mean ordinary document length.
    pair.add('empty', '', 'selected')
    pair.add('unrelated-han', '文', 'selected')
    pair.add('unrelated-astral', '𠀁', 'selected')
    expect(pair.check('alpha beta', { groups, limit: 200 })).toStrictEqual(ordinaryBefore)
    const hanAfter = pair.check('中', { groups, limit: 200 })
    const astralAfter = pair.check('𠀀', { groups, limit: 200 })
    expect(hanAfter[0]!.score).toBeGreaterThan(hanBefore[0]!.score)
    expect(astralAfter[0]!.score).toBeGreaterThan(astralBefore[0]!.score)
    pair.check('中 alpha 𠀀', { groups, minCoverage: 0.5, limit: 200 })
    pair.check('中', { groups, accept: id => id !== 'empty', limit: 200 })

    pair.remove('empty')
    pair.remove('unrelated-han')
    pair.remove('unrelated-astral')
    expect(pair.check('中', { groups, limit: 200 })).toStrictEqual(hanBefore)
    expect(pair.check('𠀀', { groups, limit: 200 })).toStrictEqual(astralBefore)
  })
})
