import { defineConfig, devices } from "@playwright/test";

/**
 * UI tests (e2e/) against a real server on a test database. The same guard as
 * the integration suite refuses any database whose name doesn't end in _e2e or
 * _test, before the server is started:
 *
 *   cp .env.test.example .env.test   # MONGODB_DB=klndr_e2e
 *   npx playwright install chromium  # once
 *   npm run test:e2e
 *
 * Locally an already running server on the port is reused (the klndr-e2e
 * launch config is the same command); CI always starts its own.
 */
// Playwright compiles this file (and e2e/) to CommonJS, so require is the
// way to the shared CommonJS helpers.
const { prepareTestDatabase } = require("./test/support/test-db.cjs");
const database = prepareTestDatabase();

const PORT = Number(process.env.E2E_PORT) || 3011;
const BASE_URL = `http://localhost:${PORT}`;
const CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One database shared by every test: run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Animations off, so a screenshot or a click never lands mid-flight.
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    // The smoke suite, once per device class.
    { name: "desktop", testIgnore: /mobile[\\/]/, use: { ...devices["Desktop Chrome"] } },
    { name: "phone", testIgnore: /mobile[\\/]/, use: { ...devices["Pixel 7"] } },
    // docs/mobile-regression-checklist.md, automated. A desktop-sized browser
    // that can also be touched, so one board serves both kinds of pointer;
    // tests that need a particular device open their own context.
    {
      name: "checklist",
      testMatch: /mobile[\\/].*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], hasTouch: true, viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    // KLNDR_TARGET=bundle tests the bundle Vercel deploys (npm run build first).
    // Otherwise the pages are built first, so the suite never runs an old build.
    command: process.env.KLNDR_TARGET === "bundle" ? "node scripts/serve-bundle.mjs" : "npm run build:web && npm start",
    url: `${BASE_URL}/login`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { PORT: String(PORT), MONGODB_DB: database },
  },
});
