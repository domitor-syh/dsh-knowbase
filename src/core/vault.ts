/**
 * The on-disk shape of a knowledge base: where the vault lives, what a base
 * folder is called, and which paths an operation is allowed to touch.
 *
 * Everything here is pure: it takes plain values and returns plain values, so
 * the rules that decide *where bytes land* are unit-testable without a host, a
 * filesystem or a clock. The read/write port is `../vault-fs.ts`; this module
 * never touches the disk.
 *
 * ## Why a folder name carries the id
 *
 * A base is a folder, and the folder's name is the base's name as far as the
 * user's file explorer is concerned. But a user renames a base inside the app
 * and also renames a folder inside the explorer, and the two must not be able
 * to disagree about identity — so the folder is `<name>--<kbId>`: the prefix is
 * display, the suffix is identity. Parsing is by the LAST `--`, because a base
 * may legitimately be called 「A--B」.
 *
 * @module @domitor-syh/dsh-knowbase/core/vault
 */

import path from 'node:path'
import { newId } from './model.ts'

/** Environment variables the root resolution reads. */
export const VAULT_ROOT_ENV = 'DSH_KNOWBASE_ROOT'
/** Host data directory; the vault sits under it. */
export const DSH_HOME_ENV = 'DSH_HOME'
/** Folder name of the vault itself, under `$DSH_HOME`. */
export const VAULT_DIR_NAME = 'knowbase'
/** Where deleted bases and files land. A plain folder: there is no UI for it. */
export const RECYCLE_DIR_NAME = '_回收站'

/** Separator between a base's display name and its id in a folder name. */
const ID_SEPARATOR = '--'

/** Characters no platform accepts in a file name, plus the Windows-reserved set. */
const ILLEGAL_IN_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/g

/** Windows device names that cannot be used even with an extension. */
const RESERVED_BASE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

/** Longest a single generated path segment may be, extension included. */
const MAX_SEGMENT_LENGTH = 100

/** What the root resolution needs, injected so it stays pure. */
export interface VaultRootSource {
  /** Process environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The user's home directory, used only when neither variable is set. */
  readonly homedir: string
}

/**
 * Absolute path of the vault.
 *
 * Three levels, in order of precedence: an explicit `DSH_KNOWBASE_ROOT` (the
 * override development and tests use — a probe must never write the user's real
 * vault), then `$DSH_HOME/knowbase`, then `~/.dsh/knowbase`.
 *
 * The `~/.dsh` fallback is not decoration: it is where the host's own data lives
 * when `DSH_HOME` is unset, so a plugin that resolved to a different directory
 * in that case would be reading and writing a vault the host itself never
 * mentions.
 *
 * @param source - environment and home directory.
 * @returns the absolute vault root; not normalized against the disk.
 */
export function resolveVaultRoot(source: VaultRootSource): string {
  const override = trimmed(source.env[VAULT_ROOT_ENV])
  if (override !== undefined) return path.resolve(override)

  const home = trimmed(source.env[DSH_HOME_ENV])
  if (home !== undefined) return path.resolve(home, VAULT_DIR_NAME)

  return path.resolve(source.homedir, '.dsh', VAULT_DIR_NAME)
}

/** The recycle folder inside a vault. */
export function recycleDir(root: string): string {
  return path.join(root, RECYCLE_DIR_NAME)
}

/** True when a directory entry is the recycle folder rather than a base. */
export function isRecycleName(name: string): boolean {
  return name === RECYCLE_DIR_NAME
}

/**
 * Whether `target` is inside `root`.
 *
 * Purely lexical (`path.relative` on resolved paths), which is the right fence
 * for a name the plugin itself built: it stops `../` from escaping, and it is
 * what every path this module produces is checked against before a write.
 *
 * @param root - the directory that bounds everything.
 * @param target - the path to test.
 * @returns true when `target` equals or sits under `root`.
 */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Assert containment, as a throw.
 *
 * The guard exists so a caller that computed a path from user-visible text
 * cannot silently write outside the vault: every write port in `../vault-fs.ts`
 * funnels through here.
 *
 * @param root - the vault root.
 * @param target - the path about to be written or removed.
 * @throws when `target` escapes `root`.
 */
export function assertInside(root: string, target: string): void {
  if (!isInside(root, target)) {
    throw new Error(`拒绝访问知识库根目录之外的路径：${target}`)
  }
}

