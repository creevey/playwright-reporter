# Windows OS Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--run-mode docker` work on native Windows hosts (experimental, with a one-time warning) and document WSL2 as the recommended Windows workflow.

**Architecture:** Three targeted fixes in the existing docker modules — separator-agnostic path rewriting in `docker-support.ts`, a fixed container-side target for the `--test-list` bind mount in `docker-launcher.ts`, POSIX separators in `--test-list` entries when docker mode is active — plus a platform-injected warn-once in the launcher and doc updates. No new modules; all behavior covered by platform-injected unit tests on the existing Linux CI.

**Tech Stack:** TypeScript, Bun (`bun test`), Node `path` module. Spec: `docs/superpowers/specs/2026-08-24-windows-os-support-design.md`.

## Global Constraints

- Use Bun for everything: `bun test`, `bun run <script>`. Never npm/node directly.
- TDD: write the failing test first, watch it fail, implement, watch it pass.
- `rewriteContainerPath` must keep returning unmatched paths **verbatim** — callers detect "not rewritten" via `rewritten === value` (`src/server/docker-launcher.ts:166-172`).
- Normalization is matching-only; it is never emitted into host-visible paths.
- No Windows CI job. All win32 logic is tested via platform/separator injection on the existing Linux CI.
- Local (non-docker) run behavior must stay byte-identical: `--test-list` entry formatting changes only when `containerPathMapping` is defined.
- Commit style follows the repo log: `fix(server): ...`, `docs: ...`, `test: ...`.
- Pre-commit hooks enforce lint/typecheck/format: run `bunx oxfmt <touched files>` before every commit.

---

### Task 1: Separator-agnostic `rewriteContainerPath`

**Files:**

- Modify: `src/server/docker-support.ts:134-143`
- Test: `tests/docker-support.test.ts:130-141`

**Interfaces:**

