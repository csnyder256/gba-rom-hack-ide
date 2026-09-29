import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 8717);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // mGBA-wasm is a pthreads build: its init creates a worker pool that
    // needs SharedArrayBuffer, which the browser only exposes when the page
    // is cross-origin isolated. Without these headers the worker handshake
    // hangs (stuck on "Booting…"). Safe here because the app loads nothing
    // cross-origin (all assets are same-origin or proxied through /api).
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // Proxy both REST (/api/projects/*, /api/agent/turn, …) and the
      // WebSocket upgrade for /api/agent/ws onto the backend. `ws: true`
      // is required for the WS upgrade to forward.
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        ws: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: { '/api': { target: `http://127.0.0.1:${BACKEND_PORT}`, ws: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
