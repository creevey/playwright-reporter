# Docker Browser Execution Design

**Date:** 2026-08-05
**Topic:** Let Crvy Rprtr execute Playwright runs inside a pinned Docker container so users get reproducible screenshot baselines across machines without installing browsers or system dependencies locally.

## Overview

Today the RunController (`src/server/run-controller.ts`) spawns `playwright test` as a host child process. Screenshot output then depends on the host's OS, fontconfig, font set, locale, timezone, and Chromium build — so baselines generated on one machine flake on another. Crvy Rprtr is a visual-regression tool, so this drift undermines its core value proposition.

This design adds a Docker execution mode: the server still runs natively on the host, but the RunController delegates child-process construction to a new `RunLauncher` unit. The Docker launcher wraps the same `playwright test` invocation in `docker run --rm` against the official Microsoft Playwright image pinned to the user's installed `@playwright/test` version. The reporter inside the container connects back to the host server over `host.docker.internal` and emits portable (relative-path) artifacts. Baseline approval keeps working unchanged because the project directory is bind-mounted read-write into the container.

## User Story

As a developer running screenshot tests locally, I want the browsers to execute inside the same pinned container image my CI uses, so that baselines I generate or approve locally match CI pixel-for-pixel — without installing Playwright browsers, system libraries, or matching fonts on my machine, and without leaving the Crvy Rprtr review UI.

## Background: verified facts

- **The spawn backend is already injectable.** `RunControllerDeps` exposes `spawn: SpawnLike` and `resolveLaunch` (`src/server/run-controller.ts:32-57`), and the controller lifecycle (`start/stop/dispose/handleChildExit`) is agnostic to what is spawned. `docker run --rm` propagates the wrapped process's exit code and forwards SIGTERM to the container's PID 1, so the existing child semantics carry over.
- **The reporter's server URL is env-driven.** `CrvyRprtrOptions.serverUrl` falls back to `process.env.CRVY_RPRTR_SERVER_URL` (`src/reporter.ts:60`), and `buildSpawnEnv` (`src/server/run-controller.ts:152-161`) sets it to `ws://localhost:<port>`. Inside a container, `localhost` does not reach the host; `host.docker.internal` does on Docker Desktop (macOS/Windows) natively and on Linux with `--add-host=host.docker.internal:host-gateway`.
- **`ci: true` is not a portable-artifacts switch.** It additionally forces offline mode (`src/reporter.ts:69`) and skips the WebSocket connection entirely (`src/reporter.ts:75-78`). Docker mode needs the _opposite_ combination: live connection plus portable artifacts. The portable path already exists as `saveAttachments` (`src/reporter-artifact-ops.ts:51-91`), which copies PNG attachments into `screenshotDir` and emits relative `<testId>/<name>` paths served by the existing `/screenshots` route.
- **The installed Playwright version is resolvable from the project.** `resolvePlaywrightVersion(cwd)` (`src/server/run-controller.ts:100-111`) reads `@playwright/test/package.json`. The official image tag convention is `mcr.microsoft.com/playwright:v<version>-noble`, matching this repo's own CI (`.github/workflows/ci.yml:73`).
- **Package-manager detection is already a dependency.** `resolvePlaywrightLaunch` (`src/server/run-controller.ts:73-78`) uses `package-manager-detector`'s `resolveCommand(agent, 'execute-local', ...)`; the library's async `detect` reads lockfiles and can run inside an async `prepare()` step even though `start()` is synchronous.
- **The repo's own CI already runs Playwright in the official container** with `--ipc=host` (`.github/workflows/ci.yml:72-74`), which is Microsoft's recommended flag for Chromium shared-memory stability.
- **`buildSpawnEnv` already strips `CI`** from the child environment (`src/server/run-controller.ts:155`). This matters doubly in Docker mode: it keeps the reporter's `isCI()` check (`src/ci.ts`) false inside the container, preserving the live WebSocket connection.
- **`isCI()` exists as a shared helper** (`src/ci.ts`) and is the natural gate for "auto mode runs local on CI".
- **Approvals write baselines on the server's filesystem.** The `/api/approve` handler resolves targets via `approvalRouting` rooted at `configDir`/`playwrightSnapshotDir` (`src/server/routes-context.ts:31-37`). When the snapshot directory lives under the project root, a read-write bind mount makes host-written baselines immediately visible inside the container.
- **The run API is minimal and additive-friendly.** `RunRequestBodySchema` (`src/schemas/http.ts:22-24`) is `{ tests?: [...] }`; `RunResponseSchema.reason` is an enum (`src/schemas/http.ts:28-34`). Both tolerate additive extension without breaking older clients.

