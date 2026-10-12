/**
 * BM25 index tests.
 *
 * The first test is the one that matters: a Chinese question must find the
 * Chinese passage that answers it. Everything else guards the properties that
 * keep an incrementally-updated index honest.
 */

import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.ts'

/** A small corpus of the kind the plugin is actually for. */
function deviceCorpus(): Bm25Index {
  const index = new Bm25Index()
  index.add('d1', '设备出厂默认波特率为115200，可在配置文件中修改。')
  index.add('d2', '本产品支持USB与以太网两种连接方式。')
  index.add('d3', '波特率配置错误会导致通信失败。')
  return index
}

describe('Bm25Index — Chinese retrieval', () => {
  it('ranks the passage that answers the question first', () => {
    const hits = deviceCorpus().search('默认波特率是多少')
    expect(hits[0]?.id).toBe('d1')
  })

  it('still returns a partially matching passage, ranked lower', () => {
    const ids = deviceCorpus()
      .search('默认波特率是多少', { limit: 10 })
      .map(hit => hit.id)
    expect(ids).toContain('d3')
    expect(ids.indexOf('d1')).toBeLessThan(ids.indexOf('d3'))
  })

  it('returns nothing when no term matches at all', () => {
    expect(deviceCorpus().search('如何申请报销差旅费用')).toEqual([])
  })

  it('matches a model number across full-width and ASCII forms', () => {
    const index = new Bm25Index()
    index.add('a', '波特率１１５２００')
    expect(index.search('115200').map(hit => hit.id)).toEqual(['a'])
  })
})

describe('Bm25Index — weighting', () => {
  it('weights a rare term above a term present in every document', () => {
    const index = new Bm25Index()
    for (let i = 0; i < 10; i += 1) index.add(`common${i}`, '通信')
    index.add('rare', '通信 以太网')

    const rareScore = index.search('以太网')[0]!.score
    const commonScore = index.search('通信')[0]!.score
    expect(rareScore).toBeGreaterThan(commonScore)
  })

  it('breaks ties by id so a result set is reproducible', () => {
    const index = new Bm25Index()
    index.add('b', '波特率')
    index.add('a', '波特率')
    expect(index.search('波特率').map(hit => hit.id)).toEqual(['a', 'b'])
  })
})

describe('Bm25Index — coverage', () => {
  it('reports the fraction of distinct query terms matched', () => {
    const index = new Bm25Index()
    index.add('full', '默认波特率为115200')
    index.add('partial', '波特率说明')

    const hits = index.search('默认波特率', { limit: 10 })
    const full = hits.find(hit => hit.id === 'full')!
    const partial = hits.find(hit => hit.id === 'partial')!

    expect(full.coverage).toBe(1)
    expect(partial.coverage).toBeLessThan(full.coverage)
  })

  it('drops hits below a coverage threshold', () => {
    const index = new Bm25Index()
    index.add('full', '默认波特率为115200')
    index.add('partial', '波特率说明')

    expect(index.search('默认波特率', { minCoverage: 0.9 }).map(hit => hit.id)).toEqual(['full'])
  })

  it('lists the matched terms in query order', () => {
    const index = new Bm25Index()
    index.add('a', '默认波特率')
    const [hit] = index.search('默认波特率')
    expect(hit!.matchedTerms.length).toBeGreaterThan(0)
    expect(hit!.matchedTerms).toContain('波特')
  })
})

describe('Bm25Index — incremental maintenance', () => {
  it('removes a document and its postings', () => {
    const index = new Bm25Index()
    index.add('a', '波特率')
    expect(index.documentFrequency('波特')).toBe(1)

    expect(index.remove('a')).toBe(true)
    expect(index.size).toBe(0)
    expect(index.documentFrequency('波特')).toBe(0)
    expect(index.search('波特率')).toEqual([])
  })

  it('reports removing an unknown id rather than silently succeeding', () => {
    expect(new Bm25Index().remove('missing')).toBe(false)
  })

  it('replaces on re-add instead of keeping stale postings', () => {
    // An edited material must not stay findable under its old text.
    const index = new Bm25Index()
    index.add('a', '波特率')
    index.add('a', '以太网')

    expect(index.size).toBe(1)
    expect(index.documentFrequency('波特')).toBe(0)
    expect(index.documentFrequency('以太')).toBe(1)
  })

  it('keeps the average length consistent across add and remove', () => {
    const index = new Bm25Index()
    index.add('a', '波特率')
    const afterAdd = index.averageLength
    expect(afterAdd).toBeGreaterThan(0)
    index.remove('a')
    expect(index.averageLength).toBe(0)
  })

  it('clears everything', () => {
    const index = deviceCorpus()
    index.clear()
    expect(index.size).toBe(0)
    expect(index.search('波特率')).toEqual([])
  })
})

describe('Bm25Index — identifier prefix search', () => {
  /** Two phone numbers, the shape that exposed the problem. */
  function phoneIndex(): Bm25Index {
    const index = new Bm25Index()
    index.add('phone', '13363537216')
    index.add('other', '13800138000')
    return index
  }

  it('finds an identifier from its first few characters', () => {
    // The reported failure: the tokenizer keeps a number whole on purpose, so
    // `133` and `13363537216` were different terms and nothing matched.
    expect(phoneIndex().search('133').map(hit => hit.id)).toEqual(['phone'])
  })

  it('still finds it from the complete number', () => {
    expect(phoneIndex().search('13363537216').map(hit => hit.id)).toEqual(['phone'])
  })

  it('does not expand a two-character numeric query', () => {
    // `13` would match most of a phone-number column; that is noise, not recall.
    expect(phoneIndex().search('13')).toEqual([])
  })

  it('does not expand Latin words', () => {
    // Prefix-matching words is stemming, which is a different decision.
    const index = new Bm25Index()
    index.add('a', 'ports')
    expect(index.search('port')).toEqual([])
  })

  it('counts a prefix match as exactly one matched query term', () => {
    // Coverage must not inflate: one query token is one term however many index
    // terms it expanded to.
    const [hit] = phoneIndex().search('133')
    expect(hit!.coverage).toBe(1)
    expect(hit!.matchedTerms).toEqual(['133'])
  })

  it('picks up a newly added identifier without a rebuild', () => {
    const index = new Bm25Index()
    index.add('a', '111222333')
    expect(index.search('999')).toEqual([])
    index.add('b', '999888777')
    expect(index.search('999').map(hit => hit.id)).toEqual(['b'])
  })

  it('forgets a removed identifier', () => {
    const index = new Bm25Index()
    index.add('a', '13363537216')
    expect(index.remove('a')).toBe(true)
    expect(index.search('133')).toEqual([])
  })
})

describe('Bm25Index — input handling', () => {
  it('returns nothing for an empty query or an empty index', () => {
    expect(deviceCorpus().search('')).toEqual([])
    expect(deviceCorpus().search('，。！')).toEqual([])
    expect(new Bm25Index().search('波特率')).toEqual([])
  })

  it('honours the limit', () => {
    expect(deviceCorpus().search('波特率', { limit: 1 })).toHaveLength(1)
    expect(deviceCorpus().search('波特率', { limit: 0 })).toEqual([])
  })

  it('scores a repeated query term once, not once per occurrence', () => {
    const index = new Bm25Index()
    index.add('a', '波特率')
    const once = index.search('波特率')[0]!.score
    const twice = index.search('波特率 波特率')[0]!.score
    expect(twice).toBeCloseTo(once, 10)
  })
})
