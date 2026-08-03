#!/usr/bin/env node
/**
 * Dev-island worldgen CLI.
 *
 *   pnpm world:generate [--seed N] [--version dev-2]
 *
 * Deterministic: same inputs, same bytes (see src/generate.mjs).
 */

import { generate } from '../src/generate.mjs';

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

generate({
  seed: Number(readFlag('seed', '7')),
  version: readFlag('version', 'dev-2'),
}).catch((error) => {
  console.error(`worldgen failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
