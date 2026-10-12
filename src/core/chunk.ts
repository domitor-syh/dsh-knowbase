/**
 * Structural chunking for ingested text.
 *
 * Chunk boundaries decide whether retrieval can ever succeed: a passage split
 * mid-sentence produces two chunks that each look like a partial answer, and a
 * chunk carrying no heading loses the context that made it findable. So the
 * splitter works on structure — headings, blank-line paragraphs, then sentence
 * boundaries — and only falls back to a hard cut when a single sentence is
 * larger than the whole budget.
 *
 * Overlap is implemented but **off by default**. Overlapping text is duplicated
 * in the index and duplicated again in citations, and whether it pays for
 * itself depends on how often real answers straddle a boundary — which is a
 * measurement, not a guess. The plan's rule applies: parameters get calibrated
 * against a real question set, not tuned by intuition.
 *
 * @module @domitor-syh/dsh-knowbase/core/chunk
 */

import { newId } from './model.ts'

/** One retrievable passage. */
export interface Chunk {
  /** Stable identity; the retrieval index is keyed by this. */
  readonly id: string
  /** Position within the material, starting at 0. */
  readonly ordinal: number
  /** Model-facing text. */
  readonly text: string
  /** Markdown heading path in effect at this chunk, `''` when none. */
  readonly headingPath: string
  /** Human-readable position, e.g. `第 12-24 行`. */
  readonly locator: string
}

/** Chunking budget. All values are characters, the natural unit for Chinese. */
export interface ChunkOptions {
  /** Size a chunk is allowed to reach before the next block starts a new one. */
  readonly targetChars?: number
  /** Hard ceiling for one chunk. */
  readonly maxChars?: number
  /** Characters carried over from the previous chunk. Default 0 — see the module note. */
  readonly overlapChars?: number
}

const DEFAULTS = { targetChars: 600, maxChars: 900, overlapChars: 0 } as const

/** A run of lines that belongs together, with the heading context in effect. */
interface Block {
  readonly lines: readonly string[]
  readonly startLine: number
  readonly endLine: number
  readonly headingPath: string
}

