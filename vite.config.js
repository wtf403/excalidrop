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
    // Remote-only: no local canvas server. The viewer talks to GitHub
    // (scene) + the shared relay (rpc) directly. ?repo=owner/name override
    // in dev comes from ghSync.detectRepo().
  },
})
