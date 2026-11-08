import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
    // Native SQLite/FFI state must not be reused between V8 test isolates.
    pool: 'forks',
  },
});
