import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'frontend',
  base: process.env.VITE_BASE || './',
  plugins: [react()],
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        chunkFileNames: (chunkInfo) => {
          if (chunkInfo.name.startsWith('subset-')) {
            return 'assets/[name].js'
          }
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
