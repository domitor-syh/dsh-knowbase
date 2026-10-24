import { defineConfig } from 'vitest/config'

// Never collect tests from old isolated profile/node_modules backups.
export default defineConfig({
  test: { include: ['tests/**/*.test.{ts,tsx}'] },
})
