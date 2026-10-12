/**
 * Query and document tokenization for the local retrieval index.
 *
 * Chinese has no word delimiters, so whitespace tokenization finds nothing at
 * all and a naive character split loses every multi-character term. The MVP
 * answer (per the plan) is character n-grams: a run of Han characters is
 * emitted as overlapping bi-grams and tri-grams, while Latin words and numbers
 * stay whole so model numbers and identifiers survive intact.
 *
 * This is deliberately not a dictionary segmenter. n-grams need no dictionary,
 * no model and no download, and they cannot fail on an out-of-vocabulary term —
 * which matters more for a first version than precision. The cost is a larger
 * index and more false candidates, both handled downstream by BM25 weighting
 * and the coverage filter.
 *
 * @module @domitor-syh/dsh-knowbase/core/tokenize
 */

/** Options controlling which n-gram orders are emitted. */
export interface TokenizeOptions {
  /** Emit overlapping bi-grams from Han runs. Default `true`. */
  readonly bigrams?: boolean
  /** Emit overlapping tri-grams from Han runs. Default `true`. */
  readonly trigrams?: boolean
}

/**
 * True for Han ideographs — the characters that receive n-gram treatment.
 *
 * Covers the BMP blocks plus the astral extensions, because a knowledge base
 * that silently drops rare characters is worse than one that indexes them
 * clumsily.
 */
export function isHan(character: string): boolean {
  const code = character.codePointAt(0)
  if (code === undefined) return false
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x20000 && code <= 0x2ebef) // CJK Extensions B-F
  )
}

/** True for characters that join into a whole word term (letters, digits). */
const WORD_CHARACTER = /^[\p{L}\p{N}]$/u

/** Emit overlapping n-grams for one contiguous Han run. */
function emitNgrams(
  run: readonly string[],
  bigrams: boolean,
  trigrams: boolean,
  out: string[],
): void {
  if (run.length === 1) {
    // A lone character has no n-gram to be part of; keeping it whole is the
    // only way a single-character query can ever match.
    out.push(run[0]!)
    return
  }
  if (bigrams) {
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run[i]! + run[i + 1]!)
  }
  if (trigrams) {
    for (let i = 0; i + 2 < run.length; i += 1) out.push(run[i]! + run[i + 1]! + run[i + 2]!)
  }
}

/**
 * Split text into index terms.
 *
 * Case is folded and width is normalized (NFKC) so that full-width digits and
 * Latin letters in Chinese text match their ASCII forms — a document using
 * `１１５２００` should answer a query typed as `115200`.
 *
 * @param text - raw document or query text.
 * @param options - which n-gram orders to emit.
 * @returns terms in document order, with repeats preserved (callers that need
 *   term frequency must count them).
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const { bigrams = true, trigrams = true } = options
  const characters = Array.from(text.normalize('NFKC').toLowerCase())
  const tokens: string[] = []

  let index = 0
  while (index < characters.length) {
    const character = characters[index]!

    if (isHan(character)) {
      let end = index
      while (end < characters.length && isHan(characters[end]!)) end += 1
      emitNgrams(characters.slice(index, end), bigrams, trigrams, tokens)
      index = end
      continue
    }

    if (WORD_CHARACTER.test(character)) {
      let end = index
      while (end < characters.length && WORD_CHARACTER.test(characters[end]!)) end += 1
      tokens.push(characters.slice(index, end).join(''))
      index = end
      continue
    }

    index += 1
  }

  return tokens
}

/** Count how often each term occurs, preserving first-seen order. */
export function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  return frequencies
}
