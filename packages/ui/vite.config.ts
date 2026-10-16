/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite serves the preview page (index.html → src/preview/main.tsx) on 5174.
// Vitest reuses this file as its project config.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['test/**/*.test.{ts,tsx}'] },
})
