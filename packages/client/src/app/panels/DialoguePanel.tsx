/**
 * The conversation (QUESTS_POI.md §3) — lower-third panel, portrait-free.
 *
 * The low-poly NPC IS the portrait: the camera frames them over the shoulder
 * (run-world drives that), so this panel is text and choices and nothing else.
 * Typewriter reveal, fast and skippable — a second press of the same key jumps
 * to the end rather than advancing, because a player who mashes to skip the
 * text should never accidentally accept the quest.
 *
 * **The client does not walk the tree.** Every choice is sent with the node id
 * the server last gave us and the answer is the next `DialogueState`. A choice
 * can accept a quest, so a client that advanced its own copy would be making
 * the accept a client decision with a server rubber-stamp — which is the whole
 * thing P8's item rule and this one exist to prevent.
 */

import { useEffect, useRef, useState } from 'react';
import type { DialogueStateMessage } from '@dawned/shared';
import type { QuestBridge } from '../../game/run-world.js';

/** Characters per second. Fast: this is flavour, not a cutscene. */
const REVEAL_CPS = 90;

/** What the button says when the action has no text of its own. */
const ACTION_FALLBACK: Record<string, string> = {
  accept: 'Accept',
  decline: 'Not now',
  turn_in: 'Hand it over',
  close: 'Goodbye',
  goto: 'Go on…',
};

interface RewardShape {
  xp?: number;
  gold?: number;
  items?: { itemId: string; qty: number }[];
  title?: string;
}

const asRewards = (raw: unknown): RewardShape | null =>
  raw && typeof raw === 'object' ? raw : null;

export const DialoguePanel = ({
  bridge,
  state,
}: {
  bridge: QuestBridge;
  state: DialogueStateMessage;
}): React.JSX.Element | null => {
  const open = state.open;
  const [revealed, setRevealed] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const nodeKey = open ? `${open.questId}:${open.nodeId}` : '';
  const lastNode = useRef('');

  // Restart the reveal when the NODE changes — not on every render, or a
  // re-render from an unrelated sync would replay the line from the start.
  useEffect(() => {
    if (nodeKey === lastNode.current) return;
    lastNode.current = nodeKey;
    setRevealed(0);
    setPicked(null);
  }, [nodeKey]);

  const text = open?.text ?? '';
  useEffect(() => {
    if (revealed >= text.length) return;
    const timer = window.setInterval(() => {
      setRevealed((count) => Math.min(text.length, count + Math.ceil(REVEAL_CPS / 30)));
    }, 33);
    return () => {
      window.clearInterval(timer);
    };
  }, [text, revealed]);

  if (!open) return null;
  const rewards = asRewards(open.rewards);
  const complete = revealed >= text.length;

  return (
    <div
      className="dlg"
      data-panel="dialogue"
      onClick={() => {
        // Click anywhere in the body to finish the reveal. Buttons stopPropagation.
        if (!complete) setRevealed(text.length);
      }}
    >
      <div className="dlg-speaker">{open.speaker}</div>
      {open.title ? <div className="dlg-title">{open.title}</div> : null}
      <div className="dlg-text" data-dialogue-text>
        {text.slice(0, revealed)}
        {complete ? '' : '▍'}
      </div>

      {rewards && (rewards.xp || rewards.gold || rewards.title) ? (
        <div className="dlg-rewards">
          {rewards.xp ? <span className="dlg-reward-xp">{rewards.xp} XP</span> : null}
          {rewards.gold ? <span className="dlg-reward-gold">{rewards.gold} gold</span> : null}
          {rewards.title ? <span>Title: “{rewards.title}”</span> : null}
        </div>
      ) : null}

      {open.choicesOfReward.length > 0 ? (
        <div className="dlg-pick">
          {open.choicesOfReward.map((choice) => (
            <button
              className="dlg-pick-item"
              data-picked={String(picked === choice.itemId)}
              key={choice.itemId}
              onClick={(event) => {
                event.stopPropagation();
                setPicked(choice.itemId);
              }}
              type="button"
            >
              {bridge.iconUrl(choice.icon) ? (
                <img alt="" src={bridge.iconUrl(choice.icon)} />
              ) : null}
              {choice.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="dlg-choices">
        {open.choices.map((choice, index) => (
          <button
            className="dlg-choice"
            data-action={choice.action}
            data-choice={index}
            key={`${choice.action}-${index}`}
            onClick={(event) => {
              event.stopPropagation();
              // Reward pick rides along with the turn-in, because it is part of
              // the same decision — a separate "confirm" step would let the
              // server hand out the default while the player was still looking.
              bridge.choose(open.questId, open.nodeId, index, picked);
            }}
            type="button"
          >
            {choice.text || (ACTION_FALLBACK[choice.action] ?? 'Continue')}
          </button>
        ))}
      </div>

      {state.more.length > 0 ? (
        <div className="dlg-more">
          {open.speaker} also has: {state.more.map((entry) => entry.name).join(' · ')}
        </div>
      ) : null}
    </div>
  );
};
