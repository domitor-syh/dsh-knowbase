/**
 * Build input for `lib/ocr-runtime.cjs` — the OCR engine half of the plugin.
 *
 * The plugin inlines tesseract.js instead of depending on it. A dependency whose
 * manifest carries a `postinstall` makes pnpm 11 abort the whole install with
 * `ERR_PNPM_IGNORED_BUILDS`, and that decision lives in the *profile's*
 * `pnpm-workspace.yaml`, which a plugin cannot write. Shipping our own copy of
 * the engine removes it from the user's install tree, so there is no install
 * script to argue about and nothing for the user to do (`ERR_PNPM_IGNORED_BUILDS`).
 *
 * Deliberately CommonJS and deliberately free of `import`/`export`: a bundler
 * only rewrites the `require` calls of a file it reads as CommonJS.
 */
module.exports = require('tesseract.js')
