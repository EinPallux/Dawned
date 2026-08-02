/**
 * Password hashing — argon2id with the SECURITY.md §1 parameters
 * (m=64 MiB, t=3, p=1 — tuned for ~80 ms on the 1-core VPS).
 */

import { hash, verify, type Options } from '@node-rs/argon2';

// Algorithm.Argon2id — the enum itself is a const enum, unreachable as a value
// under verbatimModuleSyntax, so the numeric constant is pinned here instead.
const ARGON2ID = 2 as NonNullable<Options['algorithm']>;

const OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 65536, // KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
};

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

/** Constant-time verify; never throws on malformed hashes (returns false). */
export const verifyPassword = async (storedHash: string, password: string): Promise<boolean> => {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
};
