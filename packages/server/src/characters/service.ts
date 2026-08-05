/**
 * Character CRUD (docs/tech/DATABASE.md §2):
 *  - max 5 alive per account, unique names world-wide (case-insensitive)
 *  - soft delete frees the name via a `~id` suffix
 *  - world state (position/playtime) is written by the gateway's persistence
 *    hooks, not through this service.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  characterDiscoveries,
  characterProfessions,
  characterQuests,
  characterInteractions,
  characterItems,
  characterSkills,
  characters,
  type CharacterRow,
} from '@dawned/shared/schema';
import {
  EQUIP_SLOTS,
  MAX_CHARACTERS_PER_ACCOUNT,
  createCharacterRequestSchema,
  type Appearance,
  type AttributeSpread,
  type CharacterSummary,
  type CreateCharacterRequest,
  type EquipSlot,
  type ItemStack,
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

  // -------------------------------------------------------------------------
  // Progression (P7, DATABASE.md §2 write patterns)
  // -------------------------------------------------------------------------

  /** Allocated skill-tree ranks for the spawn path. */
  async loadSkills(characterId: number): Promise<Map<string, number>> {
    const rows = await this.db
      .select()
      .from(characterSkills)
      .where(eq(characterSkills.characterId, characterId));
    return new Map(rows.map((row) => [row.nodeId, row.ranks]));
  }

  /** Discovered refs of one kind (zone first-entry, P10 material codex). */
  async loadDiscoveries(
    characterId: number,
    kind: 'zone' | 'codex' | 'poi' | 'shrine',
  ): Promise<Set<string>> {
    const rows = await this.db
      .select()
      .from(characterDiscoveries)
      .where(
        and(eq(characterDiscoveries.characterId, characterId), eq(characterDiscoveries.kind, kind)),
      );
    return new Set(rows.map((row) => row.refId));
  }

  /** Record a first-time discovery; the PK makes double-pays impossible. */
  async addDiscovery(
    characterId: number,
    kind: 'zone' | 'codex' | 'poi' | 'shrine',
    refId: string,
  ): Promise<void> {
    await this.db
      .insert(characterDiscoveries)
      .values({ characterId, kind, refId })
      .onConflictDoNothing();
  }

  /** Quest rows for one character (P11). */
  async loadQuests(
    characterId: number,
  ): Promise<
    { questId: string; status: string; step: number; counter: number; pinned: boolean }[]
  > {
    const rows = await this.db
      .select()
      .from(characterQuests)
      .where(eq(characterQuests.characterId, characterId));
    return rows.map((row) => ({
      questId: row.questId,
      status: row.status,
      step: row.step,
      counter: row.counter,
      pinned: row.pinned,
    }));
  }

  /** Write-through of one quest's state. */
  async saveQuest(
    characterId: number,
    row: { questId: string; status: string; step: number; counter: number; pinned: boolean },
  ): Promise<void> {
    await this.db
      .insert(characterQuests)
      .values({
        characterId,
        questId: row.questId,
        status: row.status as 'active' | 'complete' | 'turned_in' | 'abandoned',
        step: row.step,
        counter: row.counter,
        pinned: row.pinned,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [characterQuests.characterId, characterQuests.questId],
        set: {
          status: row.status as 'active' | 'complete' | 'turned_in' | 'abandoned',
          step: row.step,
          counter: row.counter,
          pinned: row.pinned,
          updatedAt: new Date(),
        },
      });
  }

  /** Per-character interactable records (P11): chests opened, shrines attuned. */
  async loadInteractions(
    characterId: number,
  ): Promise<{ objectId: string; kind: string; count: number }[]> {
    const rows = await this.db
      .select()
      .from(characterInteractions)
      .where(eq(characterInteractions.characterId, characterId));
    return rows.map((row) => ({ objectId: row.objectId, kind: row.kind, count: row.count }));
  }

  /**
   * Write-through of one object's record. Stored as one row per (object,
   * kind): "opened" carries the cooldown in `count` (−1 = one-shot, spent),
   * "attuned" is a marker, "used" is the interact-step tally.
   */
  async saveInteraction(
    characterId: number,
    objectId: string,
    record: { openedUntilMs: number; attuned: boolean; uses: number },
  ): Promise<void> {
    const rows: { kind: 'opened' | 'attuned' | 'used'; count: number }[] = [];
    if (record.openedUntilMs !== 0) rows.push({ kind: 'opened', count: record.openedUntilMs });
    if (record.attuned) rows.push({ kind: 'attuned', count: 1 });
    if (record.uses > 0) rows.push({ kind: 'used', count: record.uses });
    for (const row of rows) {
      await this.db
        .insert(characterInteractions)
        .values({ characterId, objectId, kind: row.kind, count: row.count, at: new Date() })
        .onConflictDoUpdate({
          target: [
            characterInteractions.characterId,
            characterInteractions.objectId,
            characterInteractions.kind,
          ],
          set: { count: row.count, at: new Date() },
        });
    }
  }

  /** Gathering-profession rows for one character (P10). */
  async loadProfessions(
    characterId: number,
  ): Promise<{ profession: string; level: number; xp: number }[]> {
    const rows = await this.db
      .select()
      .from(characterProfessions)
      .where(eq(characterProfessions.characterId, characterId));
    return rows.map((row) => ({ profession: row.profession, level: row.level, xp: row.xp }));
  }

  /**
   * Write-through one profession's level/xp. Upsert rather than update: a
   * character's first swing at a tree is also the first time that row exists,
   * and making the spawn path pre-insert four rows for every character who may
   * never gather is four writes for nothing.
   */
  async saveProfession(
    characterId: number,
    profession: 'woodcutting' | 'mining' | 'herbalism' | 'fishing',
    level: number,
    xp: number,
  ): Promise<void> {
    await this.db
      .insert(characterProfessions)
      .values({ characterId, profession, level, xp })
      .onConflictDoUpdate({
        target: [characterProfessions.characterId, characterProfessions.profession],
        set: { level, xp, updatedAt: new Date() },
      });
  }

  /**
   * Write-through progression flush: xp/level/gold/points in ONE statement
   * (gameplay-critical, DATABASE.md §2). Skill ranks travel separately via
   * {@link saveSkills} — they change on explicit clicks, not per kill.
   */
  async saveProgress(
    characterId: number,
    progress: {
      level: number;
      xp: number;
      gold: number;
      allocated: AttributeSpread;
      unspentStatPoints: number;
      unspentSkillPoints: number;
    },
  ): Promise<void> {
    await this.db
      .update(characters)
      .set({
        level: progress.level,
        xp: progress.xp,
        gold: progress.gold,
        statStr: progress.allocated.str,
        statAgi: progress.allocated.agi,
        statInt: progress.allocated.int,
        statVit: progress.allocated.vit,
        statEnd: progress.allocated.end,
        unspentStatPoints: progress.unspentStatPoints,
        unspentSkillPoints: progress.unspentSkillPoints,
      })
      .where(eq(characters.id, characterId));
  }

  /** Replace the character's skill rows wholesale (allocation + respec). */
  async saveSkills(characterId: number, ranks: ReadonlyMap<string, number>): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(characterSkills).where(eq(characterSkills.characterId, characterId));
      const values = [...ranks.entries()]
        .filter(([, rank]) => rank > 0)
        .map(([nodeId, rank]) => ({ characterId, nodeId, ranks: rank }));
      if (values.length > 0) await tx.insert(characterSkills).values(values);
    });
  }

  /**
   * Load the bag + paper-doll (P8). Cells address themselves (`container` +
   * `slot`), so the map rebuilds exactly as it was saved — no ordering
   * assumptions, no reindexing.
   */
  async loadInventory(characterId: number): Promise<{
    bag: Map<number, ItemStack>;
    equipment: Map<EquipSlot, ItemStack>;
  }> {
    const rows = await this.db
      .select()
      .from(characterItems)
      .where(eq(characterItems.characterId, characterId));
    const bag = new Map<number, ItemStack>();
    const equipment = new Map<EquipSlot, ItemStack>();
    for (const row of rows) {
      const stack: ItemStack = {
        id: row.id,
        itemId: row.itemId,
        qty: row.qty,
        rolled: (row.rolledStats as ItemStack['rolled']) ?? null,
      };
      if (row.container === 'inventory') {
        bag.set(row.slot, stack);
      } else {
        const slot = EQUIP_SLOTS[row.slot];
        if (slot) equipment.set(slot, stack);
      }
    }
    return { bag, equipment };
  }

  /**
   * Write-through inventory flush (DATABASE.md §2): one transaction, taking
   * the character row lock first so two concurrent flushes for the same
   * character serialize instead of interleaving. The rows are replaced
   * wholesale — with at most 59 cells that is cheaper than diffing, and it
   * makes a half-applied write impossible.
   */
  async saveInventory(
    characterId: number,
    rows: { container: 'inventory' | 'equipment'; slot: number; stack: ItemStack }[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM characters WHERE id = ${characterId} FOR UPDATE`);
      await tx.delete(characterItems).where(eq(characterItems.characterId, characterId));
      if (rows.length === 0) return;
      await tx.insert(characterItems).values(
        rows.map((row) => ({
          characterId,
          itemId: row.stack.itemId,
          container: row.container,
          slot: row.slot,
          qty: row.stack.qty,
          rolledStats: row.stack.rolled ?? null,
        })),
      );
    });
  }

  /** Write-behind world state flush (gateway calls this on a timer + disconnect). */
  async savePosition(
    characterId: number,
    pos: { x: number; y: number; z: number; yaw: number },
    playtimeDeltaSeconds: number,
    /** Current HP (rounded); a dead character saves as 1 — respawn is a live
     * flow, never a login state (COMBAT.md §10). */
    hp?: number,
  ): Promise<void> {
    await this.db
      .update(characters)
      .set({
        posX: pos.x,
        posY: pos.y,
        posZ: pos.z,
        yaw: pos.yaw,
        ...(hp !== undefined ? { hp: Math.max(1, Math.round(hp)) } : {}),
        playtimeSeconds: sql`${characters.playtimeSeconds} + ${Math.max(0, Math.round(playtimeDeltaSeconds))}`,
      })
      .where(eq(characters.id, characterId));
  }
}
