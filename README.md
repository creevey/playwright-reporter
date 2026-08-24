# @crvy/rprtr

Playwright reporter with a visual regression UI for comparing and approving screenshot test diffs.

> **Pronunciation:** `crvy` sounds like "creevey," not "curvy."

## Installation

```bash
npm install --save-dev @crvy/rprtr
```

> **Requires:** Playwright ≥1.40, plus **Node 22+ or Bun** for the live UI server/CLI. You can install the package with npm, pnpm, yarn, or Bun.

## Setup

Add the reporter to your `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [['@crvy/rprtr', { screenshotDir: './screenshots' }]],
})
```

## Viewing Results

Start the UI server to view and approve screenshot diffs:

```bash
npx crvy-rprtr
```

Other package-manager launchers work too: `pnpm dlx crvy-rprtr`, `yarn dlx crvy-rprtr`, and `bunx crvy-rprtr`.

Open http://localhost:3000 in your browser.

Every test run also writes a browser-openable static artifact:

- `./crvy-rprtr.html`

Open `crvy-rprtr.html` directly from CI artifacts or your filesystem to review results without starting a server. The static artifact is self-contained except for screenshot image files, and it is read-only; use the server-backed UI to approve screenshots.

To open downloaded CI artifacts with the full approval UI, point the CLI at the artifact directory:

```bash
npx crvy-rprtr ./artifacts
```

## Reporter Options

| Option                                   | Type     | Default                        | Description                                                                                            |
| ---------------------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `serverUrl`                              | `string` | `"ws://localhost:3000"`        | WebSocket URL of the Crvy Rprtr server                                                                 |
| `screenshotDir`                          | `string` | `"./screenshots"`              | Directory for saving screenshot artifacts                                                              |
| `offlineReportPath`                      | `string` | `"./crvy-rprtr-{worker}.json"` | Path for offline report when server is unavailable                                                     |
| `reportHtmlPath`                         | `string` | `"./crvy-rprtr.html"`          | Path for the browser-openable static report HTML                                                       |
| `playwrightSnapshotDir`                  | `string` | `undefined`                    | Override the Playwright snapshot directory used for passed-baseline display lookup                     |
| `playwrightSnapshotPathTemplate`         | `string` | `undefined`                    | Mirror Playwright `snapshotPathTemplate` for passed-baseline display resolution                        |
| `playwrightToHaveScreenshotPathTemplate` | `string` | `undefined`                    | Mirror Playwright `expect.toHaveScreenshot.pathTemplate` for passed-baseline display; takes precedence |

## Server CLI Options

```bash
npx crvy-rprtr [artifact-dir] [options]
```

If `artifact-dir` is provided, the CLI treats it as the directory containing:

- `report.json`
- `screenshots/`
- `crvy-rprtr-*.json`

Explicit flags override the paths derived from `artifact-dir`.

