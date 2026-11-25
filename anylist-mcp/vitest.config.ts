import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Belt and braces: tests must never reach the real AnyList service.
    env: { ANYLIST_EMAIL: '', ANYLIST_PASSWORD: '' },
  },
});
