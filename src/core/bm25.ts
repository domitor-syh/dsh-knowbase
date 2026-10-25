/**
 * BM25 over the n-gram term space from `./tokenize.ts`.
 *
 * Why BM25 and not embeddings: it needs no model, no download, no API key and
 * no external send, so the whole retrieval path stays local and inspectable.
 * The trade-off is real and is stated in the UI rather than hidden — synonym
 * rewrites and purely semantic matches are weak, and "no result" means "no
 * keyword match", not "the answer is absent".
 *
 * Two deliberate choices beyond textbook BM25:
 *
 * - **Coverage is reported alongside the score.** A long document can outrank a
 *   short precise one on term frequency alone while covering only one word of
 *   the question. The caller needs to see that, because a low-coverage hit is
 *   the plan's definition of "effectively a miss".
 * - **Removal is supported, not just rebuild.** Materials get edited, deleted
 *   and re-ingested; an index that can only grow would force a full rebuild on
 *   every change, and a full rebuild is exactly what the plan forbids on the
 *   interactive path.
 *
 * @module @domitor-syh/dsh-knowbase/core/bm25
 */

import { compareId } from './order.ts'
import { isHan, termFrequencies, tokenize, type TokenizeOptions } from './tokenize.ts'

/** One scored result. */
export interface SearchHit {
  /** Document id, as supplied to {@link Bm25Index.add}. */
  readonly id: string
  /** BM25 score; only meaningful for ranking within one query. */
  readonly score: number
  /** Fraction of the query's distinct terms present in the document, 0..1. */
  readonly coverage: number
  /** The distinct query terms that matched, in query order. */
  readonly matchedTerms: readonly string[]
}

/** Filtering applied after scoring. */
export interface SearchOptions {
  /** Maximum results. Default 6, the plan's context budget. */
  readonly limit?: number
  /** Drop hits scoring at or below this. Default 0. */
  readonly minScore?: number
  /** Drop hits covering less than this fraction of the query. Default 0. */
  readonly minCoverage?: number
  /**
   * Reject a document before it is scored.
   *
   * Scope filtering has to happen here rather than on the result list: if the
   * caller filters afterwards, hits from out-of-scope documents consume the
   * `limit` and the answer silently comes back short. The plan states the same
   * rule — filter during recall, then re-validate before returning.
   */
  readonly accept?: (id: string) => boolean
  /** Restrict recall and BM25 statistics to these add-time groups; intersected with accept. */
  readonly groups?: readonly string[]
  /** Collapse equivalent evidence BEFORE applying limit; best-ranked source wins. */
  readonly distinctKey?: (id: string) => string
}

/** Tunables, exposed for calibration against a real question set. */
export interface Bm25Options extends TokenizeOptions {
  /** Term-frequency saturation. Default 1.2. */
  readonly k1?: number
  /** Length normalization strength, 0..1. Default 0.75. */
  readonly b?: number
}

interface IndexedDocument {
  readonly length: number
  readonly frequencies: ReadonlyMap<string, number>
  readonly hanFrequencies: ReadonlyMap<string, number>
  readonly identifiers: readonly string[]
  readonly groupId: string | undefined
}

interface DocumentGroup {
  readonly documents: Map<string, IndexedDocument>
  readonly documentFrequencies: Map<string, number>
  readonly hanDocumentFrequencies: Map<string, number>
  totalLength: number
  ordinaryDocumentCount: number
}

/** Same normalization as tokenize; Han must terminate a Latin/digit run. */
function identifierRuns(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  return words.flatMap(word => word.split(/[\p{Script=Han}]+/u)).filter(word => /\d/u.test(word))
}

