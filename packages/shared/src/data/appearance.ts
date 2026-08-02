/**
 * Character appearance & class catalog — browser-safe data both the creation UI
 * and the server validator read (docs/design/CLASSES.md §0, USER_QUESTIONS Q13).
 *
 * Asset ids reference the pipeline manifest (tools/asset-pipeline). Adding an
 * option here + baking its asset is all it takes for it to appear in creation.
 */

export const MAX_CHARACTERS_PER_ACCOUNT = 5;

export type ClassId = 'warrior' | 'mage' | 'rogue' | 'cleric';
export type BodyId = 'm' | 'f';
export type OutfitId = 'ranger' | 'peasant';

export interface ClassInfo {
  id: ClassId;
  name: string;
  archetype: string;
  resource: string;
  tagline: string;
  /** UAL clip looped in the class carousel / select diorama. */
  poseClip: string;
  /** Class accent color (docs/design/UI_UX.md palette). */
  color: string;
}

export const CLASSES: readonly ClassInfo[] = [
  {
    id: 'warrior',
    name: 'Warrior',
    archetype: 'Tank',
    resource: 'Rage',
    tagline: 'The wall that hits back — sword, shield, and stubbornness.',
    poseClip: 'Sword_Idle',
    color: '#d8663a',
  },
  {
    id: 'mage',
    name: 'Mage',
    archetype: 'Ranged DPS',
    resource: 'Mana',
    tagline: 'Glass cannon with an escape plan — fire, frost, and a Blink.',
    poseClip: 'Spell_Simple_Idle_Loop',
    color: '#4fa3e8',
  },
  {
    id: 'rogue',
    name: 'Rogue',
    archetype: 'Melee DPS',
    resource: 'Energy',
    tagline: 'In, shred, out — twin daggers and impeccable timing.',
    poseClip: 'Idle_LookAround_Loop',
    color: '#8bc44a',
  },
  {
    id: 'cleric',
    name: 'Cleric',
    archetype: 'Healer',
    resource: 'Mana',
    tagline: 'The dawn is a weapon — smite by day, mend by need.',
    poseClip: 'Spell_Double_Idle_Loop',
    color: '#efd26e',
  },
] as const;

export const classById = (id: string): ClassInfo | undefined =>
  CLASSES.find((entry) => entry.id === id);

/**
 * Skin tones — multiplicative tints over the base-character texture
 * (5 tones, decided in Q13). Index 0 keeps the texture as authored.
 */
export const SKIN_TONES: readonly string[] = [
  '#ffffff',
  '#efd6b8',
  '#d9a878',
  '#a9714b',
  '#6f4a33',
] as const;

export interface OutfitInfo {
  id: OutfitId;
  name: string;
  /** Multiplicative tint options; index 0 = as authored. */
  tints: readonly string[];
}

export const OUTFITS: readonly OutfitInfo[] = [
  {
    id: 'ranger',
    name: 'Ranger set',
    tints: ['#ffffff', '#c9d6c0', '#c9b8a0', '#a8b8c8'],
  },
  {
    id: 'peasant',
    name: 'Peasant set',
    tints: ['#ffffff', '#d8c8b0', '#c0ccd0', '#d0b8c0'],
  },
] as const;

export interface HairstyleInfo {
  id: string;
  name: string;
  /** Manifest asset suffix; null = no mesh (bald). */
  asset: string | null;
  /** Restricted to a body type, or null = both. */
  body: BodyId | null;
}

/** 6 styles + bald, mapped to the Quaternius hairstyle meshes that exist. */
export const HAIRSTYLES: readonly HairstyleInfo[] = [
  { id: 'none', name: 'Bald', asset: null, body: null },
  { id: 'buzzed', name: 'Buzzed', asset: 'hair_buzzed', body: null },
  { id: 'buzzed_short', name: 'Short buzz', asset: 'hair_buzzedfemale', body: null },
  { id: 'buns', name: 'Buns', asset: 'hair_buns', body: null },
  { id: 'long', name: 'Long', asset: 'hair_long', body: null },
  { id: 'parted', name: 'Parted', asset: 'hair_simpleparted', body: null },
] as const;

export const hairstyleById = (id: string): HairstyleInfo | undefined =>
  HAIRSTYLES.find((entry) => entry.id === id);

/** 8 hair colors (multiplicative over the hair mesh). */
export const HAIR_COLORS: readonly string[] = [
  '#2b2320',
  '#4a342a',
  '#6e4a2f',
  '#a86c3c',
  '#c9973f',
  '#b5432f',
  '#b9b9c0',
  '#4a76b8',
] as const;

/** The player-facing appearance choice set, as stored on the character row. */
export interface Appearance {
  body: BodyId;
  skin: number;
  outfit: OutfitId;
  outfitTint: number;
  hair: string;
  hairColor: number;
  beard: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  body: 'm',
  skin: 0,
  outfit: 'ranger',
  outfitTint: 0,
  hair: 'buzzed',
  hairColor: 1,
  beard: false,
};
