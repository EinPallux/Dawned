/**
 * Character CRUD (docs/tech/DATABASE.md §2):
 *  - max 5 alive per account, unique names world-wide (case-insensitive)
 *  - soft delete frees the name via a `~id` suffix
 *  - world state (position/playtime) is written by the gateway's persistence
 *    hooks, not through this service.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { characters, type CharacterRow } from '@dawned/shared/schema';
import {
  MAX_CHARACTERS_PER_ACCOUNT,
  createCharacterRequestSchema,
  type Appearance,
  type CharacterSummary,
  type CreateCharacterRequest,
} from '@dawned/shared';
import { isUniqueViolation, type Db } from '../db/client.js';

export type CharacterResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: 'invalid' | 'name_taken' | 'slots_full' | 'not_found';
      message: string;
    };

export const toAppearance = (row: CharacterRow): Appearance => ({
  body: row.body,
  skin: row.skin,
  outfit: row.outfit,
  outfitTint: row.outfitTint,
  hair: row.hair,
  hairColor: row.hairColor,
  beard: row.beard,
});

export const toSummary = (row: CharacterRow): CharacterSummary => ({
  id: row.id,
  name: row.name,
  classId: row.classId,
  level: row.level,
  zoneId: row.zoneId,
  appearance: toAppearance(row),
  createdAt: row.createdAt.toISOString(),
});

export class CharacterService {
  constructor(private readonly db: Db) {}

  async list(accountId: number): Promise<CharacterSummary[]> {
    const rows = await this.db.query.characters.findMany({
      where: and(eq(characters.accountId, accountId), isNull(characters.deletedAt)),
      orderBy: (table, { asc }) => [asc(table.createdAt)],
    });
    return rows.map(toSummary);
  }

  /** Full row, only if alive and owned by the account (gateway spawn path). */
  async getOwned(accountId: number, characterId: number): Promise<CharacterRow | null> {
    const row = await this.db.query.characters.findFirst({
      where: and(
        eq(characters.id, characterId),
        eq(characters.accountId, accountId),
        isNull(characters.deletedAt),
      ),
    });
    return row ?? null;
  }

  async create(
    accountId: number,
    request: CreateCharacterRequest,
  ): Promise<CharacterResult<CharacterSummary>> {
    const parsed = createCharacterRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Invalid character.',
      };
    }
    const { name, classId, appearance } = parsed.data;

    const alive = await this.list(accountId);
    if (alive.length >= MAX_CHARACTERS_PER_ACCOUNT) {
      return {
        ok: false,
        code: 'slots_full',
        message: `Accounts hold up to ${MAX_CHARACTERS_PER_ACCOUNT} characters — delete one first.`,
      };
    }

    try {
      const [row] = await this.db
        .insert(characters)
        .values({
          accountId,
          name,
          classId,
          body: appearance.body,
          skin: appearance.skin,
          outfit: appearance.outfit,
          outfitTint: appearance.outfitTint,
          hair: appearance.hair,
          hairColor: appearance.hairColor,
          beard: appearance.beard,
        })
        .returning();
      return { ok: true, value: toSummary(row!) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { ok: false, code: 'name_taken', message: 'That character name is already taken.' };
      }
      throw error;
    }
  }

  /** Soft delete + rename so the name frees up immediately. */
  async softDelete(accountId: number, characterId: number): Promise<CharacterResult<null>> {
    const result = await this.db
      .update(characters)
      .set({
        deletedAt: new Date(),
        name: sql`${characters.name} || '~' || ${characters.id}`,
      })
      .where(
        and(
          eq(characters.id, characterId),
          eq(characters.accountId, accountId),
          isNull(characters.deletedAt),
        ),
      )
      .returning({ id: characters.id });
    if (result.length === 0) {
      return { ok: false, code: 'not_found', message: 'No such character on this account.' };
    }
    return { ok: true, value: null };
  }

  /** Write-behind world state flush (gateway calls this on a timer + disconnect). */
  async savePosition(
    characterId: number,
    pos: { x: number; y: number; z: number; yaw: number },
    playtimeDeltaSeconds: number,
  ): Promise<void> {
    await this.db
      .update(characters)
      .set({
        posX: pos.x,
        posY: pos.y,
        posZ: pos.z,
        yaw: pos.yaw,
        playtimeSeconds: sql`${characters.playtimeSeconds} + ${Math.max(0, Math.round(playtimeDeltaSeconds))}`,
      })
      .where(eq(characters.id, characterId));
  }
}
