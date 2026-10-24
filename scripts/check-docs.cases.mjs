import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkDocuments, destinations } from './check-docs.mjs'

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'knowbase-docs-check-'))
  try {
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'README.md'), '')
    writeFileSync(join(root, 'docs', '说明 (一).md'), '')
    run(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('accepts ordinary, angle-bracket, encoded, titled and parenthesized file links', () => {
  fixture(root => {
    writeFileSync(join(root, 'README.md'), '[a](<docs/说明 (一).md>) [b](docs/%E8%AF%B4%E6%98%8E%20%28%E4%B8%80%29.md#part) [c](<docs/说明 (一).md> "说明")\n[d](README.md?raw=1#part)')
    const result = checkDocuments(root, ['README.md', 'docs/说明 (一).md'])
    assert.equal(result.links, 4)
    assert.deepEqual(result.errors, [])
    assert.equal(destinations('[a](docs/name(one).md)')[0].destination, 'docs/name(one).md')
  })
})

test('resolves paths from each document directory and reports missing files with line numbers', () => {
  fixture(root => {
    writeFileSync(join(root, 'docs', '说明 (一).md'), '[good](../README.md)\n[bad](docs/README.md)')
    const result = checkDocuments(root, ['README.md', 'docs/说明 (一).md'])
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].line, 2)
    assert.match(result.errors[0].message, /docs\/README.md/)
  })
})

test('rejects ignored local artifacts and case mismatches even when the disk has them', () => {
  fixture(root => {
    writeFileSync(join(root, 'package.tgz'), 'local build')
    writeFileSync(join(root, 'README.md'), '[local](package.tgz) [case](readme.md)')
    const result = checkDocuments(root, ['README.md'])
    assert.equal(result.errors.length, 2)
  })
})

test('rejects invalid UTF-8 instead of silently replacing bytes', () => {
  fixture(root => {
    writeFileSync(join(root, 'README.md'), Buffer.from([0xc3, 0x28]))
    assert.match(checkDocuments(root, ['README.md']).errors[0].message, /UTF-8/)
  })
})

test('does not treat code examples, remote links or anchors as local files', () => {
  const source = '```md\n[example](missing.md)\n```\n`[inline](missing.md)` [web](<https://example.com/a>) [anchor](#part) [mail](mailto:hello@example.com)'
  fixture(root => {
    writeFileSync(join(root, 'README.md'), source)
    assert.deepEqual(checkDocuments(root, ['README.md']).errors, [])
    assert.equal(checkDocuments(root, ['README.md']).links, 0)
  })
})

test('checks linked images and versioned directories and rejects invalid URL encoding', () => {
  fixture(root => {
    writeFileSync(join(root, 'README.md'), '![image](missing.png) [directory](docs/) [invalid](bad%ZZ.md)')
    const result = checkDocuments(root, ['README.md', 'docs/说明 (一).md'])
    assert.equal(result.errors.length, 2)
    assert.match(result.errors[1].message, /编码无效/)
  })
})
