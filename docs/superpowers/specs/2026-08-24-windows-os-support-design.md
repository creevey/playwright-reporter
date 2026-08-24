# Windows OS Support Design

**Date:** 2026-08-24
**Topic:** Make Crvy Rprtr's Docker run mode work on Windows hosts: WSL2 as the recommended, documented path; native win32 fixed where cheap and clearly labeled experimental.

## Overview

The Docker run mode (`docs/superpowers/specs/2026-08-05-docker-browser-execution-design.md`) was designed and tested on POSIX hosts. Its original spec explicitly deferred "Windows host path normalization" as a known-limitation non-goal. Investigation on a native Windows host confirms the core mechanics work under Docker Desktop (WSL2 backend) — daemon probe, image pull, `--add-host host.docker.internal:host-gateway`, `--init`, `--ipc=host`, and `-v C:\proj:/work` mount translation all behave — but host→container path rewriting silently breaks on backslash paths, which corrupts `--config`, `--reporter`, and `--test-list` arguments.

This design fixes the three concrete code defects (separator-agnostic path rewrite, fixed container-side `--test-list` mount, POSIX separators in `--test-list` entries), adds a one-time "experimental" warning on native win32, and documents WSL2 as the recommended Windows workflow. Full native-Windows parity — including CI coverage of the docker mode on a Windows runner — stays out of scope: GitHub-hosted Windows runners cannot run Linux containers, and local-mode Windows can never match Linux CI rendering anyway (DirectWrite vs fontconfig), which is the very problem Docker mode exists to solve.

## User Story

As a developer on Windows, I want clear guidance and working behavior when I run Crvy Rprtr: a documented WSL2 workflow that gives me CI-identical baselines, and — if I run natively — a docker mode that actually launches instead of silently misbehaving, with an honest warning that the path is experimental.

## Background: verified facts

- **`rewriteContainerPath` compares paths as POSIX strings** (`src/server/docker-support.ts:139-143`): `path.startsWith(\`${mapping.from}/\`)`. On a win32 host, `ctx.cwd`is`C:\proj`and arg values are`C:\proj\pw.config.ts`— backslash prefixes never match, so the rewrite silently no-ops.`--config`reaches the container as an unreadable Windows path (plus the "outside the project directory" warning), and`--test-list`attempts a`C:\...:C:\...:ro` bind mount, invalid inside a Linux container.
- **The reverse direction already works.** Container→host rewrites (`src/server/handlers.ts:129-135`, `src/server/artifact-routes.ts:87`, `src/server/run-controller.ts:187`) take container paths (`/work/...`), which are always POSIX, so reporter registration, statuses, and approval routing survive on win32. Only the launch direction breaks.
- **The same function serves both directions.** `rewriteContainerPath` is the single chokepoint for host→container (via `rewritePlaywrightArgs`, `src/server/docker-launcher.ts:165`) and container→host rewriting, so fixing it fixes every call site at once.
- **`--test-list` uses a same-path bind mount** (`src/server/docker-launcher.ts:168-170`): the host tmpfile (from `os.tmpdir()`, `src/server/run-controller.ts:99-103`) is mounted `value:value:ro` and the flag value passed verbatim. This cannot work when the host path is not a valid container path; a fixed container-side target works uniformly on all platforms.
- **`buildTestListEntries` emits host separators** (`src/server/docker-support.ts:194-203`): `relative()` and `sep` produce backslashes on win32, but the file is consumed by Playwright inside a Linux container, which matches entries against POSIX paths. A latent third break, distinct from the mount issue. Local mode also uses `--test-list` (for `tests.length > 1`), so the separator fix must be gated on docker mode to avoid changing local behavior.
- **Docker Desktop translates the project mount itself.** `-v C:\proj:/work:rw` works without any path munging on our side; the host side of `-v` must stay native.
- **Cross-OS path helpers already exist as pure functions.** `src/path-utils.ts` injects the host platform rather than reading `process.platform`, and `tests/path-utils.test.ts` exercises win32 cases on Linux CI. The same testability pattern applies here.
- **GitHub-hosted Windows runners cannot run Linux containers** (no WSL2 backend / nested virtualization), so end-to-end docker-mode CI on Windows is not achievable with the current CI provider.
- **`docs/docker-manual-smoke-test.md:12` currently advertises "Docker Desktop (macOS/Windows)"** — an overpromise given the defects above; it needs correcting as part of this work.

## Goals

