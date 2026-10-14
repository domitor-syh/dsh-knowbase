/**
 * Entities the plugin works with.
 *
 * A knowledge base is a folder; a material is a file inside it. Nothing about a
 * material is persisted by the plugin — the file on disk IS the record — so this
 * module's types describe what a scan produces, not what a database stores. The
 * consequence is deliberate: a file the user drops into the folder from their
 * own explorer appears in the app on the next scan, with no import step.
 *
 * Base names are display fields and the id is the identity (`<name>--<kbId>` on
 * disk; see `./vault.ts`), so renaming cannot orphan anything.
 *
 * @module @domitor-syh/dsh-knowbase/core/model
 */

import { randomUUID } from 'node:crypto'

/** A knowledge base: a named container, stored as one folder. */
export interface KnowledgeBase {
  readonly id: string
  readonly name: string
  readonly description: string
  /**
   * The folder this base owns, relative to the vault root.
   *
   * Stored rather than recomputed because the user can rename the folder in
   * their own explorer: a recomputed name would silently point at a folder that
   * no longer exists, and the record would look fine while the data sat one
   * directory over under its old name.
   */
  readonly folderName: string
  readonly createdAt: number
  readonly updatedAt: number
  /**
   * Bumped whenever this base's searchable content changes. Retrieval traces
   * record it so a stale answer can be explained after the fact.
   */
  readonly indexRevision: number
}

/** One file inside a knowledge base. */
export interface Material {
  /**
   * Identity: the file's path relative to its base folder.
   *
   * Not a generated id, because nothing generates it — a scan reads whatever is
   * on disk. Renaming the file in the app is therefore an identity change, which
   * is honest: the citation an old answer carries points at the old name and
   * resolves to nothing, exactly as it would for a deleted file.
   */
  readonly id: string
  readonly kbId: string
  /** The same relative path, kept under its own name for readability at call sites. */
  readonly fileName: string
  /** Display title, which is the file name. */
  readonly title: string
  readonly bytes: number
  /** Lower-case extension without the dot; `''` when the file has none. */
  readonly extension: string
  readonly mtimeMs: number
  /** Files the plugin extracted searchable text from; the rest are stored and listed. */
  readonly indexed: boolean
  /** Extracted text for an indexable file; `undefined` for everything else. */
  readonly extractedText?: string
  /** Derived from {@link extractedText}; empty for a file that is not indexed. */
  readonly chunks: readonly ChunkRecord[]
  /**
   * Why this file holds no searchable text, in one sentence, when it should
   * have. `''` when there is nothing to explain.
   *
   * A file the plugin never claimed to read (a `.zip`) needs no note: the
   * format list already says so. This is for the files it *does* claim to read
   * and could not — an encrypted PDF, a scan with no text layer, a file past
   * the size bound — where "暂不可检索" alone would leave the user guessing.
   */
  readonly note: string
}

/** A chunk as persisted in the index. Structurally the chunker's output. */
export interface ChunkRecord {
  readonly id: string
  readonly ordinal: number
  readonly text: string
  readonly headingPath: string
  readonly locator: string
}

/**
 * Extensions the plugin extracts text from today.
 *
 * Plain text and the PDF text layer. A `.pdf` counts as indexable because the
 * plugin *can* read it — a PDF whose extraction fails or whose pages hold only
 * a scan comes back with `indexed: false` and a {@link Material.note} saying
 * why, which is the honest form of "listed but not searchable".
 *
 * Image OCR is deliberately absent until it lands: claiming a format the plugin
 * cannot yet read would index a photo's bytes as if they were words.
 */
export const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'text',
  'pdf',
])

/** Generate an identity for a new entity. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/** Lower-case extension of a file name, without the dot. */
export function extensionOf(fileName: string): string {
  const at = fileName.lastIndexOf('.')
  if (at <= 0 || at === fileName.length - 1) return ''
  return fileName.slice(at + 1).toLowerCase()
}

/** True when the plugin can extract searchable text from this file name. */
export function isIndexable(fileName: string): boolean {
  return INDEXABLE_EXTENSIONS.has(extensionOf(fileName))
}

/**
 * A material's text as the reader shows it.
 *
 * Only ever the extracted text: a material the plugin cannot read has no text,
 * and falling back to a byte dump would put binary noise in the reading pane.
 */
export function materialText(material: Material): string {
  return material.extractedText ?? ''
}

/** Trim and collapse a user-supplied name, then bound it to the documented length. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 80)
}

/**
 * A knowledge base as the storage layer read it back.
 *
 * `folderName` is optional because records written before the vault existed do
 * not carry one; the service fills it in during migration rather than the store
 * inventing a value, so a record is never silently pointing at a folder nobody
 * created. `deletedAt` is the retired soft-delete marker: deletion is now a
 * folder move, but a legacy record carrying the marker is skipped by the
 * migration instead of being resurrected.
 */
export interface StoredKnowledgeBase {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly folderName?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly indexRevision: number
  readonly deletedAt?: number
}

/**
 * A text material as the pre-vault build stored it.
 *
 * Read once, by the migration in `./migrate.ts`, which writes each one out as a
 * `.txt` file in its base's folder. After that this shape is dead data: the
 * plugin keeps the table declared so the domain stays loadable, and reads it for
 * nothing else.
 */
export interface LegacyMaterial {
  readonly id: string
  readonly kbId: string
  readonly title: string
  readonly source: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly text?: string
  readonly deletedAt?: number
  readonly chunks: readonly {
    readonly id: string
    readonly ordinal: number
    readonly text: string
    readonly headingPath: string
    readonly locator: string
  }[]
}

/** The text a legacy material held, however it was written down. */
export function legacyMaterialText(material: LegacyMaterial): string {
  if (material.text !== undefined) return material.text
  return material.chunks.map(chunk => chunk.text).join('\n\n')
}
