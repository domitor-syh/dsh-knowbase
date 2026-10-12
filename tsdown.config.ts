import { defineConfig } from 'tsdown'

/**
 * Dual-target build for the standalone repository, mirroring the layout the
 * DSH runtime contract expects (see dsh-rollback / dsh-ui-skin-switcher).
 *
 * Outputs:
 * - lib/index.js   ESM node half; `@deepseek-ai/*` and `node:*` stay external so
 *                  the host installation resolves them at runtime.
 * - lib/client.js  browser half wrapped in the `window.__ModuleLoader__.load({ id,
 *                  factory })` registration shell; `@deepseek-ai/*`, react and
 *                  react-dom stay external so the host's single React copy is
 *                  reused instead of shipping a second one.
 */

const PKG_ID = '@domitor-syh/dsh-knowbase'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'neutral',
    dts: false,
    sourcemap: false,
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
])
