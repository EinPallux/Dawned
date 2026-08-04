/**
 * Stale-build watch.
 *
 * The server reports the commit it is running (`/api/health`); this bundle
 * knows the commit it was built from. When they differ, the tab is running
 * code from before the last deploy — the failure mode that used to show up as
 * "I have to open a private window to see the update". Rather than trusting
 * cache headers alone, the game says so and offers the reload.
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

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      void api
        .health()
        .then((health) => {
          if (!cancelled && isStaleAgainst(health.buildId)) setStale(true);
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

  if (!stale) return null;
  return (
    <div className="build-watch" role="status">
      <span className="build-watch__text">
        A newer build of Dawned is live — this tab is still on <b>{BUILD_ID}</b>.
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
