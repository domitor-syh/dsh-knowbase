import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bm25Index } from '../src/core/bm25.ts'
import { IMAGE_EXTENSIONS, INDEXABLE_EXTENSIONS, TEXT_EXTENSIONS, isIndexable } from '../src/core/model.ts'
import { KnowbaseService, MemoryStore } from '../src/core/service.ts'
import { TextReadError } from '../src/core/text.ts'
import { createMemoryVaultFs, type VaultFileSystem } from '../src/vault-fs.ts'

// This root is only a map key: none of these tests constructs a Node filesystem.
const ROOT = path.resolve('C:/text-formats-memory-vault')
const LIMIT = 2 * 1024 * 1024
const encoder = new TextEncoder()
// Independent of the production allowlist so an accidental omission cannot skip tests.
const FORMATS = [
  'txt', 'md', 'markdown', 'text', 'json', 'jsonl', 'yaml', 'yml', 'csv', 'tsv',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'css', 'scss', 'html', 'htm', 'xml', 'sql', 'sh', 'ps1',
] as const
const file = (name: string, text: string) => ({ name, data: encoder.encode(text) })

async function fixture(options: { fixedMtime?: boolean; reportedSize?: number } = {}) {
  const raw = createMemoryVaultFs(ROOT)
  const readText = vi.fn(raw.readText)
  const readBytes = vi.fn(raw.readBytes)
  const fs: VaultFileSystem = {
    ...raw,
    readText,
    readBytes,
    async listDir(dir) {
      const entries = await raw.listDir(dir)
      return entries.map(entry => ({
        ...entry,
        ...(options.fixedMtime ? { mtimeMs: 100 } : {}),
        ...(entry.kind === 'file' && options.reportedSize !== undefined
          ? { size: options.reportedSize } : {}),
      }))
    },
  }
  const store = new MemoryStore()
  let now = 0
  const service = new KnowbaseService(store, fs, ROOT, { now: () => ++now })
  await service.initialize()
  const base = await service.createKnowledgeBase('文本格式测试库')
  return { raw, fs, service, store, base, dir: path.join(ROOT, base.folderName), readText, readBytes }
}

function hit(service: KnowbaseService, kbId: string, query: string) {
  const outcome = service.retrieve(query, [kbId])
  if (outcome.kind !== 'hits') throw new Error(`expected hits, got ${outcome.kind}`)
  return outcome.passages[0]!
}

afterEach(() => vi.restoreAllMocks())

