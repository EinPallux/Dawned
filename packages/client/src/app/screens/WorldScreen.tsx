/**
 * The in-world screen: mounts the game loop (src/game/run-world.ts) and handles
 * terminal notices — restart auto-reload, auth expiry back to login, character
 * conflicts back to select.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NoticeCode, noticeTextFor } from '@dawned/shared';
import { useApp } from '../store.js';
import { tokenStore } from '../../net/api.js';
import {
  runWorld,
  type PanelId,
  type QuestBridge,
  type WorldHandle,
} from '../../game/run-world.js';
import { Button } from '../components/ui.js';
import { CharacterPanel } from '../panels/CharacterPanel.js';
import { SkillsPanel } from '../panels/SkillsPanel.js';
import { InventoryPanel } from '../panels/InventoryPanel.js';
import { ProfessionsPanel } from '../panels/ProfessionsPanel.js';
import { VendorPanel } from '../panels/VendorPanel.js';
import { DialoguePanel } from '../panels/DialoguePanel.js';
import { JournalPanel } from '../panels/JournalPanel.js';
import { WorldMapPanel } from '../panels/WorldMapPanel.js';

interface OverlayState {
  title: string;
  text: string;
  action: 'none' | 'select' | 'login';
}

/**
 * Subscribes to the quest bridge so the dialogue appears the moment the SERVER
 * opens one. Its own component because the whole world screen re-rendering on
 * every quest sync would drag the panels above it along for the ride.
 */
const DialogueGate = ({ bridge }: { bridge: QuestBridge }): React.JSX.Element | null => {
  useSyncExternalStore(bridge.subscribe, bridge.version);
  const state = bridge.dialogue();
  return state ? <DialoguePanel bridge={bridge} state={state} /> : null;
};

export const WorldScreen = (): React.JSX.Element => {
  const { token, activeCharacter, leaveWorld, logout } = useApp();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [openPanel, setOpenPanel] = useState<PanelId | null>(null);
  /** The live world handle, in state so panel renders may read it. */
  const [world, setWorld] = useState<WorldHandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !token || !activeCharacter) return;

    const handle = runWorld(
      container,
      token,
      activeCharacter.id,
      activeCharacter.name,
      activeCharacter.appearance,
      {
        onPanelChange: setOpenPanel,
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
      },
    );
    setWorld(handle);

    return () => {
      handle.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once per character entry
  }, []);

  return (
    <div className="world-screen">
      <div ref={containerRef} className="world-mount" />
      {world && openPanel === 'character' ? (
        <CharacterPanel
          bridge={world.progression}
          items={world.inventory}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {world && openPanel === 'skills' ? (
        <SkillsPanel
          bridge={world.progression}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {world && openPanel === 'inventory' ? (
        <InventoryPanel
          bridge={world.inventory}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {world && openPanel === 'professions' ? (
        <ProfessionsPanel
          bridge={world.professions}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {world && openPanel === 'vendor' ? (
        <VendorPanel
          bridge={world.inventory}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {world && openPanel === 'journal' ? (
        <JournalPanel
          bridge={world.quests}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {world && openPanel === 'map' ? (
        <WorldMapPanel
          bridge={world.quests}
          onClose={() => {
            world.setPanel(null);
          }}
        />
      ) : null}
      {/* Dialogue is not a PANEL: it is a lower third that sits over the game
          while you keep looking at the person talking (QUESTS_POI §3), so the
          server's `DialogueState` opens it, not a key. */}
      {world ? <DialogueGate bridge={world.quests} /> : null}
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