## Goals

1. Run Playwright browsers inside a pinned Docker container with zero local browser/system-dependency installation.
2. Eliminate platform flakiness for screenshot baselines by pinning OS, Chromium revision, fonts, locale, and timezone.
3. Keep the review loop seamless: Start/Stop/update-baselines from the existing UI, live WebSocket updates, approve flow untouched.
4. Default to `auto` mode: Docker when available, local on CI, warned local fallback otherwise.
5. Allow custom images and container-side package managers (pnpm/yarn/bun) without crvy-rprtr publishing any image.
6. Cover all new behavior with `bun:test` unit tests plus one CI-gated real-Docker smoke test.

## Non-Goals

1. Running the crvy-rprtr server itself inside a container (server-in-container topology). Deferred; the host-server topology keeps `npx crvy-rprtr` UX unchanged.
2. Persistent warm containers or run queuing. Each run is a fresh `docker run --rm`.
3. Publishing or maintaining derived images (e.g. MS base + Bun). Users who need Bun inside the container supply their own image via `docker.image` + `docker.command`.
4. Running crvy-rprtr's own e2e suite in Docker mode (dogfooding). User-facing feature only in v1.
5. Remote Docker daemons, docker-compose orchestration, or Kubernetes execution.
6. Windows host path normalization beyond correct `-v` mount syntax; documented as a known-limitation area to validate.

## Scope and Operating Context

### Decision D1 (accepted): Host-server topology

The server runs natively on the host; only `playwright test` executes in a container. Rejected alternative: server-in-container bring-up, which aligns all paths naturally but inverts the current UX (users would mount their project into a server container and the native `npx crvy-rprtr` flow would disappear). Host-server keeps the existing contract; the one cost — container-local absolute paths leaking into the report — is neutralized by portable artifacts (D7).

### Decision D2 (accepted): `auto` default, local on CI, warned fallback

`runMode` defaults to `'auto'`. Resolution at startup:

- `isCI()` → LocalLauncher, silently. CI runners already execute inside the pinned image; Docker-in-Docker adds nothing.
- Daemon reachable (`docker info` probe) → DockerLauncher.
- Daemon unreachable → LocalLauncher + `console.warn` + one-time WebSocket notice so the UI can badge the fallback ("screenshots may differ from CI").

Explicit `'docker'` mode with an unreachable daemon does not fall back: the server still starts (report viewing works), but `/api/run` returns `{ ok: false, reason: 'docker-unavailable' }` until a retry succeeds.

### Decision D3 (accepted): npx by default, PM-aware for custom images

Container-side invocation resolves in order:

1. `docker.command` set → used verbatim (e.g. `['pnpm', 'exec', 'playwright']`).
2. Default MS image → `npx playwright` (the only invoker guaranteed present).
3. Custom `docker.image`, no command → async lockfile detection at `cwd` during `prepare()` via `package-manager-detector`, mapped to `npx` / `pnpm exec` / `yarn` / `bunx`; unresolvable → `npx` + warning.

Documentation states: overriding `docker.image` means the image must contain the resolved package manager.

### Decision D4 (accepted): User-facing only

