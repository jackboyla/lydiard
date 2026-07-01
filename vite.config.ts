import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the Cloudflare Worker runs on http://localhost:8787 (`npm run worker:dev`).
// Proxy the API + OAuth + OpenAPI routes to it so the frontend is same-origin.
// In production the frontend is served from Cloudflare Pages and talks to the
// Worker via VITE_API_BASE (an absolute origin), so no proxy is used.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
      '/openapi.json': 'http://localhost:8787',
    },
  },
});
