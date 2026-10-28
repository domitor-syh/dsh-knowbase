import type { SearchHit } from './bm25.ts'
import { compareText } from './order.ts'
import { tokenize } from './tokenize.ts'

export interface EvidenceSource {
  /** Includes both KB and material identity. */
  readonly key: string
  readonly ordinal: number
  /** Original body only: title repetition must not count as body redundancy. */
  readonly text: string
}

const normalize = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let common = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const term of small) if (large.has(term)) common++
  return common / (left.size + right.size - common)
}

/**
 * Source-aware, relevance-constrained diversification over ALL scored candidates.
 * Inspired by document grouping and MMR, using lexical body overlap (no vectors).
 * Raw BM25 score/coverage are retained; output is selection order, not score order.
 */
export function selectEvidence(
  hits: readonly SearchHit[], limit: number, sourceOf: (id: string) => EvidenceSource,
): SearchHit[] {
  if (limit <= 0 || hits.length === 0) return []
  const sources = new Map<string, EvidenceSource>()
  const source = (hit: SearchHit): EvidenceSource => {
    let value = sources.get(hit.id)
    if (!value) { value = sourceOf(hit.id); sources.set(hit.id, value) }
    return value
  }
  // Source/ordinal tie breaks survive rebuilt random chunk ids and upload order.
  const ranked = [...hits].sort((a, b) => b.score - a.score ||
    compareText(source(a).key, source(b).key) || source(a).ordinal - source(b).ordinal)
  const selected: SearchHit[] = []
  const used = new Set<string>()
  const counts = new Map<string, number>()
  const similarities = new Map<string, { through: number; maximum: number }>()
  const bodies = new Map<string, Set<string>>()
  const seenText = new Map<string, Set<string>>()
  const normalizedBodies = new Map<string, string>()
  const normalizedBody = (hit: SearchHit): string => {
    let value = normalizedBodies.get(hit.id)
    if (value === undefined) { value = normalize(source(hit).text); normalizedBodies.set(hit.id, value) }
    return value
  }
  const terms = (hit: SearchHit): Set<string> => {
    let value = bodies.get(hit.id)
    if (!value) { value = new Set(tokenize(source(hit).text)); bodies.set(hit.id, value) }
    return value
  }
  const duplicate = (hit: SearchHit): boolean => seenText.get(source(hit).key)?.has(normalizedBody(hit)) === true
  while (selected.length < limit) {
    const strongest = ranked.find(hit => !used.has(hit.id) && !duplicate(hit))
    if (!strongest) break
    let best = strongest
    let bestUtility = -Infinity
    for (const hit of ranked) {
      // Penalties never increase relevance: lower scores cannot beat this bound.
      if (hit.score / strongest.score < bestUtility) break
      if (hit.score < strongest.score * 0.65) break
      if (used.has(hit.id) || hit.coverage < strongest.coverage * 0.8 || duplicate(hit)) continue
      const key = source(hit).key
      const count = counts.get(key) ?? 0
      const similarity = similarities.get(hit.id) ?? { through: 0, maximum: 0 }
      if (count > 0) for (let i = similarity.through; i < selected.length; i++) {
        const prior = selected[i]!
        if (source(prior).key === key) similarity.maximum = Math.max(similarity.maximum, jaccard(terms(hit), terms(prior)))
      }
      similarity.through = selected.length
      similarities.set(hit.id, similarity)
      const redundancy = similarity.maximum
      // Soft source grouping, not a quota: backfill the same source when appropriate.
      const utility = (hit.score / strongest.score) / (1 + 0.5 * count) * (1 - 0.25 * redundancy)
      if (utility > bestUtility) { best = hit; bestUtility = utility }
    }
    selected.push(best)
    used.add(best.id)
    const key = source(best).key
    counts.set(key, (counts.get(key) ?? 0) + 1)
    let texts = seenText.get(key)
    if (!texts) { texts = new Set(); seenText.set(key, texts) }
    texts.add(normalizedBody(best))
  }
  return selected
}
