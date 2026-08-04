/**
 * Which build this is.
 *
 * `__BUILD_ID__` is substituted by Vite at build time with the commit the
 * bundle came from (vite.config.ts); a dev server has no commit of its own and
 * reports `dev`. The server reports the same id at `/api/health`, so the client
 * can tell the player when their tab is running yesterday's code — a cached
 * bundle used to be invisible until someone opened a private window.
 */

declare const __BUILD_ID__: string;

/** The commit this bundle was built from, or `dev` when served by Vite. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/**
 * True when the server is running a DIFFERENT build than this bundle — i.e. a
 * deploy happened and this tab is stale. Unknown ids (`dev`, empty, missing)
 * never raise it: only two real, differing commits count.
 */
export const isStaleAgainst = (serverBuildId: string | undefined): boolean => {
  if (!serverBuildId || serverBuildId === 'dev' || BUILD_ID === 'dev') return false;
  return serverBuildId !== BUILD_ID;
};