/**
 * Make one user-visible name safe as a single path segment.
 *
 * Replaces separators and reserved characters, drops trailing dots and spaces
 * (which Windows silently strips, so a name that kept them would not round-trip
 * through a scan), refuses the reserved device names, and bounds the length.
 * An empty result becomes a placeholder rather than an empty segment.
 *
 * @param raw - the desired name.
 * @param fallback - what to use when nothing survives sanitising.
 * @returns the sanitised segment, never empty.
 */
export function sanitizeSegment(raw: string, fallback: string): string {
  let value = raw.replace(ILLEGAL_IN_FILE_NAME, '_').replace(/\s+/g, ' ').trim()
  value = value.replace(/[. ]+$/g, '')
  if (value === '') return fallback
  if (RESERVED_BASE_NAMES.has(value.toLowerCase())) value = `${value}_`
  if (value.length > MAX_SEGMENT_LENGTH) value = value.slice(0, MAX_SEGMENT_LENGTH)
  // Truncation can re-expose a trailing dot or space.
  value = value.replace(/[. ]+$/g, '')
  return value === '' ? fallback : value
}

/**
 * The folder name for a base.
 *
 * @param name - display name, as the user typed it.
 * @param id - the base's identity.
 * @returns `"<sanitised name>--<id>"`.
 */
export function vaultFolderName(name: string, id: string): string {
  return `${sanitizeSegment(name, '知识库')}${ID_SEPARATOR}${id}`
}

/**
 * Read a folder name back into its display name and id.
 *
 * Splits on the LAST separator so a base named 「A--B」 still parses. A folder
 * without a separator — or with an implausible id — is not a base: it is a file
 * the user dropped in the vault, and the scan ignores it rather than inventing
 * an identity for it.
 *
 * @param folder - one directory name from the vault root.
 * @returns the pair, or `undefined` when the name is not a base folder.
 */
export function parseVaultFolderName(folder: string): { name: string; id: string } | undefined {
  const at = folder.lastIndexOf(ID_SEPARATOR)
  if (at <= 0) return undefined
  const id = folder.slice(at + ID_SEPARATOR.length)
  // The id shape is checked so a folder called 「会议记录--2026」 is treated as
  // something the user made, not as a base whose id happens to be a year.
  if (!isBaseId(id)) return undefined
  const name = folder.slice(0, at)
  return { name: name === '' ? '知识库' : name, id }
}

/** True when a string looks like an id this plugin generates. */
export function isBaseId(id: string): boolean {
  return /^kb_[0-9a-fA-F-]{8,}$/.test(id)
}

/**
 * The next free name for a new entry in a directory.
 *
 * Duplicate file names are ordinary (two folders both holding 「说明书.pdf」) and
 * overwriting one to land the other is data loss, so the second arrival becomes
 * 「说明书 (2).pdf」. The extension stays intact because a file whose extension
 * changed would no longer open in the program the user expects.
 *
 * @param desired - the name the caller wants.
 * @param taken - names already present in the directory.
 * @returns `desired`, or a numbered variant that is free.
 */
export function uniqueSegment(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired
  const extension = path.extname(desired)
  const stem = extension === '' ? desired : desired.slice(0, -extension.length)
  for (let index = 2; ; index += 1) {
    const candidate = `${stem} (${index})${extension}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Where a deleted entry lands.
 *
 * The recycle folder is flat: a deleted file and a deleted base both keep their
 * own name and are disambiguated the same way a new file is. Nothing here
 * records the original location, because the folder is not a restore UI — it is
 * a place the user can drag things back from by hand, and a manifest that no
 * surface reads would be the only thing keeping it honest.
 *
 * @param root - the vault root.
 * @param entryName - the name to keep.
 * @param taken - names already in the recycle folder.
 * @returns the destination path.
 */
export function recycleTarget(root: string, entryName: string, taken: ReadonlySet<string>): string {
  const target = path.join(recycleDir(root), uniqueSegment(entryName, taken))
  assertInside(root, target)
  return target
}

/** One user-visible name, or `undefined` when it is blank. */
function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const result = value.trim()
  return result === '' ? undefined : result
}

/**
 * A fresh base identity.
 *
 * Re-exported from `./model.ts` so this module is the single import a caller
 * needs when it wants to name a base folder for a base it is about to create.
 */
export { newId }
