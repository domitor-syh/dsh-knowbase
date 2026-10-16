/**
 * A "working" flag that lasts long enough to be seen.
 *
 * 检测, 重扫 and 重扫全部 all finish in tens of milliseconds — two `stat` calls,
 * one directory walk — so an icon tied strictly to the request would start and
 * stop between two frames and read as "the button did nothing", which is the
 * report this exists to answer. The flag therefore stays up for at least
 * {@link MIN_VISIBLE_MS}, and that number is the rotation period in
 * `./page-style.ts`, so a request that returns instantly still shows exactly one
 * full turn and comes to rest where it started.
 *
 * A failure is not this hook's business: every caller reports its own on the
 * page's notice strip, so a rejection is swallowed here rather than surfacing as
 * an unhandled one.
 *
 * @module @domitor-syh/dsh-knowbase/client/spin
 */

import * as React from 'react'

/** How long the icon keeps turning, in ms. Mirrors `.kb-icon-spin`'s period. */
const MIN_VISIBLE_MS = 600

/** Start a spin around one piece of work; the icon stops on its own. */
export type Spin = (work: () => Promise<unknown>) => void

/**
 * Subscribe to a spin flag.
 *
 * The starter takes the work itself rather than being a plain `set(true)`: only
 * then can the hook know when to start counting down, and only then does
 * "minimum visible" mean anything.
 */
export function useSpin(): readonly [boolean, Spin] {
  const [spinning, setSpinning] = React.useState(false)
  const alive = React.useRef(true)
  // Which spin the timer in flight belongs to. A second click must not be cut
  // short by the first one's timer.
  const token = React.useRef(0)

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const spin = React.useCallback<Spin>(work => {
    token.current += 1
    const mine = token.current
    const startedAt = Date.now()
    setSpinning(true)
    const stop = (): void => {
      if (alive.current && token.current === mine) setSpinning(false)
    }
    void Promise.resolve()
      .then(work)
      .catch(() => undefined)
      .then(() => {
        const left = MIN_VISIBLE_MS - (Date.now() - startedAt)
        if (left <= 0) {
          stop()
          return
        }
        window.setTimeout(stop, left)
      })
  }, [])

  return [spinning, spin]
}
