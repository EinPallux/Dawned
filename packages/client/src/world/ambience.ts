/**
 * Zone ambience blending — fog, sky gradient and lighting ease toward the
 * profile of whichever zone polygon the player stands in (ROADMAP P2 DoD:
 * "zones tint fog/light on crossing"). Zones and their profiles are data —
 * baked zones.json now, admin-edited from A2 (shared/content/zones.ts).
 */

import * as THREE from 'three';
import { zoneAt, type Zone, type ZoneAmbience, type ZonesFile } from '@dawned/shared';

/** Blend time constant — a crossing settles in roughly 3τ ≈ 4 s. */
const TAU_S = 1.3;
/** Zone lookup cadence (point-in-polygon over a handful of zones is cheap, but per-frame is silly). */
const LOOKUP_INTERVAL_S = 0.25;

/** The scene handles the blender writes into every frame. */
export interface AmbienceTargets {
  fog: THREE.Fog;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
}

/** Mutable copy of a profile used as the blend state. */
interface BlendState {
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
}

const toState = (profile: ZoneAmbience): BlendState => ({
  fogColor: new THREE.Color(profile.fogColor),
  fogNear: profile.fogNear,
  fogFar: profile.fogFar,
  skyTop: new THREE.Color(profile.skyTop),
  skyHorizon: new THREE.Color(profile.skyHorizon),
  sunColor: new THREE.Color(profile.sunColor),
  sunIntensity: profile.sunIntensity,
  hemiSky: new THREE.Color(profile.hemiSky),
  hemiGround: new THREE.Color(profile.hemiGround),
  hemiIntensity: profile.hemiIntensity,
});

export class AmbienceController {
  private readonly current: BlendState;
  private target: BlendState;
  private lookupCooldown = 0;
  private currentZone: Zone | null = null;

  constructor(
    private readonly targets: AmbienceTargets,
    private readonly zones: ZonesFile,
  ) {
    this.current = toState(zones.defaultAmbience);
    this.target = toState(zones.defaultAmbience);
    this.apply();
  }

  /** The zone the player is currently inside (HUD shows it from P3). */
  get zone(): Zone | null {
    return this.currentZone;
  }

  update(dt: number, x: number, z: number): void {
    this.lookupCooldown -= dt;
    if (this.lookupCooldown <= 0) {
      this.lookupCooldown = LOOKUP_INTERVAL_S;
      const zone = zoneAt(x, z, this.zones.zones);
      if (zone !== this.currentZone) {
        this.currentZone = zone;
        this.target = toState(zone?.ambience ?? this.zones.defaultAmbience);
      }
    }

    // Exponential ease of every parameter toward the target.
    const alpha = 1 - Math.exp(-dt / TAU_S);
    const c = this.current;
    const t = this.target;
    c.fogColor.lerp(t.fogColor, alpha);
    c.skyTop.lerp(t.skyTop, alpha);
    c.skyHorizon.lerp(t.skyHorizon, alpha);
    c.sunColor.lerp(t.sunColor, alpha);
    c.hemiSky.lerp(t.hemiSky, alpha);
    c.hemiGround.lerp(t.hemiGround, alpha);
    c.fogNear += (t.fogNear - c.fogNear) * alpha;
    c.fogFar += (t.fogFar - c.fogFar) * alpha;
    c.sunIntensity += (t.sunIntensity - c.sunIntensity) * alpha;
    c.hemiIntensity += (t.hemiIntensity - c.hemiIntensity) * alpha;
    this.apply();
  }

  private apply(): void {
    const { fog, skyTop, skyHorizon, sun, hemisphere } = this.targets;
    const c = this.current;
    fog.color.copy(c.fogColor);
    fog.near = c.fogNear;
    fog.far = c.fogFar;
    skyTop.copy(c.skyTop);
    skyHorizon.copy(c.skyHorizon);
    sun.color.copy(c.sunColor);
    sun.intensity = c.sunIntensity;
    hemisphere.color.copy(c.hemiSky);
    hemisphere.groundColor.copy(c.hemiGround);
    hemisphere.intensity = c.hemiIntensity;
  }
}
