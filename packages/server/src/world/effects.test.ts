/**
 * P6 status-layer unit tests: the absorb/cleanse/mana-shield paths that the
 * browser smoke cannot reach until enemies attack shielded players (P9).
 * These pin the ORDER contracts — oldest shield drains first, cleanse pops
 * newest-first and respects the movement filter, spent shields fall off.
 */

import { describe, expect, it } from 'vitest';
import {
  absorbFromShields,
  applyEffect,
  cleanseEffects,
  dodgeCostDeltaOf,
  dropManaShield,
  isUntargetable,
  manaShieldRateOf,
  type EffectHost,
} from './effects.js';

const host = (): EffectHost => ({ effects: [], effectsDirty: false });

const shield = (host_: EffectHost, id: string, pool: number, nowMs: number): void => {
  applyEffect(
    host_,
    {
      effectId: id,
      casterId: 1,
      durationMs: 8000,
      stacksMax: 1,
      mods: {},
      harmful: false,
      shieldPool: pool,
    },
    nowMs,
  );
};

describe('absorb shields (P6)', () => {
  it('drains oldest-first and removes spent shields', () => {
    const h = host();
    shield(h, 'shield_a', 50, 0);
    shield(h, 'shield_b', 100, 10);
    expect(absorbFromShields(h, 30)).toBe(30);
    expect(h.effects.find((e) => e.effectId === 'shield_a')?.shieldPool).toBe(20);
    expect(h.effects.find((e) => e.effectId === 'shield_b')?.shieldPool).toBe(100);

    // 70 more: finishes A (20) and bites B (50). A must drop off the bar.
    expect(absorbFromShields(h, 70)).toBe(70);
    expect(h.effects.some((e) => e.effectId === 'shield_a')).toBe(false);
    expect(h.effects.find((e) => e.effectId === 'shield_b')?.shieldPool).toBe(50);
  });

  it('absorbs only what the pools hold', () => {
    const h = host();
    shield(h, 'shield_a', 40, 0);
    expect(absorbFromShields(h, 100)).toBe(40);
    expect(h.effects).toHaveLength(0);
  });

  it('recasting a shield replaces its pool instead of stacking it', () => {
    const h = host();
    shield(h, 'shield_a', 50, 0);
    absorbFromShields(h, 30);
    shield(h, 'shield_a', 50, 100); // Aegis recast — fresh absorb
    expect(h.effects.find((e) => e.effectId === 'shield_a')?.shieldPool).toBe(50);
  });
});

describe('cleanse (P6)', () => {
  const harmful = (
    h: EffectHost,
    id: string,
    category: 'root' | 'chill' | 'burn' | 'bleed',
    nowMs: number,
  ): void => {
    applyEffect(
      h,
      {
        effectId: id,
        casterId: 2,
        durationMs: 5000,
        stacksMax: 1,
        mods: {},
        harmful: true,
        category,
      },
      nowMs,
    );
  };

  it('movement cleanse strips only root/slow/chill, newest first', () => {
    const h = host();
    harmful(h, 'burn_x', 'burn', 0);
    harmful(h, 'chill_a', 'chill', 10);
    harmful(h, 'root_b', 'root', 20);
    expect(cleanseEffects(h, 'movement', 1, false)).toBe(1);
    // Newest movement effect (the root) popped; the chill and burn remain.
    expect(h.effects.map((e) => e.effectId)).toEqual(['burn_x', 'chill_a']);
    expect(cleanseEffects(h, 'movement', 5, true)).toBe(1);
    expect(h.effects.map((e) => e.effectId)).toEqual(['burn_x']);
  });

  it('any-cleanse ignores helpful effects entirely', () => {
    const h = host();
    shield(h, 'shield_a', 50, 0);
    harmful(h, 'bleed_a', 'bleed', 10);
    expect(cleanseEffects(h, 'any', 5, true)).toBe(1);
    expect(h.effects.map((e) => e.effectId)).toEqual(['shield_a']);
  });
});

describe('mana shield + misc aggregates (P6)', () => {
  it('reports the drain rate while up and drops cleanly when dry', () => {
    const h = host();
    applyEffect(
      h,
      {
        effectId: 'buff_mana_shield',
        casterId: 1,
        durationMs: 30000,
        stacksMax: 1,
        mods: { manaShieldPerPoint: 2 },
        harmful: false,
      },
      0,
    );
    expect(manaShieldRateOf(h)).toBe(2);
    dropManaShield(h);
    expect(manaShieldRateOf(h)).toBeNull();
    expect(h.effects).toHaveLength(0);
  });

  it('untargetable + dodge discounts aggregate from mods', () => {
    const h = host();
    applyEffect(
      h,
      {
        effectId: 'buff_blink_ghost',
        casterId: 1,
        durationMs: 500,
        stacksMax: 1,
        mods: { untargetable: true, dodgeCostDelta: -5 },
        harmful: false,
      },
      0,
    );
    expect(isUntargetable(h)).toBe(true);
    expect(dodgeCostDeltaOf(h)).toBe(-5);
  });
});
