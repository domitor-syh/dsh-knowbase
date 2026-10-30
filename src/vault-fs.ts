/**
 * The vault's read/write port.
 *
 * `ctx.fs` cannot be used here: it resolves to the host's sandboxed filesystem,
 * whose `workspace-write` policy allows writes only under the session workspace
 * root and the platform temp areas, so `$DSH_HOME/knowbase` is refused outright
 * with `FS_SANDBOX_DENIED`. The host's own
 * Node process is not fenced, so this plugin writes its own data directory the
 * same way the host writes `storages/` and `attachments/`: with `node:fs`.
 *
 * Because a raw `node:fs` handle is unconstrained, every method here funnels
 * its path through lexical containment, then checks every existing component with
 * `lstat` and verifies final realpath containment. Links inside the root are
 * rejected for reads and writes; `stat` and parent directory listings report
 * links as `other`, while directly listing a final link returns an empty list.
 * File I/O accepts only plain files, directory creation accepts only directories,
 * and moving/removing directory trees rejects linked or special descendants.
 * This blocks ordinary link escapes, while external-process TOCTOU replacement and
 * hardlinks remain filesystem limitations rather than claims this port can remove.
 *
 * @module @domitor-syh/dsh-knowbase/vault-fs
 */

import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertInside } from './core/vault.ts'
import { decodeUtf8Text, TextReadError } from './core/text.ts'

/** One directory entry, as a scan sees it. */
export interface VaultEntry {
  readonly name: string
  /**
   * `other` covers symlinks, sockets and anything else that is neither a plain
   * file nor a directory. A scan lists it but never indexes or descends into
   * it: following a link out of the vault would put content under the plugin's
   * containment fence that the fence never checked.
   */
  readonly kind: 'file' | 'directory' | 'other'
  readonly size: number
  readonly mtimeMs: number
}

/** What a caller needs to know about one path. */
export interface VaultStat {
  readonly kind: 'file' | 'directory' | 'other'
  readonly size: number
  readonly mtimeMs: number
}

/** The vault's filesystem, bounded to one root. */
export interface VaultFileSystem {
  /** Entries of one directory. Missing directory reads as empty. */
  listDir(dir: string): Promise<readonly VaultEntry[]>
  /** One path's kind, size and mtime, or `undefined` when it does not exist. */
  stat(target: string): Promise<VaultStat | undefined>
  /** Strict UTF-8 text, rejecting binary control characters; optional byte bound. */
  readText(file: string, maxBytes?: number): Promise<string>
  /** Read a file as bytes. */
  readBytes(file: string): Promise<Uint8Array>
  /** Create or replace a file, creating its parent directory. */
  writeFile(file: string, data: Uint8Array | string): Promise<void>
  /** Create a directory and every missing parent. */
  ensureDir(dir: string): Promise<void>
  /** Move a file or directory. Cross-device moves are the caller's problem, not implemented. */
  move(from: string, to: string): Promise<void>
  /** Remove a file, or a directory and everything under it. */
  remove(target: string): Promise<void>
}

/** Build a `VaultEntry` from an `lstat`-style result. */
function entryOf(
  name: string,
  info: { isFile(): boolean; isDirectory(): boolean; size: number | bigint; mtimeMs: number | bigint },
): VaultEntry {
  return {
    name,
    kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
    size: info.isFile() ? Number(info.size) : 0,
    mtimeMs: Number(info.mtimeMs),
  }
}

/**
 * The real vault filesystem.
 *
 * @param root - the vault root; every path is checked against it.
 * @returns the port.
 */
