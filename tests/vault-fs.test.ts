/**
 * The vault filesystem port.
 *
 * The port is the only thing in this plugin that is allowed to touch the disk
 * with a raw handle, so the property worth pinning is the fence around it: every
 * operation refuses a path outside the vault *before* it reaches `node:fs`. The
 * test that matters most is therefore the one that proves nothing happened — a
 * guard that runs after the write is not a guard.
 *
 * Both implementations are exercised. The in-memory one is what the service
 * tests drive; the real one is what production runs, and its missing-path
 * semantics (a missing directory lists as empty, a missing file stats as
 * `undefined`) are what let a scan treat "not there yet" as ordinary rather than
 * as an error.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMemoryVaultFs, createNodeVaultFs } from '../src/vault-fs.ts'
import type { VaultFileSystem } from '../src/vault-fs.ts'

/** A root that is only ever used for lexical checks — nothing is written to it. */
const CHECK_ROOT = path.resolve('C:/vault-unused')

const OUTSIDE = path.join(CHECK_ROOT, '..', 'escape.txt')

const PORTS: readonly (readonly [string, () => VaultFileSystem])[] = [
  ['in-memory', () => createMemoryVaultFs(CHECK_ROOT)],
  ['node', () => createNodeVaultFs(CHECK_ROOT)],
]

describe.each(PORTS)('containment — the %s port', (_label, build) => {
  const fs = build()

  it('refuses a write outside the root before it reaches the disk', async () => {
    await expect(fs.writeFile(OUTSIDE, 'x')).rejects.toThrow(/知识库根目录之外/)
  })

  it('refuses every other operation outside the root', async () => {
    await expect(fs.readText(OUTSIDE)).rejects.toThrow(/知识库根目录之外/)
    await expect(fs.readBytes(OUTSIDE)).rejects.toThrow(/知识库根目录之外/)
    await expect(fs.stat(OUTSIDE)).rejects.toThrow(/知识库根目录之外/)
    await expect(fs.listDir(OUTSIDE)).rejects.toThrow(/知识库根目录之外/)
    await expect(fs.ensureDir(OUTSIDE)).rejects.toThrow(/知识库根目录之外/)
    await expect(fs.remove(OUTSIDE)).rejects.toThrow(/知识库根目录之外/)
  })

  it('refuses a move whose destination escapes, not only whose source does', async () => {
    // The half a naive guard misses: `from` is inside the vault, so a check on
    // the source alone would let the rename land the file one directory up.
    await expect(fs.move(path.join(CHECK_ROOT, 'inside.txt'), OUTSIDE)).rejects.toThrow(
      /知识库根目录之外/,
    )
  })
})

describe('createNodeVaultFs — a real directory', () => {
  let root = ''
  let fs: VaultFileSystem

  beforeAll(async () => {
    root = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'dsh-knowbase-vfs-')))
    fs = createNodeVaultFs(root)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists a directory that does not exist as empty', async () => {
    // A scan reads a folder that may not be there yet; throwing would turn
    // "nothing has been added" into a broken listing.
    expect(await fs.listDir(path.join(root, 'never-created'))).toEqual([])
  })

  it('reports a path that does not exist as undefined', async () => {
    expect(await fs.stat(path.join(root, 'never-created', 'file.txt'))).toBeUndefined()
  })

  it('creates parents, writes, reads and stats a file', async () => {
    const target = path.join(root, 'a', 'b', '手册.txt')
    await fs.writeFile(target, '出厂默认波特率为115200。')

    expect(await fs.readText(target)).toBe('出厂默认波特率为115200。')
    const info = await fs.stat(target)
    expect(info?.kind).toBe('file')
    expect(info?.size).toBe(new TextEncoder().encode('出厂默认波特率为115200。').byteLength)

    const listed = await fs.listDir(path.join(root, 'a', 'b'))
    expect(listed.map(entry => entry.name)).toEqual(['手册.txt'])
    expect(listed[0]!.kind).toBe('file')
  })

  it('moves a file', async () => {
    const from = path.join(root, 'a', 'b', '手册.txt')
    const to = path.join(root, 'a', '搬走了.txt')
    await fs.move(from, to)

    expect(await fs.stat(from)).toBeUndefined()
    expect(await fs.readText(to)).toBe('出厂默认波特率为115200。')
  })

  it('removes a directory and everything under it', async () => {
    await fs.writeFile(path.join(root, 'gone', 'deep', 'inside.txt'), 'x')
    await fs.remove(path.join(root, 'gone'))
    expect(await fs.stat(path.join(root, 'gone'))).toBeUndefined()
    await expect(fs.readText(path.join(root, 'gone', 'deep', 'inside.txt'))).rejects.toBeDefined()
  })
})

describe('createMemoryVaultFs', () => {
  const ROOT = path.resolve('C:/vault')
  const fs = createMemoryVaultFs(ROOT)

  it('lists a directory that does not exist as empty', async () => {
    expect(await fs.listDir(path.join(ROOT, 'never-created'))).toEqual([])
  })

  it('reports a path that does not exist as undefined', async () => {
    expect(await fs.stat(path.join(ROOT, 'never-created'))).toBeUndefined()
  })

  it('writes through a missing parent and reads the same text back', async () => {
    await fs.writeFile(path.join(ROOT, '产品资料--kb_1a2b3c4d', '手册.txt'), '正文')
    expect(await fs.readText(path.join(ROOT, '产品资料--kb_1a2b3c4d', '手册.txt'))).toBe('正文')

    const listed = await fs.listDir(path.join(ROOT, '产品资料--kb_1a2b3c4d'))
    expect(listed.map(entry => entry.name)).toEqual(['手册.txt'])
  })

  it('reads bytes as a copy, so a caller cannot mutate what is stored', async () => {
    const target = path.join(ROOT, '字节.bin')
    await fs.writeFile(target, new Uint8Array([1, 2, 3]))
    const first = await fs.readBytes(target)
    first[0] = 99
    expect([...(await fs.readBytes(target))]).toEqual([1, 2, 3])
  })

  it('keeps a directory\u2019s contents when the directory moves', async () => {
    const from = path.join(ROOT, '甲--kb_aaaa1111')
    const to = path.join(ROOT, '乙--kb_aaaa1111')
    await fs.writeFile(path.join(from, '深', '里面.txt'), '内容')
    await fs.move(from, to)

    expect(await fs.stat(from)).toBeUndefined()
    expect(await fs.readText(path.join(to, '深', '里面.txt'))).toBe('内容')
    expect((await fs.listDir(to)).map(entry => entry.name)).toEqual(['深'])
  })

  it('removes a directory and everything under it', async () => {
    const dir = path.join(ROOT, '要删的目录')
    await fs.writeFile(path.join(dir, '深', '文件.txt'), 'x')
    await fs.remove(dir)

    expect(await fs.stat(dir)).toBeUndefined()
    expect(await fs.stat(path.join(dir, '深', '文件.txt'))).toBeUndefined()
  })

  it('treats a file that is written twice as replaced, not appended', async () => {
    const target = path.join(ROOT, '重复.txt')
    await fs.writeFile(target, '第一版')
    await fs.writeFile(target, '第二版')
    expect(await fs.readText(target)).toBe('第二版')
  })
})
