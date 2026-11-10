import { defineConfig, devices } from '@playwright/test'

// Phone checks in WebKit, Safari's engine, with an iPhone's screen and
// touch. They run against a server already listening (DAKORT_URL, default
// 127.0.0.1:3002) and log in with DAKORT_TOKEN; without a token they skip.
// Not real iOS: no on-screen keyboard, and momentum scrolling differs.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  // The whole run takes about 2 minutes. A run that hangs past this is
  // aborted, browsers and all: one hung on 2026-11-02 and its browser sat
  // in the project folder for a day, blocking a rename.
  globalTimeout: 6 * 60_000,
  workers: 1,
  use: {
    ...devices['iPhone 15'],
    baseURL: process.env.DAKORT_URL ?? 'http://127.0.0.1:3002',
  },
  projects: [
    { name: 'iphone-webkit', use: { browserName: 'webkit' } },
    // The laptop's layout (explorer and editor side by side) differs.
    { name: 'desktop', use: { browserName: 'webkit', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false } },
  ],
})
