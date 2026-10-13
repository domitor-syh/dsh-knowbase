/**
 * The portable backup format: build, parse and plan a restore.
 *
 * The plan requires 基础备份导出/恢复 as an MVP capability, and the reason it
 * is a *file format* rather than a database copy is that a backup has to
 * outlive the thing that made it — a schema version bump, a profile reset, a
 * different machine. So the format is plain JSON with an explicit `format` and
 * `version` header, and it is versioned separately from `storageDomain`: the
 * storage schema may move while a file written today still restores tomorrow.
 *
 * ## What is in the file, and what is not
 *
 * Materials are exported as their **source text**. Chunks are derived data —
 * they are an indexing decision, and re-chunking on import is both smaller and
 * more correct than trusting boundaries that a later chunker would not produce
 * again. This is the same reasoning the plan applies to embeddings (「向量是
 * 可重建派生数据，可不纳入便携导出」).
 *
 * Soft-deleted records are **not** exported. The recycle bin is a staging area
 * for a decision the user has not finished making; a backup is a snapshot of
 * what the user actually has.
 *
 * ## Restore semantics
 *
 * Import is **non-destructive**: it never overwrites an existing knowledge
 * base. Ids are kept when they are free — which is what makes a restore onto a
 * clean profile reproduce the original exactly, including the session
 * selections that reference base ids — and reallocated when they are taken.
 * Names that clash get a 「（导入 2）」 suffix rather than replacing anything.
 * A user who imports the wrong file therefore gains a library they can delete,
 * not a library they have lost.
 *
 * @module @domitor-syh/dsh-knowbase/core/backup
 */

import { z } from 'zod'
import { normalizeForFingerprint } from './fingerprint.ts'
import { normalizeName } from './model.ts'
import { compareId, compareText } from './order.ts'

/** Marker that identifies this plugin's backups. Checked before anything else. */
export const BACKUP_FORMAT = 'dsh-knowbase-backup'

/** Format version written into every file. */
export const BACKUP_VERSION = 1

/** Failure codes, so a caller can branch without parsing Chinese prose. */
export type BackupErrorCode = 'not-json' | 'not-backup' | 'unsupported-version' | 'malformed'

/** A backup that cannot be read, with a machine-readable reason. */
export class BackupError extends Error {
  readonly code: BackupErrorCode

  constructor(code: BackupErrorCode, message: string) {
    super(message)
    this.name = 'BackupError'
    this.code = code
  }
}

/** One material inside a backup. */
export interface BackupMaterial {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** One knowledge base inside a backup. */
export interface BackupBase {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly materials: readonly BackupMaterial[]
}

/** A whole backup file, parsed. */
export interface BackupDocument {
  readonly format: typeof BACKUP_FORMAT
  readonly version: number
  readonly exportedAt: number
  /** Which build wrote the file. Informational only; never validated against. */
  readonly generator: string
  readonly bases: readonly BackupBase[]
}

/**
 * On-disk shape.
 *
 * `z.object` strips unknown keys rather than rejecting them, matching the
 * storage schema: a file written by a newer build that added a field still
 * restores on an older one. Unknown keys are the forward-compatible direction;
 * a missing required key is not.
 */
const materialSchema = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number(),
})

const baseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  materials: z.array(materialSchema),
})

const documentSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number(),
  exportedAt: z.number(),
  generator: z.string(),
  bases: z.array(baseSchema),
})

/** Raw records a caller hands to {@link buildBackupDocument}. */
export interface BackupSource {
  readonly bases: readonly BackupBase[]
  readonly exportedAt: number
  readonly generator: string
}

/**
 * Assemble a backup document.
 *
 * Bases and materials are sorted so that two backups of unchanged data are
 * byte-identical — which is what makes a backup diffable, and what makes
 * "did anything change?" answerable without opening the app.
 *
 * The orders come from `./order.ts` rather than a bare `localeCompare`: the
 * promise above is only worth anything if it holds on the machine reading the
 * file as well as the one that wrote it, and an ambient-locale comparison does
 * not (CI caught exactly that).
 */
export function buildBackupDocument(source: BackupSource): BackupDocument {
  const bases = [...source.bases]
    .sort((left, right) => compareText(left.name, right.name))
    .map(base => ({
      ...base,
      materials: [...base.materials].sort(
        (left, right) => left.createdAt - right.createdAt || compareId(left.id, right.id),
      ),
    }))

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: source.exportedAt,
    generator: source.generator,
    bases,
  }
}

