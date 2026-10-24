import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { decodeUtf8Text } from '../src/core/text.ts'
import { createMemoryVaultFs, createNodeVaultFs } from '../src/vault-fs.ts'

const roots: string[] = []
afterEach(async () => {
  // Every entry was returned by mkdtemp with this owned prefix; never a user vault.
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith('dsh-utf8-test-')) throw new Error('unexpected cleanup target')
    await rm(root, { recursive: true, force: true })
  }
})

describe('strict UTF-8 decoder', () => {
  it.each([
    [0xc0, 0xaf], // overlong
    [0xed, 0xa0, 0x80], // surrogate
    [0xf4, 0x90, 0x80, 0x80], // beyond Unicode
    [0xe4, 0xb8], // truncated
    [0xff, 0xfe, 0x61, 0], // UTF-16 BOM
  ])('rejects malformed sequence %j without replacement decoding', (...bytes) => {
    expect(() => decodeUtf8Text(new Uint8Array(bytes))).toThrow('invalid-utf8')
  })
  it('accepts an intentionally encoded replacement character rather than repairing bytes', () => {
    expect(decodeUtf8Text(new TextEncoder().encode('合法文本�'))).toBe('合法文本�')
  })
})

for (const kind of ['node', 'memory'] as const) {
  describe(`${kind} strict text port`, () => {
    async function fixture() {
      const root = kind === 'node' ? await mkdtemp(path.join(os.tmpdir(), 'dsh-utf8-test-')) : path.resolve('C:/synthetic-text-port')
      if (kind === 'node') roots.push(root)
      return { fs: kind === 'node' ? createNodeVaultFs(root) : createMemoryVaultFs(root), file: path.join(root, 'data.json') }
    }
    it('reads exactly the byte bound and rejects the next byte, even without scan metadata', async () => {
      const { fs, file } = await fixture()
      await fs.writeFile(file, '汉字')
      expect(await fs.readText(file, 6)).toBe('汉字')
      await expect(fs.readText(file, 5)).rejects.toMatchObject({ code: 'too-large' })
      await fs.writeFile(file, '')
      expect(await fs.readText(file, 0)).toBe('')
      await fs.writeFile(file, 'x')
      await expect(fs.readText(file, 0)).rejects.toMatchObject({ code: 'too-large' })
    })
    it('uses identical strict decoding with and without a bound', async () => {
      const { fs, file } = await fixture()
      for (const limit of [undefined, 128]) {
        await fs.writeFile(file, new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 13, 10, 9]))
        expect(await fs.readText(file, limit)).toBe('a\r\n\t')
        await fs.writeFile(file, new Uint8Array([0xe4, 0xb8]))
        await expect(fs.readText(file, limit)).rejects.toMatchObject({ code: 'invalid-utf8' })
        await fs.writeFile(file, 'a\0b')
        await expect(fs.readText(file, limit)).rejects.toMatchObject({ code: 'binary' })
        // A failure closes its handle; a subsequent replacement/read still works.
        await fs.writeFile(file, 'recovered')
        expect(await fs.readText(file, limit)).toBe('recovered')
      }
    })
  })
}
