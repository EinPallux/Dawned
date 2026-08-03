import { describe, expect, it } from 'vitest';
import {
  canAfford,
  createResourceState,
  gainComboPoints,
  gainResource,
  payResource,
  resourceFloor,
  spendComboPoints,
  tickResource,
} from './resources.js';

describe('resource model', () => {
  it('rage starts empty, pools start full', () => {
    expect(createResourceState('warrior', 9).value).toBe(0);
    expect(createResourceState('rogue', 15).value).toBe(100);
    expect(createResourceState('mage', 15).value).toBe(250); // 100 + 10×15
    expect(createResourceState('cleric', 14).max).toBe(240);
  });

  it('energy regens 12/s regardless of combat', () => {
    const energy = createResourceState('rogue', 10);
    energy.value = 40;
    tickResource(energy, 1000, true);
    expect(energy.value).toBeCloseTo(52);
    tickResource(energy, 1000, false);
    expect(energy.value).toBeCloseTo(64);
  });

  it('energy never leaks at 20 Hz tick granularity', () => {
    const energy = createResourceState('rogue', 10);
    energy.value = 0;
    for (let i = 0; i < 20; i++) tickResource(energy, 50, true);
    expect(energy.value).toBeCloseTo(12); // exactly one second's worth
  });

  it('rage decays only out of combat and never passively builds', () => {
    const rage = createResourceState('warrior', 13);
    rage.value = 50;
    tickResource(rage, 1000, true);
    expect(rage.value).toBe(50);
    tickResource(rage, 1000, false);
    expect(rage.value).toBe(48);
  });

  it('rage gains apply in combat only', () => {
    const rage = createResourceState('warrior', 13);
    gainResource(rage, 15, false);
    expect(rage.value).toBe(0);
    gainResource(rage, 15, true);
    expect(rage.value).toBe(15);
    gainResource(rage, 200, true);
    expect(rage.value).toBe(100); // capped
  });

  it('mana regen is % of pool and slower in combat', () => {
    const mana = createResourceState('mage', 15); // pool 250
    mana.value = 0;
    tickResource(mana, 1000, false);
    expect(mana.value).toBeCloseTo(10); // 4%/s
    mana.value = 0;
    tickResource(mana, 1000, true);
    expect(mana.value).toBeCloseTo(3.75); // 1.5%/s
  });

  it('afford/pay uses whole units', () => {
    const energy = createResourceState('rogue', 10);
    energy.value = 24.9;
    expect(resourceFloor(energy)).toBe(24);
    expect(canAfford(energy, 'energy', 25)).toBe(false);
    energy.value = 25.1;
    expect(canAfford(energy, 'energy', 25)).toBe(true);
    payResource(energy, 25);
    expect(energy.value).toBeCloseTo(0.1);
    expect(canAfford(energy, 'none', 0)).toBe(true);
    expect(canAfford(energy, 'rage', 10)).toBe(false); // wrong resource
  });

  it('combo points cap at 5 and finishers spend all', () => {
    const rogue = createResourceState('rogue', 10);
    gainComboPoints(rogue, 3);
    gainComboPoints(rogue, 4);
    expect(rogue.comboPoints).toBe(5);
    expect(spendComboPoints(rogue)).toBe(5);
    expect(rogue.comboPoints).toBe(0);
    expect(spendComboPoints(rogue)).toBe(0);
  });
});
