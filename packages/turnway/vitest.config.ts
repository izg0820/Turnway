import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Integration tests hit a real Redis, so files run serially to avoid key collisions
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
