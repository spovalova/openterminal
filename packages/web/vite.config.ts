import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const SERVER = 'http://localhost:4242'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
