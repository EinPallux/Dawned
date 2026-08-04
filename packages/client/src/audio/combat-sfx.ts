/**
 * Combat SFX slots (P4): the HOOKS are the deliverable — whoosh on swing
 * start, impact on contact, tail on kill (COMBAT.md §9 sound layers). The
 * sounds themselves are WebAudio-synthesized placeholders (license-free,
 * unmistakably temp) until P14 sources the real set; every call site stays.
 *
 * Three round-robin variants per slot via pitch jitter — §9's minimum.
 */

export type SfxSlot =
  | 'whoosh'
  | 'impact'
  | 'impact_crit'
  | 'impact_heavy'
  | 'hurt'
  | 'death'
  | 'dodge'
  | 'bolt'
  | 'deny'
  | 'levelup'
  | 'pickup'
  | 'coin';

export const SFX_SLOTS: readonly SfxSlot[] = [
  'whoosh',
  'impact',
  'impact_crit',
  'impact_heavy',
  'hurt',
  'death',
  'dodge',
  'bolt',
  'deny',
  'levelup',
  'pickup',
  'coin',
];

/** Content `sfx` ids map straight onto slots; unknown ids fall back. */
export const sfxSlotOf = (id: string, fallback: SfxSlot = 'whoosh'): SfxSlot =>
  (SFX_SLOTS as readonly string[]).includes(id) ? (id as SfxSlot) : fallback;

export class CombatSfx {
  private ctx: AudioContext | null = null;
  private variant = 0;

  /** Browsers gate audio behind a user gesture — call from the input layer. */
  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      this.ctx = null; // no audio device — every play() becomes a no-op
    }
  }

  play(slot: SfxSlot, volume = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      void this.ctx?.resume();
      return;
    }
    this.variant = (this.variant + 1) % 3;
    const jitter = 1 + (this.variant - 1) * 0.06;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    switch (slot) {
      case 'whoosh': {
        // Filtered noise sweep — reads as air, not a beep.
        const noise = this.noiseSource(ctx, 0.16);
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(900 * jitter, now);
        filter.frequency.exponentialRampToValueAtTime(300 * jitter, now + 0.14);
        filter.Q.value = 1.2;
        noise.connect(filter).connect(gain);
        gain.gain.setValueAtTime(0.12 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        noise.start(now);
        break;
      }
      case 'impact':
      case 'impact_crit':
      case 'impact_heavy': {
        const heavy = slot !== 'impact';
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(
          (slot === 'impact_heavy' ? 120 : heavy ? 160 : 220) * jitter,
          now,
        );
        osc.frequency.exponentialRampToValueAtTime(slot === 'impact_heavy' ? 45 : 60, now + 0.09);
        const thud = this.noiseSource(ctx, 0.06);
        const thudGain = ctx.createGain();
        thudGain.gain.value = 0.5;
        thud.connect(thudGain).connect(gain);
        osc.connect(gain);
        gain.gain.setValueAtTime((heavy ? 0.3 : 0.2) * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (heavy ? 0.18 : 0.1));
        osc.start(now);
        osc.stop(now + 0.2);
        thud.start(now);
        break;
      }
      case 'deny': {
        // Dull two-tick refusal — unmistakably "no", never a musical note.
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.setValueAtTime(110, now + 0.05);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.05 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      }
      case 'hurt': {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(300 * jitter, now);
        osc.frequency.exponentialRampToValueAtTime(140, now + 0.08);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.08 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.12);
        break;
      }
      case 'death': {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220 * jitter, now);
        osc.frequency.exponentialRampToValueAtTime(40, now + 0.5);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.16 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        osc.start(now);
        osc.stop(now + 0.6);
        break;
      }
      case 'dodge': {
        const noise = this.noiseSource(ctx, 0.12);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1200;
        noise.connect(filter).connect(gain);
        gain.gain.setValueAtTime(0.07 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        noise.start(now);
        break;
      }
      case 'bolt': {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(700 * jitter, now);
        osc.frequency.exponentialRampToValueAtTime(1400 * jitter, now + 0.12);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.09 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.start(now);
        osc.stop(now + 0.16);
        break;
      }
      case 'pickup': {
        // Soft leather-and-clasp tick: something entered the pack (§3 juice).
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(420 * jitter, now);
        osc.frequency.exponentialRampToValueAtTime(620 * jitter, now + 0.06);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.05 * volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      }
      case 'coin': {
        // Two bright chinks — the gold counter's own sound.
        for (const [i, freq] of [1180, 1560].entries()) {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          const at = now + i * 0.045;
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq * jitter, at);
          osc.connect(noteGain).connect(gain);
          noteGain.gain.setValueAtTime(0.0001, at);
          noteGain.gain.exponentialRampToValueAtTime(0.06 * volume, at + 0.01);
          noteGain.gain.exponentialRampToValueAtTime(0.001, at + 0.16);
          osc.start(at);
          osc.stop(at + 0.18);
        }
        gain.gain.setValueAtTime(1, now);
        break;
      }
      case 'levelup': {
        // Bright rising triad shimmer (P7 §1.3 sound hook) — C5→E5→G5, each
        // note a soft sine bloom. Real samples replace this at P14 (AUDIO.md).
        for (const [i, freq] of [523.25, 659.25, 783.99].entries()) {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          const at = now + i * 0.09;
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, at);
          osc.connect(noteGain).connect(gain);
          noteGain.gain.setValueAtTime(0.0001, at);
          noteGain.gain.exponentialRampToValueAtTime(0.12 * volume, at + 0.03);
          noteGain.gain.exponentialRampToValueAtTime(0.001, at + 0.55);
          osc.start(at);
          osc.stop(at + 0.6);
        }
        gain.gain.setValueAtTime(1, now);
        break;
      }
    }
  }

  private noiseSource(ctx: AudioContext, seconds: number): AudioBufferSourceNode {
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    return source;
  }
}
