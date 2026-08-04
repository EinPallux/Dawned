/**
 * XP curve content schema (PROGRESSION.md §1.2) — one row per level in
 * `content_xp_curve` (PK (id, status), def jsonb, the standard content
 * pattern). The panel's curve editor edits rows individually; publish runs
 * {@link xpCurveProblems} as its cross-row check (levels 1..29 exactly once)
 * the same way abilities cross-check hotbar slots.
 */

import { z } from 'zod';
import { MAX_LEVEL, xpToNextDefault, type XpCurve } from '../formulas/progression.js';

/** Content ids: `xp_l01` .. `xp_l29` (zero-padded so listings sort). */
const xpCurveIdSchema = z
  .string()
  .regex(/^xp_l(0[1-9]|[12][0-9])$/, 'xp curve ids look like xp_l01..xp_l29');

export const xpCurveEntrySchema = z
  .object({
    id: xpCurveIdSchema,
    /** The level this row leaves (29 rows: level 30 is the cap). */
    level: z
      .number()
      .int()
      .min(1)
      .max(MAX_LEVEL - 1),
    /** XP required to go from `level` to `level + 1`. Integer (project rule). */
    xpToNext: z.number().int().min(1).max(10_000_000),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const idLevel = Number(entry.id.slice(4));
    if (idLevel !== entry.level) {
      ctx.addIssue({
        code: 'custom',
        message: `id ${entry.id} does not match level ${entry.level}`,
      });
    }
  });

export type XpCurveEntry = z.infer<typeof xpCurveEntrySchema>;

/** Parse + throw with the row id in the message (boot/publish validation). */
export const validateXpCurveEntry = (raw: unknown): XpCurveEntry => {
  const result = xpCurveEntrySchema.safeParse(raw);
  if (!result.success) {
    const id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '<no id>';
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`xp curve row ${id} invalid: ${issues}`);
  }
  return result.data;
};

/**
 * Cross-row completeness check (publish + boot): every level 1..29 present
 * exactly once. Returns human-readable problems; empty = good.
 */
export const xpCurveProblems = (entries: readonly XpCurveEntry[]): string[] => {
  const problems: string[] = [];
  const seen = new Map<number, number>();
  for (const entry of entries) seen.set(entry.level, (seen.get(entry.level) ?? 0) + 1);
  for (let level = 1; level < MAX_LEVEL; level++) {
    const count = seen.get(level) ?? 0;
    if (count === 0) problems.push(`level ${level} has no xp_curve row`);
    if (count > 1) problems.push(`level ${level} has ${count} xp_curve rows`);
  }
  return problems;
};

/** Rows → the runtime lookup the server/formulas consume. Throws on gaps. */
export const buildXpCurve = (entries: readonly XpCurveEntry[]): XpCurve => {
  const problems = xpCurveProblems(entries);
  if (problems.length > 0) throw new Error(`xp curve incomplete: ${problems.join('; ')}`);
  const curve: number[] = new Array<number>(MAX_LEVEL).fill(0);
  for (const entry of entries) curve[entry.level] = entry.xpToNext;
  return curve;
};

/** The formula-generated default rows (authoring seed + tests). */
export const defaultXpCurveEntries = (): XpCurveEntry[] => {
  const entries: XpCurveEntry[] = [];
  for (let level = 1; level < MAX_LEVEL; level++) {
    entries.push({
      id: `xp_l${String(level).padStart(2, '0')}`,
      level,
      xpToNext: xpToNextDefault(level),
    });
  }
  return entries;
};
