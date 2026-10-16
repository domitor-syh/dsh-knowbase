/**
 * Handing a folder to the desktop's file manager.
 *
 * The page's row menu offers 「从文件资源管理器打开」, and the whole point of the
 * file model is that putting a document into the folder by hand is a supported
 * way in — so the one action that makes that route usable has to work, and has
 * to say the truth about whether it did.
 *
 * Two properties are worth pinning, and neither is reachable from a real click:
 *
 *   - **The platform dispatch.** Only one of the three openers is the one this
 *     machine has, and the two the developer is not sitting in front of cannot
 *     be exercised by hand. Injecting the platform is what makes all three
 *     branches testable.
 *   - **A failure is a sentence, not an exception.** A desktop with no opener is
 *     a normal outcome the page renders beside the path it could not open; a
 *     throw would escape into React's error path and blank the page instead.
 */

import { describe, expect, it } from 'vitest'
import { revealFolder, shellInfo } from '../src/core/shell.ts'

/** Records what the opener was asked to run, without running anything. */
function recorder(): { calls: string[][]; launch: (command: string, args: readonly string[]) => Promise<void> } {
  const calls: string[][] = []
  return {
    calls,
    launch: async (command, args) => {
      calls.push([command, ...args])
    },
  }
}

describe('shellInfo', () => {
  it('names the file manager each desktop actually has', () => {
    expect(shellInfo({ platform: 'win32' }).fileManager).toBe('文件资源管理器')
    expect(shellInfo({ platform: 'darwin' }).fileManager).toBe('访达')
    expect(shellInfo({ platform: 'linux' }).fileManager).toBe('文件管理器')
  })

  it('offers no reveal on a platform it has no opener for', () => {
    const info = shellInfo({ platform: 'aix' })
    expect(info.canReveal).toBe(false)
    // A name is still supplied: the page hides the menu item, but a failure
    // sentence built before that read must not contain the word `undefined`.
    expect(info.fileManager).toBe('文件管理器')
  })

  it('answers for the machine it is running on when nothing is injected', () => {
    const info = shellInfo()
    expect(typeof info.fileManager).toBe('string')
    expect(info.fileManager).not.toBe('')
    expect(typeof info.canReveal).toBe('boolean')
  })
})

describe('revealFolder', () => {
  it('starts Explorer on Windows', async () => {
    const { calls, launch } = recorder()
    const result = await revealFolder('C:\\vault\\产品资料', { platform: 'win32', launch })
    expect(calls).toEqual([['explorer.exe', 'C:\\vault\\产品资料']])
    expect(result).toEqual({
      ok: true,
      path: 'C:\\vault\\产品资料',
      fileManager: '文件资源管理器',
      message: '',
    })
  })

  it('starts Finder on macOS and the desktop opener on Linux', async () => {
    const mac = recorder()
    await revealFolder('/Users/me/vault/资料', { platform: 'darwin', launch: mac.launch })
    expect(mac.calls).toEqual([['open', '/Users/me/vault/资料']])

    const linux = recorder()
    await revealFolder('/home/me/vault/资料', { platform: 'linux', launch: linux.launch })
    expect(linux.calls).toEqual([['xdg-open', '/home/me/vault/资料']])
  })

  it('passes the path as one argument, so a folder name cannot change what runs', async () => {
    const { calls, launch } = recorder()
    await revealFolder('C:\\vault\\a b & calc', { platform: 'win32', launch })
    // One argv entry, not a command line: a space, an ampersand or a quote in a
    // folder name is then just characters in a path.
    expect(calls).toEqual([['explorer.exe', 'C:\\vault\\a b & calc']])
  })

  it('reports a missing opener instead of throwing', async () => {
    const { calls, launch } = recorder()
    const result = await revealFolder('/vault/资料', { platform: 'aix', launch })
    expect(calls).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没有可用')
  })

  it('reports a failed start instead of throwing', async () => {
    const result = await revealFolder('C:\\vault\\资料', {
      platform: 'win32',
      launch: async () => {
        throw new Error('spawn explorer.exe ENOENT')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('没能打开文件资源管理器')
    expect(result.message).toContain('ENOENT')
    // The path still travels back, so the page can show what it could not open.
    expect(result.path).toBe('C:\\vault\\资料')
  })
})