/** An inverted index with BM25 ranking over n-gram terms. */
export class Bm25Index {
  readonly #k1: number
  readonly #b: number
  readonly #tokenizeOptions: TokenizeOptions
  readonly #documents = new Map<string, IndexedDocument>()
  readonly #postings = new Map<string, Map<string, number>>()
  readonly #hanPostings = new Map<string, Map<string, number>>()
  readonly #groups = new Map<string | undefined, DocumentGroup>()
  #totalLength = 0
  #ordinaryDocumentCount = 0

  constructor(options: Bm25Options = {}) {
    this.#k1 = options.k1 ?? 1.2
    this.#b = options.b ?? 0.75
    this.#tokenizeOptions = { bigrams: options.bigrams, trigrams: options.trigrams }
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.#documents.size
  }

  /** Mean document length in terms; 0 when empty. */
  get averageLength(): number {
    return this.#ordinaryDocumentCount === 0 ? 0 : this.#totalLength / this.#ordinaryDocumentCount
  }

  /** Whether a document id is indexed. */
  has(id: string): boolean {
    return this.#documents.has(id)
  }

  /** Indexed documents in one named group, including Han-only/empty documents. */
  groupSize(groupId: string): number {
    return this.#groups.get(groupId)?.documents.size ?? 0
  }

