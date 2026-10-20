import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const SERVER = 'http://localhost:4242'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // The server refuses state-changing requests from other origins (packages/server/src/guard.ts), so the dev
      // proxy presents the server's own origin.
      '/api': { target: SERVER, changeOrigin: true, headers: { origin: SERVER } },
      '/ws': { target: SERVER, ws: true, changeOrigin: true, headers: { origin: SERVER } },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}', 'src/**/__tests__/*.test.{ts,tsx}'],
  },
})
