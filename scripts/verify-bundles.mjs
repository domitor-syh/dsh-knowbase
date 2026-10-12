/**
 * Build-artifact contract smoke test.
 *
 * `tsc` proves the source matches the published type contracts and `tsdown`
 * proves it bundles — neither proves the emitted files match what the DSH
 * runtime actually loads. This script closes that gap by exercising the two
 * bundles the way the host does:
 *
 * - Host half: imported as ESM; must export `name`, `inject` and `apply`.
 * - Browser half: evaluated against a stubbed `window.__ModuleLoader__`; the
 *   registered factory must produce the same exports, and must NOT have inlined
 *   `react` or any `@deepseek-ai/*` module (a second React copy in the bundle is
 *   the exact failure the host's single-React rule exists to prevent).
 *
 * Run after `pnpm build`.
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_ID = '@domitor-syh/dsh-knowbase'

let failures = 0

/** Report one assertion outcome. */
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok    ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------- host half

console.log('host half (lib/index.js)')
const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

check('exports name', typeof host.name === 'string', `got ${typeof host.name}`)
check('exports inject array', Array.isArray(host.inject), `got ${typeof host.inject}`)
check('exports apply()', typeof host.apply === 'function', `got ${typeof host.apply}`)

// `apply` must survive a context offering only what the plugin uses: `effect`
// for lifetime, `on` for the pre-step waterfall, and `inject` for the services
// it acquires lazily. A throw here means the host would fail to mount us.
if (typeof host.apply === 'function') {
  const disposers = []
  const listeners = new Map()
  const injected = []
  const stubCtx = {
    effect: (factory) => {
      disposers.push(factory())
      return () => {}
    },
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => true
    },
    inject: (services, _callback) => {
      injected.push(...services)
      return () => {}
    },
  }
  try {
    host.apply(stubCtx)
    check('apply() tolerates a minimal context', true)
    check('registers a disposer via ctx.effect', disposers.length === 1, `got ${disposers.length}`)
    // The retrieval seam is the whole point of the host half; a build that
    // stopped wiring it would otherwise still load and look healthy.
    check(
      'subscribes to the agent/pre-step waterfall',
      typeof listeners.get('agent/pre-step') === 'function',
    )
    // Services must be acquired through `ctx.inject`, never declared in the
    // static `inject` array: a name no build provides parks the whole host half
    // in "pending" forever, with no apply and no error anywhere.
    check('declares no static service requirements', host.inject.length === 0, host.inject.join(','))
    check('acquires storageDomain dynamically', injected.includes('storageDomain'))
    check('acquires commands dynamically', injected.includes('commands'))
  } catch (error) {
    check('apply() tolerates a minimal context', false, String(error))
  }
}

// ------------------------------------------------------------- browser half

console.log('browser half (lib/client.js)')
const clientSource = await readFile(resolve(root, 'lib/client.js'), 'utf8')

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      registration = entry
    },
  },
}

// The factory receives the host's `require`; mirror that so externals resolve.
const hostRequire = createRequire(resolve(root, 'package.json'))

try {
  // eslint-disable-next-line no-eval
  ;(0, eval)(clientSource)
  check('registers through window.__ModuleLoader__.load', registration !== null)
  check('registers under the package id', registration?.id === PKG_ID, `got ${registration?.id}`)

  const exported = registration.factory(hostRequire)
  check('factory exports name', typeof exported.name === 'string')
  check('factory exports inject array', Array.isArray(exported.inject))
  check('factory exports apply()', typeof exported.apply === 'function')
} catch (error) {
  check('evaluates as a lazy-CJS factory', false, String(error))
}

// Externals must stay external: the source may only reference them through the
// injected `require`, never as inlined module bodies.
for (const external of ['react', 'react-dom']) {
  const inlined = clientSource.includes(`node_modules/${external}/`)
  check(`${external} is not inlined`, !inlined)
}
check(
  'no @deepseek-ai/* module body is inlined',
  !clientSource.includes('node_modules/@deepseek-ai/'),
)

// -------------------------------------------------------------------- result

console.log('')
if (failures === 0) {
  console.log('bundle contract: OK')
} else {
  console.error(`bundle contract: ${failures} check(s) failed`)
  process.exitCode = 1
}
