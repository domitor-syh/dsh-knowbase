/**
 * The whole build: clear `lib/`, bundle, then stage what a bundler cannot carry.
 *
 * Two steps exist because tsdown cannot do either of them for us:
 *
 * - **The clean.** Three targets write into `lib/`, and a per-target clean would
 *   have each later target delete the earlier ones' files. So `tsdown.config.ts`
 *   sets `clean: false` everywhere and the directory is removed here, once.
 * - **The WASM.** `lib/ocr-worker.cjs` inlines the three `tesseract.js-core`
 *   loaders, but a `.wasm` file is not an import the bundler can follow — it is
 *   a name the loader builds at runtime. The loader resolves it against its own
 *   `__dirname`, and after bundling that is the emitted file's directory, so the
 *   payloads are copied next to the outputs. Copying after the build is
 *   mandatory: an earlier copy is deleted by the clean.
 *
 * The tesseract.js licence travels with the code it covers, because this package
 * redistributes that code.
 *
 *     pnpm build
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageThirdPartyLicenses } from './stage-third-party-licenses.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = resolve(root, 'lib')

rmSync(lib, { recursive: true, force: true })

const require = createRequire(import.meta.url)

const tsdownDir = dirname(require.resolve('tsdown/package.json'))
const tsdown = spawnSync(process.execPath, [resolve(tsdownDir, 'dist/run.mjs')], {
  cwd: root,
  stdio: 'inherit',
})
if (tsdown.error !== undefined) throw tsdown.error
if (tsdown.status !== 0) process.exit(tsdown.status ?? 1)

// A `.wasm` cannot be bundled, so the three variants the loader may ask for are
// copied in: `tesseract.js` picks one at runtime from what the CPU supports
// (relaxed SIMD, plain SIMD, or neither), so all three have to be present.
const CORE_WASM = ['tesseract-core.wasm', 'tesseract-core-simd.wasm', 'tesseract-core-relaxedsimd.wasm']

const fromTesseract = createRequire(require.resolve('tesseract.js'))
const staged = []
for (const name of CORE_WASM) {
  const source = fromTesseract.resolve(`tesseract.js-core/${name}`)
  const target = resolve(lib, name)
  copyFileSync(source, target)
  staged.push(target)
}

// Apache-2.0: inlining the engine makes this package a redistributor of it, so
// the licence has to ship alongside.
const licence = resolve(lib, 'THIRD-PARTY-LICENSE-tesseract.txt')
copyFileSync(require.resolve('tesseract.js/LICENSE.md'), licence)
staged.push(licence)
staged.push(stageThirdPartyLicenses(root, lib))

for (const file of staged) {
  const bytes = statSync(file).size
  // A wasm under a megabyte is not a wasm: it is a truncated copy, and the only
  // symptom later would be a loader error at the first recognition.
  if (file.endsWith('.wasm') && bytes < 1024 * 1024) {
    throw new Error(`${relative(root, file)} is ${bytes} bytes — not a real payload`)
  }
  console.log(`staged ${relative(root, file)} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
}
