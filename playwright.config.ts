import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: 'https://vicentedomus.github.io/checavuelos/',
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
