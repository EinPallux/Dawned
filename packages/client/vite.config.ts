import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The commit this bundle was built from. The client shows it and compares it
 * against the one the server reports (`/api/health`), so "am I actually on the
 * latest build?" is a question the game answers instead of the player guessing
 * from an incognito window.
 */
const buildId = ((): string => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
})();

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  // @dawned/shared is a workspace package that we rebuild constantly. Pre-bundling
  // it makes the dev server serve a stale copy after every `pnpm build` of shared,
  // which shows up as phantom "no such export" errors — so keep it out of the cache.
  optimizeDeps: {
    exclude: ['@dawned/shared'],
  },
  server: {
    port: 5173,
    // Dev proxy so the client can talk to the game server on one origin, exactly
    // like Caddy does in production (docs/tech/DEPLOYMENT.md §2).
    proxy: {
      '/api': { target: 'http://127.0.0.1:8081', changeOrigin: true },
      '/game': { target: 'ws://127.0.0.1:8081', ws: true },
    },
  },
  // `vite preview` serves the PRODUCTION build with the same proxy, so
  // minified-bundle-only bugs reproduce locally before a deploy does it for us.
  preview: {
    port: 5199,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8081', changeOrigin: true },
      '/game': { target: 'ws://127.0.0.1:8081', ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // three.js is the heavy dependency: keep it in its own long-cached chunk.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
