/**
 * Ordering tests.
 *
 * These pin the property CI broke: an order must not depend on the machine that
 * computed it. The discriminating case is a pair of Han characters whose pinyin
 * order and code-point order disagree — 甲 (jiǎ) before 乙 (yǐ) by pinyin, but
 * 乙 (U+4E59) before 甲 (U+7532) by code point. On a zh-CN desktop a bare
 * `localeCompare` happens to agree with the pinyin answer, so this file can only
 * fail on a machine whose locale is not Chinese — which is exactly where the
 * export has to keep working.
 */

import { describe, expect, it } from 'vitest'
import { compareId, compareText } from '../src/core/order.ts'

/** Sort a copy, so a test never mutates its fixture. */
const sorted = (values: readonly string[]): string[] => [...values].sort(compareText)

describe('compareText — pinyin order, not code-point order', () => {
  it('orders 甲 before 乙, which code points order the other way', () => {
    // The pair CI reported as ['乙', '甲'].
    expect(compareText('甲', '乙')).toBeLessThan(0)
    expect(compareText('乙', '甲')).toBeGreaterThan(0)
    // Guard the premise: if a future runtime made these agree, this test would
    // stop being able to detect the bug it exists for.
    expect('甲' < '乙').toBe(false)
  })

  it('sorts four characters by pinyin rather than by code point', () => {
    // 丙 bǐng < 丁 dīng < 甲 jiǎ < 乙 yǐ
    expect(sorted(['甲', '乙', '丙', '丁'])).toEqual(['丙', '丁', '甲', '乙'])
  })

  it('sorts knowledge-base-like names the way a Chinese reader expects', () => {
    // 产品 chǎn < 刘 liú — the two names in the dev store.
    expect(sorted(['刘一江的信息', '产品资料1'])).toEqual(['产品资料1', '刘一江的信息'])
  })

  it('is not affected by the ambient locale', () => {
    // `localeCompare` with no locale argument is the defect; this asserts the
    // replacement never reaches for it. Compared against the explicit collator
    // so the expectation is stated in terms of the pinned locale, not in terms
    // of whatever this machine happens to default to.
    const pinned = new Intl.Collator('zh-Hans-CN')
    const names = ['甲', '乙', '丙', '丁', '刘一江的信息', '产品资料1']
    expect(sorted(names)).toEqual([...names].sort((a, b) => pinned.compare(a, b)))
  })

  it('never calls the ambient localeCompare', () => {
    // The test above cannot fail on a zh-CN machine, because there the ambient
    // locale gives the same answer the pinned one does — so it only catches the
    // bug where CI caught it. This one catches it anywhere: replace the ambient
    // method with a tripwire, and any implementation that consults it throws
    // here instead of silently reordering somebody's export on another machine.
    const original = String.prototype.localeCompare
    String.prototype.localeCompare = function tripwire(): number {
      throw new Error('ambient localeCompare was consulted')
    }
    try {
      expect(sorted(['甲', '乙', '产品资料1', '刘一江的信息'])).toEqual([
        '产品资料1',
        '甲',
        '刘一江的信息',
        '乙',
      ])
      expect([...['mat_b', 'mat_a']].sort(compareId)).toEqual(['mat_a', 'mat_b'])
    } finally {
      String.prototype.localeCompare = original
    }
  })
})

describe('compareText — total order', () => {
  it('reports 0 only for identical strings', () => {
    expect(compareText('甲', '甲')).toBe(0)
    expect(compareText('', '')).toBe(0)
  })

  it('breaks a collator tie with code points, so equal-ranked text still orders', () => {
    // A collator may call strings equal that are not identical (it can ignore
    // case or punctuation). Without the code-point fallback the order of those
    // two would be left to sort stability, and the export would stop being
    // reproducible. Any pair the collator ties must still get a decisive answer.
    const tied = 'a'
    const other = 'A'
    const byCollation = new Intl.Collator('zh-Hans-CN').compare(tied, other)
    if (byCollation === 0) {
      expect(compareText(tied, other)).toBeGreaterThan(0)
      expect(compareText(other, tied)).toBeLessThan(0)
    } else {
      // On runtimes that do distinguish them, the collator's answer stands.
      expect(compareText(tied, other)).toBe(byCollation)
    }
  })

  it('is antisymmetric on a sample', () => {
    const names = ['甲', '乙', '产品资料1', '刘一江的信息', '', 'a', 'A', '1']
    for (const left of names) {
      for (const right of names) {
        // `===` rather than `toBe`: `Math.sign` returns -0 for a descending
        // equal pair, and `toBe` compares with Object.is, where -0 is not 0.
        expect(Math.sign(compareText(left, right)) === -Math.sign(compareText(right, left))).toBe(
          true,
        )
      }
    }
  })
})

describe('compareId — code points, no collation', () => {
  it('orders by code point', () => {
    expect(compareId('mat_a', 'mat_b')).toBeLessThan(0)
    expect(compareId('kb_1', 'kb_2')).toBeLessThan(0)
    expect(compareId('mat_a', 'mat_a')).toBe(0)
  })

  it('orders uppercase before lowercase, unlike a collator', () => {
    // The reason ids do not go through `compareText`: a collator applies
    // language rules to a token that has no language. Ids are opaque, so the
    // only thing wanted is a fixed total order.
    expect(compareId('A', 'a')).toBeLessThan(0)
    expect(new Intl.Collator('zh-Hans-CN').compare('A', 'a')).toBeGreaterThan(0)
  })

  it('is a total order over the ids this plugin mints', () => {
    const ids = ['kb_a1', 'kb_a2', 'kb_b1', 'mat_a1', 'mat_a2', 'mat_b1']
    expect([...ids].reverse().sort(compareId)).toEqual([...ids].sort(compareId))
  })
})
