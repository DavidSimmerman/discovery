import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: {
    command: 'pnpm exec vite dev --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'e2e',
      testDir: 'tests/e2e',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live-setup',
      testDir: 'tests/live',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live',
      testDir: 'tests/live',
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['live-setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/spotify.json',
        launchOptions: { args: ['--mute-audio'] },
      },
    },
  ],
});
