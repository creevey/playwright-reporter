import { defineConfig, devices } from '@playwright/test'

// Component testing (the "stories + gallery" model, Playwright >= 1.62):
// components are served by a dev server (the gallery), tests mount stories via
// the built-in `mount` fixture, and everything else is a regular Playwright test.
// @crvy/rprtr therefore reports component tests exactly like e2e tests:
// live streaming, baseline display, diffs, and one-click approval.
export default defineConfig({
  testDir: './tests',
  reporter: [['@crvy/rprtr', { screenshotDir: './screenshots' }], ['line']],
  projects: [
    {
      name: 'components',
      testDir: './tests/components',
      use: {
        ...devices['Desktop Chrome'],
        // `mount` navigates to baseURL, so it must point at the gallery page.
        baseURL: 'http://localhost:5173/playwright/gallery/index.html',
        // Keep a dev-server service worker from shadowing page.route() mocks.
        serviceWorkers: 'block',
        // Reuse the browser context between tests in a worker (big speedup).
        reuseContext: true,
      },
    },
  ],
  webServer: {
    // The gallery is served by your own dev server. This example ships a tiny
    // dependency-free static server that runs under both Bun (local) and Node
    // (inside the official Playwright Docker image, which does not ship Bun).
    command: "sh -c 'command -v bun >/dev/null 2>&1 && exec bun gallery/server.mjs || exec node gallery/server.mjs'",
    url: 'http://localhost:5173/playwright/gallery/index.html',
    reuseExistingServer: process.env.CI === undefined || process.env.CI === '',
  },
})
