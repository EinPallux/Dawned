/**
 * The journal (`L`, QUESTS_POI.md §4): every quest you hold, grouped by zone,
 * with its found-voice prose, its steps and what it pays.
 *
 * The prose is the point. A step list is a checklist you could read off the
 * tracker; the journal entry is written in the world's own voice ("Marla's
 * fence posts are dissolving. She'd like the bog to stop doing that.") and it
 * is the only place a player can go back and remember WHY they are carrying
 * this. Everything on this page comes from `QuestSync` — the client derives
 * nothing, not the counters and not what is turn-in-able.
 *
 * An EXPLORE step shows its clue text and never a marker (§1 rule 4). That is a
 * design rule with teeth: the server sends the clue and deliberately does not
 * send a hint circle for those steps, so there is nothing here to draw even if
 * this panel wanted to.
 */

import { useState, useSyncExternalStore } from 'react';
import type { QuestSyncMessage } from '@dawned/shared';
import type { QuestBridge } from '../../game/run-world.js';

/** Zone id → the heading a player recognises. Falls back to the raw id. */
const ZONE_NAME: Record<string, string> = {
  dawnshore: 'Dawnshore',
  verdant_weald: 'The Verdant Weald',
  ashen_reach: 'The Ashen Reach',
};

type QuestRow = QuestSyncMessage['quests'][number];

/** Steps that count something. A DELIVER or an EXPLORE is one act, not a tally. */
const COUNTED = new Set(['kill', 'collect', 'interact', 'use_at']);

export const JournalPanel = ({
  bridge,
  onClose,
}: {
  bridge: QuestBridge;
  onClose: () => void;
}): React.JSX.Element => {
  useSyncExternalStore(bridge.subscribe, bridge.version);
  const log = bridge.log();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const active = (log?.quests ?? []).filter((quest) => quest.status === 'active');
  const selected = active.find((quest) => quest.questId === selectedId) ?? active[0] ?? null;
  const clue = selected
    ? (log?.clues.find((entry) => entry.questId === selected.questId)?.text ?? '')
    : '';

  // Group by zone, keeping the server's order inside each group.
  const byZone = new Map<string, QuestRow[]>();
  for (const quest of active) {
    const rows = byZone.get(quest.zoneId) ?? [];
    rows.push(quest);
    byZone.set(quest.zoneId, rows);
  }

  const readyCount = active.filter((quest) => quest.ready).length;

  return (
    <div className="pv-scrim" data-panel="journal">
      <section className="pv-panel is-wide pv-journal">
        <header className="pv-title">
          JOURNAL
          <span className="pv-title-meta">
            {active.length} held
            {readyCount > 0 ? (
              <>
                {' · '}
                <b data-live="true">{readyCount} ready</b>
              </>
            ) : null}
          </span>
          <button className="pv-close" onClick={onClose} type="button" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="pv-body">
          {log === null ? (
            <p className="pv-note">Waiting for the server…</p>
          ) : active.length === 0 ? (
            <p className="pv-note">
              Nothing in the journal yet. Quests are found, not handed out — try the notice board in
              Dawnhaven, or talk to anyone standing still.
            </p>
          ) : (
            <div className="jr-layout">
              <div className="jr-list">
                {[...byZone].map(([zoneId, rows]) => (
                  <div key={zoneId}>
                    <div className="jr-zone">{ZONE_NAME[zoneId] ?? zoneId}</div>
                    {rows.map((quest) => (
                      <button
                        className="jr-row"
                        data-quest={quest.questId}
                        data-ready={String(quest.ready)}
                        data-selected={String(selected?.questId === quest.questId)}
                        key={quest.questId}
                        onClick={() => {
                          setSelectedId(quest.questId);
                        }}
                        type="button"
                      >
                        <span className="jr-row-name">{quest.name}</span>
                        <span className="jr-row-level">lv {quest.suggestedLevel}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              {selected ? (
                <div className="jr-detail" data-quest-detail={selected.questId}>
                  <div className="jr-prose">{selected.journalText}</div>

                  <div className="jr-steps">
                    {selected.steps.map((step, index) => (
                      <div
                        className="jr-step"
                        data-current={String(index === selected.step)}
                        data-done={String(step.done)}
                        key={`${selected.questId}-${index}`}
                      >
                        {COUNTED.has(step.type)
                          ? `${step.have}/${step.need}  ${step.text}`
                          : `· ${step.text}`}
                      </div>
                    ))}
                  </div>

                  {clue ? <div className="jr-clue">“{clue}”</div> : null}

                  {selected.ready ? (
                    <div className="jr-clue" data-ready-line="true">
                      Ready to hand in
                      {selected.turnInNpcId
                        ? ` — find ${selected.turnInNpcId.replace('npc_', '')}`
                        : ''}
                      .
                    </div>
                  ) : null}

                  <div className="jr-actions">
                    <button
                      className="pv-button"
                      data-action="pin"
                      onClick={() => {
                        bridge.pin(selected.questId, !selected.pinned);
                      }}
                      type="button"
                    >
                      {selected.pinned ? 'UNPIN' : 'PIN TO TRACKER'}
                    </button>
                    <button
                      className="pv-button is-danger"
                      data-action="abandon"
                      onClick={() => {
                        bridge.abandon(selected.questId);
                        setSelectedId(null);
                      }}
                      type="button"
                    >
                      ABANDON
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
