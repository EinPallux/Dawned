/**
 * Client-authored gathering intents (v13, `ClientOp.GatherOp`).
 *
 * The second JSON envelope the client is allowed to author, and it gets the
 * same treatment as the first: a zod gate at the boundary, because these carry
 * ids and positions rather than being fixed-width binary the codec bounds by
 * construction (item-ops.ts has the longer version of this argument).
 *
 * Discrete intents only. Anything HELD — the fishing reel — rides the input
 * bitfield on the 20 Hz stream instead, because a held button is a per-tick
 * fact and JSON per frame would be the wrong lane for it.
 */

import { z } from 'zod';

/** A placement id from the baked map (`nodes[]` in placements.json). */
const placementRef = z.string().min(1).max(80);

export const gatherOpSchema = z.discriminatedUnion('kind', [
  /**
   * Begin the hold on a node. The server re-checks range, tier and the claim —
   * this is a request, and the GatherState that comes back is the answer.
   */
  z.object({ kind: z.literal('start'), placementId: placementRef }).strict(),
  /**
   * Let go. Sent on key-up, on moving away, and when the UI is closed; the
   * server also cancels on its own when the player moves or takes a hit, so a
   * cancel that never arrives is not a stuck channel.
   */
  z.object({ kind: z.literal('cancel') }).strict(),
]);
export type GatherOp = z.infer<typeof gatherOpSchema>;

/** Parse an op off the wire. `null` = malformed; the caller drops it. */
export const parseGatherOp = (raw: unknown): GatherOp | null => {
  const parsed = gatherOpSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};
