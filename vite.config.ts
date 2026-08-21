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
        // Keep @pierre/diffs (+shiki) out of the entry chunk — it's a large,
        // lazily-adopted dependency that only diff surfaces pull in.
        //
        // The $initial vendor group must claim statically-imported node_modules
        // first: rolldown's chunk groups capture matched modules' dependencies
        // recursively by default, so without it shiki's mdast/hast deps (shared
        // with react-markdown) land in the pierre chunk and the entry ends up
        // statically importing the whole 2MB chunk.
        codeSplitting: {
          groups: [
            {
              name: 'initial-vendor',
              test: /[\\/]node_modules[\\/]/,
              tags: ['$initial'],
              priority: 10,
            },
            {
              name: 'pierre-diffs',
              test: /[\\/]node_modules[\\/](@pierre|shiki|@shikijs)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
