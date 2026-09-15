import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // 실제 Redis 를 쓰는 통합 테스트는 순차 실행으로 키 충돌 방지
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
