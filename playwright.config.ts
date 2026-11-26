import { defineConfig } from '@playwright/test';

/** App tests: drive the real Orion (Electron) with a throwaway profile. Run `npm run test:app`. */
export default defineConfig({
  testDir: 'tests/app',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: { screenshot: 'only-on-failure' },
  outputDir: 'test-results',
});
