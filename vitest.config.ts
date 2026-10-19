import { defineConfig } from 'vitest/config';

// Engine and pure-logic tests run in Node; the engine has no DOM dependencies.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'electron/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
  },
});