export function createNodeVaultFs(root: string): VaultFileSystem {
  const rootPath = path.resolve(root)

  const check = async (target: string, mode: 'observe' | 'read' | 'write'): Promise<PathCheck> => {
    assertInside(rootPath, target)
    const absolute = path.resolve(target)
    const relative = path.relative(rootPath, absolute)
    const parts = relative === '' ? [] : relative.split(path.sep)

    // The vault itself is never accepted as a link. Its ancestors may be links:
    // those are trusted installation paths, and assertRealContainment uses the
    // root's resolved physical location as the boundary.
    let rootInfo
    try {
      rootInfo = await lstat(rootPath)
    } catch (error) {
      if (isMissing(error)) return { absolute, info: undefined, missing: true }
      throw error
    }
    if (rootInfo.isSymbolicLink()) throw linkError(rootPath)
    if (!rootInfo.isDirectory()) throw new Error(`知识库根目录不是目录：${rootPath}`)
    let current = rootPath
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index] as string)
      let info
      try {
        info = await lstat(current)
      } catch (error) {
        if (isMissing(error)) return { absolute, info: undefined, missing: true }
        throw error
      }
      const isFinal = index === parts.length - 1
      if (info.isSymbolicLink()) {
        if (isFinal && mode === 'observe') return { absolute, info, link: true }
        throw linkError(current)
      }
      if (!isFinal && !info.isDirectory()) {
        return { absolute, info: undefined, missing: true }
      }
      if (isFinal) {
        if (mode !== 'observe' && !info.isFile() && !info.isDirectory()) throw specialFileError(current)
        if (mode === 'read' && !info.isFile()) throw specialFileError(current)
        await assertRealContainment(rootPath, absolute)
        return { absolute, info, link: false }
      }
    }

    if (mode === 'read') throw specialFileError(absolute)
    await assertRealContainment(rootPath, absolute)
    return { absolute, info: rootInfo, link: false }
  }

  const checkWriteParent = async (target: string): Promise<void> => {
    await check(path.dirname(target), 'write')
  }

  return {
    async listDir(dir) {
      const checked = await check(dir, 'observe')
      if (checked.link || checked.missing || checked.info?.isFile()) return []
      if (!checked.info?.isDirectory()) throw specialFileError(checked.absolute)
      try {
        const entries = await readdir(checked.absolute, { withFileTypes: true })
        const result: VaultEntry[] = []
        for (const entry of entries) {
          const full = path.join(checked.absolute, entry.name)
          try {
            // lstat is deliberate: listing must never turn a link into the
            // directory or file it points at.
            const info = await lstat(full)
            result.push(entryOf(entry.name, info))
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }
        return result
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },

    async stat(target) {
      try {
        const checked = await check(target, 'observe')
        if (checked.missing || checked.info === undefined) return undefined
        return entryOf('', checked.info)
      } catch (error) {
        if (isMissing(error)) return undefined
        throw error
      }
    },

    async readText(file, maxBytes) {
      const checked = await check(file, 'read')
      if (maxBytes === undefined) return decodeUtf8Text(await readFile(checked.absolute))
      const handle = await open(checked.absolute, 'r')
      try {
        // Read at most one byte beyond the bound; the scan's stat may already be stale.
        const bytes = new Uint8Array(maxBytes + 1)
        let length = 0
        while (length < bytes.byteLength) {
          const { bytesRead } = await handle.read(bytes, length, bytes.byteLength - length, null)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length > maxBytes) throw new TextReadError('too-large')
        return decodeUtf8Text(bytes.subarray(0, length), maxBytes)
      } finally {
        await handle.close()
      }
    },

    async readBytes(file) {
      const checked = await check(file, 'read')
      const buffer = await readFile(checked.absolute)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },

    async writeFile(file, data) {
      const checked = await check(file, 'write')
      if (checked.info && !checked.info.isFile()) throw specialFileError(checked.absolute)
      await mkdir(path.dirname(checked.absolute), { recursive: true })
      // Re-check after recursive creation: a pre-existing link or a link raced
      // into the path must not be accepted merely because mkdir succeeded.
      const final = await check(checked.absolute, 'write')
      await writeFile(final.absolute, data)
    },

    async ensureDir(dir) {
      const checked = await check(dir, 'write')
      if (checked.info && !checked.info.isDirectory()) {
        throw new Error(`知识库路径已存在且不是目录：${checked.absolute}`)
      }
      await mkdir(checked.absolute, { recursive: true })
      await check(checked.absolute, 'write')
    },

    async move(from, to) {
      const source = await check(from, 'write')
      const destination = await check(to, 'write')
      if (source.missing) throw missingError(source.absolute)
      if (source.info?.isDirectory()) await assertTreeHasNoLinks(source.absolute)
      await checkWriteParent(destination.absolute)
      await mkdir(path.dirname(destination.absolute), { recursive: true })
      await check(destination.absolute, 'write')
      await check(source.absolute, 'write')
      await rename(source.absolute, destination.absolute)
    },

    async remove(target) {
      const checked = await check(target, 'write')
      if (checked.missing) return
      if (checked.info?.isDirectory()) await assertTreeHasNoLinks(checked.absolute)
      await rm(checked.absolute, { recursive: true, force: true })
    },
  }
}

type PathInfo = {
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
  readonly size: number | bigint
  readonly mtimeMs: number | bigint
}

type PathCheck = {
  readonly absolute: string
  readonly info: PathInfo | undefined
  readonly missing?: boolean
  readonly link?: boolean
}

function linkError(target: string): Error {
  return new Error(`拒绝访问知识库内的链接路径：${target}`)
}

function specialFileError(target: string): Error {
  return new Error(`拒绝访问知识库内的特殊文件或非普通文件：${target}`)
}

function missingError(target: string): Error {
  const error = new Error(`ENOENT: no such file or directory, ${target}`) as Error & { code?: string }
  error.code = 'ENOENT'
  return error
}

/** Resolve the trusted root and final object, rejecting real-path escape. */
async function assertRealContainment(root: string, target: string): Promise<void> {
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)])
  const relative = path.relative(rootReal, targetReal)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝访问知识库真实根目录之外的路径：${target}`)
  }
}

/** A move/remove must not silently carry or recurse through linked or special objects. */
async function assertTreeHasNoLinks(target: string): Promise<void> {
  const info = await lstat(target)
  if (info.isSymbolicLink()) throw linkError(target)
  if (!info.isDirectory()) return
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    const child = path.join(target, entry.name)
    const childInfo = await lstat(child)
    if (childInfo.isSymbolicLink()) throw linkError(child)
    if (!childInfo.isFile() && !childInfo.isDirectory()) throw specialFileError(child)
    if (childInfo.isDirectory()) await assertTreeHasNoLinks(child)
  }
}


/** True for the "no such file or directory" family, which is not an error here. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code: unknown }).code === 'ENOENT' || (error as { code: unknown }).code === 'ENOTDIR')
  )
}

/**
 * An in-memory vault filesystem.
 *
 * The real port cannot be driven from a unit test without a sandbox-safe temp
 * directory, and the service's rules — containment, recycle destinations, scan
 * semantics — are the part worth testing. This keeps every one of them
 * reachable, and its path handling still goes through `node:path`, so the
 * lexical rules it is checked against are the same ones production uses.
 *
 * @param root - the vault root.
 * @returns the port.
 */
export function createMemoryVaultFs(root: string): VaultFileSystem {
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>([path.resolve(root)])
  const times = new Map<string, number>()
  let clock = 1_700_000_000_000

  const tick = (): number => (clock += 1000)
  const guard = (target: string): string => {
    const resolved = path.resolve(target)
    assertInside(root, resolved)
    return resolved
  }
  const hasChildren = (dir: string): boolean =>
    [...files.keys(), ...directories].some(candidate => candidate !== dir && path.dirname(candidate) === dir)

  return {
    async listDir(dir) {
      const resolved = guard(dir)
      if (!directories.has(resolved)) return []
      const names = new Set<string>()
      for (const candidate of [...files.keys(), ...directories]) {
        if (candidate !== resolved && path.dirname(candidate) === resolved) names.add(path.basename(candidate))
      }
      return [...names].sort().map(name => {
        const full = path.join(resolved, name)
        const data = files.get(full)
        return {
          name,
          kind: data === undefined ? ('directory' as const) : ('file' as const),
          size: data === undefined ? 0 : data.byteLength,
          mtimeMs: times.get(full) ?? 0,
        }
      })
    },

    async stat(target) {
      const resolved = guard(target)
      const data = files.get(resolved)
      if (data !== undefined) return { kind: 'file', size: data.byteLength, mtimeMs: times.get(resolved) ?? 0 }
      if (directories.has(resolved)) return { kind: 'directory', size: 0, mtimeMs: times.get(resolved) ?? 0 }
      return undefined
    },

    async readText(file, maxBytes) {
      const resolved = guard(file)
      const data = files.get(resolved)
      if (data === undefined) throw new Error(`ENOENT: ${resolved}`)
      return decodeUtf8Text(data, maxBytes)
    },

    async readBytes(file) {
      const resolved = guard(file)
      const data = files.get(resolved)
      if (data === undefined) throw new Error(`ENOENT: ${resolved}`)
      return data.slice()
    },

    async writeFile(file, data) {
      const resolved = guard(file)
      mkdirMemory(directories, path.dirname(resolved))
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice()
      files.set(resolved, bytes)
      times.set(resolved, tick())
    },

    async ensureDir(dir) {
      mkdirMemory(directories, guard(dir))
      times.set(path.resolve(dir), tick())
    },

    async move(from, to) {
      const source = guard(from)
      const destination = guard(to)
      mkdirMemory(directories, path.dirname(destination))
      const data = files.get(source)
      if (data !== undefined) {
        files.delete(source)
        files.set(destination, data)
        times.set(destination, times.get(source) ?? tick())
        times.delete(source)
        return
      }
      if (!directories.has(source)) throw new Error(`ENOENT: ${source}`)
      for (const key of [...files.keys()]) {
        if (key === source || key.startsWith(source + path.sep)) {
          const moved = destination + key.slice(source.length)
          files.set(moved, files.get(key) as Uint8Array)
          times.set(moved, times.get(key) ?? tick())
          files.delete(key)
        }
      }
      for (const key of [...directories]) {
        if (key === source || key.startsWith(source + path.sep)) {
          directories.delete(key)
          directories.add(destination + key.slice(source.length))
        }
      }
      directories.add(destination)
    },

    async remove(target) {
      const resolved = guard(target)
      const existed = files.delete(resolved) || (directories.delete(resolved) && hasChildren(resolved))
      void existed
      for (const key of [...files.keys()]) {
        if (key.startsWith(resolved + path.sep)) files.delete(key)
      }
      for (const key of [...directories]) {
        if (key.startsWith(resolved + path.sep)) directories.delete(key)
      }
    },
  }
}

/** Create every missing directory above a path. */
function mkdirMemory(directories: Set<string>, dir: string): void {
  let current = path.resolve(dir)
  while (!directories.has(current)) {
    directories.add(current)
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}