describe('O-05 explicit UTF-8 text format allowlist', () => {
  it('exports exactly the text allowlist and retains PDF/image indexing', () => {
    expect([...TEXT_EXTENSIONS].sort()).toEqual([...FORMATS].sort())
    expect([...INDEXABLE_EXTENSIONS].sort()).toEqual([...FORMATS, 'pdf', 'png', 'jpg', 'jpeg'].sort())
    expect([...IMAGE_EXTENSIONS].sort()).toEqual(['jpeg', 'jpg', 'png'])
    for (const extension of FORMATS) expect(isIndexable(`sample.${extension.toUpperCase()}`)).toBe(true)
  })

  describe.each(FORMATS)('.%s', extension => {
    it('stores and retrieves a unique body marker, not a filename/title match', async () => {
      const { service, base, dir, raw, readText, readBytes } = await fixture()
      const name = `sample.${extension}`
      const marker = `bodyuniquemarker${extension}`
      const text = `Ordinary text\n\n${marker} is present only in the body.`
      expect(name).not.toContain(marker)
      const added = await service.addFiles(base.id, [file(name, text)])
      expect(added).toHaveLength(1)
      expect(service.listMaterials(base.id)).toHaveLength(1)
      expect(service.getMaterial(base.id, name)).toMatchObject({
        fileName: name, extension, indexed: true, extractedText: text, note: '',
        bytes: encoder.encode(text).byteLength,
      })
      expect(await raw.readText(path.join(dir, name))).toBe(text)
      expect(readText).toHaveBeenCalledTimes(1)
      expect(readText).toHaveBeenCalledWith(path.join(dir, name), LIMIT)
      expect(readBytes).not.toHaveBeenCalled()
      expect(hit(service, base.id, marker)).toMatchObject({ materialId: name })
      expect(hit(service, base.id, marker).text).toContain(marker)
    })

    it('lists but does not index a rejected readText, and retries after repair', async () => {
      const { service, base, dir, readText, readBytes } = await fixture()
      const name = `locked.${extension}`
      readText.mockRejectedValueOnce(new Error('injected read denial'))
      await service.addFiles(base.id, [file(name, 'recoveredbodymarker')])
      expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: false, chunks: [] })
      expect(service.getMaterial(base.id, name)!.extractedText).toBeUndefined()
      expect(service.getMaterial(base.id, name)!.note).toMatch(/无法读取|读取失败/)
      expect(service.retrieve('recoveredbodymarker', [base.id]).kind).toBe('not_ready')
      expect(readText).toHaveBeenCalledTimes(1)
      expect(readText).toHaveBeenCalledWith(path.join(dir, name), LIMIT)
      expect(readBytes).not.toHaveBeenCalled()
      readText.mockClear()
      await service.rescan(base.id)
      expect(readText).toHaveBeenCalledTimes(1)
      expect(readText).toHaveBeenCalledWith(path.join(dir, name), LIMIT)
      expect(hit(service, base.id, 'recoveredbodymarker').materialId).toBe(name)
    })

    it('rejects metadata over 2 MiB before invoking either content reader', async () => {
      // A synthetic size avoids allocating a large file once per extension.
      const { service, base, readText, readBytes } = await fixture({ reportedSize: LIMIT + 1 })
      const name = `oversized.${extension}`
      await service.addFiles(base.id, [file(name, 'mustnotbeindexed')])
      expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: false, chunks: [], bytes: LIMIT + 1 })
      expect(service.getMaterial(base.id, name)!.note).toMatch(/超过.*2\s*Mi?B/i)
      expect(readText).not.toHaveBeenCalled()
      expect(readBytes).not.toHaveBeenCalled()
      expect(service.retrieve('mustnotbeindexed', [base.id]).kind).toBe('not_ready')
      await service.rescan(base.id, { force: true })
      expect(readText).not.toHaveBeenCalled()
      expect(readBytes).not.toHaveBeenCalled()
    })

    it('keeps empty text unsearchable without inventing content', async () => {
      const { service, base, readText } = await fixture()
      const name = `empty.${extension}`
      await service.addFiles(base.id, [file(name, '')])
      expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: false, chunks: [] })
      expect(service.getMaterial(base.id, name)!.extractedText ?? '').toBe('')
      expect(readText).toHaveBeenCalledTimes(1)
      expect(service.retrieve('empty', [base.id]).kind).toBe('not_ready')
    })

    it('reuses unchanged scans and force rebuilds without a spurious revision', async () => {
      const { service, base, readText } = await fixture()
      const name = `stable.${extension}`
      await service.addFiles(base.id, [file(name, 'stablebodymarker')])
      const prior = service.getMaterial(base.id, name)!
      const revision = service.getKnowledgeBase(base.id)!.indexRevision
      const add = vi.spyOn(Bm25Index.prototype, 'add')
      const remove = vi.spyOn(Bm25Index.prototype, 'remove')
      readText.mockClear()
      await service.rescan(base.id)
      expect(readText).not.toHaveBeenCalled()
      expect(add).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(service.getMaterial(base.id, name)).toBe(prior)
      expect(service.getLastScanReport(base.id)).toMatchObject({ added: 0, reused: 1, changed: 0, deleted: 0, unsearchable: 0 })
      await service.rescan(base.id, { force: true })
      expect(readText).toHaveBeenCalledTimes(1)
      expect(add).toHaveBeenCalledTimes(prior.chunks.length)
      expect(remove).toHaveBeenCalledTimes(prior.chunks.length)
      expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision)
      expect(hit(service, base.id, 'stablebodymarker').materialId).toBe(name)
    })

    it('removes old searchable chunks when text becomes invalid, then repairs them', async () => {
      const { service, base, raw, dir } = await fixture()
      const name = `changing.${extension}`
      await service.addFiles(base.id, [file(name, 'obsoletebodymarker'), file('anchor.txt', 'independentanchor')])
      const revision = service.getKnowledgeBase(base.id)!.indexRevision
      await raw.writeFile(path.join(dir, name), encoder.encode('invalid\u0000binary'))
      await service.rescan(base.id)
      expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: false, chunks: [] })
      expect(service.getMaterial(base.id, name)!.extractedText).toBeUndefined()
      expect(service.getMaterial(base.id, name)!.note).toMatch(/二进制|控制字符/)
      // The anchor keeps the base ready, distinguishing stale hits from no_match.
      expect(service.retrieve('obsoletebodymarker', [base.id]).kind).toBe('no_match')
      expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
      await raw.writeFile(path.join(dir, name), 'repairedbodymarker')
      await service.rescan(base.id)
      expect(hit(service, base.id, 'repairedbodymarker').materialId).toBe(name)
      expect(service.retrieve('obsoletebodymarker', [base.id]).kind).toBe('no_match')
      expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 2)
    })
  })

  it.each(['sample.docx', 'sample.bin', 'README', 'sample.', 'sample.zip', 'sample.pdf.exe', 'sample.svg', 'sample.ini'])('%s is stored but never read as text or bytes', async name => {
    const { service, base, raw, dir, readText, readBytes } = await fixture()
    await raw.writeFile(path.join(dir, name), 'unsupportedbodymarker')
    await service.rescan(base.id)
    expect(service.listMaterials(base.id)).toHaveLength(1)
    expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: false, chunks: [], note: '' })
    expect(isIndexable(name)).toBe(false)
    await service.rescan(base.id)
    await service.rescan(base.id, { force: true })
    expect(readText).not.toHaveBeenCalled()
    expect(readBytes).not.toHaveBeenCalled()
    expect(service.retrieve('unsupportedbodymarker', [base.id]).kind).toBe('not_ready')
  })

  it('handles uppercase and nested extensions on externally added files', async () => {
    const { service, base, raw, dir } = await fixture()
    await raw.writeFile(path.join(dir, 'nested', 'sample.TsX'), 'nestedbodymarker')
    await service.rescan(base.id)
    expect(service.getMaterial(base.id, 'nested/sample.TsX')).toMatchObject({ extension: 'tsx', indexed: true })
    expect(hit(service, base.id, 'nestedbodymarker').materialId).toBe('nested/sample.TsX')
  })
})

