/**
 * World settings — the key/value feature-flag surface of `content_world_settings`
 * (docs/tech/DATABASE.md §3, docs/tech/ARCHITECTURE.md "feature flags").
 *
 * Dawned-Admin's settings editor generates its form from THIS schema (its rule:
 * hand-rolled forms that shadow the schema are forbidden), and the game server
 * consumes published values as each system lands (xpRate → P7 progression,
 * dayNightEnabled → P14 visuals, motd → join chat). Validation lives here so
 * neither side can drift; UI labels/help live in the admin repo's enhancements.
 */

import { z } from 'zod';

export const worldSettingsSchema = z.object({
  /** Global XP multiplier (PROGRESSION.md §"XP-rate world modifier"). */
  xpRate: z.number().min(0.25).max(8).default(1),
  /** Visual day/night cycle master switch — the feature ships in P14. */
  dayNightEnabled: z.boolean().default(false),
  /** Message of the day, whispered on join; empty = none. */
  motd: z.string().max(300).default(''),
});

export type WorldSettings = z.infer<typeof worldSettingsSchema>;

/** The defaults as a concrete object (what a fresh world runs with). */
export const defaultWorldSettings = (): WorldSettings => worldSettingsSchema.parse({});
