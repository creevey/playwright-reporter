# Manual Smoke Test Guide: Docker Mode in an External Project

This guide verifies the Docker browser-execution harness (`DockerLauncher`, `--run-mode docker`)
end-to-end from a **real consumer project's** perspective — the thing the CI-gated
`tests/docker-smoke.test.ts` automates, done by hand so you can inspect every intermediate state.

Each scenario lists steps and explicit pass criteria. Run them in order; later scenarios reuse the
project scaffolded in Setup.

## Prerequisites

- Docker Desktop (macOS/Windows) or Docker Engine (Linux) installed and the **daemon running**:
  `docker info` exits 0.
- Node.js 20+ and npm (the default MS Playwright image only guarantees `npx` in-container).
- This repo checked out at the commit under test.
- ~1–2 GB disk for the `mcr.microsoft.com/playwright:*-noble` image pull.

## Setup: build, pack, and scaffold the external project

```bash
# 1. In the crvy-rprtr repo: build dist/ and create a tarball
bun run build
npm pack                          # produces crvy-rprtr-<version>.tgz

# 2. Create the external project somewhere OUTSIDE the repo
mkdir -p /tmp/crvy-smoke/tests && cd /tmp/crvy-smoke
npm init -y
npm install /Users/ki/Projects/creevey/crvy-rprtr/crvy-rprtr-*.tgz @playwright/test
```

> Do **not** run `npx playwright install` — the point of docker mode is that the container's
> bundled browsers are used. If the host has browsers installed already that's fine; the harness
> must never reference them (`PLAYWRIGHT_BROWSERS_PATH` is denylisted).

```ts
// /tmp/crvy-smoke/playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  reporter: [['@crvy/rprtr']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
```

```ts
// /tmp/crvy-smoke/tests/basic.spec.ts
import { expect, test } from '@playwright/test'

test('smoke passes', () => {
  expect(1 + 1).toBe(2)
})
```

Note the installed Playwright version (`npm ls @playwright/test`) — the harness derives the image
tag `mcr.microsoft.com/playwright:v<version>-noble` from it.

---

## S1 — First run in explicit docker mode (image pull + round-trip)

**Steps**

```bash
cd /tmp/crvy-smoke
npx crvy-rprtr --run-mode docker --port 4321
# In another shell:
curl -X POST http://localhost:4321/api/run -H 'Content-Type: application/json' -d '{}'
# Poll until tests reach a terminal status:
curl -s http://localhost:4321/api/report | jq '{runMode, tests}'
```

Open `http://localhost:4321` in a browser to watch the UI during the first run.

**Pass criteria**

- First run only: UI shows the **pulling** phase (run controls disabled, progress text) while
  `docker pull mcr.microsoft.com/playwright:v<version>-noble` downloads. Server log/WS shows
  `phase: 'pulling'`.
- UI mode badge shows `docker · mcr.microsoft.com/playwright:v<version>-noble`.
- Report JSON: `"runMode": "docker"`, the test reaches `status: "success"`.
- The container-side reporter connected back over `host.docker.internal` — proven implicitly by
  any live status updates at all; if it failed you'd see a running-but-silent report.
- Server console shows **no** warn-and-fallback lines (explicit mode never falls back).

## S2 — Container lifecycle: naming, mounts, env, cleanup

**Steps**

```bash
# While a run is in flight (re-trigger S1 and be quick, or use a slower test):
docker ps --filter name=crvy-rprtr-run --format '{{.Names}}  {{.Image}}  {{.Mounts}}'
docker inspect crvy-rprtr-run-* --format '{{json .Config.Env}}' | jq
# After the run finishes:
docker ps -a --filter name=crvy-rprtr-run   # must be EMPTY
```

**Pass criteria**

- Container named `crvy-rprtr-run-<pid of server>`.
- Mounts include `<project dir>:/work:rw` (and a `<path>:<path>:ro` mount for `--test-list`
  tmpfiles when running filtered subsets).
