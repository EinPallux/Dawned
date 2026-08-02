/**
 * REST request/response contracts — zod at the boundary, shared by both sides:
 * the client validates before sending (instant feedback), the server re-validates
 * on receipt (the only validation that counts — docs/tech/SECURITY.md §2).
 */

import { z } from 'zod';
import { HAIRSTYLES, HAIR_COLORS, OUTFITS, SKIN_TONES } from '../data/appearance.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Blocked for both account and character names (case-insensitive). */
export const RESERVED_NAMES: readonly string[] = [
  'admin',
  'administrator',
  'gm',
  'gamemaster',
  'mod',
  'moderator',
  'system',
  'server',
  'dawned',
  'support',
  'root',
];

const isReserved = (value: string): boolean => RESERVED_NAMES.includes(value.toLowerCase());

/** Account names: 3–20 chars, letters/digits/underscore (docs/tech/DATABASE.md). */
export const accountNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{3,20}$/, 'Account names are 3–20 characters: letters, digits, underscore.')
  .refine((value) => !isReserved(value), 'That name is reserved.');

export const passwordSchema = z
  .string()
  .min(8, 'Passwords need at least 8 characters.')
  .max(128, 'Passwords are capped at 128 characters.');

/** Character names: 2–16 chars, letters with single spaces between words. */
export const characterNameSchema = z
  .string()
  .min(2, 'Character names need at least 2 characters.')
  .max(16, 'Character names are capped at 16 characters.')
  .regex(
    /^[A-Za-z]+(?: [A-Za-z]+)*$/,
    'Character names: letters only, single spaces between words.',
  )
  .refine((value) => !isReserved(value), 'That name is reserved.');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerRequestSchema = z.object({
  name: accountNameSchema,
  password: passwordSchema,
  /** Only checked when the server has an invite code configured (Q8: off). */
  inviteCode: z.string().max(64).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  name: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface AccountInfo {
  id: number;
  name: string;
  role: 'player' | 'gm' | 'admin';
}

export interface AuthResponse {
  token: string;
  account: AccountInfo;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export const appearanceSchema = z.object({
  body: z.enum(['m', 'f']),
  skin: z
    .number()
    .int()
    .min(0)
    .max(SKIN_TONES.length - 1),
  outfit: z.enum(['ranger', 'peasant']),
  outfitTint: z.number().int().min(0),
  hair: z.string().refine((id) => HAIRSTYLES.some((h) => h.id === id), 'Unknown hairstyle.'),
  hairColor: z
    .number()
    .int()
    .min(0)
    .max(HAIR_COLORS.length - 1),
  beard: z.boolean(),
});

/** Cross-field rule: the tint index must exist for the chosen outfit. */
export const validatedAppearanceSchema = appearanceSchema.refine((value) => {
  const outfit = OUTFITS.find((entry) => entry.id === value.outfit);
  return outfit !== undefined && value.outfitTint < outfit.tints.length;
}, 'Unknown outfit tint.');

export const createCharacterRequestSchema = z.object({
  name: characterNameSchema,
  classId: z.enum(['warrior', 'mage', 'rogue', 'cleric']),
  appearance: validatedAppearanceSchema,
});
export type CreateCharacterRequest = z.infer<typeof createCharacterRequestSchema>;

export interface CharacterSummary {
  id: number;
  name: string;
  classId: 'warrior' | 'mage' | 'rogue' | 'cleric';
  level: number;
  zoneId: string | null;
  appearance: z.infer<typeof appearanceSchema>;
  createdAt: string;
}

/** Uniform REST error shape (client maps `code` to friendly copy). */
export interface ApiError {
  error: string;
  message: string;
}
