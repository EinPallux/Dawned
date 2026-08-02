/**
 * Character select: cards on the left, the chosen character alive in a diorama
 * on the right, delete with type-the-name confirmation (docs/design/UI_UX.md §4).
 */

import { useState } from 'react';
import { MAX_CHARACTERS_PER_ACCOUNT, classById, type CharacterSummary } from '@dawned/shared';
import { useApp } from '../store.js';
import { Backdrop } from '../components/Backdrop.js';
import { CharacterStage } from '../components/CharacterStage.js';
import { Button, ErrorLine, Panel, TextField } from '../components/ui.js';

export const CharacterSelectScreen = (): React.JSX.Element => {
  const { account, characters, busy, error, goTo, enterWorld, deleteCharacter, logout } = useApp();
  const [selectedId, setSelectedId] = useState<number | null>(characters[0]?.id ?? null);
  const [deleting, setDeleting] = useState<CharacterSummary | null>(null);
  const [confirmName, setConfirmName] = useState('');

  const selected = characters.find((entry) => entry.id === selectedId) ?? characters[0] ?? null;
  const slotsFree = MAX_CHARACTERS_PER_ACCOUNT - characters.length;

  return (
    <div className="screen">
      <Backdrop />
      <div className="screen__scrim screen__scrim--heavy" />

      <div className="select-layout">
        <Panel className="select-list">
          <div className="panel__title">
            YOUR CHARACTERS
            <span className="panel__title-side">{account?.name}</span>
          </div>

          {characters.length === 0 ? (
            <div className="select-empty">
              No characters yet.
              <br />
              The Dawnlands are waiting — create your first.
            </div>
          ) : (
            <div className="select-cards">
              {characters.map((character) => {
                const cls = classById(character.classId);
                return (
                  <button
                    key={character.id}
                    className={`char-card${selected?.id === character.id ? ' is-selected' : ''}`}
                    style={{ ['--accent' as never]: cls?.color ?? '#c9a34e' }}
                    onClick={() => {
                      setSelectedId(character.id);
                    }}
                    onDoubleClick={() => {
                      enterWorld(character);
                    }}
                  >
                    <span className="char-card__name">{character.name}</span>
                    <span className="char-card__meta">
                      Level {character.level} {cls?.name ?? character.classId}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="select-actions">
            <Button
              onClick={() => {
                goTo('create');
              }}
              disabled={slotsFree <= 0}
              title={slotsFree <= 0 ? 'All 5 slots used — delete a character first.' : undefined}
            >
              NEW CHARACTER {slotsFree > 0 ? `(${slotsFree} free)` : '(full)'}
            </Button>
            {selected ? (
              <Button
                kind="danger"
                onClick={() => {
                  setDeleting(selected);
                  setConfirmName('');
                }}
              >
                DELETE
              </Button>
            ) : null}
            <Button kind="ghost" onClick={() => void logout()}>
              LOG OUT
            </Button>
          </div>
          <ErrorLine message={error} />
        </Panel>

        <div className="select-stage">
          {selected ? (
            <>
              <CharacterStage appearance={selected.appearance} classId={selected.classId} />
              <div className="select-stage__plate">
                <div className="select-stage__name">{selected.name}</div>
                <div
                  className="select-stage__class"
                  style={{ color: classById(selected.classId)?.color }}
                >
                  Level {selected.level} {classById(selected.classId)?.name}
                </div>
                <Button
                  onClick={() => {
                    enterWorld(selected);
                  }}
                  disabled={busy}
                >
                  ENTER WORLD
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {deleting ? (
        <div className="modal-scrim">
          <Panel className="modal">
            <div className="panel__title">DELETE {deleting.name.toUpperCase()}?</div>
            <p className="modal__text">
              This permanently removes <b>{deleting.name}</b> (level {deleting.level}). Type the
              character's name to confirm.
            </p>
            <TextField
              label="Character name"
              value={confirmName}
              onChange={setConfirmName}
              autoFocus
            />
            <div className="modal__actions">
              <Button
                kind="danger"
                disabled={confirmName.toLowerCase() !== deleting.name.toLowerCase() || busy}
                onClick={() => {
                  void deleteCharacter(deleting.id).then((ok) => {
                    if (ok) {
                      setDeleting(null);
                      setSelectedId(null);
                    }
                  });
                }}
              >
                DELETE FOREVER
              </Button>
              <Button
                kind="ghost"
                onClick={() => {
                  setDeleting(null);
                }}
              >
                KEEP
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
};
