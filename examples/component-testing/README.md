# Component testing example — Playwright stories + gallery, reported by @crvy/rprtr

This example shows [Playwright Component Testing](https://playwright.dev/docs/test-components) (the **stories + gallery** model introduced in Playwright **1.62**) working end to end with the `@crvy/rprtr` reporter: live reporting in the browser, screenshot baselines, visual diffs, and one-click approval.

It is intentionally **framework-free** (vanilla DOM components, no bundler, no dependencies beyond Playwright and the reporter) so every piece of the mechanism is visible. Swapping in React, Vue, or Svelte only changes the gallery page — see [Adapting to React/Vue/Svelte](#adapting-to-reactvue-svelte).

## Requirements

- Playwright **≥ 1.62** (`fixtures.mount()` was added in 1.62) — pinned to `1.62.1` here
- Node **≥ 22** or Bun (the gallery server and the `crvy-rprtr` UI server run on either)

## How the component-testing model works

```
                     ┌────────────────────────────────────────────────┐
                     │  your dev server (gallery/server.mjs)          │
                     │  serves the gallery page + component modules   │
                     └───────────────▲────────────────────────────────┘
                                     │ baseURL
┌────────────────────┐    navigate   │
│ playwright test    │───────────────┘
│  fixtures.mount()  │── calls window.mount({ story, props }) in the browser
│  returns Locator   │◄─ resolves after the story rendered into #root
└─────────┬──────────┘
          │ reporter events (WebSocket)
          ▼
┌────────────────────┐        approve: copy actual image
│ crvy-rprtr server  │──────────────────────────────────▶ baseline .png
│  UI · diffs · runs │
└────────────────────┘
```

Three concepts ([docs](https://playwright.dev/docs/test-components)):

- A **story** wraps the component under test in one scenario — hard-coded props, mock data, state, callbacks. Each named export in a `*.story.js` file is one story.
- The **gallery** is a single page served by your dev server. It exposes `window.mount({ story, props })` and `window.unmount()`, rendering a story into `#root`. You own it; Playwright never compiles or serves it.
- The built-in **`mount` fixture** navigates to `baseURL`, calls `window.mount()` with the story id, and returns a `Locator` for the story root — with `update(props)` / `unmount()` helpers. From there, everything is an ordinary Playwright test: `expect(...)`, `page.route(...)`, and `toHaveScreenshot()`.

Because component tests are regular Playwright tests, `@crvy/rprtr` needs **zero configuration** to report them: it sees the same test events, the same `toHaveScreenshot` steps, and the same snapshot files as for e2e tests.

## Project layout

```
├── playwright.config.ts        # components project + rprtr reporter + webServer
├── gallery/
│   ├── server.mjs              # tiny static dev server (runs on Bun AND Node)
│   ├── index.html              # gallery shell: #root, global CSS
│   ├── gallery.js              # the gallery contract: window.mount/unmount
│   └── registry.js             # story id → story factory (static import map)
├── src/components/
│   ├── Button.js               # component: factory → { root, update(props) }
│   ├── Button.story.js         # stories: Primary, Disabled, Danger, WithTitle
│   ├── Expandable.js           # stateful component (internal `expanded` state)
│   └── Expandable.story.js     # Stateful: records state into a hidden input
└── tests/components/
    ├── button.spec.ts          # DOM assertions, props, update(), screenshots
    └── expandable.spec.ts      # interaction → recorded state → screenshot
```

## Quickstart

```bash
cd examples/component-testing
bun install                 # or: npm install

# Terminal 1 — start the review/approval UI
bun run reporter            # → http://localhost:3000

# Terminal 2 — run the tests (starts the gallery dev server itself)
bun run test
```

What happens on the first run:

1. Playwright starts the `webServer` (the gallery) and navigates each `mount()` to it.
2. The three interaction tests pass.
3. The four visual tests **fail because no baselines exist yet** — this is normal. Playwright writes the actual images as new baselines; from the second run on, the suite is green.
4. Everything streams live into the rprtr UI at http://localhost:3000.

A second `bun run test` should pass 7/7. Baselines for this example are committed for both `darwin` and `linux` (see [Where baselines live](#where-baselines-live)), so the suite is green immediately on macOS and in the official Docker image.

## The rprtr loop, step by step

1. **Live view** — keep the UI open while tests run; each test appears with status, duration, and per-screenshot state.
2. **Make a visual change** — e.g. change the danger color in `src/components/Button.js`:
   ```bash
   bun run test   # → 'matches the danger baseline' fails
   ```
   The failing test now shows **expected / actual / diff** images with side-by-side, swap, slide, and blend views.
3. **Approve** — click **Approve** on the diff (or **Approve All**). rprtr copies the actual image over the exact baseline file Playwright will compare against next run — including the `-components` project suffix and platform suffix:
   ```
   tests/components/button.spec.ts-snapshots/danger-components-darwin.png
   ```
   Re-run: green. There is also a CLI-free API behind the button (`POST /api/approve`), used by the UI.
4. **Regenerate on purpose** — `bun run update-snapshots` (runs `playwright test --update-snapshots`); the UI also has a run-with-update button (▶↻).
5. **CI artifacts** — `bun run test:ci` runs with `CI=true`: the reporter switches to offline mode and writes `report.json`, portable `screenshots/`, and the self-contained `crvy-rprtr.html` for review without a server.

## Run buttons

With the UI server running, the sidebar offers Start/Stop and per-test ▶ buttons. The server spawns `playwright test` (or `pnpm exec`/`bunx` depending on your lockfile) with the same config — the gallery `webServer` starts as part of it, and results stream back into the UI.

## Docker mode

Reproducible baselines need the same rendering environment everywhere — that's what [Docker mode](../../../README.md#docker-mode) is for:

```bash
bun node_modules/.bin/crvy-rprtr --run-mode docker
```

Then press Run in the UI. Two things make this example docker-ready:

- The `webServer` command is `sh -c 'command -v bun … || node gallery/server.mjs'` — the official `mcr.microsoft.com/playwright:v1.62.1-noble` image ships Node but **not Bun**, so the gallery falls back to `node`. (Any node-based dev server — vite, webpack-dev-server — has the same property.)
- The gallery server binds all interfaces, which docker mode requires (see the [main README](../../../README.md#docker-mode)).

Note that baselines are platform-suffixed: docker runs compare against `-linux` baselines, local macOS runs against `-darwin` ones. Both are committed here; if you change a component, regenerate both (`bun run update-snapshots` locally, plus a docker run or the ▶↻ button under docker mode).

## Test patterns demonstrated

- **Plain mount + assertion** — `button.spec.ts › renders a primary button`.
- **Per-test props** — `mount('Button/WithTitle', { title: 'Hello' })`; the story maps its props onto the component (also across `update`).
- **`update()` without remounting** — the element handle stays valid and state survives (see `update preserves component state`).
- **Record state for assertions** — `Expandable.story.js` writes its `expanded` state into a hidden `data-testid` input; the test clicks like a user and asserts with the retrying `toHaveValue()`. No callback marshalling between Node and the browser.
- **Element screenshot** — `expect(component.getByRole('button')).toHaveScreenshot('primary.png')` for a tight baseline.
- **Whole-story screenshot** — `expect(component).toHaveScreenshot('expanded.png')` captures everything the story renders, after an interaction flipped its state.

## Where baselines live

Playwright's default `toHaveScreenshot` layout places baselines next to the spec file:

```
tests/components/button.spec.ts-snapshots/<name>-<project>-<platform>.png
                                               │        │         └─ snapshotSuffix (darwin/linux/…)
                                               │        └─ project name ("components")
                                               └─ the name passed to toHaveScreenshot()
```

- First run on a new platform: tests fail once while Playwright writes the new `-<platform>` baselines; the second run is green.
- If your suite uses a custom `snapshotPathTemplate`, pass the matching `playwrightSnapshotDir` / `playwrightToHaveScreenshotPathTemplate` options — see the [main README](../../../README.md#reporter-options).

## Adapting to React/Vue/Svelte

Only two things are framework-specific: the **registry** (how story modules are discovered) and the **rendering** inside `window.mount`. With Vite, generate the registry automatically and let the framework reconcile into `#root`:

```js
// gallery/main.js (Vite)
const modules = import.meta.glob('../src/**/*.story.*', { eager: true })
// map 'components/Button/Primary' → module.Primary, then
// window.mount = ({ story, props }) => render(stories[story](props), document.getElementById('root'))
```

Playwright ships the whole methodology as an agent skill that scaffolds the gallery for your stack: `npx playwright init-skills`. The tests, the reporter configuration, and every rprtr feature in this example stay exactly the same.

## FAQ

- **`Error: Process from config.webServer was not able to start`** — the gallery port (5173) is in use or the command failed. Run `bun run gallery` manually to see errors; `reuseExistingServer: true` lets Playwright reuse an already-running gallery.
- **Unknown story `…`** — `window.mount` rejects unknown ids (by design); the error lists every known story id. Check the id against `gallery/registry.js`.
- **Visual tests fail on a brand-new machine** — you're likely on a new platform suffix (e.g. first linux run without `-linux` baselines). Run once to write them, or `bun run update-snapshots`.
- **Diffs appear everywhere after an intentional redesign** — use ▶↻ (run & update) or Approve All, then commit the regenerated `*-snapshots/` directories.
