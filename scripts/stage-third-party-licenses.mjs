import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

// Packages inlined by the browser and OCR builds. Host-resolved dependencies
// distribute their own licenses. Keep these notices with the inlined code.
const BUNDLED = new Set([
  'zod', 'tesseract.js', 'tesseract.js-core', 'regenerator-runtime',
  'webidl-conversions', 'whatwg-url', 'tr46', 'node-fetch', 'is-url',
  'bmp-js', 'wasm-feature-detect',
])

export function stageThirdPartyLicenses(root, lib) {
  const pending = [resolve(root, 'package.json')]
  const visited = new Set()
  const found = new Map()
  while (pending.length > 0) {
    const manifestPath = pending.shift()
    if (visited.has(manifestPath)) continue
    visited.add(manifestPath)
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const dir = dirname(manifestPath)
    if (BUNDLED.has(pkg.name)) {
      const names = readdirSync(dir).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name))
        .filter(name => statSync(join(dir, name)).isFile()).sort()
      let texts
      if (names.length === 0 && pkg.name === 'tr46' && pkg.version === '0.0.3' && pkg.license === 'MIT') {
        texts = readFileSync(resolve(root, 'scripts/licenses/tr46-MIT.txt'), 'utf8').trim()
      } else {
        if (names.length === 0) throw new Error(`Missing upstream license: ${pkg.name}`)
        texts = names.map(name => `${name}\n\n${readFileSync(join(dir, name), 'utf8').trim()}`).join('\n\n')
      }
      found.set(`${pkg.name}@${pkg.version}`, texts)
    }
    // Traverse only the dependencies of the two inlined entry packages. Do not
    // visit the plugin's development/Host dependency graph.
    const dependencies = manifestPath === resolve(root, 'package.json')
      ? ['zod', 'tesseract.js'] : Object.keys(pkg.dependencies ?? {})
    const require = createRequire(manifestPath)
    for (const name of dependencies) {
      let next
      try { next = require.resolve(`${name}/package.json`) }
      catch {
        let candidate = dirname(require.resolve(name))
        for (;;) {
          try {
            const file = join(candidate, 'package.json')
            if (JSON.parse(readFileSync(file, 'utf8')).name === name) { next = file; break }
          } catch {}
          const parent = dirname(candidate)
          if (parent === candidate) throw new Error(`Cannot locate package manifest: ${name}`)
          candidate = parent
        }
      }
      pending.push(next)
    }
  }
  for (const name of BUNDLED) {
    if (![...found.keys()].some(key => key.startsWith(`${name}@`))) throw new Error(`Missing bundled dependency: ${name}`)
  }
  const sections = [...found.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, text]) => `${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n\n${text}`)
  const output = resolve(lib, 'THIRD-PARTY-NOTICES.txt')
  writeFileSync(output, `Licenses and notices for bundled third-party code.\n\n${sections.join('\n\n')}\n`, 'utf8')
  return output
}
