/**
 * Build input for `lib/ocr-worker.cjs` — the thread `createWorker` spawns.
 *
 * tesseract.js normally resolves this file by name out of its own package, which
 * stops working once the engine is inlined: there is no `tesseract.js` in the
 * profile's node_modules to resolve it from. So the plugin ships the script
 * itself and passes its path as `workerPath`.
 *
 * The three `tesseract-core` loaders it pulls in are inlined here; their `.wasm`
 * payloads are not — a `.wasm` is not an import statement, so the bundler cannot
 * follow it. `scripts/build.mjs` copies those next to the emitted files, which
 * is where the emscripten loader looks for them.
 *
 * Deliberately CommonJS and deliberately free of `import`/`export`: a bundler
 * only rewrites the `require` calls of a file it reads as CommonJS.
 */
require('tesseract.js/src/worker-script/node/index.js')
