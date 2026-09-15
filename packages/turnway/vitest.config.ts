import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Run files serially to limit contention on the shared Redis test instance
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