v1 targets users' projects. The repo's own `tests/e2e` suite keeps running natively; its `webServer` fixtures would need container-reachability work that is out of scope.

### Decision D5 (accepted): In-UI baseline updates

The Run control gains a "Run & update baselines" action that POSTs `{ update: true }`; the server appends `--update-snapshots` to the Playwright args. Regenerated baselines land on the host filesystem via the bind mount. A manual `docker run … --update-snapshots` recipe is also documented but is not the primary path.

### Decision D6 (accepted): Launcher strategy unit

A new `RunLauncher` unit owns launch-command and environment construction, with `LocalLauncher` (today's behavior) and `DockerLauncher` implementations. RunController delegates to it. Rejected alternatives: branching inside `RunController.start` (buries docker arg-building, weakens testability) and swapping only the `spawn`/`resolveLaunch` deps (leaves `buildSpawnEnv` mode-blind, so the WebSocket URL stays `localhost` and the callback breaks).

### Decision D7 (accepted): Portable artifacts via reporter env flag, not `ci`

DockerLauncher sets `CRVY_RPRTR_PORTABLE_ARTIFACTS=1` in the container. The reporter reads it in its constructor next to the existing `CRVY_RPRTR_SERVER_URL` read. When set: the WebSocket connection stays live, but attachments are copied into `screenshotDir` with relative paths (`saveAttachments` behavior) instead of absolute-path `/file/` references. This deliberately does not reuse `ci: true`, which would force offline mode and sever the live connection.

### Decision D8 (accepted): Platform explicit-only, arch warning documented

`--platform` is passed only when `docker.platform` is configured; otherwise the container runs the host's native architecture. Docs warn that baselines are architecture-specific: baselines generated on arm64 (Apple Silicon native) must not be shared with amd64 CI. Teams that need cross-machine parity pin `platform: 'linux/amd64'` and accept emulation cost.

### Decision D9 (accepted): Named containers for reliable cleanup

Every run container is named `crvy-rprtr-run-<pid>`. The force-kill path (SIGKILL after the existing 5s grace) additionally issues a best-effort `docker rm -f <name>`, because killing the `docker run` CLI alone can orphan a live container. `dispose()` on server shutdown uses the same path.

## Architecture and Data Flow

```
┌─ Host ─────────────────────────────────────────────────────┐
│ Browser UI ──POST /api/run {tests?, update?}──► Server     │
│                  ◄──WS run-status/progress──   (native)    │
│                                                   │        │
│                                            RunController   │  (lifecycle unchanged)
│                                                   │        │
│                                            RunLauncher     │  ← selected at startup
│                                             ┌─────┴──────┐ │
│                                     LocalLauncher  DockerLauncher
└────────────────────────────────────────────┼─────────────┼─┘
                                             │ spawns      ▼
   ┌─ Container (mcr.microsoft.com/playwright:v<pw-version>-noble) ────────┐
   │  <pm> playwright test --config … --reporter @crvy/rprtr [--update-snapshots] │
   │  env: CRVY_RPRTR_SERVER_URL=ws://host.docker.internal:<port>          │
   │       CRVY_RPRTR_PORTABLE_ARTIFACTS=1                                 │
   │       TZ=UTC LANG=C.UTF-8 LC_ALL=C.UTF-8                              │
   │  mounts: <cwd> → /work (rw)                                           │
   └──────────────┬────────────────────────────────────────────────────────┘
                  │ WS test events (live, unchanged protocol)
                  ▼ host server handlers → report state → UI
```

Three flows stay intact:

1. **Live reporting.** The reporter in the container connects to the host server via `host.docker.internal`; the WebSocket protocol is untouched.
2. **Artifacts.** Portable mode copies attachments into `screenshotDir` with relative URLs; the bind mount makes them host-visible; the existing `/screenshots` route serves them. No container paths leak into the report.
3. **Baselines.** Approve flow unchanged — the server writes baselines on the host filesystem under the project root, visible to the next containerized run through the mount. Update mode appends `--update-snapshots`; new baselines land on the host filesystem the same way.

## Components

### `RunLauncher` (new unit, e.g. `src/server/run-launcher.ts`)

```ts
interface LaunchSpec {
  cmd: string
  args: string[]
  env: Record<string, string | undefined> // complete env for spawn
}

interface RunLauncher {
  readonly mode: 'local' | 'docker'
  /** Docker: probe daemon, resolve image, pull if missing. No-op for local. */
  prepare?(onProgress: (phase: string) => void): Promise<void>
  launch(params: {
    ctx: RunContext
    playwrightArgs: string[] // --config, --reporter, filters, --update-snapshots
  }): LaunchSpec
  /** Docker: best-effort `docker rm -f <name>` for the SIGKILL/dispose path. */
  onForceKill?(): void
}
```

`RunController` asks the launcher for a `LaunchSpec` instead of calling `resolveLaunch` + `buildSpawnEnv` directly; both helpers fold into `LocalLauncher` with unchanged behavior. Everything else in the controller — refusal reasons, stop/grace/SIGKILL, exit handling, broadcasts — is untouched.

### `DockerLauncher.launch()` arg vector

```
docker run --rm --init
  --name crvy-rprtr-run-<pid>
  --add-host=host.docker.internal:host-gateway   # Linux requirement; harmless on Docker Desktop
  --ipc=host                                     # Chromium shm; matches repo CI
  [--platform linux/amd64]                       # only when configured (D8)
  -v <cwd>:/work:rw  -w /work
  -e CRVY_RPRTR_SERVER_URL=ws://host.docker.internal:<port>
  -e CRVY_RPRTR_PORTABLE_ARTIFACTS=1
  -e TZ=UTC -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8    # rendering pins
  -e <user env passthrough>
  <image>  <resolved pm invocation> <playwrightArgs>
```

Invariants:

- Host `PLAYWRIGHT_BROWSERS_PATH` is **never** propagated, and host browser caches are never mounted; the image's bundled browsers are always used.
- `CI` is stripped (existing behavior), which also keeps the reporter live inside the container.
- User env passthrough mirrors today's `buildSpawnEnv` semantics (all of `process.env` minus `CI`), expressed as `-e KEY` flags.

### Image resolution

`docker.image` override wins; otherwise `mcr.microsoft.com/playwright:v<installed @playwright/test version>-noble` via the existing `resolvePlaywrightVersion(cwd)`; if the version is unresolvable, `prepare()` fails with an actionable error telling the user to set `docker.image` explicitly (the registry has no reliable floating tag to fall back to). `prepare()` runs `docker image inspect` and `docker pull` when missing, emitting progress.

### Mode resolution

Computed once at server startup in `createServerApp` from `runMode`, `isCI()`, and the `docker info` probe (D2); the selected launcher is stored and reused for every run.

## Configuration Surface

| Surface                                  | Addition                                                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServerOptions` (`src/server/app.ts:34`) | `runMode?: 'local' \| 'docker' \| 'auto'` (default `'auto'`); `docker?: { image?: string; platform?: 'linux/amd64' \| 'linux/arm64'; command?: string[]; extraArgs?: string[] }`                         |
| CLI (`src/cli.ts`)                       | `--run-mode <m>`, `--docker-image <img>`, `--docker-platform <p>`. `command`/`extraArgs` remain programmatic-only, matching the existing approval-routing options pattern (README "Server CLI Options"). |
| Reporter options                         | None. Docker mode is server-driven; the reporter only reads the new env var.                                                                                                                             |

## API and UI Changes

- `RunRequestBodySchema` += `update?: boolean`.
- `RunResponseSchema` reason enum += `'docker-unavailable'`.
- WS `run-status` payload extended additively: `{ running: boolean, mode: 'local' | 'docker', phase?: 'pulling' }`; older clients ignore the new fields.
- UI (`src/client/App.svelte` + Sidebar component): mode badge next to the Run controls (`docker · <image>` or `local`), a warning state for the auto-fallback, a split Run action (**Run** / **Run & update baselines**), and disabled controls with progress text while `phase === 'pulling'`.
- Approve flow: zero changes.

## Error Handling and Lifecycle

- **Explicit docker + daemon down:** server starts; runs refused with `docker-unavailable` until retry succeeds. Report viewing never degrades.
- **Pull failure:** run fails before spawn; UI exits `pulling` into an error notice; no child, no container.
- **Stop:** SIGTERM to the `docker run` child; Docker proxies it to the container's PID 1 (`--init` guarantees a real init). Existing 5s grace timer unchanged.
- **Force kill / dispose:** SIGKILL plus `launcher.onForceKill()` → `docker rm -f crvy-rprtr-run-<pid>` best-effort (D9).
- **Exit codes:** `docker run --rm` propagates Playwright's code; existing `handleChildExit` warn-and-broadcast path unchanged.

## Platform-Flakiness Guards

| Drift source                        | Pin                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| Chromium revision                   | Image tag derived from installed `@playwright/test` version                         |
| OS / fontconfig / fonts             | Ubuntu Noble base image                                                             |
| Locale-driven text/number rendering | `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`                                                    |
| Timezone-driven UI                  | `TZ=UTC`                                                                            |
| Browser binaries                    | Image-bundled only; host cache never mounted/propagated                             |
| Architecture                        | Native by default; explicit `docker.platform` + documented arch-specificity warning |

The `TZ`/`LANG`/`LC_ALL` pins are user-overridable: `docker.extraArgs` flags are appended last, and later `-e` flags win.

## Testing Strategy

All coverage uses the repo's existing `bun:test` setup; no new tooling.

- **Unit — DockerLauncher:** golden tests for the full arg vector (mounts, add-host, ipc, name, env set/passthrough/filtering, platform presence/absence); container-command resolution (default npx / per-lockfile PM mapping / explicit `command`); image resolution (override / version-derived / fallback warning).
- **Unit — mode resolution:** the `runMode × isCI × daemon` matrix, including explicit-docker-unavailable.
- **Unit — reporter:** `CRVY_RPRTR_PORTABLE_ARTIFACTS=1` keeps the WebSocket live and emits relative-path attachments (fixture asserting path shape).
- **Unit — schemas:** `update` passthrough; `docker-unavailable` round-trip.
- **Controller integration:** fake `SpawnLike` asserting the spawned command is the docker invocation; stop → SIGTERM then SIGKILL + `docker rm -f`; exit-code propagation to `run-status` broadcast.
- **Smoke e2e (CI-gated):** one real Docker run on the GitHub Actions ubuntu runner — a trivial fixture project, Chromium only — asserting a test event round-trips over `host.docker.internal`. Guarded by an env flag so forks without Docker skip cleanly.

## Risks and Open Questions

1. **Apple Silicon emulation.** `linux/amd64` under QEMU is slower and can render subtly differently from native amd64; mitigated by D8's native-arch default plus documentation, at the cost of making arch discipline the user's responsibility.
2. **`webServer` in user configs.** A user's Playwright `webServer` now starts inside the container; it must bind `0.0.0.0`, and hosts it references must resolve in the container's network namespace. Documented setup step (mirrors the `extra_hosts` host-gateway pattern); not auto-handled in v1.
3. **First-run image pull** is hundreds of MB; surfaced through the `pulling` phase so the UI can show progress instead of appearing stuck.
4. **UID mismatches** on Linux bind mounts (host user vs container root) may require `--user`; `docker.extraArgs` is the escape hatch, documented.
5. **Windows volume syntax** (`C:\…` vs `/c/…`) needs validation; listed in Non-Goals as a known-limitation area, not silently assumed working.
