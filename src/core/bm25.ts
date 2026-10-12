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

import { termFrequencies, tokenize, type TokenizeOptions } from './tokenize.ts'

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
}

/** An inverted index with BM25 ranking over n-gram terms. */
export class Bm25Index {
  readonly #k1: number
  readonly #b: number
  readonly #tokenizeOptions: TokenizeOptions
  readonly #documents = new Map<string, IndexedDocument>()
  readonly #postings = new Map<string, Map<string, number>>()
  #totalLength = 0

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
    return this.#documents.size === 0 ? 0 : this.#totalLength / this.#documents.size
  }

  /** Whether a document id is indexed. */
  has(id: string): boolean {
    return this.#documents.has(id)
  }

  /**
   * Add or replace a document.
   *
   * Replacing is the same call as adding, so an edited material does not need a
   * separate code path — and cannot leave stale postings behind.
   */
  add(id: string, text: string): void {
    if (this.#documents.has(id)) this.remove(id)

    const tokens = tokenize(text, this.#tokenizeOptions)
    const frequencies = termFrequencies(tokens)
    this.#documents.set(id, { length: tokens.length, frequencies })
    this.#totalLength += tokens.length

    for (const [term, frequency] of frequencies) {
      let posting = this.#postings.get(term)
      if (posting === undefined) {
        posting = new Map()
        this.#postings.set(term, posting)
      }
      posting.set(id, frequency)
    }
  }

  /** Remove a document. Returns whether it was present. */
  remove(id: string): boolean {
    const document = this.#documents.get(id)
    if (document === undefined) return false

    this.#documents.delete(id)
    this.#totalLength -= document.length

    for (const term of document.frequencies.keys()) {
      const posting = this.#postings.get(term)
      if (posting === undefined) continue
      posting.delete(id)
      // An empty posting list is dead weight that would also inflate nothing —
      // document frequency reads `posting.size` — but leaving it keeps a term
      // alive forever after its last document is gone.
      if (posting.size === 0) this.#postings.delete(term)
    }

    return true
  }

  /** Drop every document. */
  clear(): void {
    this.#documents.clear()
    this.#postings.clear()
    this.#totalLength = 0
  }

  /**
   * Rank documents against a query.
   *
   * Distinct query terms are scored once each: a short question that repeats a
   * word is not a stronger request for that word.
   */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const { limit = 6, minScore = 0, minCoverage = 0, accept } = options
    if (limit <= 0 || this.#documents.size === 0) return []

    const queryTerms = [...new Set(tokenize(query, this.#tokenizeOptions))]
    if (queryTerms.length === 0) return []

    const total = this.#documents.size
    const average = this.averageLength || 1
    const accumulated = new Map<string, { score: number; matched: Set<string> }>()

    for (const term of queryTerms) {
      const posting = this.#postings.get(term)
      if (posting === undefined) continue

      const documentFrequency = posting.size
      // Robertson/Sparck-Jones with the +1 shift, so a term present in every
      // document scores 0 rather than going negative.
      const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))

      for (const [id, frequency] of posting) {
        if (accept !== undefined && !accept(id)) continue
        const document = this.#documents.get(id)
        if (document === undefined) continue

        const normalization =
          frequency + this.#k1 * (1 - this.#b + this.#b * (document.length / average))
        const contribution = (idf * (frequency * (this.#k1 + 1))) / normalization

        const entry = accumulated.get(id) ?? { score: 0, matched: new Set<string>() }
        entry.score += contribution
        entry.matched.add(term)
        accumulated.set(id, entry)
      }
    }

    const hits: SearchHit[] = []
    for (const [id, entry] of accumulated) {
      const coverage = entry.matched.size / queryTerms.length
      if (entry.score <= minScore || coverage < minCoverage) continue
      hits.push({
        id,
        score: entry.score,
        coverage,
        matchedTerms: queryTerms.filter(term => entry.matched.has(term)),
      })
    }

    // Ties break on id so a result set is reproducible rather than dependent on
    // Map insertion order, which would make tests and trace logs flaky.
    hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    return hits.slice(0, limit)
  }

  /** How many indexed documents contain a term. Diagnostics and tests. */
  documentFrequency(term: string): number {
    return this.#postings.get(term)?.size ?? 0
  }
}
