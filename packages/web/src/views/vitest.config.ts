/**
 * Views-only test config. The package's vite.config.ts (web workstream) only includes `test/**`;
 * until it also includes `src/**\/__tests__`, run these with:
 *   pnpm exec vitest run --config src/views/vitest.config.ts
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/views/__tests__/*.test.{ts,tsx}'],
  },
})
