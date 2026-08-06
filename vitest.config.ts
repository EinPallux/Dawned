import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The pipeline is plain `.mjs` and lives outside packages/, but its
    // transforms (clip merging) are as testable as any formula — and a bad bake
    // is only visible as a T-posing enemy in a screenshot otherwise.
    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.mjs'],
    environment: 'node',
    reporters: ['default'],
  },
});
