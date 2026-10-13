/**
 * The total orders everything in this plugin sorts by.
 *
 * ## Why this module exists
 *
 * `String.prototype.localeCompare` with no locale argument uses the *ambient*
 * locale, so the same data comes out in different orders on different machines.
 * CI found that the hard way. An export ordered by name came back
 * `['乙', '甲']` on the Linux runner and `['甲', '乙']` on a zh-CN desktop: the
 * runner's root collation orders Han by code point (`乙` = U+4E59 before
 * `甲` = U+7532), while a Chinese locale orders by pinyin (`甲` jiǎ before
 * `乙` yǐ).
 *
 * That matters here rather than being a cosmetic difference, because the backup
 * export promises that unchanged data serialises to the *same bytes* — that is
 * what makes a backup diffable, and what makes 「变了没有」 answerable without
 * opening the app. An order that depends on where the export ran defeats that
 * promise, and it does so silently: the file still looks fine.
 *
 * The same defect sat in two more places. `listKnowledgeBases()` orders what the
 * settings page and the scope picker show, so the list was not the same list on
 * two machines; and the BM25 tiebreaker exists precisely so that "a result set
 * is reproducible rather than dependent on Map insertion order" — which a
 * locale-dependent comparison cannot deliver either.
 *
 * ## The two orders
 *
 * `compareText` is for text a person reads: knowledge base names, material
 * titles. It pins the collation to Simplified Chinese pinyin so Chinese names
 * sort the way a Chinese reader expects *regardless of the host's locale*, and
 * falls back to code points for anything the collator calls equal — so the order
 * is total, never left to `Array.prototype.sort` stability.
 *
 * `compareId` is for opaque identifiers (`kb_…`, `mat_…`). Nobody reads these as
 * language, and the only property needed is that the order is total and fixed.
 * Code points give that with no collation data involved at all — which is the
 * point, since a collator applies language rules to a token that has no language
 * (it orders `a` before `A`, the reverse of code points).
 *
 * ## What this module does not promise
 *
 * Pinning the locale removes the dependency on *where* the code runs; it does
 * not remove the dependency on ICU data, which ships with the runtime. For the
 * common Han characters a knowledge base name is made of, pinyin order has been
 * stable across ICU versions for years. `tests/order.test.ts` asserts the pinyin
 * order directly, so a runtime whose ICU cannot do it fails loudly here instead
 * of silently reordering an export.
 *
 * @module @domitor-syh/dsh-knowbase/core/order
 */

/**
 * Pinned so the ambient locale cannot influence the result.
 *
 * Built once at module load: constructing a collator is not free, and this one
 * is used on every list and every export.
 */
const TEXT_COLLATOR = new Intl.Collator('zh-Hans-CN')

/**
 * Order text a person reads, by pinned Simplified Chinese pinyin.
 *
 * Use for anything shown to a user or written into a user-facing file — names,
 * titles, labels.
 *
 * @param left - one string.
 * @param right - the other.
 * @returns negative if `left` sorts first, positive if `right` does, `0` only
 *   for identical strings.
 */
export function compareText(left: string, right: string): number {
  const byCollation = TEXT_COLLATOR.compare(left, right)
  // A collator may report equality for strings that differ (it can ignore
  // punctuation, and at the default strength it can ignore case). Falling
  // through to code points keeps the order total, which is what makes a sorted
  // export reproducible rather than dependent on input order.
  if (byCollation !== 0) return byCollation
  return compareId(left, right)
}

/**
 * Order opaque identifiers by code point.
 *
 * Use for ids, never for names: this order is stable everywhere but means
 * nothing to a reader.
 *
 * @param left - one id.
 * @param right - the other.
 * @returns negative if `left` sorts first, positive if `right` does, `0` only
 *   for identical strings.
 */
export function compareId(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}
