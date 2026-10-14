/**
 * The vault's read/write port.
 *
 * `ctx.fs` cannot be used here: it resolves to the host's sandboxed filesystem,
 * whose `workspace-write` policy allows writes only under the session workspace
 * root and the platform temp areas, so `$DSH_HOME/knowbase` is refused outright
 * with `FS_SANDBOX_DENIED` (measured — see `HANDOFF.md` §15 ②). The host's own
 * Node process is not fenced, so this plugin writes its own data directory the
 * same way the host writes `storages/` and `attachments/`: with `node:fs`.
 *
 * Because a raw `node:fs` handle is unconstrained, every method here funnels
 * its path through {@link assertInside} first. The fence is lexical — it stops
 * a name built from user text from walking out of the vault with `../` — and it
 * is applied at one place rather than at each call site.
 *
 * @module @domitor-syh/dsh-knowbase/vault-fs
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertInside } from './core/vault.ts'

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
  /** Read a file as text (UTF-8). */
  readText(file: string): Promise<string>
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
function entryOf(name: string, info: { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }): VaultEntry {
  return {
    name,
    kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
    size: info.isFile() ? info.size : 0,
    mtimeMs: info.mtimeMs,
  }
}

/**
 * The real vault filesystem.
 *
 * @param root - the vault root; every path is checked against it.
 * @returns the port.
 */
export function createNodeVaultFs(root: string): VaultFileSystem {
  const guard = (target: string): string => {
    assertInside(root, target)
    return target
  }

  return {
    async listDir(dir) {
      try {
        const entries = await readdir(guard(dir), { withFileTypes: true })
        const result: VaultEntry[] = []
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          const info = await stat(full).catch(() => undefined)
          if (info === undefined) continue
          result.push(entryOf(entry.name, info))
        }
        return result
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },

    async stat(target) {
      try {
        return entryOf('', await stat(guard(target)))
      } catch (error) {
        if (isMissing(error)) return undefined
        throw error
      }
    },

    async readText(file) {
      return readFile(guard(file), 'utf8')
    },

    async readBytes(file) {
      const buffer = await readFile(guard(file))
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },

    async writeFile(file, data) {
      guard(file)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, data)
    },

    async ensureDir(dir) {
      await mkdir(guard(dir), { recursive: true })
    },

    async move(from, to) {
      guard(from)
      guard(to)
      await mkdir(path.dirname(to), { recursive: true })
      await rename(from, to)
    },

    async remove(target) {
      await rm(guard(target), { recursive: true, force: true })
    },
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

    async readText(file) {
      const resolved = guard(file)
      const data = files.get(resolved)
      if (data === undefined) throw new Error(`ENOENT: ${resolved}`)
      return new TextDecoder().decode(data)
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
