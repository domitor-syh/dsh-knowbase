/**
 * Tokenizer tests.
 *
 * Chinese retrieval quality is decided here, not in the ranking code: if the
 * n-grams are wrong, no amount of BM25 tuning recovers the recall.
 */

import { describe, expect, it } from 'vitest'
import { isHan, termFrequencies, tokenize } from '../src/core/tokenize.ts'

describe('isHan', () => {
  it('accepts Han and rejects everything else', () => {
    expect(isHan('波')).toBe(true)
    expect(isHan('，')).toBe(false)
    expect(isHan('a')).toBe(false)
    expect(isHan('1')).toBe(false)
  })

  it('accepts astral-plane ideographs', () => {
    // U+20000, CJK Extension B — two UTF-16 units, one code point.
    expect(isHan('𠀀')).toBe(true)
  })
})

describe('tokenize — Han runs', () => {
  it('emits overlapping bi-grams and tri-grams', () => {
    expect(tokenize('波特率')).toEqual(['波特', '特率', '波特率'])
  })

  it('emits only the bi-gram for a two-character run', () => {
    expect(tokenize('波特')).toEqual(['波特'])
  })

  it('keeps a single character whole', () => {
    // Without this a one-character query could never match anything.
    expect(tokenize('率')).toEqual(['率'])
  })

  it('splits runs at punctuation', () => {
    expect(tokenize('波特率，默认值')).toEqual(['波特', '特率', '波特率', '默认', '认值', '默认值'])
  })
})

describe('tokenize — Latin and digits', () => {
  it('keeps whole words and folds case', () => {
    expect(tokenize('USB Port')).toEqual(['usb', 'port'])
  })

  it('keeps model numbers intact', () => {
    expect(tokenize('BR-115200')).toEqual(['br', '115200'])
  })

  it('does not n-gram Latin text', () => {
    // Character n-grams on ASCII would multiply the index for no recall gain.
    expect(tokenize('abc')).toEqual(['abc'])
  })

  it('does not let a Latin word swallow the Chinese that follows it', () => {
    // `\p{L}` matches Han too, so a naive word-run test collapses
    // `支持USB与以太网` into the single token `usb与以太网`, and every Chinese
    // term inside it disappears from the index. Mixed text is the normal case.
    const tokens = tokenize('支持USB与以太网')
    expect(tokens).toContain('usb')
    expect(tokens).toContain('以太')
    expect(tokens).toContain('太网')
    expect(tokens).not.toContain('usb与以太网')
  })

  it('splits a Latin word from Chinese on both sides', () => {
    expect(tokenize('波特率115200bps')).toEqual(['波特', '特率', '波特率', '115200bps'])
    expect(tokenize('USB接口')).toEqual(['usb', '接口'])
  })
})

describe('tokenize — normalization', () => {
  it('folds full-width digits so a Chinese document answers an ASCII query', () => {
    expect(tokenize('１１５２００')).toEqual(['115200'])
  })

  it('folds full-width Latin', () => {
    expect(tokenize('ＵＳＢ')).toEqual(['usb'])
  })
})

describe('tokenize — mixed and edge cases', () => {
  it('handles mixed Chinese, Latin and digits', () => {
    expect(tokenize('波特率115200bps')).toEqual([
      '波特',
      '特率',
      '波特率',
      '115200bps',
    ])
  })

  it('returns nothing for empty or separator-only input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   \n\t')).toEqual([])
    expect(tokenize('，。！？')).toEqual([])
  })

  it('can be restricted to one n-gram order', () => {
    expect(tokenize('波特率', { trigrams: false })).toEqual(['波特', '特率'])
    expect(tokenize('波特率', { bigrams: false })).toEqual(['波特率'])
  })
})

describe('termFrequencies', () => {
  it('counts repeats while preserving first-seen order', () => {
    const frequencies = termFrequencies(['a', 'b', 'a'])
    expect([...frequencies]).toEqual([
      ['a', 2],
      ['b', 1],
    ])
  })
})