| Option             | Short | Default         | Description                                                                                                                                                                                        |
| ------------------ | ----- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port`           | `-p`  | `3000`          | Server port                                                                                                                                                                                        |
| `--screenshot-dir` | `-s`  | `./screenshots` | Screenshot directory path                                                                                                                                                                          |
| `--report-path`    | `-r`  | `./report.json` | Report JSON file path or directory containing `report.json` and `crvy-rprtr-*.json` files                                                                                                          |
| `--config`         | `-c`  | auto-detect     | Playwright config path used to enable the run buttons at startup. When omitted, the server discovers `playwright.config.*` in the working directory. A registering reporter always overrides this. |

When the server can resolve a Playwright config (via `--config` or auto-discovery, or once a reporter registers), the sidebar shows Start/Stop and per-test run buttons that trigger `playwright test` without leaving the browser. Approval-routing resolver overrides are available through the programmatic server API, not additional CLI flags.

## How It Works

1. **During test runs:** The Playwright reporter sends test results to the server via WebSocket in real-time and records the same run for artifact export.
2. **After tests complete:** A static `crvy-rprtr.html` artifact is written for direct browser viewing, and offline report JSON is also written if the server was unavailable.
3. **In the browser:** The UI shows all screenshot tests with side-by-side, swap, slide, and blend diff views.
4. **Approving changes:** Start the UI server and click "Approve" or "Approve All" to accept a new screenshot as the baseline. Approval uses the same exact Playwright-aware resolver as passed-baseline display, including default layouts, unnamed screenshots, duplicate names, and custom templates when the running server was started with matching resolver options. Those approval-routing options are read from the server startup path, not from reporter options. If the server starts without explicit resolver overrides, approval falls back to the server defaults instead. If Crvy Rprtr cannot determine exactly one target path, it leaves the image unresolved instead of guessing.

## Offline Mode

When the server isn't running during tests, the reporter automatically falls back to offline mode:

- Test events are queued in memory
- On test completion, events are written to `crvy-rprtr-{index}.json`
- On test completion, a self-contained `crvy-rprtr.html` is written for direct browser review
- When the server starts, it loads and merges all `crvy-rprtr-*.json` files from the offline report directory

## Passed Screenshot Modes

Crvy Rprtr keeps passed Playwright screenshot assertions visible in two fallback modes when Playwright does not emit a full passing comparison payload:

- `baseline-only`: Crvy Rprtr resolved the exact expected snapshot path and copied that baseline into the screenshot directory, so the UI can show the stored baseline.
- `declared-only`: the screenshot assertion was detected, but Crvy Rprtr could not resolve one exact snapshot file and therefore keeps the honest text-only fallback.

Exact resolution mirrors Playwright's screenshot naming and template rules for default layouts, unnamed screenshots, and explicitly configured custom templates. For slash-containing named screenshot titles, Crvy Rprtr may check both Playwright-equivalent variants and only uses a baseline when exactly one candidate wins.

Crvy Rprtr does not auto-read Playwright config for snapshot template discovery. If your suite uses a custom snapshot layout, pass the matching `playwrightSnapshotDir`, `playwrightSnapshotPathTemplate`, or `playwrightToHaveScreenshotPathTemplate` reporter options explicitly for passed-baseline display.

Approval routing uses the same resolver, but it reads its resolver settings from the server startup path today. The current user-facing place to pass those overrides is `startServer({...})`, via options such as `configDir`, `playwrightTestDir`, `playwrightSnapshotDir`, `playwrightSnapshotPathTemplate`, and `playwrightToHaveScreenshotPathTemplate`. The CLI does not expose flags for those overrides, so `npx crvy-rprtr` uses the server defaults when they are omitted. For slash-containing named screenshot titles, Crvy Rprtr only updates the baseline when one exact Playwright-equivalent target can be determined.

When the server is running, Crvy Rprtr also refreshes the UI after report JSON or screenshot artifacts change on disk.

## Cross-OS Artifact Loading

Crvy Rprtr stores image URLs exactly as the reporter that produced them saw them. In live mode (server running during the test run), failure artifacts are referenced by absolute path under `/file/<encoded>`; in CI/offline mode, attachments are copied into `screenshots/` and referenced by relative path under `/screenshots/`.

If you generate a report on one operating system and then open it on another (for example, downloading a Windows CI runner's `report.json` onto a macOS laptop), absolute-path `/file/...` URLs cannot resolve: the file is not on your filesystem. Crvy Rprtr logs a single diagnostic line per such request and returns 404. The `/screenshots/...` and `/baseline/...` URLs remain portable because they resolve through the server's `screenshotDir` or snapshot resolver.

For fully portable artifact loading across operating systems, run the reporter in CI mode (`ci: true`) and ship the `screenshots/` directory alongside the report JSON.

## Docker Mode

Run Playwright browsers inside a pinned Docker container so screenshot baselines are reproducible across machines — no local browser or system-dependency installation required.

```bash
npx crvy-rprtr --run-mode docker
```

The server still runs on your host; only `playwright test` executes in the container, against the official `mcr.microsoft.com/playwright:v<your @playwright/test version>-noble` image with your project bind-mounted. Reporters stream results back live, and approve/update flows work unchanged.

| Mode             | Behavior                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `auto` (default) | Docker when a daemon is reachable, local on CI, warned local fallback otherwise |
| `docker`         | Always Docker; runs fail fast with `docker-unavailable` when the daemon is down |
| `local`          | Never Docker                                                                    |

| Option                         | Description                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--run-mode <mode>`            | `local`, `docker`, or `auto` (default: `auto`)                                                                                                                               |
| `--docker-image <image>`       | Custom image. With a custom image, the container-side package manager is auto-detected from your lockfile (`npx` / `pnpm exec` / `yarn` / `bunx`); the image must contain it |
| `--docker-platform <platform>` | `linux/amd64` or `linux/arm64` (default: host architecture)                                                                                                                  |

