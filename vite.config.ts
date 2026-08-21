import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so production assets load correctly via file:// in Electron.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Keep @pierre/diffs (+shiki) out of the main chunk — it's a large,
        // lazily-adopted dependency that only diff surfaces pull in.
        manualChunks(id: string) {
          if (
            id.includes('node_modules/@pierre/') ||
            /node_modules\/(shiki|@shikijs)[/@]/.test(id)
          ) {
            return 'pierre-diffs';
          }
          return undefined;
        },
      },
    },
  },
})