const HEADING = /^(#{1,6})\s+(.*)$/
const SENTENCE_BREAK = /(?<=[。！？；!?;])/

/** Split one oversized paragraph at sentence boundaries, then by hard cut. */
function splitOversized(lines: readonly string[], maxChars: number): string[][] {
  const pieces: string[][] = []
  let current: string[] = []
  let length = 0

  const flush = (): void => {
    if (current.length > 0) pieces.push(current)
    current = []
    length = 0
  }

  for (const line of lines) {
    if (line.length > maxChars) {
      flush()
      for (let start = 0; start < line.length; start += maxChars) {
        pieces.push([line.slice(start, start + maxChars)])
      }
      continue
    }

    const sentences = line.split(SENTENCE_BREAK).filter(part => part.length > 0)
    for (const sentence of sentences) {
      if (length + sentence.length > maxChars) flush()
      current.push(sentence)
      length += sentence.length
    }
  }

  flush()
  return pieces
}

/**
 * Split text into chunks.
 *
 * @param text - the material's extracted text.
 * @param options - budget overrides.
 * @returns chunks in document order; empty for whitespace-only input.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetChars ?? DEFAULTS.targetChars
  const max = Math.max(options.maxChars ?? DEFAULTS.maxChars, target)
  const overlap = Math.max(options.overlapChars ?? DEFAULTS.overlapChars, 0)

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const headingStack: string[] = []
  const blocks: Block[] = []

  let buffer: string[] = []
  let bufferStart = 0
  let bufferHeading = ''
  let bufferHasBody = false

  const closeBuffer = (endLine: number): void => {
    if (buffer.length === 0) return
    blocks.push({
      lines: buffer,
      startLine: bufferStart,
      endLine,
      headingPath: bufferHeading,
    })
    buffer = []
    bufferHasBody = false
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const heading = HEADING.exec(line.trim())

    if (heading !== null) {
      closeBuffer(lineNumber - 1)
      const level = heading[1]!.length
      headingStack.length = Math.min(headingStack.length, level - 1)
      headingStack[level - 1] = heading[2]!.trim()
      // The heading line opens the next block rather than standing alone: a
      // chunk that carries its heading is findable by the words in it.
      bufferStart = lineNumber
      bufferHeading = headingStack.filter(part => part !== undefined).join(' > ')
      buffer.push(line)
      bufferHasBody = false
      return
    }

    if (line.trim() === '') {
      // A heading followed by a blank line is not a section of its own: keeping
      // the buffer open attaches the heading to the content that follows, so
      // the chunk carries it instead of the heading standing alone.
      if (bufferHasBody) closeBuffer(lineNumber - 1)
      return
    }

    if (buffer.length === 0) {
      bufferStart = lineNumber
      bufferHeading = headingStack.filter(part => part !== undefined).join(' > ')
    }
    buffer.push(line)
    bufferHasBody = true
  })
  closeBuffer(lines.length)

  const chunks: Chunk[] = []
  let pending: { lines: string[]; startLine: number; endLine: number; headingPath: string } | null =
    null
  let pendingLength = 0

  const pendingHeadingPath = (): string | null => pending?.headingPath ?? null

  const flush = (): void => {
    if (pending === null) return
    const body = pending.lines.join('\n').trim()
    // A chunk made only of headings cannot serve as evidence — offering
    // "## 串口" as a citation is worse than offering nothing.
    const hasBody = pending.lines.some(line => HEADING.exec(line.trim()) === null)
    if (body.length > 0 && hasBody) {
      const locator =
        pending.startLine === pending.endLine
          ? `第 ${pending.startLine} 行`
          : `第 ${pending.startLine}-${pending.endLine} 行`
      chunks.push({
        id: newId('chunk'),
        ordinal: chunks.length,
        text: body,
        headingPath: pending.headingPath,
        locator,
      })
    }
    pending = null
    pendingLength = 0
  }

  const append = (
    piece: readonly string[],
    startLine: number,
    endLine: number,
    heading: string,
  ): void => {
    if (pending === null) {
      pending = { lines: [...piece], startLine, endLine, headingPath: heading }
      pendingLength = piece.join('\n').length
      return
    }
    pending.lines.push(...piece)
    pending.endLine = endLine
    pendingLength += piece.join('\n').length
  }

  for (const block of blocks) {
    const blockLength = block.lines.join('\n').length

    if (blockLength > max) {
      flush()
      const pieces = splitOversized(block.lines, max)
      let cursor = block.startLine
      for (const piece of pieces) {
        flush()
        const span = piece.join('\n').split('\n').length
        append(piece, cursor, cursor + span - 1, block.headingPath)
        cursor += span
        flush()
      }
      continue
    }

    // A chunk must not span a heading boundary: a passage mixing two sections
    // has no single honest heading path, and its citation would point at the
    // wrong place. Read through a function so the check does not depend on
    // control-flow narrowing of a variable the closures reassign.
    const openHeading = pendingHeadingPath()
    if (openHeading !== null && openHeading !== block.headingPath) flush()
    if (pending !== null && pendingLength + blockLength > max) flush()
    append(block.lines, block.startLine, block.endLine, block.headingPath)
    if (pendingLength >= target) flush()
  }
  flush()

  if (overlap > 0) {
    // Read the tails from an untouched snapshot: reading the array while
    // rewriting it would compound the overlap chunk after chunk.
    const originals = chunks.map(chunk => chunk.text)
    for (let index = 1; index < chunks.length; index += 1) {
      const tail = originals[index - 1]!.slice(-overlap)
      chunks[index] = { ...chunks[index]!, text: `${tail}\n${chunks[index]!.text}` }
    }
  }

  return chunks
}
