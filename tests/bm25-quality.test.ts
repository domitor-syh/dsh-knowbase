import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.ts'
import { tokenize } from '../src/core/tokenize.ts'

describe('BM25 O-04 query guards', () => {
  it.each(['税', '𠀀'])('finds one Han code point %s inside a run', character => {
    const index = new Bm25Index()
    index.add('a', `古文字${character}说明`)
    const hit = index.search(` ${character} `, { minCoverage: 1 })[0]!
    expect(hit).toMatchObject({ id: 'a', coverage: 1, matchedTerms: [character] })
    expect(index.search(character, { accept: () => false })).toEqual([])
  })

  it('does not add single Han terms to ordinary BM25 lengths/frequencies', () => {
    const index = new Bm25Index()
    const text = '增值税申报截止日期'
    index.add('a', text)
    const baselineScore = index.search('申报')[0]!.score
    const averageBefore = index.averageLength
    expect(index.averageLength).toBe(tokenize(text).filter(token => !(Array.from(token).length === 1 && /^[\p{Script=Han}]$/u.test(token))).length)
    expect(index.documentFrequency('税')).toBe(0)
    index.add('single', '税')
    expect(index.averageLength).toBe(averageBefore)
    expect(index.search('申报')[0]!.score).toBeCloseTo(baselineScore, 10)
    expect(index.search('申报')[0]!.coverage).toBe(1)
  })

  it('keeps scores and ranking independent of rejected documents', () => {
    const index = new Bm25Index()
    index.add('a', '税务申报 alpha')
    index.add('b', '申报 alpha alpha')
    const accept = (id: string) => id === 'a' || id === 'b'
    const before = ['申报', '税', '税 alpha'].map(query => index.search(query, { accept }))
    for (let i = 0; i < 20; i += 1) index.add(`hidden${i}`, '税 申报 alpha '.repeat(i + 1))
    expect(['申报', '税', '税 alpha'].map(query => index.search(query, { accept }))).toEqual(before)
    expect(index.search('申报', { accept: () => false })).toEqual([])
  })

  it('finds isolated and mixed single Han terms without ordinary posting pollution', () => {
    const index = new Bm25Index()
    index.add('isolated', '税')
    expect(index.averageLength).toBe(0)
    expect(index.documentFrequency('税')).toBe(0)
    expect(index.search('税')).toMatchObject([{ id: 'isolated', coverage: 1 }])
    index.add('mixed', '税务 alpha')
    expect(index.search('税 alpha', { minCoverage: 1 })).toMatchObject([{ id: 'mixed', coverage: 1 }])
    index.add('isolated', '税 A')
    expect(index.averageLength).toBeGreaterThan(0)
    expect(index.documentFrequency('税')).toBe(0)
    index.remove('mixed')
    index.remove('isolated')
    expect(index.averageLength).toBe(0)
    index.add('again', '申报')
    expect(index.search('申报')[0]!.score).toBeCloseTo(0.28768207245178085, 10)
  })

  it('removes/replaces/clears short-query postings alongside the main index', () => {
    const index = new Bm25Index()
    index.add('a', '增值税申报')
    expect(index.search('税')).toHaveLength(1)
    index.add('a', '园艺种植')
    expect(index.search('税')).toEqual([])
    expect(index.search('园')).toHaveLength(1)
    index.remove('a')
    expect(index.search('园')).toEqual([])
    index.add('b', '增值税申报')
    index.clear()
    index.add('c', '园艺种植')
    expect(index.search('税')).toEqual([])
  })

  it('requires a contiguous long identifier fragment, not scattered grams', () => {
    const index = new Bm25Index()
    index.add('a', '电话13363537216，型号ZX2048')
    for (const query of ['6353', '13363537216', 'ＺＸ２０４８', '2048']) {
      expect(index.search(query).map(hit => hit.id)).toEqual(['a'])
    }
    for (const query of ['13399999999', '6353999', 'ZX2099']) {
      expect(index.search(query)).toEqual([])
    }
  })

  it('retains partial OR recall for mixed, multiword and punctuated queries', () => {
    const index = new Bm25Index()
    index.add('a', '电话13363537216，型号ZX2048')
    for (const query of ['电话13399999999是多少', 'ZX2099 型号', 'ZX-2099']) {
      expect(index.search(query).map(hit => hit.id)).toEqual(['a'])
    }
  })

  it('does not combine identifiers across punctuation or separate runs', () => {
    const index = new Bm25Index()
    index.add('a', '1234 5678')
    index.add('b', '12345678')
    expect(index.search('3456').map(hit => hit.id)).toEqual(['b'])
    index.add('b', '999999')
    expect(index.search('3456')).toEqual([])
  })

  it('uses all candidates to deduplicate before limit, keeping normal zero limit', () => {
    const index = new Bm25Index()
    for (let i = 0; i < 40; i += 1) index.add(`a${i}`, '恢复设置')
    index.add('z', '恢复设置需要备份')
    expect(index.search('恢复设置', { limit: 2, distinctKey: id => id.startsWith('a') ? 'same' : id }).map(hit => hit.id)).toEqual(['a0', 'z'])
    expect(index.search('恢复设置', { limit: 0, distinctKey: id => id })).toEqual([])
  })
})
