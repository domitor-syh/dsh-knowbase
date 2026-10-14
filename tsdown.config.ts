import { builtinModules } from 'node:module'
import { defineConfig } from 'tsdown'

/**
 * Build for the standalone repository, mirroring the layout the DSH runtime
 * contract expects (see dsh-rollback / dsh-ui-skin-switcher).
 *
 * Outputs:
 * - lib/index.js        ESM node half; `@deepseek-ai/*` and `node:*` stay external
 *                       so the host installation resolves them at runtime.
 * - lib/client.js       browser half wrapped in the `window.__ModuleLoader__.load({
 *                       id, factory })` registration shell; `@deepseek-ai/*`,
 *                       react and react-dom stay external so the host's single
 *                       React copy is reused instead of shipping a second one.
 * - lib/ocr-runtime.cjs tesseract.js, inlined. See below.
 * - lib/ocr-worker.cjs  the worker script `createWorker` spawns, inlined.
 *
 * Every target sets `clean: false` and `scripts/build.mjs` clears `lib/` once
 * before running tsdown: three targets share one output directory, so a
 * per-target clean would have each later target delete the earlier ones' files.
 */

/**
 * Every target below writes into `lib/`, so the OCR pair — which inlines the
 * engine — is built here rather than shipped as a dependency.
 *
 * `tesseract.js` carries `"postinstall": "opencollective-postinstall || true"`.
 * pnpm 11 refuses to install a build script it has not been told about, and the
 * setting it wants (`allowBuilds`) belongs to the *profile's* workspace root,
 * which no plugin can write: a fresh `dsh plugin add` dies with
 * `ERR_PNPM_IGNORED_BUILDS` before the plugin is ever loaded. Inlining the
 * engine removes it from the user's install tree entirely, which is what makes
 * a first install work with no manual step (`HANDOFF.md` §16「首装阻断 Spike」).
 *
 * What the bundler cannot carry is the WASM: the three `tesseract-core` loaders
 * are inlined, but each builds its `.wasm` file name at runtime and reads it
 * from its own `__dirname`. `scripts/build.mjs` copies all three variants next
 * to these outputs, after the build.
 */
const isNodeBuiltin = (id: string): boolean =>
  id.startsWith('node:') || builtinModules.includes(id)

const PKG_ID = '@domitor-syh/dsh-knowbase'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'neutral',
    dts: false,
    sourcemap: false,
    clean: false,
    // `zod` stays external too: it is a declared dependency, so the host
    // installation resolves it, and inlining a second copy would bloat the
    // bundle for no benefit.
    deps: { neverBundle: [/^@deepseek-ai\//, /^node:/, 'zod'] },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//, 'react', 'react-dom'] },
    // `zod` must be INLINED here, unlike in the host half. tsdown externalizes
    // everything listed in `dependencies` by default, and the browser half is
    // loaded from the host's module table, which serves platform seeds and
    // registered package factories — not arbitrary npm packages. Leaving it
    // external produced, at boot:
    //   require("zod") missed the module table — not a platform seed word, not
    //   a materialized module, and no registered package factory
    // The host half keeps zod external, because Node resolves it from the
    // profile's node_modules.
    noExternal: ['zod'],
    outputOptions: {
      entryFileNames: '[name].js',
      banner:
        'window.__ModuleLoader__.load({\n' +
        `\tid: ${JSON.stringify(PKG_ID)},\n` +
        '\tfactory: (require) => {\n' +
        '\t\tvar module = { exports: {} };\n' +
        '\t\tvar exports = module.exports;\n' +
        '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      footer:
        '\t\treturn module.exports;\n' +
        '\t}\n' +
        '});',
    },
  },
  // The two halves of the inlined OCR engine. Everything is inlined *except*
  // node's own builtins, which have to stay `require` calls: the worker runs in
  // a `worker_threads` thread and talks to `parentPort`, and a bundled copy of
  // `worker_threads` is not a thing that can work.
  //
  // `.cjs` is not cosmetic: this package is `"type": "module"`, so a `.js`
  // output would be evaluated as ESM and every `require` / `__dirname` inside
  // the inlined CommonJS engine would be undefined at the first use.
  {
    entry: { 'ocr-runtime': 'scripts/ocr-runtime.entry.cjs' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'node',
    dts: false,
    sourcemap: false,
    clean: false,
    deps: { alwaysBundle: isNodeBuiltin },
    outputOptions: { entryFileNames: 'ocr-runtime.cjs' },
  },
  {
    entry: { 'ocr-worker': 'scripts/ocr-worker.entry.cjs' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'node',
    dts: false,
    sourcemap: false,
    clean: false,
    deps: { alwaysBundle: isNodeBuiltin },
    outputOptions: { entryFileNames: 'ocr-worker.cjs' },
  },
])