- Env contains `CRVY_RPRTR_SERVER_URL=ws://host.docker.internal:4321`,
  `CRVY_RPRTR_PORTABLE_ARTIFACTS=1`, `TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`,
  `PLAYWRIGHT_HTML_OPEN=never`.
- Env does **not** contain `CI` or `PLAYWRIGHT_BROWSERS_PATH` (denylist works).
- After the run: container is gone (`--rm` + no orphans).

## S3 — Portable artifacts (no container paths in the report)

Trigger a **failing** screenshot test to force attachment emission:

```ts
// /tmp/crvy-smoke/tests/visual.spec.ts
import { expect, test } from '@playwright/test'

test('visual mismatch', async ({ page }) => {
  await page.setContent('<h1>hello docker</h1>')
  await expect(page).toHaveScreenshot('hero.png') // no baseline yet → fails
})
```

```bash
curl -X POST http://localhost:4321/api/run -H 'Content-Type: application/json' -d '{}'
sleep 15; curl -s http://localhost:4321/api/report | jq '.. | .image? // empty' | sort -u
ls /tmp/crvy-smoke/screenshots/
```

**Pass criteria**

- Image URLs in report.json are **relative** `screenshots/...` paths (portable mode), never
  `/file/<container-path>` or anything containing `/work/`.
- PNG files physically exist under the host's `/tmp/crvy-smoke/screenshots/` (bind mount worked).
- Images render in the browser UI (served via the existing `/screenshots` route).

## S4 — Stop and force-kill paths

**Steps**

```bash
# Start a run, then immediately stop it from the UI (Stop button) or:
# (run must still be in progress)
curl -X POST http://localhost:4321/api/stop     # or the UI Stop button
docker ps -a --filter name=crvy-rprtr-run       # check repeatedly for ~10s
# Then kill -9 the server mid-run to exercise dispose/force-kill:
kill -9 <server-pid>
docker ps -a --filter name=crvy-rprtr-run
```

**Pass criteria**

- Graceful stop: container exits within the 5s grace window (SIGTERM proxied to container PID 1
  via `--init`); no orphaned container afterwards.
- Hard kill: `onForceKill()` issues best-effort `docker rm -f crvy-rprtr-run-<pid>` — no orphaned
  container after server death either. (If the server dies before spawning, nothing to clean —
  also fine.)

## S5 — Run & update baselines (update flow)

**Steps**

1. UI: click the split **Run & update baselines** action (▶↻) — or:
   `curl -X POST .../api/run -d '{"update": true}'`
2. `git status` / `ls` the project's snapshot dir (default: `tests/visual.spec.ts-snapshots/`).

**Pass criteria**

- Server appends `--update-snapshots` (visible in server debug output / spawned args).
- New baseline PNGs land on the **host** filesystem (rw bind mount), named per Playwright's
  `<name>-chromium-linux.png` convention — note `-linux`, not `-darwin`: proof the screenshot was
  taken in-container.
- A subsequent normal run passes against those baselines.

## S6 — Approve flow unchanged

**Steps**

1. Make the visual test fail again (change the `<h1>` text), run, open the UI diff view.
2. Click **Approve** on the failed test.
3. Re-run.

**Pass criteria**

- Approval writes the baseline on the host (via the server, not the container).
- The next containerized run immediately sees the approved baseline through the mount and passes.
- No `docker`-specific errors in server logs during approval — routing is mode-agnostic.

## S7 — `docker-unavailable` refusal (explicit mode, daemon down)

**Steps**

```bash
# Quit Docker Desktop / stop the daemon, keep the server from S1 running (or restart it):
npx crvy-rprtr --run-mode docker --port 4321 &
curl -X POST http://localhost:4321/api/run -H 'Content-Type: application/json' -d '{}'
```

**Pass criteria**

- Server **starts fine** — report viewing of previous results still works.
- `/api/run` responds `200` with body `{ "ok": false, "reason": "docker-unavailable" }`.
- Restarting the daemon and re-POSTing succeeds (prepare re-probes after failure — no server
  restart needed).

## S8 — Auto mode fallback (daemon down)

**Steps**

```bash
# Daemon still down:
npx crvy-rprtr --run-mode auto --port 4322
```

