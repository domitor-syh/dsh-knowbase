/**
 * Vitest config that runs the suite as a non-Chinese machine would.
 *
 * Vitest has no `--setupFiles` CLI flag, so the shim needs a config. This one is
 * deliberately separate from any default config: `pnpm test` keeps running with
 * vitest's own defaults, and only this opt-in run rewrites the ambient locale.
 *
 *     npx vitest run --config scripts/vitest.ci-locale.config.mjs
 *
 * See `ci-locale.setup.mjs` for what the shim does and why it is worth having.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pinned to the repo root so paths in test output match a normal run.
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    setupFiles: [fileURLToPath(new URL('./ci-locale.setup.mjs', import.meta.url))],
  },
})