  /**
   * Add or replace a document.
   *
   * Replacing is the same call as adding, so an edited material does not need a
   * separate code path — and cannot leave stale postings behind.
   */
  add(id: string, text: string, groupId?: string): void {
    if (this.#documents.has(id)) this.remove(id)

    const tokens = tokenize(text, this.#tokenizeOptions)
    // Single Han characters have a dedicated code-point posting list. Keeping
    // them out of ordinary BM25 statistics prevents adding an unrelated one-
    // character document from changing every multi-character query's IDF or
    // length normalization.
    const frequencies = termFrequencies(tokens.filter(token => !(Array.from(token).length === 1 && isHan(token))))
    const hanFrequencies = termFrequencies(Array.from(text.normalize('NFKC').toLowerCase()).filter(character => isHan(character)))
    const identifiers = identifierRuns(text)
    const length = [...frequencies.values()].reduce((sum, frequency) => sum + frequency, 0)
    const document = { length, frequencies, hanFrequencies, identifiers, groupId }
    this.#documents.set(id, document)
    this.#totalLength += length
    if (frequencies.size > 0) this.#ordinaryDocumentCount += 1
    let group = this.#groups.get(groupId)
    if (group === undefined) {
      group = { documents: new Map(), documentFrequencies: new Map(), hanDocumentFrequencies: new Map(), totalLength: 0, ordinaryDocumentCount: 0 }
      this.#groups.set(groupId, group)
    }
    group.documents.set(id, document)
    group.totalLength += length
    if (frequencies.size > 0) group.ordinaryDocumentCount += 1

    for (const [term, frequency] of frequencies) {
      let posting = this.#postings.get(term)
      if (posting === undefined) {
        posting = new Map()
        this.#postings.set(term, posting)
      }
      posting.set(id, frequency)
      group.documentFrequencies.set(term, (group.documentFrequencies.get(term) ?? 0) + 1)
    }

    for (const [term, frequency] of hanFrequencies) {
      let posting = this.#hanPostings.get(term)
      if (posting === undefined) {
        posting = new Map()
        this.#hanPostings.set(term, posting)
      }
      posting.set(id, frequency)
      group.hanDocumentFrequencies.set(term, (group.hanDocumentFrequencies.get(term) ?? 0) + 1)
    }
  }

  /** Remove a document. Returns whether it was present. */
  remove(id: string): boolean {
    const document = this.#documents.get(id)
    if (document === undefined) return false

    this.#documents.delete(id)
    this.#totalLength -= document.length
    if (document.frequencies.size > 0) this.#ordinaryDocumentCount -= 1
    const group = this.#groups.get(document.groupId)!
    group.documents.delete(id)
    group.totalLength -= document.length
    if (document.frequencies.size > 0) group.ordinaryDocumentCount -= 1
    if (group.documents.size === 0) this.#groups.delete(document.groupId)

    for (const term of document.frequencies.keys()) {
      const remaining = group.documentFrequencies.get(term)! - 1
      if (remaining === 0) group.documentFrequencies.delete(term)
      else group.documentFrequencies.set(term, remaining)
      const posting = this.#postings.get(term)
      if (posting === undefined) continue
      posting.delete(id)
      // An empty posting list is dead weight that would also inflate nothing —
      // document frequency reads `posting.size` — but leaving it keeps a term
      // alive forever after its last document is gone.
      if (posting.size === 0) this.#postings.delete(term)
    }
    for (const term of document.hanFrequencies.keys()) {
      const remaining = group.hanDocumentFrequencies.get(term)! - 1
      if (remaining === 0) group.hanDocumentFrequencies.delete(term)
      else group.hanDocumentFrequencies.set(term, remaining)
      const posting = this.#hanPostings.get(term)
      if (posting === undefined) continue
      posting.delete(id)
      if (posting.size === 0) this.#hanPostings.delete(term)
    }

    return true
  }

  /** Drop every document. */
  clear(): void {
    this.#documents.clear()
    this.#postings.clear()
    this.#hanPostings.clear()
    this.#groups.clear()
    this.#totalLength = 0
    this.#ordinaryDocumentCount = 0
  }

  /**
   * Rank documents against a query.
   *
   * Distinct query terms are scored once each: a short question that repeats a
   * word is not a stronger request for that word.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const { limit = 6, minScore = 0, minCoverage = 0, accept, groups, distinctKey } = options
    if (limit <= 0 || this.#documents.size === 0) return []

    const normalizedQuery = query.normalize('NFKC').toLowerCase().trim()
    const queryTerms = [...new Set(tokenize(normalizedQuery, this.#tokenizeOptions))]
    const queryCharacters = Array.from(normalizedQuery)
    const singleHanQuery = queryCharacters.length === 1 && isHan(queryCharacters[0]!)
    if (queryTerms.length === 0 && !singleHanQuery) return []

    // Preserve legacy 2–3-character fragment recall. Longer identifier-only
    // queries must occur CONTIGUOUSLY inside one indexed run, not merely share
    // a few n-grams. Mixed questions, multiword queries and punctuation retain
    // normal OR recall; this is not an implicit AND/semantic query rewrite.
    const identifierQuery = queryCharacters.length >= 4 &&
      /^[\p{L}\p{N}]+$/u.test(normalizedQuery) && /\d/u.test(normalizedQuery) &&
      !queryCharacters.some(character => isHan(character))
    // Group totals are maintained by add/remove; arbitrary accept stays uncached.
    let selectedGroups: DocumentGroup[] | undefined
    let groupIds: Set<string> | undefined
    let scopeSize = this.#documents.size
    let total = this.#ordinaryDocumentCount
    let totalLength = this.#totalLength
    if (groups !== undefined) {
      groupIds = new Set(groups)
      selectedGroups = []
      scopeSize = 0
      total = 0
      totalLength = 0
      for (const groupId of groupIds) {
        const group = this.#groups.get(groupId)
        if (group === undefined) continue
        selectedGroups.push(group)
        scopeSize += group.documents.size
        total += group.ordinaryDocumentCount
        totalLength += group.totalLength
      }
    }
    let accepted: Set<string> | undefined
    if (accept !== undefined) {
      accepted = new Set()
      total = 0
      totalLength = 0
      const ranges = selectedGroups === undefined || scopeSize === this.#documents.size
        ? [this.#documents] : selectedGroups.map(group => group.documents)
      for (const documents of ranges) for (const [id, document] of documents) {
        if (!accept(id)) continue
        accepted.add(id)
        if (document.frequencies.size > 0) {
          total += 1
          totalLength += document.length
        }
      }
      scopeSize = accepted.size
    }
    if (scopeSize === 0) return []
    const unfiltered = scopeSize === this.#documents.size
    const average = totalLength / total || 1
    const accumulated = new Map<string, { score: number; matched: Set<string> }>()
    // Shared identifier grams revisit candidates; memoize only within this query.
    const identifierMatches = identifierQuery ? new Map<string, boolean>() : undefined
    for (const term of singleHanQuery ? [queryCharacters[0]!] : queryTerms) {
      const hanTerm = Array.from(term).length === 1 && isHan(term)
      const posting = (hanTerm ? this.#hanPostings : this.#postings).get(term)
      if (posting === undefined) continue
      let candidateIds: Iterable<string> = posting.keys()
      let documentFrequency = posting.size
      if (accepted !== undefined && !unfiltered) {
        const intersection: string[] = []
        if (posting.size <= scopeSize) {
          for (const id of posting.keys()) if (accepted.has(id)) intersection.push(id)
        } else {
          for (const id of accepted) if (posting.has(id)) intersection.push(id)
        }
        candidateIds = intersection
        documentFrequency = intersection.length
      } else if (!unfiltered) {
        documentFrequency = 0
        for (const group of selectedGroups!) {
          documentFrequency += (hanTerm ? group.hanDocumentFrequencies : group.documentFrequencies).get(term) ?? 0
        }
        if (documentFrequency === 0) continue
        if (documentFrequency !== posting.size) {
          const intersection: string[] = []
          if (posting.size <= scopeSize) {
            for (const id of posting.keys()) {
              if (groupIds!.has(this.#documents.get(id)!.groupId!)) intersection.push(id)
            }
          } else {
            for (const group of selectedGroups!) for (const id of group.documents.keys()) {
              if (posting.has(id)) intersection.push(id)
            }
          }
          candidateIds = intersection
        }
      }
      // Scope DF precedes the identifier guard; Han-only documents count only
      // toward the single-Han corpus size, matching the original denominator.
      const corpusSize = hanTerm ? scopeSize : total
      const idf = Math.log(1 + (corpusSize - documentFrequency + 0.5) / (documentFrequency + 0.5))
      for (const id of candidateIds) {
        const frequency = posting.get(id)!
        const document = this.#documents.get(id)!
        if (identifierMatches !== undefined) {
          let matches = identifierMatches.get(id)
          if (matches === undefined) {
            matches = document.identifiers.some(identifier => identifier.includes(normalizedQuery))
            identifierMatches.set(id, matches)
          }
          if (!matches) continue
        }
        const normalization = frequency + this.#k1 * (1 - this.#b + this.#b * (document.length / average))
        const contribution = (idf * (frequency * (this.#k1 + 1))) / normalization
        const entry = accumulated.get(id) ?? { score: 0, matched: new Set<string>() }
        entry.score += contribution
        entry.matched.add(term)
        accumulated.set(id, entry)
      }
    }

    const hits: SearchHit[] = []
    for (const [id, entry] of accumulated) {
      const coverage = singleHanQuery ? 1 : entry.matched.size / queryTerms.length
      if (entry.score <= minScore || coverage < minCoverage) continue
      hits.push({ id, score: entry.score, coverage, matchedTerms: singleHanQuery ? [queryCharacters[0]!] : queryTerms.filter(term => entry.matched.has(term)) })
    }

    hits.sort((left, right) => right.score - left.score || compareId(left.id, right.id))
    if (distinctKey === undefined) return hits.slice(0, limit)
    const distinct: SearchHit[] = []
    const seen = new Set<string>()
    for (const hit of hits) {
      const key = distinctKey(hit.id)
      if (seen.has(key)) continue
      seen.add(key)
      distinct.push(hit)
      if (distinct.length >= limit) break
    }
    return distinct
  }

  /** How many indexed documents contain a term. Diagnostics and tests. */
  documentFrequency(term: string): number {
    return this.#postings.get(term)?.size ?? 0
  }
}
