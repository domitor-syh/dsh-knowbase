/**
 * Handing a folder to the operating system's file manager.
 *
 * The page's whole model is "the folder is the record": a base *is* a directory
 * in the vault, and putting a file in it by hand is a supported way to add
 * material. So the one action that makes that model usable is being able to
 * open that directory — without it the user is left copying a path out of a
 * tooltip and pasting it into Explorer.
 *
 * ## Why this is not the host's own helper
 *
 * The host ships `@deepseek-ai/dsh-native-command` (`revealNativePath`,
 * `nativeFileManager`, `canOpenNativePath`) and it is the better implementation
 * — it knows about WSL path translation and checks the desktop itself. It is
 * not reachable from a plugin: the package lives inside `app.asar`, it is not a
 * published dependency, and the host does not expose it as a Cordis service
 * (`ctx.provide` offers `resources`, `layout`, `theme`, … and nothing for this).
 * Spawning the platform's own opener is the reachable equivalent, so the two
 * facts the host's helper would have supplied — which file manager this is, and
 * whether it can be opened at all — are supplied here instead, and the page
 * words its menu from them rather than assuming Windows.
 *
 * ## What "opened" means
 *
 * The host's own documentation is explicit that a successful hand-off is not
 * proof a window appeared. This module is equally modest: it reports whether the
 * opener process was *started*, and says so, because the alternative — claiming
 * the folder is on screen when it may not be — is a lie the user cannot check
 * without opening the folder themselves.
 *
 * @module @domitor-syh/dsh-knowbase/core/shell
 */

/** Which file manager this desktop has, and whether it can be asked to open one. */
export interface ShellInfo {
  /** What to call it in the UI: 文件资源管理器 / 访达 / 文件管理器. */
  readonly fileManager: string
  /** False on a headless or unknown platform, where the page must not offer it. */
  readonly canReveal: boolean
}

/** The result of asking the desktop to show a folder. */
export interface RevealOutcome {
  /** True when the opener process was started; not proof that a window opened. */
  readonly ok: boolean
  readonly path: string
  /** The name to use in the sentence the user reads. */
  readonly fileManager: string
  /** Why it failed, when it did; `''` otherwise. */
  readonly message: string
}

/**
 * The pieces the platform dispatch is built from.
 *
 * Injected so the dispatch is testable on one machine: the tests drive every
 * branch (including the two the developer is not sitting in front of) by
 * replacing the platform and the spawner, which is the same trade the rest of
 * `core/` makes for the filesystem.
 */
export interface ShellInternals {
  readonly platform?: string
  /** Start a detached process. Rejects when the executable is missing. */
  readonly launch?: (command: string, args: readonly string[]) => Promise<void>
}

/** The command that opens a directory, per platform. */
function openerFor(platform: string): { command: string; fileManager: string } | undefined {
  if (platform === 'win32') return { command: 'explorer.exe', fileManager: '文件资源管理器' }
  if (platform === 'darwin') return { command: 'open', fileManager: '访达' }
  if (platform === 'linux') return { command: 'xdg-open', fileManager: '文件管理器' }
  return undefined
}

/**
 * Start a detached opener process.
 *
 * Detached and unref'd because the page must not hold a handle on the file
 * manager: closing the app should not be blocked by a window the user left open,
 * and the opener's own exit code is not information this plugin can use.
 */
async function launchDetached(command: string, args: readonly string[]): Promise<void> {
  const { spawn } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    // `spawn` means the process exists; waiting for `exit` would mean waiting for
    // the user to close the window.
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** What this desktop calls its file manager, and whether it has one. */
export function shellInfo(internals: ShellInternals = {}): ShellInfo {
  const platform = internals.platform ?? process.platform
  const opener = openerFor(platform)
  if (opener === undefined) return { fileManager: '文件管理器', canReveal: false }
  return { fileManager: opener.fileManager, canReveal: true }
}

/**
 * Ask the desktop to open `path` in its file manager.
 *
 * Never throws: a machine without an opener, or one whose opener has been
 * removed, is a normal outcome the page reports next to the path it could not
 * open. The path travels as its own argv entry so a directory named with spaces
 * or a shell metacharacter cannot change what runs.
 */
export async function revealFolder(
  path: string,
  internals: ShellInternals = {},
): Promise<RevealOutcome> {
  const info = shellInfo(internals)
  const platform = internals.platform ?? process.platform
  const opener = openerFor(platform)
  if (opener === undefined) {
    return {
      ok: false,
      path,
      fileManager: info.fileManager,
      message: `这台机器上没有可用的${info.fileManager}。`,
    }
  }
  try {
    await (internals.launch ?? launchDetached)(opener.command, [path])
    return { ok: true, path, fileManager: opener.fileManager, message: '' }
  } catch (failure) {
    return {
      ok: false,
      path,
      fileManager: opener.fileManager,
      message: `没能打开${opener.fileManager}：${failure instanceof Error ? failure.message : String(failure)}`,
    }
  }
}
