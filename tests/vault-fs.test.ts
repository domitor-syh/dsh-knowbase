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
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile as diskWriteFile } from 'node:fs/promises'
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
    root = await createFixture()
    fs = createNodeVaultFs(root)
  })

  afterAll(async () => {
    await removeFixture(root)
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

  it('refuses to create a directory over an ordinary file and preserves its contents', async () => {
    const target = path.join(root, 'keep-as-file.txt')
    await fs.writeFile(target, 'preserved')
    await expect(fs.ensureDir(target)).rejects.toThrow(/已存在且不是目录/)
    expect(await fs.readText(target)).toBe('preserved')
    expect((await fs.stat(target))?.kind).toBe('file')
    await fs.ensureDir(root)
    expect((await fs.stat(root))?.kind).toBe('directory')
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

describe('createNodeVaultFs — links stay outside the write boundary', () => {
  const fixtures: string[] = []

  async function fixture() {
    const temp = await createFixture()
    fixtures.push(temp)
    const root = path.join(temp, 'vault')
    const outside = path.join(temp, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await diskWriteFile(path.join(root, 'source.txt'), 'source')
    await diskWriteFile(path.join(outside, 'secret.txt'), 'outside')
    return { temp, root, outside, fs: createNodeVaultFs(root) }
  }

  afterAll(async () => {
    for (const temp of fixtures) await removeFixture(temp)
  })

  async function rejectsLinkOperations(fs: VaultFileSystem, target: string, root: string) {
    await expect(fs.readText(target)).rejects.toThrow(/链接路径/)
    await expect(fs.readBytes(target)).rejects.toThrow(/链接路径/)
    await expect(fs.writeFile(target, 'overwritten')).rejects.toThrow(/链接路径/)
    await expect(fs.ensureDir(target)).rejects.toThrow(/链接路径/)
    await expect(fs.remove(target)).rejects.toThrow(/链接路径/)
    await expect(fs.move(target, path.join(root, 'moved'))).rejects.toThrow(/链接路径/)
    await expect(fs.move(path.join(root, 'source.txt'), target)).rejects.toThrow(/链接路径/)
  }

  it.for(['inside', 'outside'] as const)('rejects a directory junction pointing %s for every operation', async (kind, ctx) => {
    const { root, outside, fs } = await fixture()
    const internal = path.join(root, 'actual')
    await mkdir(internal)
    await diskWriteFile(path.join(internal, 'secret.txt'), 'inside')
    const target = kind === 'outside' ? outside : internal
    const link = path.join(root, 'linked-dir')
    await makeLink(target, link, 'dir', ctx)
    expect((await fs.stat(link))?.kind).toBe('other')
    expect((await fs.listDir(root)).find(entry => entry.name === 'linked-dir')?.kind).toBe('other')
    expect(await fs.listDir(link)).toEqual([])
    await rejectsLinkOperations(fs, link, root)
    const child = path.join(link, 'secret.txt')
    await rejectsLinkOperations(fs, child, root)
    await expect(fs.stat(child)).rejects.toThrow(/链接路径/)
    await expect(fs.listDir(path.join(link, 'nested'))).rejects.toThrow(/链接路径/)
    await expect(fs.writeFile(path.join(link, 'missing', 'new.txt'), 'x')).rejects.toThrow(/链接路径/)
    await expect(fs.ensureDir(path.join(link, 'missing', 'nested'))).rejects.toThrow(/链接路径/)
    expect(await readFile(path.join(target, 'secret.txt'), 'utf8')).toBe(target === outside ? 'outside' : 'inside')
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('source')
    await expect(lstat(path.join(root, 'moved'))).rejects.toHaveProperty('code', 'ENOENT')
    await expect(lstat(path.join(target, 'missing'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it.for(['inside', 'outside', 'dangling'] as const)('rejects a %s file symlink without modifying its target', async (kind, ctx) => {
    const { root, outside, fs } = await fixture()
    const target = kind === 'outside' ? path.join(outside, 'secret.txt') : path.join(root, kind === 'inside' ? 'source.txt' : 'missing.txt')
    const link = path.join(root, 'file-link')
    await makeLink(target, link, 'file', ctx)
    expect((await fs.stat(link))?.kind).toBe('other')
    expect((await fs.listDir(root)).find(entry => entry.name === 'file-link')?.kind).toBe('other')
    await rejectsLinkOperations(fs, link, root)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    if (kind === 'dangling') await expect(lstat(target)).rejects.toHaveProperty('code', 'ENOENT')
    else expect(await readFile(target, 'utf8')).toBe(kind === 'outside' ? 'outside' : 'source')
  })

  it('rejects a dangling directory junction and missing children below it', async ctx => {
    const { root, outside, fs } = await fixture()
    const target = path.join(outside, 'missing-dir')
    const link = path.join(root, 'dangling-dir')
    await makeLink(target, link, 'dir', ctx)
    expect((await fs.stat(link))?.kind).toBe('other')
    await rejectsLinkOperations(fs, link, root)
    await rejectsLinkOperations(fs, path.join(link, 'child.txt'), root)
    await expect(lstat(target)).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('refuses to move or recursively remove a directory containing a nested link', async ctx => {
    const { root, outside, fs } = await fixture()
    const parent = path.join(root, 'container')
    await mkdir(path.join(parent, 'nested'), { recursive: true })
    await diskWriteFile(path.join(parent, 'keep.txt'), 'keep')
    await makeLink(outside, path.join(parent, 'nested', 'link'), 'dir', ctx)
    await expect(fs.move(parent, path.join(root, 'moved'))).rejects.toThrow(/链接路径/)
    await expect(fs.remove(parent)).rejects.toThrow(/链接路径/)
    expect(await readFile(path.join(parent, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside')
    await expect(lstat(path.join(root, 'moved'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('rejects moving a plain directory into a linked destination parent', async ctx => {
    const { root, outside, fs } = await fixture()
    await fs.ensureDir(path.join(root, 'ordinary'))
    await fs.writeFile(path.join(root, 'ordinary', 'a.txt'), 'keep')
    const link = path.join(root, 'destination')
    await makeLink(outside, link, 'dir', ctx)
    await expect(fs.move(path.join(root, 'ordinary'), path.join(link, 'new', 'child'))).rejects.toThrow(/链接路径/)
    expect(await fs.readText(path.join(root, 'ordinary', 'a.txt'))).toBe('keep')
    await expect(lstat(path.join(outside, 'new'))).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('rejects every operation when the configured vault root is a link', async ctx => {
    const { temp, root } = await fixture()
    const linkedRoot = path.join(temp, 'root-link')
    await makeLink(root, linkedRoot, 'dir', ctx)
    const fs = createNodeVaultFs(linkedRoot)
    await expect(fs.stat(linkedRoot)).rejects.toThrow(/链接路径/)
    await expect(fs.listDir(linkedRoot)).rejects.toThrow(/链接路径/)
    await expect(fs.readText(path.join(linkedRoot, 'source.txt'))).rejects.toThrow(/链接路径/)
    await expect(fs.readBytes(path.join(linkedRoot, 'source.txt'))).rejects.toThrow(/链接路径/)
    await expect(fs.writeFile(path.join(linkedRoot, 'new.txt'), 'x')).rejects.toThrow(/链接路径/)
    await expect(fs.ensureDir(path.join(linkedRoot, 'new'))).rejects.toThrow(/链接路径/)
    await expect(fs.move(path.join(linkedRoot, 'source.txt'), path.join(linkedRoot, 'other.txt'))).rejects.toThrow(/链接路径/)
    await expect(fs.remove(linkedRoot)).rejects.toThrow(/链接路径/)
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('source')
  })

  it('allows a trusted linked parent above a plain vault root', async ctx => {
    const { temp, root } = await fixture()
    const alias = path.join(temp, 'trusted-parent')
    const realParent = path.join(temp, 'trusted-real')
    await mkdir(realParent)
    await makeLink(realParent, alias, 'dir', ctx)
    const vault = path.join(alias, 'vault')
    const fs = createNodeVaultFs(vault)
    await fs.ensureDir(vault)
    await fs.writeFile(path.join(vault, 'a.txt'), 'trusted')
    expect(await fs.readText(path.join(vault, 'a.txt'))).toBe('trusted')
    expect(await readFile(path.join(realParent, 'vault', 'a.txt'), 'utf8')).toBe('trusted')
    expect((await fs.stat(vault))?.kind).toBe('directory')
    expect((await fs.listDir(vault)).map(entry => entry.name)).toEqual(['a.txt'])
    await fs.move(path.join(vault, 'a.txt'), path.join(vault, 'b.txt'))
    await fs.remove(path.join(vault, 'b.txt'))
    expect(await fs.listDir(vault)).toEqual([])
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('source')
  })

  it('creates a missing vault root and nested parents safely', async () => {
    const { temp } = await fixture()
    const root = path.join(temp, 'not-created', 'vault')
    const fs = createNodeVaultFs(root)
    expect(await fs.listDir(root)).toEqual([])
    await fs.writeFile(path.join(root, 'nested', 'a.txt'), 'new-root')
    expect(await fs.readText(path.join(root, 'nested', 'a.txt'))).toBe('new-root')
    await fs.ensureDir(path.join(root, 'other', 'deep'))
    expect((await fs.stat(path.join(root, 'other', 'deep')))?.kind).toBe('directory')
  })
})

const fixtureRoots = new Set<string>()

async function createFixture(): Promise<string> {
  const root = path.resolve(await mkdtemp(path.join(os.tmpdir(), 'dsh-knowbase-vfs-')))
  fixtureRoots.add(root)
  return root
}

async function makeLink(target: string, link: string, kind: 'dir' | 'file', ctx: { skip(): void }): Promise<void> {
  try {
    await symlink(target, link, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind)
  } catch (error) {
    // Vitest 2.1's ctx.skip sets pending and throws VITEST_PENDING, so the
    // original permission error below is not rethrown for a skipped test.
    if (process.platform === 'win32' && isPermissionError(error)) ctx.skip()
    throw error
  }
}

async function removeFixture(target: string): Promise<void> {
  const absolute = path.resolve(target)
  if (!fixtureRoots.has(absolute) || path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
      !path.basename(absolute).startsWith('dsh-knowbase-vfs-')) {
    throw new Error('Refusing to remove an unregistered temporary fixture')
  }
  await rm(absolute, { recursive: true, force: true })
  fixtureRoots.delete(absolute)
}

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    ((error as { code?: unknown }).code === 'EPERM' || (error as { code?: unknown }).code === 'EACCES')
}


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
