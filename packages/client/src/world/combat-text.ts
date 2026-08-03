/**
 * Floating combat text (COMBAT.md §9): pooled canvas sprites, batched per
 * frame, hard cap on screen. Outgoing white (crits bigger with a tick),
 * incoming red, heals green — resource/XP colors join with their systems.
 */

import * as THREE from 'three';

const MAX_ON_SCREEN = 40;
const LIFETIME_S = 1.1;
const RISE_M = 1.4;

export type CombatTextKind = 'outgoing' | 'outgoing-crit' | 'incoming' | 'heal';

const STYLES: Record<CombatTextKind, { fill: string; px: number; suffix: string }> = {
  outgoing: { fill: '#f2ead8', px: 34, suffix: '' },
  'outgoing-crit': { fill: '#ffd75e', px: 46, suffix: '!' },
  incoming: { fill: '#ff6a55', px: 34, suffix: '' },
  heal: { fill: '#7ed87e', px: 34, suffix: '' },
};

interface FloatingText {
  sprite: THREE.Sprite;
  age: number;
  baseY: number;
  driftX: number;
}

export class CombatTextManager {
  private readonly pool: THREE.Sprite[] = [];
  private readonly active: FloatingText[] = [];
  /** Lifetime spawn counter (smoke-test observability). */
  spawnedTotal = 0;

  constructor(private readonly scene: THREE.Scene) {}

  spawn(kind: CombatTextKind, amount: number, x: number, y: number, z: number): void {
    this.spawnedTotal++;
    if (this.active.length >= MAX_ON_SCREEN) {
      const oldest = this.active.shift();
      if (oldest) this.recycle(oldest.sprite);
    }
    const style = STYLES[kind];
    const text = `${kind === 'incoming' ? '−' : ''}${amount}${style.suffix}`;

    const sprite = this.pool.pop() ?? this.makeSprite();
    const canvas = (sprite.material.map as THREE.CanvasTexture).image;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `bold ${style.px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(21,26,38,0.9)';
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillStyle = style.fill;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    (sprite.material.map as THREE.CanvasTexture).needsUpdate = true;

    const height = kind === 'outgoing-crit' ? 0.52 : 0.38;
    sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
    sprite.material.opacity = 1;
    sprite.position.set(x, y, z);
    sprite.visible = true;
    this.scene.add(sprite);
    this.active.push({
      sprite,
      age: 0,
      baseY: y,
      driftX: (Math.random() - 0.5) * 0.5,
    });
  }

  private makeSprite(): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 64;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
    );
  }

  private recycle(sprite: THREE.Sprite): void {
    sprite.visible = false;
    this.scene.remove(sprite);
    this.pool.push(sprite);
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const text = this.active[i]!;
      text.age += dt;
      if (text.age >= LIFETIME_S) {
        this.recycle(text.sprite);
        this.active.splice(i, 1);
        continue;
      }
      const t = text.age / LIFETIME_S;
      // Ease-out rise with a slight sideways drift; fade in the last 40%.
      const rise = RISE_M * (1 - (1 - t) * (1 - t));
      text.sprite.position.y = text.baseY + rise;
      text.sprite.position.x += text.driftX * dt;
      text.sprite.material.opacity = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    }
  }

  get count(): number {
    return this.active.length;
  }
}
