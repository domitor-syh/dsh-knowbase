/**
 * The reader's address grammar and its navigation parameters.
 *
 * These are the two places a citation turns into a location, so they are tested
 * as pure functions: an address that round-trips wrong opens the wrong material,
 * and a params shape read too trustingly opens the right material at a passage
 * that does not exist.
 *
 * The ids are deliberately awkward — a knowledge-base id and a material id are
 * both opaque, so anything that survives only because the fixture happens to be
 * alphanumeric is not actually tested.
 */

import { describe, expect, it } from 'vitest'
import {
  chunkOfParams,
  knowbaseResourceOfAddress,
  parseReaderAddress,
  provisionalTitle,
  readerAddress,
  titleOfParams,
} from '../src/client/reader-address.ts'

const KB = 'kb-7f3a-2b'
const MATERIAL = 'mat 9d/1'

describe('readerAddress', () => {
  it('builds an address the host recognises as a resource', () => {
    expect(readerAddress('kb1', 'mat1')).toBe('dsh-resource://knowbase/kb1/mat1')
  })

  it('encodes segments so a slash inside an id cannot forge a path boundary', () => {
    const address = readerAddress(KB, MATERIAL)
    expect(address).toBe('dsh-resource://knowbase/kb-7f3a-2b/mat%209d%2F1')
    expect(parseReaderAddress(address)).toEqual({ kbId: KB, materialId: MATERIAL })
  })

  it('round-trips an id that looks like a percent escape', () => {
    const tricky = '100%25done'
    expect(parseReaderAddress(readerAddress('kb', tricky))).toEqual({
      kbId: 'kb',
      materialId: tricky,
    })
  })
})

describe('parseReaderAddress', () => {
  it('rejects another protocol', () => {
    expect(parseReaderAddress('dsh-resource://file/session/s1/a.md')).toBeUndefined()
  })

  it('rejects a bare prefix with no ids', () => {
    expect(parseReaderAddress('dsh-resource://knowbase/')).toBeUndefined()
    expect(parseReaderAddress('dsh-resource://knowbase/kb1')).toBeUndefined()
    expect(parseReaderAddress('dsh-resource://knowbase/kb1/')).toBeUndefined()
  })

  it('rejects a malformed percent escape instead of throwing', () => {
    expect(parseReaderAddress('dsh-resource://knowbase/kb1/%E0%A4%A')).toBeUndefined()
  })

  it('ignores a query or fragment, which is not part of the identity', () => {
    expect(parseReaderAddress('dsh-resource://knowbase/kb1/mat1?chunk=2#x')).toEqual({
      kbId: 'kb1',
      materialId: 'mat1',
    })
  })

  it('rejects a non-address', () => {
    expect(parseReaderAddress('not a url')).toBeUndefined()
  })
})

describe('knowbaseResourceOfAddress', () => {
  it('names the material, which is all the resource provider promises', () => {
    expect(knowbaseResourceOfAddress(readerAddress(KB, MATERIAL))).toEqual({
      kind: 'knowbase-material',
      address: 'dsh-resource://knowbase/kb-7f3a-2b/mat%209d%2F1',
      kbId: KB,
      materialId: MATERIAL,
    })
  })

  it('declines an address that is not a reader address', () => {
    expect(knowbaseResourceOfAddress('dsh-resource://file/session/s1/a.md')).toBeUndefined()
  })
})

describe('chunkOfParams', () => {
  it('reads a chunk ordinal', () => {
    expect(chunkOfParams({ chunk: 3 })).toBe(3)
    expect(chunkOfParams({ chunk: 0 })).toBe(0)
  })

  it('ignores everything that is not a usable ordinal', () => {
    // `params` crosses an untyped boundary, so the body must land at the top
    // rather than throw on a shape it did not expect.
    for (const params of [undefined, null, {}, { chunk: '3' }, { chunk: -1 }, { chunk: 1.5 }, { chunk: NaN }]) {
      expect(chunkOfParams(params)).toBeUndefined()
    }
  })
})

describe('titleOfParams', () => {
  it('reads a title the opener carried', () => {
    expect(titleOfParams({ title: '端口说明' })).toBe('端口说明')
  })

  it('ignores a blank or non-string title', () => {
    expect(titleOfParams({ title: '   ' })).toBeUndefined()
    expect(titleOfParams({ title: 7 })).toBeUndefined()
    expect(titleOfParams(undefined)).toBeUndefined()
  })
})

describe('provisionalTitle', () => {
  it('truncates the material id so the chip is obviously provisional', () => {
    expect(provisionalTitle('dsh-resource://knowbase/kb1/abcdef123456')).toBe('资料 abcdef')
  })

  it('falls back to a generic label for an address it cannot parse', () => {
    expect(provisionalTitle('dsh-resource://file/session/s1/a.md')).toBe('知识库资料')
  })
})