1. Native win32 host + `--run-mode docker` launches successfully for the common case: project under a drive-letter path (e.g. `C:\proj`), default or custom image, filtered and unfiltered runs.
2. WSL2 documented as the recommended Windows workflow (project in the WSL filesystem, Docker Desktop WSL2 integration enabled), with the rationale: identical paths/rendering to Linux CI.
3. Native win32 docker mode labeled experimental via a one-time warning at first `prepare()`.
4. All new path logic covered by platform-injected unit tests running on the existing Linux CI; no new CI infrastructure.
5. Docs corrected to match reality: README Windows section, smoke-test guide prerequisite line, known limitations.

## Non-Goals

1. Windows CI coverage (unit or smoke) on a real Windows runner — infeasible for docker mode on GitHub-hosted runners, and unit-level win32 simulation on Linux CI covers the new logic.
2. UNC paths (`\\server\share\...`) as project roots — documented known limitation.
3. Rendering parity for `--run-mode local` on Windows (DirectWrite vs fontconfig) — impossible by construction; WSL2 + docker is the answer, and the docs say so.
4. WSL-vs-native detection or any behavior change when running inside WSL — from the process's perspective WSL is Linux, and everything already works there.
5. Sanitizing Windows-specific host env vars (`Path`, `SYSTEMROOT`, …) forwarded into the container via `-e KEY` — harmless in a Linux container; noted as a known limitation only.

## Design

### D1: Separator-agnostic `rewriteContainerPath`