const MALFORMED_UTF8 = [
  ['stray continuation', [0x80]],
  ['truncated two-byte sequence', [0xc2]],
  ['truncated three-byte sequence', [0xe4, 0xb8]],
  ['truncated four-byte sequence', [0xf0, 0x9f, 0x98]],
  ['overlong NUL', [0xc0, 0x80]],
  ['encoded surrogate', [0xed, 0xa0, 0x80]],
  ['above Unicode maximum', [0xf4, 0x90, 0x80, 0x80]],
  ['invalid leading byte', [0xff]],
] as const
const FORBIDDEN_CONTROLS = Array.from({ length: 0xa0 }, (_, code) => code)
  .filter(code => (code < 0x20 && ![9, 10, 13].includes(code)) || code >= 0x7f)

describe('O-05 strict UTF-8 reads using only the memory filesystem', () => {
  it('strips an optional UTF-8 BOM and accepts CRLF, tabs and multilingual text', async () => {
    const { service, base, raw, dir } = await fixture()
    const text = 'Header\r\n\t中文 résumé 😀\r\n\r\nbomcrlfbodymarker\r\n'
    await service.addFiles(base.id, [file('bom.txt', `\uFEFF${text}`)])
    expect(await raw.readText(path.join(dir, 'bom.txt'))).toBe(text)
    expect(service.getMaterial(base.id, 'bom.txt')).toMatchObject({ indexed: true, extractedText: text })
    expect(hit(service, base.id, 'bomcrlfbodymarker').text).toContain('bomcrlfbodymarker')
  })

  it.each(MALFORMED_UTF8)('rejects %s instead of silently inserting U+FFFD', async (_label, bytes) => {
    const { service, base, raw, dir } = await fixture()
    const data = new Uint8Array([...encoder.encode('prefix '), ...bytes, ...encoder.encode(' suffix')])
    await service.addFiles(base.id, [{ name: 'malformed.txt', data }])
    await expect(raw.readText(path.join(dir, 'malformed.txt'))).rejects.toMatchObject({ code: 'invalid-utf8' })
    expect(service.getMaterial(base.id, 'malformed.txt')).toMatchObject({ indexed: false, chunks: [] })
    expect(service.getMaterial(base.id, 'malformed.txt')!.note).toMatch(/UTF-?8/i)
    expect(service.getMaterial(base.id, 'malformed.txt')!.extractedText).toBeUndefined()
  })

  it.each(FORBIDDEN_CONTROLS)('rejects forbidden C0/DEL/C1 control U+%i, including NUL and ESC', async code => {
    const { service, base, raw, dir } = await fixture()
    await service.addFiles(base.id, [file('control.txt', `prefix${String.fromCharCode(code)}suffix`)])
    await expect(raw.readText(path.join(dir, 'control.txt'))).rejects.toMatchObject({ code: 'binary' })
    expect(service.getMaterial(base.id, 'control.txt')).toMatchObject({ indexed: false, chunks: [] })
    expect(service.getMaterial(base.id, 'control.txt')!.note).toMatch(/二进制|控制字符/)
  })

  it.each([
    ['UTF-16 LE with BOM', [0xff, 0xfe, 0x41, 0x00]],
    ['UTF-16 BE with BOM', [0xfe, 0xff, 0x00, 0x41]],
    ['UTF-16 LE without BOM', [0x41, 0x00, 0x42, 0x00]],
    ['UTF-16 BE without BOM', [0x00, 0x41, 0x00, 0x42]],
  ] as const)('rejects %s rather than guessing the encoding', async (_label, bytes) => {
    const { service, base } = await fixture()
    await service.addFiles(base.id, [{ name: 'utf16.txt', data: new Uint8Array(bytes) }])
    expect(service.getMaterial(base.id, 'utf16.txt')).toMatchObject({ indexed: false, chunks: [] })
    expect(service.getMaterial(base.id, 'utf16.txt')!.note).toMatch(/UTF-?8|二进制|控制字符/i)
  })

  it('accepts a literal replacement character when it was validly UTF-8 encoded', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const target = path.join(ROOT, 'valid.txt')
    await fs.writeFile(target, 'valid \uFFFD text')
    expect(await fs.readText(target)).toBe('valid \uFFFD text')
  })

  it('enforces maxBytes on actual bytes, with an inclusive boundary and optional ceiling', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const target = path.join(ROOT, 'boundary.txt')
    await fs.writeFile(target, '中文')
    expect(await fs.readText(target)).toBe('中文')
    expect(await fs.readText(target, 6)).toBe('中文')
    await expect(fs.readText(target, 5)).rejects.toMatchObject({ code: 'too-large' })
    await fs.writeFile(target, '')
    expect(await fs.readText(target, 0)).toBe('')
    await fs.writeFile(target, 'a')
    await expect(fs.readText(target, 0)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('rejects an actual file above 2 MiB in the memory read port', async () => {
    const fs = createMemoryVaultFs(ROOT)
    const target = path.join(ROOT, 'large.txt')
    const bytes = new Uint8Array(LIMIT + 1).fill(0x61)
    await fs.writeFile(target, bytes)
    await expect(fs.readText(target, LIMIT)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('allows metadata exactly at the service ceiling and passes the ceiling to readText', async () => {
    const { service, base, readText, dir } = await fixture({ reportedSize: LIMIT })
    await service.addFiles(base.id, [file('boundary.txt', 'boundarybodymarker')])
    expect(readText).toHaveBeenCalledTimes(1)
    expect(readText).toHaveBeenCalledWith(path.join(dir, 'boundary.txt'), LIMIT)
    expect(hit(service, base.id, 'boundarybodymarker').materialId).toBe('boundary.txt')
  })

  it.each([
    ['invalid-utf8', /UTF-?8/i],
    ['binary', /二进制|控制字符/],
    ['too-large', /超过.*2\s*Mi?B/i],
  ] as const)('maps a read-time %s error even when metadata passed preflight', async (code, note) => {
    const { service, base, readText, dir } = await fixture()
    readText.mockRejectedValueOnce(new TextReadError(code))
    await service.addFiles(base.id, [file('race.txt', 'smallbody')])
    expect(readText).toHaveBeenCalledTimes(1)
    expect(readText).toHaveBeenCalledWith(path.join(dir, 'race.txt'), LIMIT)
    expect(service.getMaterial(base.id, 'race.txt')).toMatchObject({ indexed: false, chunks: [] })
    expect(service.getMaterial(base.id, 'race.txt')!.note).toMatch(note)
  })
})

describe('O-05 plain source indexing, never parsing or executing', () => {
  const SOURCE_FORMATS = FORMATS.filter(extension => !['txt', 'md', 'markdown', 'text'].includes(extension))

  it.each(SOURCE_FORMATS)('keeps hash-prefixed plain text searchable without Markdown headings in .%s', async extension => {
    const { service, base } = await fixture()
    const name = `comments.${extension}`
    const text = '# firstcommentmarker\n# secondcommentmarker'
    await service.addFiles(base.id, [file(name, text)])
    const material = service.getMaterial(base.id, name)!
    expect(material).toMatchObject({ indexed: true, extractedText: text, note: '' })
    expect(material.chunks.length).toBeGreaterThan(0)
    expect(material.chunks.every(chunk => chunk.headingPath === '')).toBe(true)
    for (const marker of ['firstcommentmarker', 'secondcommentmarker']) {
      expect(hit(service, base.id, marker)).toMatchObject({ materialId: name })
      expect(hit(service, base.id, marker).text).toContain(marker)
    }
  })

  it.each(['py', 'sh', 'yaml'])('keeps long .%s comments searchable across chunk boundaries', async extension => {
    const { service, base } = await fixture()
    const name = `long-comments.${extension}`
    // Each line is below the 900-character hard cap; the combined comment-only
    // block is above it, exercising splitOversized without splitting a marker.
    const markers = ['startcommentmarker', 'middlecommentmarker', 'endcommentmarker']
    const text = markers.map(marker => `# ${marker} ${'padding '.repeat(80)}`).join('\n')
    await service.addFiles(base.id, [file(name, text)])
    const material = service.getMaterial(base.id, name)!
    expect(material).toMatchObject({ indexed: true, extractedText: text, note: '' })
    expect(material.chunks.length).toBeGreaterThan(1)
    expect(material.chunks.every(chunk => chunk.headingPath === '')).toBe(true)
    for (const marker of markers) {
      expect(hit(service, base.id, marker)).toMatchObject({ materialId: name })
      expect(hit(service, base.id, marker).text).toContain(marker)
    }
  })

  it.each([
    ['invalid.json', '{ brokenjsonbodymarker: [not JSON,'],
    ['invalid.jsonl', 'first line is not JSON\n{ brokenjsonlbodymarker'],
    ['invalid.yaml', 'brokenyamlbodymarker: [unterminated\n\t: :'],
    ['invalid.yml', 'brokenymlbodymarker: !!invalid ['],
  ])('indexes invalid structured text %s verbatim', async (name, text) => {
    const { service, base } = await fixture()
    await service.addFiles(base.id, [file(name, text)])
    expect(service.getMaterial(base.id, name)).toMatchObject({ indexed: true, extractedText: text, note: '' })
    const marker = text.match(/broken[a-z]+bodymarker/)![0]
    expect(hit(service, base.id, marker).materialId).toBe(name)
  })

  it.each(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'sh', 'ps1', 'html'])('does not execute .%s source', async extension => {
    const { service, base } = await fixture()
    const sentinel = '__o05_text_formats_must_not_execute__'
    expect(Object.prototype.hasOwnProperty.call(globalThis, sentinel)).toBe(false)
    const text = `globalThis.${sentinel} = true; throw new Error('never execute');\nsourcebodymarker`
    await service.addFiles(base.id, [file(`source.${extension}`, text)])
    expect(Object.prototype.hasOwnProperty.call(globalThis, sentinel)).toBe(false)
    expect(service.getMaterial(base.id, `source.${extension}`)!.extractedText).toBe(text)
    expect(hit(service, base.id, 'sourcebodymarker').materialId).toBe(`source.${extension}`)
  })

  it('force repairs same-size/same-mtime source edits while ordinary scans reuse the prior text', async () => {
    const { service, base, raw, dir, readText } = await fixture({ fixedMtime: true })
    await service.addFiles(base.id, [file('sample.json', 'oldbodymarker')])
    const revision = service.getKnowledgeBase(base.id)!.indexRevision
    await raw.writeFile(path.join(dir, 'sample.json'), 'newbodymarker')
    readText.mockClear()
    await service.rescan(base.id)
    expect(readText).not.toHaveBeenCalled()
    expect(hit(service, base.id, 'oldbodymarker').materialId).toBe('sample.json')
    await service.rescan(base.id, { force: true })
    expect(readText).toHaveBeenCalledTimes(1)
    expect(hit(service, base.id, 'newbodymarker').materialId).toBe('sample.json')
    expect(service.retrieve('oldbodymarker', [base.id]).kind).toBe('no_match')
    expect(service.getKnowledgeBase(base.id)!.indexRevision).toBe(revision + 1)
  })
})
