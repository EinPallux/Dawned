/**
 * Stale-build watch.
 *
 * The server reports the commit it is running (`/api/health`); this bundle
 * knows the commit it was built from. When they differ, the tab is running
 * code from before the last deploy — the failure mode that used to show up as
 * "I have to open a private window to see the update". Rather than trusting
 * cache headers alone, the game says so and offers the reload.
 *
 * The same poll carries the live MAP version (A2). A map publish swaps the
 * ground under the running server; a tab that streamed the previous bake is
 * standing on terrain the server no longer simulates, which is the same class
 * of problem and gets the same answer.
 *
 * Checks on mount, whenever the tab regains focus, and every few minutes —
 * cheap (one tiny uncached GET) and it means a friend who left the tab open
 * over a deploy finds out the moment they come back to it.
 */

import { useEffect, useState } from 'react';
import { api } from '../../net/api.js';
import { BUILD_ID, isStaleAgainst } from '../../build-info.js';

const POLL_MS = 150_000;

export const BuildWatch = (): React.JSX.Element | null => {
  const [stale, setStale] = useState(false);
  const [mapStale, setMapStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // The map version this tab first saw. Not the compiled-in constant: the
    // world screen resolves the live version from this same field, so "changed
    // since we loaded" is the only comparison that means anything.
    let seenMapVersion: string | null = null;
    const check = (): void => {
      void api
        .health()
        .then((health) => {
          if (cancelled) return;
          if (isStaleAgainst(health.buildId)) setStale(true);
          if (health.mapVersion) {
            seenMapVersion ??= health.mapVersion;
            if (health.mapVersion !== seenMapVersion) setMapStale(true);
          }
        })
        .catch(() => {
          // Offline or mid-restart: not a staleness signal, try again later.
        });
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (!stale && !mapStale) return null;
  return (
    <div className="build-watch" role="status">
      <span className="build-watch__text">
        {stale ? (
          <>
            A newer build of Dawned is live — this tab is still on <b>{BUILD_ID}</b>.
          </>
        ) : (
          <>The world has been republished — this tab is still on the old map.</>
        )}
      </span>
      <button
        type="button"
        className="build-watch__button"
        onClick={() => {
          window.location.reload();
        }}
      >
        RELOAD
      </button>
    </div>
  );
};
