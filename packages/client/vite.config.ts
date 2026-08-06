import { execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAP_DIR = path.join(REPO_ROOT, 'assets_baked/map');

const MAP_MIME: Record<string, string> = {
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Serve `/assets/map/*` straight out of `assets_baked/map`, in dev and preview.
 *
 * The client fetches its map artifacts from that URL, and they used to get there
 * by `assets:sync` COPYING the bake into `packages/client/public/assets/map` at
 * build time. That is invisible on a dev box, where a rebuild follows every
 * publish anyway — and on the VPS it meant a published world never reached a
 * player: the server hot-loaded the new bake and the browser 404'd on every
 * artifact, because the bundle it was asking had been built before the publish.
 * Production serves the bake directory directly now (deploy/Caddyfile), and this
 * keeps dev on the SAME bytes rather than on a copy that only a rebuild refreshes
 * — a copy is exactly what hid the bug for the whole of A2.
 */
const bakedMaps = (): Plugin => {
  const middleware = async (
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader: (name: string, value: string) => void;
      end: (body?: string) => void;
    },
    next: () => void,
  ): Promise<void> => {
    const url = req.url ?? '';
    if (!url.startsWith('/assets/map/')) return next();
    const relative = decodeURIComponent(url.slice('/assets/map/'.length).split('?')[0]);
    // A traversal out of the map directory is the only way this can serve
    // something it should not; resolve first, then check containment.
    const file = path.resolve(MAP_DIR, relative);
    if (file !== MAP_DIR && !file.startsWith(MAP_DIR + path.sep)) return next();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return next();
    res.statusCode = 200;
    res.setHeader('content-type', MAP_MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('content-length', String(info.size));
    createReadStream(file).pipe(res as unknown as import('node:stream').Writable);
  };
  return {
    name: 'dawned-baked-maps',
    configureServer: (server) => {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
    configurePreviewServer: (server) => {
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
  };
};

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
  plugins: [react(), bakedMaps()],
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
