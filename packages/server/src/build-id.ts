/**
 * Which build the server is running.
 *
 * Read once at boot from the checkout itself (`/opt/dawned/game` is a git
 * clone — DEPLOYMENT.md §1), or from `DAWNED_BUILD_ID` when something else
 * already knows. The client bundle carries the same id, baked in by Vite, and
 * compares the two at `/api/health`: a tab still running yesterday's bundle is
 * told to reload instead of quietly playing an old client.
 */

import { execFileSync } from 'node:child_process';

const read = (): string => {
  const fromEnv = process.env.DAWNED_BUILD_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    // No git, no env: say so rather than inventing a version. An unknown id
    // never triggers the client's stale-build notice.
    return 'dev';
  }
};

export const BUILD_ID = read();
