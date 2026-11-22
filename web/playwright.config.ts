import { defineConfig, devices } from '@playwright/test'

// Phone checks in WebKit, Safari's engine, with an iPhone's screen and
// touch. They run against a server already listening (DAKORT_URL, default
// 127.0.0.1:3002) and log in with DAKORT_TOKEN; without a token they skip.
// Not real iOS: no on-screen keyboard, and momentum scrolling differs.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  // The whole run takes about 4.5 minutes (2026-11-21, 110 checks). A run
  // that hangs past this is aborted, browsers and all: one hung on
  // 2026-11-02 and its browser sat in the project folder for a day,
  // blocking a rename. At 6 minutes one failing check (90 s, twice with
  // the retry) left a third of the run unrun.
  globalTimeout: 9 * 60_000,
  workers: 1,
  // One retry: on 2026-11-17 a different check failed in about one full
  // run in three (a PDF, a CSV, a Word file, the old-device login), in the
  // single old file as in the split ones, and passed when run again. A
  // pass on the retry is counted as flaky in the summary ship.sh prints; a
  // real break fails twice and stops the ship.
  retries: 1,
  use: {
    ...devices['iPhone 15'],
    baseURL: process.env.DAKORT_URL ?? 'http://127.0.0.1:3002',
    // The app has no service worker now; blocked still, since requests a
    // controlled page makes slip past page.route, which most checks play
    // the server's answers through. The check that one is removed opens a
    // context that allows them.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'iphone-webkit', use: { browserName: 'webkit' } },
    // The laptop's layout (explorer and editor side by side) differs.
    { name: 'desktop', use: { browserName: 'webkit', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false } },
  ],
})
