import { defineConfig, devices } from '@playwright/test';

// Port is overridable (E2E_PORT) so a git-worktree checkout can run its own
// isolated dev server instead of reusing whatever is already on the default port.
const PORT = process.env.E2E_PORT ?? '5173';
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: BASE_URL },
  webServer: {
    command: `pnpm exec vite dev --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
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