`rewriteContainerPath(path, mapping)` normalizes before comparing: a module-private `normalizeForMatch(p)` replaces `\` with `/` and lowercases a leading drive letter (`C:` → `c:`). Comparison becomes `normalizeForMatch(path)` against `normalizeForMatch(mapping.from)` using the existing exact-or-`from + '/'` rules. On a match, the result is `mapping.to + normalizedPath.slice(normalizedFrom.length)`; on no match the **original** path is returned verbatim (callers rely on `rewritten === value` to detect "not rewritten" — `src/server/docker-launcher.ts:166-172`).

Consequences per direction:

- **Host→container** (`from: ctx.cwd` native, `to: /work`): `C:\proj\pw.config.ts` now rewrites to `/work/pw.config.ts`. The `--reporter` and `--config` "not rewritten" fallbacks (bare specifier, warning) keep working unchanged.
- **Container→host** (`from: /work`, `to: process.cwd()` native): unchanged behavior; the result may mix separators (`C:\proj/tests/x.spec.ts`), which Node's fs APIs accept on win32.

Normalization is unconditional (not platform-gated): on POSIX it is a no-op for any path without backslashes. The one regression vector — a POSIX filename literally containing `\` — is accepted and documented (see Known Limitations).

### D2: Fixed container-side path for the `--test-list` mount

In `rewritePlaywrightArgs` (`src/server/docker-launcher.ts:168-170`), the `--test-list` branch stops mounting `value:value:ro`. Instead it mounts the host tmpfile onto a module-private constant `CONTAINER_TEST_LIST_PATH = '/tmp/crvy-rprtr-test-list.txt'` and pushes that constant as the flag value:

```
args.push(CONTAINER_TEST_LIST_PATH)
bindMounts.push(`${value}:${CONTAINER_TEST_LIST_PATH}:ro`)
```

One code path for every host OS; the same-path mount hack disappears on POSIX too. A fixed name is safe because `RunController` guarantees a single in-flight run (`already-running` guard, `src/server/run-controller.ts:183`). The existing CI-gated smoke test (`tests/docker-smoke.test.ts`) posts an unfiltered run and therefore does **not** exercise `--test-list`; the new mount shape is covered by unit tests only (see Testing). Extending the smoke test with a filtered run is out of scope.

### D3: POSIX separators in `--test-list` entries for docker mode

`buildTestListEntries(tests, rootDir?, cwd?)` gains a fourth parameter `pathStyle: 'host' | 'posix'` defaulting to `'host'`. With `'posix'`, every emitted entry's file portion uses `/` separators: `relative()` results get `\`→`/`, and the no-rootDir suffix-fallback branch splits on both separators and joins with `/`. `RunController.buildPlaywrightArgs` (`src/server/run-controller.ts:164`) passes `'posix'` when `deps.containerPathMapping !== undefined`, `'host'` otherwise — local-mode entry formatting is byte-identical to today.

### D4: One-time experimental warning on native win32

`DockerLauncherOptions` gains `platform?: NodeJS.Platform` (default `process.platform`), mirroring the existing `env`/`warn` injection seams. `prepare()` warns once (state flag alongside `available`/`prepared`):

> `Native Windows host detected: docker run mode is experimental on this platform. For CI-identical baselines, run crvy-rprtr from WSL2 with the project stored in the WSL filesystem.`

Explicit `--run-mode docker` and resolved `auto`-docker both warn; local mode never touches the launcher. The flag resets with the rest of prepare state after a failed prepare (`src/server/docker-launcher.ts:254-258`), so a fixed environment re-warns once — acceptable and simplest.

### D5: Documentation

- **README.md**, new "Windows" subsection under "Docker Mode": recommended WSL2 workflow (Docker Desktop → Settings → Resources → WSL integration; project under `\\wsl$\<distro>\...` i.e. the WSL filesystem, not `/mnt/c` — bind-mount performance and inotify); native win32 works but is experimental; pointer to known limitations. Also one honest line usable in the accompanying article: native Windows host for docker mode is currently experimental, WSL2 is the supported path.
- **`docs/docker-manual-smoke-test.md:12`**: prerequisite corrected to "Docker Desktop (macOS; Windows via WSL2 integration) or Docker Engine (Linux)".
- **Known limitations** (README + this spec): UNC project roots unsupported; drive-letter case differences are normalized away; POSIX filenames containing literal `\` would be mis-rewritten (not a Windows concern, accepted); Windows-specific host env vars are forwarded into the container harmlessly; no Windows CI.

## Data flow walkthrough (native win32, docker mode, filtered run)

1. UI POSTs `/api/run` with test descriptors → `RunController.start`.
2. `rewriteContainerTestDescriptors` maps any stale container paths to host paths (D1; no-op for already-host paths).
3. `buildPlaywrightArgs` writes the tmp `--test-list` file under `C:\Users\...\AppData\Local\Temp\` with POSIX-separator entries (D3).
4. `DockerLauncher.launch` → `rewritePlaywrightArgs`:
   - `--config C:\proj\pw.config.ts` → `/work/pw.config.ts` (D1).
   - `--reporter C:\proj\node_modules\@crvy\rprtr\...` → `/work/...` (D1); resolved outside the project → bare `@crvy/rprtr` (unchanged).
   - `--test-list C:\Users\...\crvy-rprtr-test-list-....txt` → `/tmp/crvy-rprtr-test-list.txt` plus `-v <host tmp>:/tmp/crvy-rprtr-test-list.txt:ro` (D2).
5. `docker run -v C:\proj:/work:rw ...` — Docker Desktop translates the host side (verified working).
6. Container-side reporter registers with `/work/...` paths; container→host rewrite (D1, already-working direction) maps them back for serving and approval routing.

## Error handling

- No new failure modes are introduced: unmatched paths still pass through verbatim with the existing `--config` warning; a failed prepare still resets launcher state and surfaces `docker-unavailable`.
- The win32 warning (D4) is advisory only — it never blocks a run.
- Malformed or unmountable `--test-list` host paths surface as the container's normal "file not found" through the existing child-exit path, same as today.

## Testing

All tests are platform-injected unit tests running on the existing Linux CI (`bun run test:bun`); no Windows CI job is added.

- **`tests/docker-support.test.ts`** — `rewriteContainerPath`: win32 host→container (`C:\proj\pw.config.ts` → `/work/pw.config.ts`), exact match, prefix-lookalike rejection (`C:\proj2\...` untouched), drive-letter case mismatch (`c:\proj` vs `C:\PROJ`), container→host with native `to`. `buildTestListEntries` with `pathStyle: 'posix'`: backslash `relative()` results emitted with `/`; no-rootDir suffix candidates joined with `/`.
- **`tests/docker-launcher.test.ts`** — `launch` spec on an injected win32 cwd: `--config` rewritten to `/work/...`; `--test-list` value is `/tmp/crvy-rprtr-test-list.txt` and the bind mount is `<host tmp>:/tmp/crvy-rprtr-test-list.txt:ro`; `prepare` with `platform: 'win32'` warns exactly once across two prepares (success path) and local-mode construction never warns.
- **`tests/run-controller.test.ts`** — docker-mode run passes `pathStyle: 'posix'` down (assert tmp file content uses `/`); local-mode content unchanged.
- **Existing coverage that must keep passing unchanged:** `tests/docker-smoke.test.ts` (CI-gated, Linux), `tests/docker-approval-routing.test.ts`, `tests/register-container-paths.test.ts`.

## Risks

- **POSIX `\`-in-filename regression** (D1 unconditional normalization): judged theoretical; mitigated by documentation. If it ever surfaces, the fix is platform-gating normalization behind an injected platform — the seam already exists via D4's `platform` option.
- **Behavior change for POSIX `--test-list` mounts** (D2): the same-path mount was load-bearing only for "container sees the exact host path"; the fixed target preserves semantics and is covered by unit tests (the CI smoke test never exercises `--test-list` today — it posts an unfiltered run).
- **Overpromising in docs**: the word "experimental" must appear wherever native win32 is mentioned, and the smoke-guide prerequisite fix (D5) is part of the deliverable, not an afterthought.
