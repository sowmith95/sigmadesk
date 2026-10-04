// Builds the desk UI (ui/src) into public/app with stable file names. The server serves public/ with
// Cache-Control: no-store, so stable names cannot go stale, and public/index.html can reference them directly.
// The build output is committed because the launchd service runs `node src/server.js` without a build step;
// scripts/ui-stamp.mjs records a hash of the sources so a test catches a stale bundle.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, 'ui'),
  // Lazy chunks and their preloads resolve under /app/ (the bundle's URL), not the site root.
  base: '/app/',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.join(root, 'ui', 'src') } },
  server: {
    // `npm run dev:ui` while a desk runs on 8790: live-reloading UI against the real API and stream.
    proxy: { '/api': 'http://127.0.0.1:8790', '/fonts': 'http://127.0.0.1:8790', '/icon.svg': 'http://127.0.0.1:8790' },
  },
  build: {
    outDir: path.join(root, 'public', 'app'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
    modulePreload: { polyfill: false }, // every browser that runs the desk supports modulepreload
    rolldownOptions: {
      // The desk (main.js) and the Projects home (hub.js) share one stylesheet and the component chunks.
      input: { main: path.join(root, 'ui', 'src', 'main.tsx'), hub: path.join(root, 'ui', 'src', 'hub', 'main.tsx') },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (a) => ((a.names || [a.name]).some((n) => String(n).endsWith('.css')) ? 'main.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
