/**
 * The in-world screen: mounts the game loop (src/game/run-world.ts) and handles
 * terminal notices — restart auto-reload, auth expiry back to login, character
 * conflicts back to select.
 */

import { useEffect, useRef, useState } from 'react';
import { NoticeCode, noticeTextFor } from '@dawned/shared';
import { useApp } from '../store.js';
import { tokenStore } from '../../net/api.js';
import { runWorld } from '../../game/run-world.js';
import { Button } from '../components/ui.js';

interface OverlayState {
  title: string;
  text: string;
  action: 'none' | 'select' | 'login';
}

export const WorldScreen = (): React.JSX.Element => {
  const { token, activeCharacter, leaveWorld, logout } = useApp();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !token || !activeCharacter) return;

    const handle = runWorld(container, token, activeCharacter.id, activeCharacter.name, {
      onNotice: (code, friendlyText) => {
        switch (code) {
          case NoticeCode.ServerShuttingDown:
            setOverlay({
              title: 'Restarting',
              text: 'The world is restarting — reloading in a few seconds…',
              action: 'none',
            });
            setTimeout(() => {
              location.reload();
            }, 5000);
            break;
          case NoticeCode.AuthFailed:
            tokenStore.clear();
            setOverlay({ title: 'Session expired', text: friendlyText, action: 'login' });
            break;
          case NoticeCode.ReplacedByNewLogin:
          case NoticeCode.CharacterUnavailable:
          case NoticeCode.Kicked:
          case NoticeCode.ServerFull:
          case NoticeCode.ProtocolMismatch:
            setOverlay({ title: 'Disconnected', text: friendlyText, action: 'select' });
            break;
          default:
            setOverlay({ title: 'Disconnected', text: noticeTextFor(code), action: 'select' });
        }
      },
      onDisconnected: () => {
        setOverlay(
          (current) =>
            current ?? {
              title: 'Connection lost',
              text: 'The connection to the world dropped.',
              action: 'select',
            },
        );
      },
    });

    return () => {
      handle.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once per character entry
  }, []);

  return (
    <div className="world-screen">
      <div ref={containerRef} className="world-mount" />
      {overlay ? (
        <div className="modal-scrim">
          <div className="panel modal">
            <div className="panel__title">{overlay.title.toUpperCase()}</div>
            <p className="modal__text">{overlay.text}</p>
            {overlay.action !== 'none' ? (
              <div className="modal__actions">
                <Button
                  onClick={() => {
                    if (overlay.action === 'login') void logout();
                    else leaveWorld();
                  }}
                >
                  {overlay.action === 'login' ? 'BACK TO LOGIN' : 'BACK TO CHARACTERS'}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
