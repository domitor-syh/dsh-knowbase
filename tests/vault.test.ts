/**
 * The vault's naming and containment rules.
 *
 * These decide where a user's bytes actually land, so they are tested as pure
 * functions: a folder name that parses wrong adopts the wrong base, and a
 * containment check that is too lax lets a name built from user text write
 * outside the vault.
 */

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertInside,
  isBaseId,
  isInside,
  isRecycleName,
  parseVaultFolderName,
  RECYCLE_DIR_NAME,
  recycleDir,
  recycleTarget,
  resolveVaultRoot,
  sanitizeSegment,
  uniqueSegment,
  VAULT_DIR_NAME,
  vaultFolderName,
} from '../src/core/vault.ts'

describe('resolveVaultRoot', () => {
  it('prefers the explicit override so a probe never writes the real vault', () => {
    expect(
      resolveVaultRoot({ env: { DSH_KNOWBASE_ROOT: 'E:/dev/vault', DSH_HOME: 'C:/home/user/.dsh' }, homedir: 'C:/home/user' }),
    ).toBe(path.resolve('E:/dev/vault'))
  })

  it('falls back to $DSH_HOME/knowbase', () => {
    expect(resolveVaultRoot({ env: { DSH_HOME: 'C:/home/user/.dsh' }, homedir: 'C:/home/user' })).toBe(
      path.resolve('C:/home/user/.dsh', VAULT_DIR_NAME),
    )
  })

  it('falls back to ~/.dsh/knowbase, where an unconfigured host keeps its data', () => {
    expect(resolveVaultRoot({ env: {}, homedir: 'C:/home/user' })).toBe(
      path.resolve('C:/home/user', '.dsh', VAULT_DIR_NAME),
    )
  })

  it('ignores a blank override rather than resolving to the cwd', () => {
    expect(resolveVaultRoot({ env: { DSH_KNOWBASE_ROOT: '   ' }, homedir: 'C:/home/user' })).toBe(
      path.resolve('C:/home/user', '.dsh', VAULT_DIR_NAME),
    )
  })
})

describe('isInside / assertInside', () => {
  const root = 'C:/vault'

  it('accepts the root itself and anything under it', () => {
    expect(isInside(root, 'C:/vault')).toBe(true)
    expect(isInside(root, 'C:/vault/base/file.txt')).toBe(true)
  })

  it('rejects a sibling, a parent, and a lexical escape', () => {
    expect(isInside(root, 'C:/other')).toBe(false)
    expect(isInside(root, 'C:/')).toBe(false)
    expect(isInside(root, path.join(root, '..', 'other'))).toBe(false)
  })

  it('throws with a person-readable message rather than returning false', () => {
    expect(() => assertInside(root, 'C:/other')).toThrow(/知识库根目录之外/)
  })
})

describe('sanitizeSegment', () => {
  it('replaces separators so a name cannot forge a path boundary', () => {
    expect(sanitizeSegment('a/b', 'fb')).toBe('a_b')
    expect(sanitizeSegment('a\\b', 'fb')).toBe('a_b')
    expect(sanitizeSegment('a:b', 'fb')).toBe('a_b')
  })

  it('drops trailing dots and spaces, which Windows strips silently', () => {
    expect(sanitizeSegment('说明书. ', 'fb')).toBe('说明书')
  })

  it('refuses the reserved device names', () => {
    expect(sanitizeSegment('con', 'fb')).toBe('con_')
    expect(sanitizeSegment('LPT1', 'fb')).toBe('LPT1_')
  })

  it('falls back rather than producing an empty segment', () => {
    expect(sanitizeSegment('   ', '未命名文件')).toBe('未命名文件')
    expect(sanitizeSegment('...', '未命名文件')).toBe('未命名文件')
  })

  it('bounds the length without leaving a trailing dot behind', () => {
    const long = sanitizeSegment(`${'x'.repeat(200)}.`, 'fb')
    expect(long.length).toBeLessThanOrEqual(100)
    expect(long.endsWith('.')).toBe(false)
  })
})

describe('vaultFolderName / parseVaultFolderName', () => {
  it('round-trips a name and an id', () => {
    const folder = vaultFolderName('产品资料', 'kb_12345678')
    expect(folder).toBe('产品资料--kb_12345678')
    expect(parseVaultFolderName(folder)).toEqual({ name: '产品资料', id: 'kb_12345678' })
  })

  it('splits on the LAST separator, so a base may be called 「A--B」', () => {
    expect(parseVaultFolderName(vaultFolderName('A--B', 'kb_abcdef12'))).toEqual({
      name: 'A--B',
      id: 'kb_abcdef12',
    })
  })

  it('declines a folder the user made rather than inventing an identity', () => {
    expect(parseVaultFolderName('会议记录')).toBeUndefined()
    expect(parseVaultFolderName('会议记录--2026')).toBeUndefined()
  })

  it('accepts only ids this plugin generates', () => {
    expect(isBaseId('kb_12345678')).toBe(true)
    expect(isBaseId('kb_1234567')).toBe(false)
    expect(isBaseId('mat_12345678')).toBe(false)
  })
})

describe('uniqueSegment', () => {
  it('keeps the desired name when it is free', () => {
    expect(uniqueSegment('说明书.pdf', new Set())).toBe('说明书.pdf')
  })

  it('numbers the second arrival and keeps the extension intact', () => {
    expect(uniqueSegment('说明书.pdf', new Set(['说明书.pdf']))).toBe('说明书 (2).pdf')
    expect(uniqueSegment('说明书.pdf', new Set(['说明书.pdf', '说明书 (2).pdf']))).toBe(
      '说明书 (3).pdf',
    )
  })

  it('numbers a file that has no extension', () => {
    expect(uniqueSegment('README', new Set(['README']))).toBe('README (2)')
  })
})

describe('recycleTarget', () => {
  const root = 'C:/vault'

  it('lands in the recycle folder, keeping the entry name', () => {
    expect(recycleTarget(root, '说明书.pdf', new Set())).toBe(
      path.join(recycleDir(root), '说明书.pdf'),
    )
    expect(isRecycleName(RECYCLE_DIR_NAME)).toBe(true)
  })

  it('disambiguates when the recycle folder already holds that name', () => {
    expect(recycleTarget(root, 'a.txt', new Set(['a.txt']))).toBe(
      path.join(recycleDir(root), 'a (2).txt'),
    )
  })
})