- Consumes: existing `ContainerPathMapping { from: string; to: string }`.
- Produces: `rewriteContainerPath(path: string, mapping: ContainerPathMapping): string` — signature unchanged. New behavior: matching normalizes `\` → `/` and lowercases a leading drive letter on both `path` and `mapping.from`; the rewritten remainder keeps normalized (forward-slash) form; unmatched paths return `path` verbatim.

- [ ] **Step 1: Write the failing tests**

Append to `tests/docker-support.test.ts`, after the existing `describe('rewriteContainerPath', ...)` block (line 141):

```ts
describe('rewriteContainerPath — Windows hosts', () => {
  const hostToContainer = { from: 'C:\\proj', to: '/work' }

  test('rewrites backslash descendants of the project root', () => {
    expect(rewriteContainerPath('C:\\proj\\pw.config.ts', hostToContainer)).toBe('/work/pw.config.ts')
  })

  test('rewrites the exact project root', () => {
    expect(rewriteContainerPath('C:\\proj', hostToContainer)).toBe('/work')
  })

  test('rejects prefix lookalikes with backslashes', () => {
    expect(rewriteContainerPath('C:\\proj2\\x.ts', hostToContainer)).toBe('C:\\proj2\\x.ts')
  })

  test('matches when only the drive-letter case differs', () => {
    expect(rewriteContainerPath('c:\\proj\\tests\\x.ts', hostToContainer)).toBe('/work/tests/x.ts')
  })

  test('leaves unmatched paths verbatim (no normalization leakage)', () => {
    expect(rewriteContainerPath('D:\\elsewhere\\x.ts', hostToContainer)).toBe('D:\\elsewhere\\x.ts')
  })

  test('container-to-host keeps the native `to` and appends the POSIX remainder', () => {
    expect(rewriteContainerPath('/work/tests/x.spec.ts', { from: '/work', to: 'C:\\proj' })).toBe(
      'C:\\proj/tests/x.spec.ts',
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test docker-support.test.ts`
Expected: FAIL — the five new win32 cases fail (rewrites no-op on backslash input); the existing POSIX tests pass.

- [ ] **Step 3: Implement the normalization**

In `src/server/docker-support.ts`, replace the docstring and body of `rewriteContainerPath` (lines 134-143):

```ts
/**
 * Maps an absolute path between the container's mount namespace and the host.
 * Only exact matches and direct descendants of `mapping.from` are rewritten;
 * prefix lookalikes like `/workspace` are left untouched. Matching is
 * separator- and drive-letter-case-insensitive so Windows host paths
 * (`C:\proj\...`) rewrite correctly; the normalized form feeds the rewritten
 * remainder, but unmatched paths return verbatim so callers can detect
 * "not rewritten" via `rewritten === value`.
 */
export function rewriteContainerPath(path: string, mapping: ContainerPathMapping): string {
  const normalizedPath = normalizeForMatch(path)
  const normalizedFrom = normalizeForMatch(mapping.from)
  if (normalizedPath === normalizedFrom) return mapping.to
  if (normalizedPath.startsWith(`${normalizedFrom}/`)) return mapping.to + normalizedPath.slice(normalizedFrom.length)
  return path
}

/** Module-private: matching-only normalization — the result is never emitted as a host path. */
function normalizeForMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/^[A-Z](?=:)/, (c) => c.toLowerCase())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests && bun test docker-support.test.ts`
Expected: PASS — all tests including the pre-existing POSIX ones.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt src/server/docker-support.ts tests/docker-support.test.ts
git add src/server/docker-support.ts tests/docker-support.test.ts
git commit -m "fix(server): separator-agnostic rewriteContainerPath for Windows hosts"
```

---

### Task 2: POSIX `--test-list` entries in docker mode

**Files:**

- Modify: `src/server/docker-support.ts:187-203` (`buildTestListEntries`)
- Modify: `src/server/run-controller.ts:163-167`
- Test: `tests/run-controller.test.ts` (`describe('buildTestListEntries')` at line 516, and the docker-mode `start` tests at lines 251-283)

**Interfaces:**

- Consumes: `RunControllerDeps.containerPathMapping` (existing, `src/server/run-controller.ts:56`).
- Produces: `buildTestListEntries(tests, rootDir?, cwd?, pathStyle?: 'host' | 'posix'): string[]` — new fourth parameter, default `'host'`. With `'posix'`, every emitted entry's file portion has `\` converted to `/`. `RunController` passes `'posix'` iff `deps.containerPathMapping !== undefined`.

- [ ] **Step 1: Write the failing tests**

In `tests/run-controller.test.ts`, inside `describe('buildTestListEntries', ...)` (starts line 516), add:

```ts
test('posix pathStyle converts backslashes in file paths', () => {
  const entries = buildTestListEntries(
    [{ file: 'tests\\foo.spec.ts', line: 10, titlePath: ['does a thing'] }],
    undefined,
    undefined,
    'posix',
  )
  expect(entries).toEqual(['tests/foo.spec.ts:10 › does a thing'])
})

test('host pathStyle (default) preserves backslashes', () => {
  const entries = buildTestListEntries([{ file: 'tests\\foo.spec.ts', line: 10, titlePath: ['does a thing'] }])
  expect(entries).toEqual(['tests\\foo.spec.ts:10 › does a thing'])
})
```

And after the test at line 251 ('docker mode routes a single descriptor through --test-list with rewritten paths'), add the wiring tests:

```ts
test('docker mode writes --test-list entries with POSIX separators', () => {
  const f = createFixture(SAMPLE_CTX, () => null, { from: '/work', to: 'C:\\proj' })
  f.setPlaywrightVersion('1.59.0')
  f.controller.start({
    tests: [{ file: 'tests\\foo.spec.ts', line: 10, titlePath: ['foo'] }],
  })
  expect(f.writtenTempFiles[0]!.content).toBe('tests/foo.spec.ts:10 › foo')
})

test('local mode keeps host separators in --test-list entries', () => {
  const f = createFixture(SAMPLE_CTX)
  f.setPlaywrightVersion('1.59.0')
  f.controller.start({
    tests: [
      { file: 'tests\\a.spec.ts', line: 1, titlePath: ['a'] },
      { file: 'tests\\b.spec.ts', line: 2, titlePath: ['b'] },
    ],
  })
  expect(f.writtenTempFiles[0]!.content).toContain('tests\\a.spec.ts:1')
})
```

Note: the fixture's `writeTempFile` captures content (`tests/run-controller.test.ts:121-125`); local mode uses `--test-list` only for `tests.length > 1` (`src/server/run-controller.ts:155-158`), hence two descriptors in the second test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test run-controller.test.ts`
Expected: FAIL — the two `pathStyle` unit tests fail (extra argument ignored, backslashes preserved); the docker-mode wiring test fails (content keeps `tests\foo.spec.ts`). The local-mode test passes already — it is a regression guard.

- [ ] **Step 3: Implement the `pathStyle` parameter**

In `src/server/docker-support.ts`, replace `buildTestListEntries` (lines 187-203) — including its docstring:

```ts
/**
 * Builds `--test-list` lines mirroring `playwright test --list`, with paths relative to
 * Playwright's rootDir. When rootDir is unknown (no register yet — seeded run context),
 * emits one candidate entry per plausible base (every suffix of the cwd-relative path):
 * Playwright derives rootDir from testDir when set, and non-matching entries are
 * ignored silently, so exactly one candidate matches the intended test.
 * `pathStyle: 'posix'` (docker mode) converts backslashes so the in-container
 * Linux Playwright can match entries; the default `'host'` keeps host separators.
 */
export function buildTestListEntries(
  tests: readonly TestListDescriptor[],
  rootDir?: string,
  cwd?: string,
  pathStyle: 'host' | 'posix' = 'host',
): string[] {
  const convert = (p: string): string => (pathStyle === 'posix' ? p.replace(/\\/g, '/') : p)
  if (rootDir !== undefined) {
    return tests.map((d) =>
      testListEntry(d, convert(isAbsolute(d.file) ? relative(rootDir, d.file) || d.file : d.file)),
    )
  }
  return tests.flatMap((d) => {
    if (!isAbsolute(d.file)) return [testListEntry(d, convert(d.file))]
    const rel = relative(cwd ?? process.cwd(), d.file)
    const segments = pathStyle === 'posix' ? rel.split(/[\\/]/) : rel.split(sep)
    return segments.map((_, i) => testListEntry(d, convert(segments.slice(i).join(sep))))
  })
}
```

In `src/server/run-controller.ts`, replace line 164:

```ts
const content = buildTestListEntries(
  tests,
  ctx.rootDir,
  ctx.cwd,
  this.deps.containerPathMapping !== undefined ? 'posix' : 'host',
).join('\n')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests && bun test run-controller.test.ts`
Expected: PASS — all tests, including the pre-existing docker-mode tests at lines 251-283 (their entries are POSIX already, so `'posix'` is an identity transform on Linux fixtures).

- [ ] **Step 5: Commit**

```bash
bunx oxfmt src/server/docker-support.ts src/server/run-controller.ts tests/run-controller.test.ts
git add src/server/docker-support.ts src/server/run-controller.ts tests/run-controller.test.ts
git commit -m "fix(server): posix --test-list entries in docker mode"
```

---

### Task 3: Fixed container-side path for the `--test-list` mount

**Files:**

- Modify: `src/server/docker-launcher.ts:19-23` (constants), `144-179` (`rewritePlaywrightArgs` docstring + `--test-list` branch)
- Test: `tests/docker-launcher.test.ts:200-216` (rewrite existing test), plus a new win32 launch test

**Interfaces:**

- Consumes: Task 1's `rewriteContainerPath` (win32 `--config` rewrite in the new test relies on it).
- Produces: module-private `CONTAINER_TEST_LIST_PATH = '/tmp/crvy-rprtr-test-list.txt'` (not exported — tests hardcode the literal). `--test-list <host tmp>` now yields flag value `CONTAINER_TEST_LIST_PATH` plus bind mount `<host tmp>:/tmp/crvy-rprtr-test-list.txt:ro` on every host OS.

- [ ] **Step 1: Rewrite the existing mount test and add the win32 test (both failing)**

Replace the test at `tests/docker-launcher.test.ts:200-216` ('bind-mounts --test-list outside ctx.cwd read-only at the same path before the image') with:

```ts
test('bind-mounts the host --test-list tmpfile read-only at a fixed container path', async () => {
  const { launcher } = makeLauncher()
  await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
  const args = launcher.launch({
    ctx: CTX,
    playwrightArgs: ['test', '--test-list', '/tmp/crvy-rprtr-test-list-123.txt'],
  }).args
  const idx = args.indexOf('--test-list')
  expect(idx).toBeGreaterThan(-1)
  expect(args[idx + 1]).toBe('/tmp/crvy-rprtr-test-list.txt')
  const mount = '/tmp/crvy-rprtr-test-list-123.txt:/tmp/crvy-rprtr-test-list.txt:ro'
  const mountIdx = args.indexOf(mount)
  expect(mountIdx).toBeGreaterThan(-1)
  expect(args[mountIdx - 1]).toBe('-v')
  const imageIdx = args.indexOf('mcr.microsoft.com/playwright:v1.59.0-noble')
  expect(mountIdx).toBeLessThan(imageIdx)
})

test('rewrites Windows host paths in --config and --test-list', async () => {
  const { launcher } = makeLauncher()
  const winCtx: RunContext = { configFile: 'C:\\proj\\playwright.config.ts', cwd: 'C:\\proj' }
  await launcher.prepare!({ ctx: winCtx, onProgress: noopProgress })
  const args = launcher.launch({
    ctx: winCtx,
    playwrightArgs: [
      'test',
      '--config',
      'C:\\proj\\playwright.config.ts',
      '--test-list',
      'C:\\Users\\dev\\AppData\\Local\\Temp\\crvy-rprtr-test-list-1.txt',
    ],
  }).args
  expect(args).toContain(`C:\\proj:${DOCKER_WORK_DIR}:rw`)
  const configIdx = args.indexOf('--config')
  expect(args[configIdx + 1]).toBe(`${DOCKER_WORK_DIR}/playwright.config.ts`)
  const listIdx = args.indexOf('--test-list')
  expect(args[listIdx + 1]).toBe('/tmp/crvy-rprtr-test-list.txt')
  expect(args).toContain(
    'C:\\Users\\dev\\AppData\\Local\\Temp\\crvy-rprtr-test-list-1.txt:/tmp/crvy-rprtr-test-list.txt:ro',
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test docker-launcher.test.ts`
Expected: FAIL — the rewritten mount test fails (same-path mount string not found); the win32 test fails (backslash `--config` unrewritten until Task 1 — ensure Task 1 is committed first).

- [ ] **Step 3: Implement the fixed container path**

In `src/server/docker-launcher.ts`, add after `const DOCKER_HOST_GATEWAY = ...` (line 22):

```ts
/** Module-private: fixed container-side target for the host `--test-list` tmpfile mount. */
const CONTAINER_TEST_LIST_PATH = '/tmp/crvy-rprtr-test-list.txt'
```

In `rewritePlaywrightArgs`, update the docstring line:

```
 * - `--test-list` outside ctx.cwd (host tmpdir) → fixed container path (`CONTAINER_TEST_LIST_PATH`), plus a read-only bind mount of the host file onto it.
```

and replace the `--test-list` branch (lines 168-170):

```ts
    } else if (flag === '--test-list' && rewritten === value) {
      args.push(CONTAINER_TEST_LIST_PATH)
      bindMounts.push(`${value}:${CONTAINER_TEST_LIST_PATH}:ro`)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests && bun test docker-launcher.test.ts docker-support.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt src/server/docker-launcher.ts tests/docker-launcher.test.ts
git add src/server/docker-launcher.ts tests/docker-launcher.test.ts
git commit -m "fix(server): mount --test-list tmpfile at a fixed container path"
```

---

### Task 4: One-time experimental warning on native win32

**Files:**

- Modify: `src/server/docker-launcher.ts` — `DockerLauncherOptions` (line 33-43), `LauncherState` (64-69), `PrepareDeps` (71-76), `prepareDocker` (98-130), `LauncherDeps` (221-231), `createState` (233-235), `buildLauncher` prepare/reset (243-260), `createDockerLauncher` (285-297)
- Test: `tests/docker-launcher.test.ts` — `makeLauncher` helper (23-38) and `describe('DockerLauncher.prepare')` (56-121)

**Interfaces:**

- Consumes: nothing from later tasks.
- Produces: `DockerLauncherOptions.platform?: NodeJS.Platform` (default `process.platform`) — injection seam mirroring `env`/`warn`. Warning text (exact): `Native Windows host detected: docker run mode is experimental on this platform. For CI-identical baselines, run crvy-rprtr from WSL2 with the project stored in the WSL filesystem.`

- [ ] **Step 1: Write the failing tests**

In `tests/docker-launcher.test.ts`, add inside `describe('DockerLauncher.prepare', ...)`:

```ts
test('warns once about experimental support on a native Windows host', async () => {
  const warnings: string[] = []
  const { launcher } = makeLauncher({ platform: 'win32', warn: (m) => warnings.push(m) })
  await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
  await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('experimental')
  expect(warnings[0]).toContain('WSL2')
})

test('does not warn on POSIX hosts', async () => {
  const warnings: string[] = []
  const { launcher } = makeLauncher({ platform: 'linux', warn: (m) => warnings.push(m) })
  await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
  expect(warnings).toHaveLength(0)
})

test('re-warns once after a failed prepare resets state', async () => {
  const warnings: string[] = []
  let daemonUp = false
  const exec: DockerExec = (args) => {
    if (args[0] === 'info') return Promise.resolve(daemonUp ? ok : fail)
    return Promise.resolve(ok)
  }
  const launcher = createDockerLauncher({
    port: 3000,
    getPlaywrightVersion: () => '1.59.0',
    env: {},
    containerName: 'c',
    exec,
    platform: 'win32',
    warn: (m) => warnings.push(m),
  })
  await rejectionOf(launcher.prepare!({ ctx: CTX, onProgress: noopProgress }))
  daemonUp = true
  await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
  expect(warnings).toHaveLength(2)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test docker-launcher.test.ts`
Expected: FAIL — TS/type errors or assertion failures: `platform` is not yet a known option (excess property), and no warning is emitted. Note: `createDockerLauncher` options are typed, so the failure may surface as a typecheck error under `bun run typecheck`; `bun test` transpiles without typechecking, so expect assertion failures (`warnings` empty / length 1 instead of 2).

- [ ] **Step 3: Implement the platform seam and warn-once**

In `src/server/docker-launcher.ts`:

1. `DockerLauncherOptions` — add after `warn?: Warn` (line 42):

```ts
  /** Injectable host-platform seam for tests; defaults to process.platform. */
  platform?: NodeJS.Platform
```

2. `LauncherState` — add field:

```ts
interface LauncherState {
  available: boolean | undefined
  prepared: Promise<void> | null
  image: string | null
  command: readonly string[]
  warnedWin32: boolean
}
```

3. `PrepareDeps` and `LauncherDeps` — add to each:

```ts
platform: NodeJS.Platform
```

4. `prepareDocker` — at the very top of the function body:

```ts
if (deps.platform === 'win32' && !state.warnedWin32) {
  state.warnedWin32 = true
  deps.warn(
    'Native Windows host detected: docker run mode is experimental on this platform. For CI-identical baselines, run crvy-rprtr from WSL2 with the project stored in the WSL filesystem.',
  )
}
```

5. `createState` — return `{ available: undefined, prepared: null, image: null, command: ..., warnedWin32: false }`.

6. `buildLauncher` prepare — pass `platform: deps.platform` into the `prepareDocker` deps object, and extend the failure reset:

```ts
      ).catch((error: unknown) => {
        // Reset so a later run re-probes after the user fixes the problem.
        state.prepared = null
        state.warnedWin32 = false
        throw error
      })
```

7. `createDockerLauncher` — add to the deps object passed to `buildLauncher`:

```ts
    platform: options.platform ?? process.platform,
```

8. In `tests/docker-launcher.test.ts` `makeLauncher`, pin the default platform so the other tests stay host-independent (overrides still win via the spread):

```ts
const launcher = createDockerLauncher({
  port: 3000,
  getPlaywrightVersion: () => '1.59.0',
  env: {},
  containerName: 'test-container',
  platform: 'linux',
  exec,
  ...overrides,
})
```

(The two inline `createDockerLauncher` calls in the 'resets after failure' and image tests keep their current form — they do not pass `warn`, so a win32 dev machine would only add a console line, not an assertion failure. Optional: leave them; do not churn.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tests && bun test docker-launcher.test.ts`
Expected: PASS — all prepare/launch/onForceKill tests.

- [ ] **Step 5: Commit**

```bash
bunx oxfmt src/server/docker-launcher.ts tests/docker-launcher.test.ts
git add src/server/docker-launcher.ts tests/docker-launcher.test.ts
git commit -m "feat(server): warn once that native Windows docker mode is experimental"
```

---

### Task 5: Documentation — WSL2 recommendation and corrected prerequisites

**Files:**

- Modify: `README.md` (insert after line 147, before `Notes:`)
- Modify: `docs/docker-manual-smoke-test.md:12`

**Interfaces:**

- Consumes: the final warning wording from Task 4 (docs must say "experimental").
- Produces: no code interface.

- [ ] **Step 1: Add the Windows section to README.md**

Insert between the programmatic-equivalents paragraph (line 147) and `Notes:` (line 149):

```markdown
### Windows

The recommended Windows setup is **WSL2**: enable Docker Desktop's WSL2 integration (Settings → Resources → WSL integration), keep the project inside the WSL filesystem (e.g. `~/proj` in your distro, not `/mnt/c/...` — bind-mounts from `/mnt/c` are slow and lack inotify events), and run `npx crvy-rprtr` from the WSL shell. Paths and rendering then behave exactly as on Linux, so baselines match CI.

Running natively on a Windows host (PowerShell/cmd) works but is **experimental**: Docker Desktop translates the `C:\proj:/work` mount, and crvy-rprtr rewrites Windows paths in container arguments, but this path has no CI coverage — expect a one-time experimental warning on the first run. Local (`--run-mode local`) Windows runs can never match Linux CI baselines (DirectWrite vs fontconfig text rendering) — which is exactly the problem Docker mode solves, so prefer WSL2.

Known limitations on native Windows: UNC project roots (`\\server\share\...`) are unsupported; drive-letter casing is normalized (`C:` ≡ `c:`); Windows-specific host env vars are forwarded into the container harmlessly.
```

- [ ] **Step 2: Fix the smoke-test guide prerequisite**

In `docs/docker-manual-smoke-test.md`, replace line 12:

```markdown
- Docker Desktop (macOS; Windows via WSL2 integration — native Windows hosts are experimental) or Docker Engine (Linux) installed and the **daemon running**:
```

- [ ] **Step 3: Verify docs render**

Run: `bun run format:check`
Expected: PASS (oxfmt covers markdown; if it flags the new section, run `bunx oxfmt README.md docs/docker-manual-smoke-test.md`).

- [ ] **Step 4: Commit**

```bash
bunx oxfmt README.md docs/docker-manual-smoke-test.md
git add README.md docs/docker-manual-smoke-test.md
git commit -m "docs: recommend WSL2 on Windows, mark native win32 docker mode experimental"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full unit suite**

Run: `bun run test:bun`
Expected: PASS — entire suite including the new win32 tests.

- [ ] **Step 2: Lint, typecheck, format**

Run: `bun run lint && bun run typecheck && bun run format:check`
Expected: all PASS.

- [ ] **Step 3: Knip (unused-export check)**

Run: `bun run knip`
Expected: PASS — confirms nothing new was exported unnecessarily (`CONTAINER_TEST_LIST_PATH`, `normalizeForMatch`, `pathStyle` all stay module-private/inline).

## Self-Review Notes (already applied)

- Spec coverage: D1 → Task 1; D3 → Task 2; D2 → Task 3; D4 → Task 4; D5 → Task 5; Testing/verification → per-task steps + Task 6. Known-limitation documentation lives in Task 5's README section (UNC, drive-letter casing, env forwarding) and Task 1's docstring (normalization contract). The spec's "POSIX filenames containing `\`" limitation is covered by the Task 1 docstring + spec; no code task needed.
- Task order matters: Task 3's win32 test depends on Task 1's rewrite; Task 5 quotes Task 4's warning semantics. Execute 1 → 6 in order.
- No placeholders: every code step shows complete code; every command has expected output.
