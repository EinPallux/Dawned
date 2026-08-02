#!/usr/bin/env node
/**
 * Asset pipeline CLI.
 *
 *   pnpm assets:build [--force]   convert selected source packs → assets_baked/
 *   pnpm assets:report            validate the manifest, licenses, budgets, rigs
 *   pnpm assets:sync              copy assets_baked/ → packages/client/public/assets
 */

import { build } from '../src/build.mjs';
import { report } from '../src/report.mjs';
import { sync } from '../src/sync.mjs';

const [command = 'report', ...flags] = process.argv.slice(2);

const run = async () => {
  switch (command) {
    case 'build': {
      const { problems } = await build({ force: flags.includes('--force') });
      if (problems.length > 0) process.exitCode = 1;
      return;
    }
    case 'report': {
      const result = await report();
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'sync': {
      await sync();
      return;
    }
    default:
      console.error(`unknown command "${command}" — expected "build", "report" or "sync"`);
      process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(`asset pipeline failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