Programmatic equivalents: `startServer({ runMode: 'docker', docker: { image, platform, command, extraArgs } })`. `docker.command` overrides the container-side invocation verbatim (e.g. `['pnpm', 'exec', 'playwright']`); `docker.extraArgs` appends raw `docker run` flags.

### Windows

The recommended Windows setup is **WSL2**: enable Docker Desktop's WSL2 integration (Settings → Resources → WSL integration), keep the project inside the WSL filesystem (e.g. `~/proj` in your distro, not `/mnt/c/...` — bind-mounts from `/mnt/c` are slow and lack inotify events), and run `npx crvy-rprtr` from the WSL shell. Paths and rendering then behave exactly as on Linux, so baselines match CI.

Running natively on a Windows host (PowerShell/cmd) works but is **experimental**: Docker Desktop translates the `C:\proj:/work` mount, and crvy-rprtr rewrites Windows paths in container arguments, but this path has no CI coverage — expect a one-time experimental warning on the first run. Local (`--run-mode local`) Windows runs can never match Linux CI baselines (DirectWrite vs fontconfig text rendering) — which is exactly the problem Docker mode solves, so prefer WSL2.

Known limitations on native Windows: UNC project roots (`\\server\share\...`) are unsupported; drive-letter casing is normalized (`C:` ≡ `c:`); Windows-specific host env vars are forwarded into the container harmlessly.

Notes:

> **Important — baselines are image-specific, not architecture-specific.** Text rendering follows the image's fontconfig: Ubuntu-based images (including the default `mcr.microsoft.com/playwright:*-noble`) render text with subpixel (LCD) antialiasing and slight hinting, while Debian-based images (e.g. `node:24` + `playwright install --with-deps`) render grayscale with full hinting — different pixels _and_ slightly different text widths. Generate and verify baselines in the **same image** everywhere (CI and local), and regenerate baselines once after switching image flavor. See [docs/docker-screenshot-determinism.md](docs/docker-screenshot-determinism.md) for the full investigation.

- Baselines are **not** architecture-specific for typical DOM/text pages: amd64 and arm64 variants of the same image render bit-identically in practice (verified: 100/103 tests byte-identical between an amd64 CI runner and Apple Silicon). Use the native architecture on every host — do **not** pin `--docker-platform` to force amd64 emulation on Apple Silicon (Rosetta/QEMU is slower and less stable, and buys nothing). Residual risk: canvas 2D / complex SVG / WebGL content can show tiny cross-arch anti-aliasing diffs; handle per-test with `maxDiffPixels`.
- If your `playwright.config.ts` uses `webServer`, that server now starts inside the container: it must bind `0.0.0.0`, and hosts it references must resolve inside the container.
- Timezone and locale are pinned (`TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`) so date/number rendering in screenshots is stable; override via `docker.extraArgs` if you need a different locale under test.
- The "Run & update baselines" button (▶↻) regenerates baselines inside the container, keeping generation and verification in the same image.

## Programmatic API

```ts
import { startServer } from '@crvy/rprtr/server'

// reportPath can be a directory (will use report.json inside)
await startServer({
  port: 3000,
  screenshotDir: './screenshots',
  reportPath: './artifacts',
})

// Or a specific file path
await startServer({
  port: 3000,
  screenshotDir: './screenshots',
  reportPath: './artifacts/report.json',
})
```

If you need approval routing to follow a custom Playwright snapshot layout, pass the resolver options when starting the server programmatically:

```ts
await startServer({
  port: 3000,
  screenshotDir: './screenshots',
  reportPath: './artifacts',
  configDir: process.cwd(),
  playwrightTestDir: './tests',
  playwrightSnapshotDir: './tests/__screenshots__',
  playwrightToHaveScreenshotPathTemplate: '{snapshotDir}/{testFilePath}/{arg}{ext}',
})
```

The programmatic server API works in both Node 22+ and Bun.

## Development

```bash
bun install
bun run dev      # Start dev server with HMR
bun run build    # Build for production
bun run test     # Run tests
bun run lint     # Lint with oxlint
```

## License

MIT