/** Render a document as the bytes of a backup file. */
export function serializeBackup(document: BackupDocument): string {
  // Indented on purpose: a backup is something a user may open, diff or inspect
  // by hand, and the text dominates the file size so the padding is free.
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * A filename for a backup taken at `exportedAt`, in local time.
 *
 * Built from date parts rather than `toLocaleString`, so the name is the same
 * shape on every machine and never contains a character a filesystem dislikes.
 */
export function backupFileName(exportedAt: number): string {
  const at = new Date(exportedAt)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `dsh-knowbase-backup-${stamp}.json`
}

/** Summarise zod issues into one line, capped so a huge file cannot flood the UI. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map(issue => `${issue.path.join('.') || '(根)'}：${issue.message}`)
    .join('；')
}

/**
 * Read a backup file.
 *
 * The checks are ordered cheapest-and-most-informative first, so a user who
 * picked the wrong file gets "this is not a backup" rather than a field-level
 * complaint about a document they never meant to import.
 */
export function parseBackupDocument(json: string): BackupDocument {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new BackupError('not-json', '这不是一个 JSON 文件，无法作为备份导入。')
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BackupError('not-backup', '备份文件的结构不正确：顶层应当是一个对象。')
  }

  const header = raw as { format?: unknown; version?: unknown }

  if (header.format !== BACKUP_FORMAT) {
    throw new BackupError(
      'not-backup',
      '这不是 dsh-knowbase 的备份文件（format 字段不匹配）。',
    )
  }
  if (typeof header.version !== 'number' || !Number.isInteger(header.version) || header.version < 1) {
    throw new BackupError('not-backup', '备份文件缺少合法的 version 字段。')
  }
  if (header.version > BACKUP_VERSION) {
    throw new BackupError(
      'unsupported-version',
      `备份文件版本为 ${header.version}，高于当前插件支持的 ${BACKUP_VERSION}；请先升级插件再导入。`,
    )
  }

  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    throw new BackupError('malformed', `备份文件内容不完整：${describeIssues(parsed.error)}`)
  }
  return parsed.data
}

/** What already exists, so the plan can avoid it. */
export interface TakenNames {
  readonly baseIds: readonly string[]
  readonly baseNames: readonly string[]
}

/** One material, as the restore will create it. */
export interface PlannedMaterial {
  readonly id: string
  readonly title: string
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** One knowledge base, as the restore will create it. */
export interface PlannedBase {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly materials: readonly PlannedMaterial[]
}

/** What {@link planImport} decided. */
export interface ImportPlan {
  readonly bases: readonly PlannedBase[]
  /** Materials dropped because they carried no indexable text. */
  readonly skippedMaterials: number
  /** Bases that could not keep their original id because something already uses it. */
  readonly reallocatedBases: number
}

/** Longest name the domain accepts; mirrors `normalizeName`. */
const NAME_LIMIT = 80

/**
 * The first free variant of `desired`.
 *
 * Terminates without an arbitrary cap: `taken` is a finite set, so some suffix
 * is free after at most `taken.size` attempts.
 */
function uniqueName(desired: string, taken: ReadonlySet<string>): string {
  const base = normalizeName(desired) || '未命名知识库'
  if (!taken.has(base)) return base

  let attempt = 2
  let candidate = base
  while (taken.has(candidate)) {
    const suffix = `（导入 ${attempt}）`
    candidate = base.slice(0, Math.max(1, NAME_LIMIT - suffix.length)) + suffix
    attempt += 1
  }
  return candidate
}

/**
 * Turn a parsed document into the records a restore will write.
 *
 * Pure, and deliberately separate from the write itself: this is where every
 * decision about collisions and unusable input lives, so it can be tested
 * exhaustively without a store — the same split that makes the rest of
 * `core/` verifiable.
 *
 * @param document - a parsed backup.
 * @param taken - ids and names already in the profile.
 * @param makeId - id factory, injected so tests are deterministic.
 */
export function planImport(
  document: BackupDocument,
  taken: TakenNames,
  makeId: (prefix: string) => string,
): ImportPlan {
  const usedIds = new Set(taken.baseIds)
  const usedNames = new Set(taken.baseNames.map(normalizeName))

  const bases: PlannedBase[] = []
  let skippedMaterials = 0
  let reallocatedBases = 0

  for (const base of document.bases) {
    let id = base.id
    if (id === '' || usedIds.has(id)) {
      id = makeId('kb')
      reallocatedBases += 1
    }
    usedIds.add(id)

    const name = uniqueName(base.name, usedNames)
    usedNames.add(name)

    const materials: PlannedMaterial[] = []
    for (const material of base.materials) {
      // A material with no indexable text cannot be restored as one — `addText`
      // would reject it and abort the whole import. Dropping it and reporting
      // the count keeps the restorable part restorable.
      if (normalizeForFingerprint(material.text) === '') {
        skippedMaterials += 1
        continue
      }
      materials.push({
        // Material ids are always fresh: nothing outside the store references
        // them, so preserving them would only risk colliding with a material
        // that a different base already holds.
        id: makeId('mat'),
        title: material.title,
        text: material.text,
        createdAt: material.createdAt,
        updatedAt: material.updatedAt,
        revision: material.revision,
      })
    }

    bases.push({
      id,
      name,
      description: base.description,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
      materials,
    })
  }

  return { bases, skippedMaterials, reallocatedBases }
}
