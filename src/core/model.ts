/**
 * Entities persisted by the plugin.
 *
 * Names are display fields; every association uses an immutable id. Renaming a
 * knowledge base therefore cannot orphan anything, and two bases may share a
 * name without colliding — the plan's rule that a name is never a key or a path.
 *
 * @module @domitor-syh/dsh-knowbase/core/model
 */

import { randomUUID } from 'node:crypto'

/** A knowledge base: a named container of materials. */
export interface KnowledgeBase {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: number
  readonly updatedAt: number
  /**
   * Bumped whenever this base's searchable content changes. Retrieval traces
   * record it so a stale answer can be explained after the fact.
   */
  readonly indexRevision: number
  /**
   * Soft-delete marker: set when the base moved to the recycle bin, absent
   * while it is live. Optional (not `number | undefined`) so records written
   * before soft delete existed load unchanged — absence is the live state.
   */
  readonly deletedAt?: number
}

/** One material inside a knowledge base. */
export interface Material {
  readonly id: string
  readonly kbId: string
  readonly title: string
  /** How it entered the base: `text` for typed or pasted content. */
  readonly source: 'text'
  readonly createdAt: number
  readonly updatedAt: number
  /** Bumped on every edit; citations snapshot it so old answers stay explicable. */
  readonly revision: number
  /**
   * The text as the user supplied it, kept so the editor can round-trip it
   * losslessly. The chunks are derived and their boundaries are an indexing
   * decision; reassembling a document from them would quietly normalise blank
   * lines and lose whatever fell between chunk edges.
   *
   * Optional because records written before this field existed do not carry it;
   * the editor falls back to reassembling from the chunks for those.
   */
  readonly text?: string
  /** Soft-delete marker; absence is the live state. See {@link KnowledgeBase.deletedAt}. */
  readonly deletedAt?: number
  /**
   * Fingerprint of {@link text}, used to refuse the same material twice inside
   * one base. Optional for the same reason as `text`: records written before
   * duplicate detection existed do not carry it, and absence is handled by
   * hashing on demand rather than by rejecting the record.
   */
  readonly contentHash?: string
  /** Extracted text, already split for retrieval. */
  readonly chunks: readonly ChunkRecord[]
}

/** A chunk as persisted. Structurally the chunker's output. */
export interface ChunkRecord {
  readonly id: string
  readonly ordinal: number
  readonly text: string
  readonly headingPath: string
  readonly locator: string
}

/** Generate an identity for a new entity. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/**
 * A material's text as the user supplied it.
 *
 * Records written before the editor existed carry no `text`, and for those the
 * chunks are the only surviving copy — reassembling them normalises blank lines,
 * which is lossy but better than showing nothing. Both the editor and the
 * backup export read text through here so the fallback exists exactly once.
 */
export function materialText(material: Material): string {
  return material.text ?? material.chunks.map(chunk => chunk.text).join('\n\n')
}

/** Trim and collapse a user-supplied name, then bound it to the documented length. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 80)
}
