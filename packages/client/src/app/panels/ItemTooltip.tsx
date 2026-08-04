/**
 * The item tooltip and the hover model behind it — shared by the pack (`I`)
 * and the character sheet (`C`), because an item has to read the same wherever
 * you point at it.
 *
 * Fixed-position on purpose: a panel's clip-path would cut an in-flow tooltip
 * off at the corner cuts.
 */

import type { ItemDef } from '@dawned/shared';
import {
  consumableText,
  damageLine,
  effectText,
  rarityColor,
  rollCount,
  sellLine,
  statLines,
  typeLine,
} from './item-format.js';

export interface HoverStack {
  itemId: string;
  qty: number;
  rolled?: Record<string, number> | null;
}

export interface HoverTarget {
  def: ItemDef;
  stack: HoverStack;
  /** The equipped piece this would replace, for the compare column. */
  compare: { def: ItemDef; rolled: Record<string, number> | null } | null;
  x: number;
  y: number;
}

/** The tooltip itself: fixed-position so no panel clip-path can cut it off. */
export const ItemTooltip = ({ hover }: { hover: HoverTarget }): React.JSX.Element => {
  const { def, stack, compare } = hover;
  const lines = statLines(def, stack.rolled, compare);
  const rolls = rollCount(def);
  const flipX = hover.x > window.innerWidth - 320;
  return (
    <div
      className="inv-tip"
      style={{
        left: flipX ? undefined : hover.x + 18,
        right: flipX ? window.innerWidth - hover.x + 18 : undefined,
        top: Math.min(hover.y, window.innerHeight - 260),
      }}
    >
      <div className="inv-tip-name" style={{ color: rarityColor(def.rarity) }}>
        {def.name}
      </div>
      <div className="inv-tip-type">{typeLine(def)}</div>
      {damageLine(def) ? <div className="inv-tip-damage">{damageLine(def)}</div> : null}
      {lines.map((line) => (
        <div className="inv-tip-stat" key={line.key}>
          <span>
            +{line.value} {line.label}
          </span>
          {line.delta !== null && line.delta !== 0 ? (
            <em data-sign={line.delta > 0 ? 'up' : 'down'}>
              {line.delta > 0 ? '+' : ''}
              {line.delta}
            </em>
          ) : null}
        </div>
      ))}
      {effectText(def) ? <div className="inv-tip-effect">{effectText(def)}</div> : null}
      {consumableText(def) ? <div className="inv-tip-effect">{consumableText(def)}</div> : null}
      {def.requiresLevel > 1 ? (
        <div className="inv-tip-req">Requires level {def.requiresLevel}</div>
      ) : null}
      {def.classLock.length > 0 ? (
        <div className="inv-tip-req">{def.classLock.join(', ')} only</div>
      ) : null}
      {def.flavor ? <div className="inv-tip-flavor">{def.flavor}</div> : null}
      <div className="inv-tip-sell">{sellLine(def)}</div>
      {rolls > 0 ? (
        <div className="inv-tip-rolls">
          Dropped copies roll {rolls} extra attribute{rolls === 1 ? '' : 's'}
        </div>
      ) : null}
      {compare ? (
        <div className="inv-tip-compare">compared with your {compare.def.name}</div>
      ) : null}
    </div>
  );
};
