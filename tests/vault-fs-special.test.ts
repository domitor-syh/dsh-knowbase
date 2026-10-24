import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// No real sockets/FIFOs: a mistaken read on one could hang the test process.
const disk = vi.hoisted(() => ({
  lstat: vi.fn(), realpath: vi.fn(), readdir: vi.fn(),
  readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn(),
}))
vi.mock('node:fs/promises', () => disk)
import { createNodeVaultFs } from '../src/vault-fs.ts'

const ROOT = path.resolve('C:/vault-special-fixture')
const socket = path.join(ROOT, 'socket')
const source = path.join(ROOT, 'source.txt')
const container = path.join(ROOT, 'container')
const kinds = new Map<string, 'directory' | 'file' | 'other'>()

function info(kind: 'directory' | 'file' | 'other') {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
    size: 4,
    mtimeMs: 100,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  kinds.clear()
  kinds.set(ROOT, 'directory')
  kinds.set(source, 'file')
  kinds.set(socket, 'other')
  kinds.set(container, 'directory')
  kinds.set(path.join(container, 'socket'), 'other')
  disk.lstat.mockImplementation(async (target: string) => {
    const kind = kinds.get(target)
    if (!kind) throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' })
    return info(kind)
  })
  disk.realpath.mockImplementation(async (target: string) => target)
  disk.readdir.mockImplementation(async (target: string) => {
    return [...kinds.keys()].filter(candidate => candidate !== target && path.dirname(candidate) === target)
      .map(candidate => ({ name: path.basename(candidate) }))
  })
})

function expectNoIo() {
  expect(disk.readFile).not.toHaveBeenCalled()
  expect(disk.writeFile).not.toHaveBeenCalled()
  expect(disk.mkdir).not.toHaveBeenCalled()
  expect(disk.rename).not.toHaveBeenCalled()
  expect(disk.rm).not.toHaveBeenCalled()
}

describe('createNodeVaultFs — special objects do not reach file I/O', () => {
  it('reports a socket/special object as other in stat and parent listing', async () => {
    const fs = createNodeVaultFs(ROOT)
    expect((await fs.stat(socket))?.kind).toBe('other')
    expect((await fs.listDir(ROOT)).find(entry => entry.name === 'socket')?.kind).toBe('other')
    expectNoIo()
  })

  it('rejects reads, writes, mkdir, move and remove of a special final object', async () => {
    const fs = createNodeVaultFs(ROOT)
    await expect(fs.readText(socket)).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.readBytes(socket)).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.writeFile(socket, 'x')).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.ensureDir(socket)).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.move(socket, path.join(ROOT, 'moved'))).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.move(source, socket)).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.remove(socket)).rejects.toThrow(/特殊文件|非普通文件/)
    expectNoIo()
  })

  it('rejects listing a special object before attempting readdir', async () => {
    const fs = createNodeVaultFs(ROOT)
    await expect(fs.listDir(socket)).rejects.toThrow(/特殊文件|非普通文件/)
    expect(disk.readdir).not.toHaveBeenCalled()
    expectNoIo()
  })

  it('refuses directory move/remove when a nested special object is present', async () => {
    const fs = createNodeVaultFs(ROOT)
    await expect(fs.move(container, path.join(ROOT, 'moved'))).rejects.toThrow(/特殊文件|非普通文件/)
    await expect(fs.remove(container)).rejects.toThrow(/特殊文件|非普通文件/)
    expectNoIo()
  })

  it('rejects directory reads and writes, including the root, before file I/O or mkdir', async () => {
    const fs = createNodeVaultFs(ROOT)
    for (const directory of [ROOT, container]) {
      await expect(fs.readText(directory)).rejects.toThrow()
      await expect(fs.readBytes(directory)).rejects.toThrow()
      await expect(fs.writeFile(directory, 'x')).rejects.toThrow()
    }
    expectNoIo()
  })

  it('rejects ensureDir on an existing ordinary file before calling mkdir', async () => {
    const fs = createNodeVaultFs(ROOT)
    await expect(fs.ensureDir(source)).rejects.toThrow(/已存在且不是目录/)
    expectNoIo()
  })

  it('returns an empty listing for an ordinary file without calling readdir', async () => {
    const fs = createNodeVaultFs(ROOT)
    expect(await fs.listDir(source)).toEqual([])
    expect(disk.readdir).not.toHaveBeenCalled()
    expectNoIo()
  })
})