**Pass criteria**

- Server console prints a `console.warn` about Docker being unavailable and falling back to local.
- UI badge shows `local` **with a warning state** ("screenshots may differ from CI").
- Runs execute locally and pass (host must have browsers for this — otherwise expect Playwright's
  "browser not installed" error surfaced through the normal run-failure path).

## S9 — Auto mode on CI is silently local

```bash
CI=true npx crvy-rprtr --run-mode auto --port 4323   # daemon can be up or down
```

**Pass criteria**: badge shows `local`, **no** fallback warning, runs never touch Docker
(`docker ps` stays empty during a run).

## S10 — Custom image + package-manager detection

```bash
# In a copy of the project with a pnpm lockfile:
cd /tmp/crvy-smoke && rm package-lock.json && pnpm install   # creates pnpm-lock.yaml
npx crvy-rprtr --run-mode docker \
  --docker-image your-registry/playwright-with-pnpm:v1.59.0-noble --port 4324
```

**Pass criteria**

- Container-side invocation is `pnpm exec playwright ...` (check server logs or
  `docker inspect <name> --format '{{json .Config.Cmd}}'` mid-run).
- With a lockfile whose PM is missing from the image: run fails with the PM's "command not found"
  surfaced through the normal child-exit path — that failure mode is acceptable and documented.
- With no detectable lockfile: server warns "Could not detect a package manager... falling back to
  npx."

## S11 — Platform pinning (Apple Silicon → amd64 parity)

```bash
npx crvy-rprtr --run-mode docker --docker-platform linux/amd64 --port 4325
```

**Pass criteria**

- `docker inspect` mid-run shows `"Platform": "linux/amd64"`; run passes (slower under QEMU is
  expected).
- Baselines from this run carry the same pixel identity as an amd64 CI runner (compare a hash
  against a CI-produced baseline if you have one).

## S12 — Reporter resolution from outside the project

**Steps**: delete `node_modules/@crvy/rprtr` from the external project and instead run the server
from the repo's own `dist/cli.js` (so the `--reporter` path resolves outside `ctx.cwd`):

```bash
node /Users/ki/Projects/creevey/crvy-rprtr/dist/cli.js --run-mode docker --port 4326
curl -X POST http://localhost:4326/api/run -d '{}'
```

**Pass criteria**: the spawned container command uses the **bare specifier** `--reporter
@crvy/rprtr` (resolvable from the packed dependency the container's npm sees), not a host
absolute path; run passes. A `--config` path outside the project logs the "will not resolve
inside the container" warning.

---

## Troubleshooting

| Symptom                                       | Likely cause                                 | Check                                                                                                                             |
| --------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Run starts, no test events ever arrive        | Reporter can't reach host                    | `CRVY_RPRTR_SERVER_URL` in `docker inspect`; on Linux confirm `--add-host host.docker.internal:host-gateway` is in the arg vector |
| `docker-unavailable` despite running daemon   | Server started before daemon                 | Re-POST `/api/run` — prepare re-probes                                                                                            |
| First run appears stuck                       | Image pull (hundreds of MB)                  | UI should show `pulling`; `docker images` grows                                                                                   |
| 404s for images in UI                         | Non-portable absolute paths leaked           | report.json image URLs must be relative `screenshots/...`                                                                         |
| Baselines written but next run can't see them | Snapshot dir outside project root            | Approve routing resolves under `configDir`; keep snapshots under the bind-mounted cwd                                             |
| `webServer` tests fail in container           | Server bound to `127.0.0.1` or host-only URL | Bind `0.0.0.0`; hosts must resolve in the container network namespace                                                             |
| Linux: permission errors on written artifacts | Container root vs host UID                   | Pass `--user $(id -u):$(id -g)` via `docker.extraArgs` (programmatic API)                                                         |

## Cleanup

```bash
docker ps -aq --filter name=crvy-rprtr-run | xargs -r docker rm -f
docker image rm mcr.microsoft.com/playwright:v<version>-noble   # optional
rm -rf /tmp/crvy-smoke
```
