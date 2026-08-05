# Docker Browser Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Playwright browsers inside a pinned Docker container from Crvy Rprtr so users get reproducible screenshot baselines without installing browsers or system dependencies.

**Architecture:** The server stays on the host; a new `RunLauncher` unit decides how `playwright test` is spawned. `LocalLauncher` preserves today's behavior; `DockerLauncher` wraps the same invocation in `docker run --rm` against the official Microsoft Playwright image, bind-mounts the project at `/work`, and points the reporter back at the host via `host.docker.internal`. The reporter gains a portable-artifacts mode (env-driven) so container paths never leak into the report. Spec: `docs/superpowers/specs/2026-08-05-docker-browser-execution-design.md`.

**Tech Stack:** Bun, TypeScript, `@playwright/test` reporter API, `ws`, zod, Svelte 5, `package-manager-detector`, Docker CLI.

## Global Constraints

- Tests run from the `tests/` directory: `cd tests && bun test <file>.test.ts` (this is how `package.json`'s `test:bun` script invokes them; imports use `../src/...` without the `.ts` extension).
- The pre-commit hook (`scripts/check.sh --staged`) runs `oxlint`, `tsc --noEmit`, and `oxfmt --check` on staged files. Run `bunx oxfmt --write <staged files>` before every commit.
- Commit messages follow Conventional Commits as seen in `git log` (e.g. `feat(server): …`, `fix(run-controller): …`, `docs(spec): …`).
- `knip --strict` runs in full checks: every new export must be consumed somewhere in the plan.
- Do not modify `tests/e2e/ui-controls.html` (static snapshot fixture; changing it would invalidate committed screenshot baselines — visual coverage of new controls is a follow-up).
- Docker mode never propagates host `PLAYWRIGHT_BROWSERS_PATH` into the container and never mounts host browser caches.
- Spec decisions D1–D9 are binding. One amendment was discovered during planning, recorded below as D10.

## Design Amendment D10 (accepted during planning): container path rewrite at ingress

The spec's D7 makes attachment paths portable, but the reporter's `register` message also carries `cwd`, `configFile`, `playwrightSnapshotDir`, and `playwrightTestDir` — and `handleRegister` (`src/server/handlers.ts:121-161`) stores them into `runContext` (used as the next run's spawn cwd), `approvalRouting` (used with `existsSync` for baseline display and approval writes), and `artifactRoots`. With the project mounted at `/work`, these arrive as container-local absolute paths and silently break host-side filesystem operations. Amendment: when Docker mode is active, `routesContext` carries a `containerPathMapping: { from: '/work', to: <host cwd> }` and `handleRegister` rewrites those four fields through it before storing. Test locations (`test.location.file`) are relative in practice and are left untouched.

## File Structure

| File                                        | Responsibility                                                                                                             | Status |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/reporter.ts`                           | Read `CRVY_RPRTR_PORTABLE_ARTIFACTS`; copy attachments before send in portable live mode                                   | Modify |
| `src/server/run-launcher.ts`                | `RunLauncher` interface, `LaunchSpec`, `buildSpawnEnv`, `resolvePlaywrightLaunch`, `createLocalLauncher`                   | Create |
| `src/server/run-controller.ts`              | Consume `RunLauncher`; add `update` flag, `docker-unavailable` reason, `prepareRun()`; re-export `resolvePlaywrightLaunch` | Modify |
| `src/server/docker-support.ts`              | Docker CLI exec seam, daemon/image probes, pull, force-remove, image + container-command resolution, path rewrite helper   | Create |
| `src/server/docker-launcher.ts`             | `createDockerLauncher` — builds the `docker run` arg vector, env, prepare/pull lifecycle                                   | Create |
| `src/server/run-mode.ts`                    | `resolveRunMode` — the auto × CI × daemon matrix                                                                           | Create |
| `src/server/app.ts`                         | `ServerOptions` extension, launcher selection, pass `runInfo`/`containerPathMapping` into routes context                   | Modify |
| `src/server/routes-context.ts`              | `RoutesContextOptions` += `runInfo`, `containerPathMapping`                                                                | Modify |
| `src/server/routes.ts`                      | `RoutesContext` += `runInfo`, `containerPathMapping`; `/api/report` += `runMode`                                           | Modify |
| `src/server/handlers.ts`                    | `handleRegister` applies `containerPathMapping`                                                                            | Modify |
| `src/server/run-routes.ts`                  | Await `prepareRun()` before `start()`; map `docker-unavailable` to 409                                                     | Modify |
| `src/schemas/http.ts`                       | `RunRequestBodySchema` += `update`; `RunResponseSchema` reason += `docker-unavailable`                                     | Modify |
| `src/schemas.ts`                            | `WebSocketMessageSchema` run-status += `mode`, `phase`; `ReportApiResponseSchema` += `runMode`                             | Modify |
| `src/types.ts`                              | `ClientWebSocketMessage` run-status payload += `mode`, `phase`                                                             | Modify |
| `src/cli.ts`                                | `--run-mode`, `--docker-image`, `--docker-platform` flags + help text                                                      | Modify |
| `src/client/App.svelte`                     | `runMode` prop, `update` filter, `isPreparing` state, run-status phase handling                                            | Modify |
| `src/client/components/Sidebar.svelte`      | Mode badge, update-baselines button, preparing state                                                                       | Modify |
| `src/index.ts`                              | Thread `runMode` from `/api/report` into App props                                                                         | Modify |
| `tests/reporter-portable-artifacts.test.ts` | Reporter portable mode tests                                                                                               | Create |
| `tests/run-launcher.test.ts`                | LocalLauncher/buildSpawnEnv/resolvePlaywrightLaunch tests                                                                  | Create |
| `tests/run-controller.test.ts`              | Fixture swaps `resolveLaunch` dep for `launcher`; broadcast assertions gain `mode`                                         | Modify |
| `tests/run-request-schema.test.ts`          | `update` passthrough, `docker-unavailable` route mapping                                                                   | Create |
| `tests/docker-support.test.ts`              | Probe/pull/image/command/rewrite helpers                                                                                   | Create |
| `tests/docker-launcher.test.ts`             | Arg vector, env denylist, prepare lifecycle                                                                                | Create |
| `tests/run-mode.test.ts`                    | Mode resolution matrix                                                                                                     | Create |
| `tests/register-container-paths.test.ts`    | Register path rewrite                                                                                                      | Create |
| `tests/cli.test.ts`                         | New flags                                                                                                                  | Modify |
| `tests/docker-smoke.test.ts`                | CI-gated real-docker round trip                                                                                            | Create |
| `tests/fixtures/docker-smoke/`              | Minimal Playwright project for the smoke test                                                                              | Create |
| `.github/workflows/ci.yml`                  | `docker-smoke` job                                                                                                         | Modify |
| `.gitignore`                                | Fixture artifacts                                                                                                          | Modify |
| `README.md`                                 | Docker mode docs                                                                                                           | Modify |

---

### Task 1: Reporter portable-artifacts mode

**Files:**

- Modify: `src/reporter.ts:41-70` (constructor + fields) and `src/reporter.ts:175-208` (`onTestEnd`)
- Test: `tests/reporter-portable-artifacts.test.ts`

**Interfaces:**

- Consumes: `saveAttachments(screenshotDir, testId, { attachments })` from `src/reporter-artifact-ops.ts:51` — returns `AttachmentData[]` with relative `path` values; `collectNativeImageAttachments` from `src/reporter-helpers.ts:25`.
- Produces: reporter behavior change only — when `CRVY_RPRTR_PORTABLE_ARTIFACTS === '1'` and not in CI mode, `test-end` events carry copied, relative-path attachments while the WebSocket stays live. No new exports.

- [ ] **Step 1: Write the failing test**

Create `tests/reporter-portable-artifacts.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocketServer, type WebSocket } from 'ws'

import { CrvyRprtr } from '../src/reporter'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2G0K0AAAAASUVORK5CYII=',
  'base64',
)

interface ReceivedMessage {
  type: string
  data: {
    id?: string
    attachments?: Array<{ name: string; path: string }>
  }
}

function makeFakeTest(id: string) {
  return {
    id,
    title: 'visual test',
    location: { file: 'tests/visual.spec.ts', line: 3, column: 1 },
    parent: {
      title: 'Suite',
      type: 'describe',
      project: () => ({ name: 'chromium' }),
      parent: undefined,
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(25)
  }
  throw new Error('waitFor timed out')
}

describe('portable artifacts mode', () => {
  const savedFlag = process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS
    else process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS = savedFlag
  })

  test('copies attachments into screenshotDir with relative paths while streaming live', async () => {
    process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS = '1'
    delete process.env.CI

    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-portable-'))
    const screenshotDir = join(tempDir, 'screenshots')
    const attachmentPath = join(tempDir, 'actual.png')
    await writeFile(attachmentPath, TINY_PNG)

    const received: ReceivedMessage[] = []
    const sockets = new Set<WebSocket>()
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      sockets.add(ws)
      ws.on('message', (raw) => {
        received.push(JSON.parse(String(raw)) as ReceivedMessage)
      })
    })
    const address = wss.address()
    if (typeof address === 'string') throw new Error('unexpected pipe address')
    const port = address.port

    try {
      const reporter = new CrvyRprtr({ serverUrl: `ws://127.0.0.1:${port}`, screenshotDir })
      // onBegin triggers connect() when not in CI mode.
      reporter.onBegin(
        { configFile: undefined, rootDir: tempDir, projects: [] } as never,
        { allTests: () => [] } as never,
      )

      await waitFor(() => sockets.size === 1)

      const fakeTest = makeFakeTest('test-1')
      reporter.onTestBegin(fakeTest as never)
      await reporter.onTestEnd(
        fakeTest as never,
        {
          status: 'failed',
          errors: [{ message: 'mismatch' }],
          duration: 5,
          steps: [],
          attachments: [{ name: 'actual.png', path: attachmentPath, contentType: 'image/png' }],
        } as never,
      )

      await waitFor(() => received.some((m) => m.type === 'test-end'))
      await reporter.onEnd({ status: 'failed' } as never)

      const testEnd = received.find((m) => m.type === 'test-end')
      expect(testEnd).toBeDefined()
      const attachments = testEnd!.data.attachments ?? []
      expect(attachments).toHaveLength(1)
      // Relative path under screenshotDir — no absolute container/host path leaks.
      expect(attachments[0]!.path).toBe('test-1/actual.png')
      expect(attachments[0]!.path.startsWith('/')).toBe(false)
      expect(existsSync(join(screenshotDir, 'test-1', 'actual.png'))).toBe(true)
    } finally {
      for (const ws of sockets) ws.close()
      wss.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps native absolute-path attachments when the flag is unset', async () => {
    delete process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS
    delete process.env.CI

    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-portable-off-'))
    const attachmentPath = join(tempDir, 'actual.png')
    await writeFile(attachmentPath, TINY_PNG)

    const received: ReceivedMessage[] = []
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        received.push(JSON.parse(String(raw)) as ReceivedMessage)
      })
    })
    const address = wss.address()
    if (typeof address === 'string') throw new Error('unexpected pipe address')
    const port = address.port

    try {
      const reporter = new CrvyRprtr({ serverUrl: `ws://127.0.0.1:${port}` })
      reporter.onBegin(
        { configFile: undefined, rootDir: tempDir, projects: [] } as never,
        { allTests: () => [] } as never,
      )

      const fakeTest = makeFakeTest('test-2')
      reporter.onTestBegin(fakeTest as never)
      await reporter.onTestEnd(
        fakeTest as never,
        {
          status: 'failed',
          errors: [],
          duration: 1,
          steps: [],
          attachments: [{ name: 'actual.png', path: attachmentPath, contentType: 'image/png' }],
        } as never,
      )

      await waitFor(() => received.some((m) => m.type === 'test-end'))
      await reporter.onEnd({ status: 'failed' } as never)

      const testEnd = received.find((m) => m.type === 'test-end')
      expect(testEnd!.data.attachments?.[0]?.path).toBe(attachmentPath)
    } finally {
      wss.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && bun test reporter-portable-artifacts.test.ts`
Expected: FAIL — first test fails because `attachments[0].path` is the absolute `attachmentPath` (portable behavior not implemented), and `onTestEnd` is currently synchronous so `await reporter.onTestEnd(...)` resolves immediately with un-copied attachments. (Second test passes already; it pins current behavior.)

- [ ] **Step 3: Implement portable mode in the reporter**

In `src/reporter.ts`, add the field after line 57 (`private pendingArtifacts…`):

```ts
  private readonly portableArtifacts: boolean
```

In the constructor, after `this.ci = options.ci ?? isCI()` (line 68), add:

```ts
// Docker mode streams live over WebSocket but must not leak container-local
// absolute paths into the report — attachments are copied into screenshotDir
// and referenced by relative path, exactly like CI mode produces.
this.portableArtifacts = process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS === '1'
```

Replace the `onTestEnd` method (lines 175-208) with an async version that copies attachments before sending when portable mode is active:

```ts
  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const reporterTitlePath = this.testMetadata.get(test.id)?.reporterTitlePath ?? this.reporterTitlePath(test)
    const screenshotDeclarations = withResolvedVisualNames(
      extractScreenshotDeclarations(result.steps),
      reporterTitlePath,
    )
    const nativeAttachments = collectNativeImageAttachments(result)
    const data = {
      id: test.id,
      title: test.title,
      status: result.status,
      attachments: nativeAttachments,
      visualNames: screenshotDeclarations.map(({ visualName }) => visualName),
      visualDeclarations: screenshotDeclarations,
      error: result.errors.length > 0 ? result.errors[0]?.message : undefined,
      duration: result.duration,
    }
    try {
      if (this.ci) {
        const baselineInput = result.status === 'passed' ? this.baselineInput(test, screenshotDeclarations) : null
        const resolvedTargets = baselineInput === null ? [] : resolveBaselineTargets(baselineInput)
        this.pendingArtifacts.push({
          testId: test.id,
          status: result.status,
          resolvedTargets,
          nativeAttachments,
          eventData: data,
        })
      } else if (this.portableArtifacts) {
        await mkdir(this.screenshotDir, { recursive: true })
        data.attachments = await saveAttachments(this.screenshotDir, test.id, { attachments: nativeAttachments })
      }
      this.send({ type: 'test-end', data })
    } finally {
      this.testMetadata.delete(test.id)
    }
  }
```

Note: `mkdir` is already imported at `src/reporter.ts:2`; `saveAttachments` is already imported at line 22.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tests && bun test reporter-portable-artifacts.test.ts`
Expected: PASS (2 tests)

Also confirm no regression in the existing reporter suites:

Run: `cd tests && bun test offline.test.ts offline-artifact.test.ts offline-reports.test.ts report-persistence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx oxfmt --write src/reporter.ts tests/reporter-portable-artifacts.test.ts
git add src/reporter.ts tests/reporter-portable-artifacts.test.ts
git commit -m "feat(reporter): portable artifacts mode via CRVY_RPRTR_PORTABLE_ARTIFACTS"
```

---

### Task 2: RunLauncher interface, LocalLauncher, RunController refactor

**Files:**

- Create: `src/server/run-launcher.ts`
- Modify: `src/server/run-controller.ts` (deps, `start`, `stop`, `dispose`; move `buildSpawnEnv`/`resolvePlaywrightLaunch` out)
- Modify: `src/server/app.ts:217-239` (`createServerRunController` passes a launcher)
- Test: `tests/run-launcher.test.ts` (new), `tests/run-controller.test.ts` (fixture swap)

**Interfaces:**

- Consumes: nothing from other plan tasks.
- Produces (every later task relies on these exact names):
  - `LaunchSpec` = `{ cmd: string; args: string[]; env: Record<string, string | undefined> }`
  - `LaunchParams` = `{ ctx: RunContext; playwrightArgs: string[] }`
  - `RunLauncher` = `{ readonly mode: 'local' | 'docker'; readonly available?: boolean; prepare?(params: { ctx: RunContext; onProgress: (phase: string) => void }): Promise<void>; launch(params: LaunchParams): LaunchSpec; onForceKill?(): void }`
  - `createLocalLauncher(options: { port: number; resolveLaunch?: (cwd: string, playwrightArgs: string[]) => { cmd: string; args: string[] }; env?: Record<string, string | undefined> }): RunLauncher`
  - `buildSpawnEnv(port: number, baseEnv?: Record<string, string | undefined>): Record<string, string | undefined>`
  - `resolvePlaywrightLaunch(cwd: string, playwrightArgs: string[]): { cmd: string; args: string[] }` (moved; re-exported from `run-controller.ts` for compatibility)
  - `RunControllerDeps.launcher: RunLauncher` (replaces `resolveLaunch`)
  - `StartResult` gains reason `'docker-unavailable'`

- [ ] **Step 1: Write the failing tests**

Create `tests/run-launcher.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import {
  buildSpawnEnv,
  createLocalLauncher,
  resolvePlaywrightLaunch,
  type LaunchParams,
} from '../src/server/run-launcher'
import type { RunContext } from '../src/server/run-controller'

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

function params(playwrightArgs: string[]): LaunchParams {
  return { ctx: SAMPLE_CTX, playwrightArgs }
}

describe('buildSpawnEnv', () => {
  test('strips CI and sets reporter URL and HTML_OPEN', () => {
    const env = buildSpawnEnv(3000, { CI: 'true', KEEP_ME: '1' })
    expect(env.CI).toBeUndefined()
    expect(env.KEEP_ME).toBe('1')
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(env.PLAYWRIGHT_HTML_OPEN).toBe('never')
  })

  test('defaults to process.env', () => {
    const env = buildSpawnEnv(4100)
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:4100')
  })
})

describe('resolvePlaywrightLaunch', () => {
  test('falls back to npx when no package manager is detectable', () => {
    const saved = process.env.npm_config_user_agent
    try {
      delete process.env.npm_config_user_agent
      const result = resolvePlaywrightLaunch('/any/cwd', ['test', '--config', 'x.ts'])
      expect(result.cmd).toBe('npx')
      expect(result.args).toEqual(['playwright', 'test', '--config', 'x.ts'])
    } finally {
      if (saved !== undefined) process.env.npm_config_user_agent = saved
    }
  })
})

describe('createLocalLauncher', () => {
  test('mode is local and available is undefined', () => {
    const launcher = createLocalLauncher({ port: 3000, env: {} })
    expect(launcher.mode).toBe('local')
    expect(launcher.available).toBeUndefined()
  })

  test('launch resolves the command and attaches the spawn env', () => {
    const launcher = createLocalLauncher({
      port: 3000,
      env: { CI: 'true' },
      resolveLaunch: (cwd, args) => ({ cmd: 'pnpm', args: ['exec', 'playwright', ...args] }),
    })
    const spec = launcher.launch(params(['test', '--config', 'x.ts']))
    expect(spec.cmd).toBe('pnpm')
    expect(spec.args).toEqual(['exec', 'playwright', 'test', '--config', 'x.ts'])
    expect(spec.env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(spec.env.CI).toBeUndefined()
  })

  test('launch defaults to the package-manager-aware resolver', () => {
    const saved = process.env.npm_config_user_agent
    try {
      delete process.env.npm_config_user_agent
      const launcher = createLocalLauncher({ port: 3000, env: {} })
      const spec = launcher.launch(params(['test']))
      expect(spec.cmd).toBe('npx')
      expect(spec.args).toEqual(['playwright', 'test'])
    } finally {
      if (saved !== undefined) process.env.npm_config_user_agent = saved
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && bun test run-launcher.test.ts`
Expected: FAIL — `Cannot find module '../src/server/run-launcher'`

- [ ] **Step 3: Create `src/server/run-launcher.ts`**

```ts
import { resolveCommand } from 'package-manager-detector/commands'
import { getUserAgent } from 'package-manager-detector/detect'

import type { RunContext } from './run-controller.ts'

export interface LaunchSpec {
  cmd: string
  args: string[]
  env: Record<string, string | undefined>
}

export interface LaunchParams {
  ctx: RunContext
  playwrightArgs: string[]
}

export interface RunLauncher {
  readonly mode: 'local' | 'docker'
  /** false once a docker probe/pull has failed; undefined for local or unprobed. */
  readonly available?: boolean
  /** Docker: probe the daemon, resolve image and container command, pull if missing. */
  prepare?(params: { ctx: RunContext; onProgress: (phase: string) => void }): Promise<void>
  launch(params: LaunchParams): LaunchSpec
  /** Docker: best-effort removal of the named container on the SIGKILL path. */
  onForceKill?(): void
}

/**
 * Resolves the `playwright` launch command for the project's package manager.
 * `cwd` is reserved for future cwd-based detection (`package-manager-detector`'s
 * `detect` is async in v1.x and cannot run in the synchronous `start()` path),
 * so today detection uses the synchronous `getUserAgent()`, matching Creevey's
 * spawn pattern. Falls back to `npx` when no agent is detectable.
 */
export function resolvePlaywrightLaunch(cwd: string, playwrightArgs: string[]): { cmd: string; args: string[] } {
  const agent = getUserAgent()
  const resolved = agent === null ? null : resolveCommand(agent, 'execute-local', ['playwright', ...playwrightArgs])
  if (resolved !== null) return { cmd: resolved.command, args: resolved.args }
  return { cmd: 'npx', args: ['playwright', ...playwrightArgs] }
}

export function buildSpawnEnv(
  port: number,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === 'CI') continue
    env[key] = value
  }
  env.CRVY_RPRTR_SERVER_URL = `ws://localhost:${port}`
  env.PLAYWRIGHT_HTML_OPEN = 'never'
  return env
}

export interface LocalLauncherOptions {
  port: number
  resolveLaunch?: (cwd: string, playwrightArgs: string[]) => { cmd: string; args: string[] }
  env?: Record<string, string | undefined>
}

export function createLocalLauncher(options: LocalLauncherOptions): RunLauncher {
  return {
    mode: 'local',
    launch({ ctx, playwrightArgs }: LaunchParams): LaunchSpec {
      const resolve = options.resolveLaunch ?? resolvePlaywrightLaunch
      const { cmd, args } = resolve(ctx.cwd, playwrightArgs)
      return { cmd, args, env: buildSpawnEnv(options.port, options.env) }
    },
  }
}
```

- [ ] **Step 4: Refactor `src/server/run-controller.ts` to consume the launcher**

Apply these edits:

1. Delete the `resolvePlaywrightLaunch` function (lines 66-78) and the `buildSpawnEnv` function (lines 152-161) — they now live in `run-launcher.ts`. Delete the now-unused imports `resolveCommand` (line 7) and `getUserAgent` (line 8).

2. Add to the import block at the top:

```ts
import { type RunLauncher } from './run-launcher.ts'

export { resolvePlaywrightLaunch } from './run-launcher.ts'
```

3. In `RunControllerDeps`, replace the `resolveLaunch` field (lines 51-52) with:

```ts
/** Builds the launch command and environment for a run. */
launcher: RunLauncher
```

4. In `StartResult`, extend the failure union:

```ts
export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'no-config' | 'already-running' | 'no-tests' | 'docker-unavailable' }
```

5. In `start()`, add the availability guard right after the `no-tests` check (after line 192):

```ts
if (this.deps.launcher.available === false) return { ok: false, reason: 'docker-unavailable' }
```

6. Replace the launch construction (lines 217-218) and spawn call (line 221):

```ts
const spec = this.deps.launcher.launch({ ctx, playwrightArgs: args })
let child: ChildProcessLike
try {
  child = this.deps.spawn(spec.cmd, spec.args, { cwd: ctx.cwd, env: spec.env, stdio: 'inherit' })
} catch (err) {
  this.cleanupTempFile()
  throw err
}
```

7. In `stop()`, extend the SIGKILL timer body (lines 243-245):

```ts
this.sigkillTimer = this.deps.timers.setTimeout(() => {
  if (this.child !== null) {
    this.child.kill('SIGKILL')
    this.deps.launcher.onForceKill?.()
  }
}, STOP_GRACE_MS)
```

8. In `dispose()`, after `this.child.kill('SIGKILL')` (line 253), add:

```ts
this.deps.launcher.onForceKill?.()
```

- [ ] **Step 5: Update `tests/run-controller.test.ts` fixture**

1. Change the import block (lines 1-13): remove `resolvePlaywrightLaunch` from the run-controller import; add:

```ts
import type { LaunchParams, LaunchSpec } from '../src/server/run-launcher'
```

2. In `createFixture`, replace the `resolveLaunch` dep (lines 103-104) with:

```ts
    launcher: {
      mode: 'local' as const,
      launch: ({ ctx, playwrightArgs }: LaunchParams): LaunchSpec => {
        const resolved =
          resolveLaunch?.(ctx.cwd, playwrightArgs) ?? { cmd: 'npx', args: ['playwright', ...playwrightArgs] }
        return { cmd: resolved.cmd, args: resolved.args, env: { STUB_ENV: '1' } }
      },
    },
```

3. In the happy-path test `spawns with --config and cwd on happy path` (lines 164-180), replace the three env assertions with:

```ts
const env = opts.env as Record<string, string | undefined>
expect(env.STUB_ENV).toBe('1')
```

(The real env-content assertions now live in `tests/run-launcher.test.ts`.)

4. Delete the `describe('resolvePlaywrightLaunch', …)` block (lines 402-414) — it moved to `run-launcher.test.ts`.

All other tests are untouched: the stub launcher defaults to `npx playwright …`, so every existing `spawnCalls` assertion still holds.

- [ ] **Step 6: Update `src/server/app.ts` to pass a launcher**

In `createServerRunController` (lines 217-239), add a `launcher: RunLauncher` parameter and include `launcher` in the deps object passed to `new RunController({...})`. In `createServerApp`, add the import and construct the local launcher for now (mode resolution arrives in Task 7):

```ts
import { createLocalLauncher, type RunLauncher } from './run-launcher.ts'
```

and inside `createServerApp`, before `createServerRunController(...)` is called:

```ts
const launcher: RunLauncher = createLocalLauncher({ port })
```

then pass `launcher` as the new argument.

- [ ] **Step 7: Run tests**

Run: `cd tests && bun test run-launcher.test.ts run-controller.test.ts`
Expected: PASS (all tests in both files)

Run: `cd tests && bun test server-handlers.test.ts server-routes.test.ts run-snapshot.test.ts`
Expected: PASS (no behavioral change visible outside the controller)

Run: `bun run typecheck && bun run lint`
Expected: both clean

- [ ] **Step 8: Commit**

```bash
bunx oxfmt --write src/server/run-launcher.ts src/server/run-controller.ts src/server/app.ts tests/run-launcher.test.ts tests/run-controller.test.ts
git add src/server/run-launcher.ts src/server/run-controller.ts src/server/app.ts tests/run-launcher.test.ts tests/run-controller.test.ts
git commit -m "refactor(run-controller): extract RunLauncher strategy with LocalLauncher"
```

---

### Task 3: `--update-snapshots` flag and `docker-unavailable` API reason

**Files:**

- Modify: `src/schemas/http.ts:22-36`
- Modify: `src/server/run-controller.ts:19-20` (`RunFilters`) and the `start()` arg construction
- Test: `tests/run-request-schema.test.ts` (new), `tests/run-controller.test.ts` (one new test)

**Interfaces:**

- Consumes: `RunControllerDeps.launcher` (Task 2).
- Produces: `RunFilters = { tests?: RunTestDescriptor[]; update?: boolean }`; `RunRequestBodySchema` with `update?: boolean`; `RunResponseSchema` reason enum including `'docker-unavailable'`; Playwright arg `--update-snapshots` appended after the `--reporter` arg when `update === true`.

- [ ] **Step 1: Write the failing tests**

Create `tests/run-request-schema.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { RunRequestBodySchema, RunResponseSchema, safeParse } from '../src/schemas'
import { handleRunRoutes } from '../src/server/run-routes'
import type { RunController } from '../src/server/run-controller'

describe('RunRequestBodySchema', () => {
  test('accepts update flag', () => {
    const parsed = safeParse(RunRequestBodySchema, { update: true })
    expect(parsed).toEqual({ update: true })
  })

  test('accepts tests with update', () => {
    const parsed = safeParse(RunRequestBodySchema, {
      update: true,
      tests: [{ file: 'a.spec.ts', line: 1, titlePath: ['t'] }],
    })
    expect(parsed?.update).toBe(true)
    expect(parsed?.tests).toHaveLength(1)
  })

  test('accepts empty body', () => {
    expect(safeParse(RunRequestBodySchema, {})).toEqual({})
  })
})

describe('RunResponseSchema', () => {
  test('accepts docker-unavailable reason', () => {
    const parsed = safeParse(RunResponseSchema, { ok: false, reason: 'docker-unavailable' })
    expect(parsed).toEqual({ ok: false, reason: 'docker-unavailable' })
  })
})

describe('handleRunRoutes docker-unavailable mapping', () => {
  test('returns 409 when the controller reports docker-unavailable', async () => {
    const fakeController = {
      start: () => ({ ok: false as const, reason: 'docker-unavailable' as const }),
      stop: () => ({ ok: false as const, reason: 'not-running' as const }),
      prepareRun: () => Promise.resolve({ ok: true as const }),
    }
    const response = await handleRunRoutes(
      '/api/run',
      'POST',
      fakeController as unknown as RunController,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
    )
    expect(response).not.toBeNull()
    expect(response!.status).toBe(409)
    expect(await response!.json()).toEqual({ ok: false, reason: 'docker-unavailable' })
  })
})
```

Add to the `describe('RunController.start')` block in `tests/run-controller.test.ts`:

```ts
test('appends --update-snapshots when update is true', () => {
  const f = createFixture(SAMPLE_CTX, () => null)
  f.controller.start({ update: true })
  expect(f.spawnCalls[0]!.args).toEqual([
    'playwright',
    'test',
    '--config',
    '/proj/playwright.config.ts',
    '--update-snapshots',
  ])
})

test('refuses with docker-unavailable when the launcher is unavailable', () => {
  const f = createFixture(SAMPLE_CTX)
  f.setLauncherAvailable(false)
  const result = f.controller.start({})
  expect(result).toEqual({ ok: false, reason: 'docker-unavailable' })
  expect(f.spawnCalls).toHaveLength(0)
})
```

The second test needs a fixture seam. In `createFixture` (`tests/run-controller.test.ts`), add a mutable flag and expose a setter: declare `let launcherAvailable: boolean | undefined` next to `let resolveLaunch …`; make the stub launcher a getter-based object:

```ts
    launcher: {
      mode: 'local' as const,
      get available(): boolean | undefined {
        return launcherAvailable
      },
      launch: ({ ctx, playwrightArgs }: LaunchParams): LaunchSpec => {
        const resolved =
          resolveLaunch?.(ctx.cwd, playwrightArgs) ?? { cmd: 'npx', args: ['playwright', ...playwrightArgs] }
        return { cmd: resolved.cmd, args: resolved.args, env: { STUB_ENV: '1' } }
      },
    },
```

and add to the returned fixture object:

```ts
    setLauncherAvailable: (value: boolean | undefined): void => {
      launcherAvailable = value
    },
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test run-request-schema.test.ts run-controller.test.ts`
Expected: FAIL — `update` is stripped by the schema (`toEqual({ update: true })` fails), `docker-unavailable` is rejected by `RunResponseSchema`, the run-controller tests fail to compile (`update` unknown on `RunFilters`, `setLauncherAvailable` missing), and the route test fails to compile (`prepareRun` missing on the fake).

- [ ] **Step 3: Implement schema changes**

In `src/schemas/http.ts`, replace `RunRequestBodySchema` (lines 22-24) and `RunResponseSchema` (lines 28-34):

```ts
export const RunRequestBodySchema = z.object({
  tests: z.array(RunTestDescriptorSchema).optional(),
  update: z.boolean().optional(),
})

export type RunRequestBody = z.infer<typeof RunRequestBodySchema>

export const RunResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no-config', 'already-running', 'no-tests', 'docker-unavailable']),
  }),
])
```

- [ ] **Step 4: Implement controller changes**

In `src/server/run-controller.ts`:

1. Extend `RunFilters` (lines 18-20):

```ts
export interface RunFilters {
  tests?: RunTestDescriptor[]
  update?: boolean
}
```

2. In `start()`, after the `--reporter` push (line 200), add:

```ts
if (filters.update === true) args.push('--update-snapshots')
```

3. Add a `prepareRun` method used by the routes (real preparation arrives with DockerLauncher; for LocalLauncher it is a no-op). Insert after `stop()`:

```ts
  async prepareRun(): Promise<{ ok: true } | { ok: false; reason: 'docker-unavailable' }> {
    const launcher = this.deps.launcher
    if (launcher.prepare === undefined) return { ok: true }
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: true }
    try {
      await launcher.prepare({
        ctx,
        onProgress: () => {
          // Task 4 widens this payload with mode and phase.
          this.deps.broadcast({ type: 'run-status', data: { running: true } })
        },
      })
      return { ok: true }
    } catch (error) {
      // Task 4 widens this payload with mode.
      this.deps.broadcast({ type: 'run-status', data: { running: false } })
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[RunController] run preparation failed: ${message}`)
      return { ok: false, reason: 'docker-unavailable' }
    }
  }
```

The `onProgress` parameter is intentionally unused at this point (prefix-free name keeps the diff minimal; Task 4 replaces both broadcast bodies with the `mode`/`phase`-carrying versions).

- [ ] **Step 5: Wire `prepareRun` into the run route**

In `src/server/run-routes.ts`, replace `handleApiRun`:

```ts
async function handleApiRun(runController: RunController, req: Request): Promise<Response> {
  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Empty body is allowed; default to {}.
  }
  const parsed = safeParse(RunRequestBodySchema, body)
  if (parsed === null) {
    return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
  }
  const preparation = await runController.prepareRun()
  if (!preparation.ok) {
    return Response.json({ ok: false, reason: preparation.reason }, { status: 409 })
  }
  const result = runController.start(parsed)
  if (result.ok) return Response.json(result)
  const status = result.reason === 'no-tests' ? 400 : 409
  return Response.json(result, { status })
}
```

- [ ] **Step 6: Run tests**

Run: `cd tests && bun test run-request-schema.test.ts run-controller.test.ts`
Expected: PASS

Run: `bun run typecheck && bun run lint`
Expected: clean

- [ ] **Step 7: Commit**

```bash
bunx oxfmt --write src/schemas/http.ts src/server/run-controller.ts src/server/run-routes.ts tests/run-request-schema.test.ts tests/run-controller.test.ts
git add src/schemas/http.ts src/server/run-controller.ts src/server/run-routes.ts tests/run-request-schema.test.ts tests/run-controller.test.ts
git commit -m "feat(server): --update-snapshots run flag and docker-unavailable run reason"
```

---

### Task 4: run-status WebSocket payload extension

**Files:**

- Modify: `src/types.ts:93-99`
- Modify: `src/schemas.ts:154-159`
- Modify: `src/server/run-controller.ts` (three broadcast sites: `start`, `prepareRun` ×2, `handleChildExit`)
- Test: `tests/run-controller.test.ts` (assertion updates), `tests/run-request-schema.test.ts` (one new test)

**Interfaces:**

- Produces: run-status payload `{ running: boolean; mode?: 'local' | 'docker'; phase?: string }`. Task 9's UI consumes `phase === 'pulling'` and `mode`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/run-request-schema.test.ts`:

```ts
import { WebSocketMessageSchema } from '../src/schemas'

describe('WebSocketMessageSchema run-status', () => {
  test('accepts mode and phase', () => {
    const parsed = safeParse(WebSocketMessageSchema, {
      type: 'run-status',
      data: { running: true, mode: 'docker', phase: 'pulling' },
    })
    expect(parsed).toEqual({ type: 'run-status', data: { running: true, mode: 'docker', phase: 'pulling' } })
  })

  test('still accepts the bare payload', () => {
    const parsed = safeParse(WebSocketMessageSchema, { type: 'run-status', data: { running: false } })
    expect(parsed).toEqual({ type: 'run-status', data: { running: false } })
  })
})
```

Update the three broadcast assertions in `tests/run-controller.test.ts`:

1. `spawns with --config and cwd on happy path` — the broadcasts assertion becomes:

```ts
expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true, mode: 'local' } }])
```

2. `resets state on clean exit` — becomes:

```ts
expect(f.broadcasts).toEqual([
  { type: 'run-status', data: { running: true, mode: 'local' } },
  { type: 'run-status', data: { running: false, mode: 'local' } },
])
```

3. `treats spawn error event as immediate exit` — becomes:

```ts
expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false, mode: 'local' } })
```

4. `cleans up the temp file and propagates when spawn throws synchronously` — the negative assertion becomes:

```ts
expect(f.broadcasts).not.toContainEqual({ type: 'run-status', data: { running: true, mode: 'local' } })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test run-request-schema.test.ts run-controller.test.ts`
Expected: FAIL — schema strips `mode`/`phase`; broadcast payloads lack `mode`.

- [ ] **Step 3: Implement**

In `src/types.ts`, replace the run-status variant of `ClientWebSocketMessage` (line 99):

```ts
  | { type: 'run-status'; data: { running: boolean; mode?: 'local' | 'docker'; phase?: string } }
```

In `src/schemas.ts`, replace the run-status variant of `WebSocketMessageSchema` (lines 154-159):

```ts
  z.object({
    type: z.literal('run-status'),
    data: z.object({
      running: z.boolean(),
      mode: z.enum(['local', 'docker']).optional(),
      phase: z.string().optional(),
    }),
  }),
```

In `src/server/run-controller.ts`:

1. In `start()`, the success broadcast becomes:

```ts
this.deps.broadcast({ type: 'run-status', data: { running: true, mode: this.deps.launcher.mode } })
```

2. In `prepareRun()`, replace the whole `onProgress` handler (gaining the `phase` parameter):

```ts
        onProgress: (phase) => {
          this.deps.broadcast({ type: 'run-status', data: { running: true, mode: launcher.mode, phase } })
        },
```

and in the catch:

```ts
this.deps.broadcast({ type: 'run-status', data: { running: false, mode: launcher.mode } })
```

3. In `handleChildExit()`, the final broadcast becomes:

```ts
this.deps.broadcast({ type: 'run-status', data: { running: false, mode: this.deps.launcher.mode } })
```

- [ ] **Step 4: Run tests**

Run: `cd tests && bun test run-request-schema.test.ts run-controller.test.ts`
Expected: PASS

Run: `bun run typecheck && bun run lint`
Expected: clean

- [ ] **Step 5: Commit**

```bash
bunx oxfmt --write src/types.ts src/schemas.ts src/server/run-controller.ts tests/run-controller.test.ts tests/run-request-schema.test.ts
git add src/types.ts src/schemas.ts src/server/run-controller.ts tests/run-controller.test.ts tests/run-request-schema.test.ts
git commit -m "feat(server): carry run mode and phase in run-status broadcasts"
```

---

### Task 5: Docker support helpers

**Files:**

- Create: `src/server/docker-support.ts`
- Test: `tests/docker-support.test.ts`

**Interfaces:**

- Consumes: nothing from other plan tasks.
- Produces:
  - `DockerExecResult` = `{ exitCode: number; stdout: string; stderr: string }`
  - `DockerExec` = `(args: string[]) => Promise<DockerExecResult>`
  - `createDockerExec(): DockerExec`
  - `probeDockerDaemon(exec: DockerExec): Promise<boolean>`
  - `isDockerImagePresent(exec: DockerExec, image: string): Promise<boolean>`
  - `pullDockerImage(exec: DockerExec, image: string): Promise<boolean>`
  - `forceRemoveContainer(exec: DockerExec, name: string): Promise<void>`
  - `resolveDockerImage(options: { image?: string; version: string | null }): string | null`
  - `DEFAULT_CONTAINER_COMMAND: readonly string[]` (= `['npx']`)
  - `resolveContainerCommand(input: { command?: string[]; hasCustomImage: boolean; detectedAgentName?: string | null; warn?: (message: string) => void }): string[]`
  - `DetectedAgent` = `{ name: string; agent: string }`, `DetectAgent` = `(cwd: string) => Promise<DetectedAgent | null>`
  - `detectProjectAgent: DetectAgent`
  - `rewriteContainerPath(path: string, mapping: { from: string; to: string }): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/docker-support.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_CONTAINER_COMMAND,
  probeDockerDaemon,
  isDockerImagePresent,
  pullDockerImage,
  forceRemoveContainer,
  resolveContainerCommand,
  resolveDockerImage,
  rewriteContainerPath,
  type DockerExec,
  type DockerExecResult,
} from '../src/server/docker-support'

function fakeExec(script: Array<{ match: string[]; result: DockerExecResult }>): {
  exec: DockerExec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: DockerExec = (args) => {
    calls.push(args)
    const entry = script.find((s) => s.match.every((m, i) => args[i] === m))
    if (entry === undefined)
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` })
    return Promise.resolve(entry.result)
  }
  return { exec, calls }
}

const ok: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }
const fail: DockerExecResult = { exitCode: 1, stdout: '', stderr: 'boom' }

describe('probeDockerDaemon', () => {
  test('true when docker info succeeds', async () => {
    const { exec } = fakeExec([{ match: ['info'], result: ok }])
    expect(await probeDockerDaemon(exec)).toBe(true)
  })

  test('false when docker info fails', async () => {
    const { exec } = fakeExec([{ match: ['info'], result: fail }])
    expect(await probeDockerDaemon(exec)).toBe(false)
  })

  test('false when docker binary is missing (exec throws)', async () => {
    const exec: DockerExec = () => Promise.reject(new Error('ENOENT'))
    expect(await probeDockerDaemon(exec)).toBe(false)
  })
})

describe('isDockerImagePresent / pullDockerImage', () => {
  test('image inspect exit code drives presence', async () => {
    const present = fakeExec([{ match: ['image', 'inspect', 'img:1'], result: ok }])
    expect(await isDockerImagePresent(present.exec, 'img:1')).toBe(true)
    const missing = fakeExec([{ match: ['image', 'inspect', 'img:1'], result: fail }])
    expect(await isDockerImagePresent(missing.exec, 'img:1')).toBe(false)
  })

  test('pull success and failure', async () => {
    const good = fakeExec([{ match: ['pull', 'img:1'], result: ok }])
    expect(await pullDockerImage(good.exec, 'img:1')).toBe(true)
    const bad = fakeExec([{ match: ['pull', 'img:1'], result: fail }])
    expect(await pullDockerImage(bad.exec, 'img:1')).toBe(false)
  })
})

describe('forceRemoveContainer', () => {
  test('issues docker rm -f and never throws', async () => {
    const { exec, calls } = fakeExec([{ match: ['rm', '-f', 'c1'], result: fail }])
    await forceRemoveContainer(exec, 'c1')
    expect(calls).toEqual([['rm', '-f', 'c1']])
    const throwing: DockerExec = () => Promise.reject(new Error('gone'))
    await forceRemoveContainer(throwing, 'c1')
  })
})

describe('resolveDockerImage', () => {
  test('explicit image wins', () => {
    expect(resolveDockerImage({ image: 'custom/img:1', version: '1.59.0' })).toBe('custom/img:1')
  })

  test('derives the official tag from the installed version', () => {
    expect(resolveDockerImage({ version: '1.59.0' })).toBe('mcr.microsoft.com/playwright:v1.59.0-noble')
  })

  test('null when neither image nor version is resolvable', () => {
    expect(resolveDockerImage({ version: null })).toBeNull()
  })
})

describe('resolveContainerCommand', () => {
  test('explicit command wins over everything', () => {
    expect(resolveContainerCommand({ command: ['bunx'], hasCustomImage: true, detectedAgentName: 'npm' })).toEqual([
      'bunx',
    ])
  })

  test('default image always uses npx regardless of detected agent', () => {
    const warnings: string[] = []
    expect(
      resolveContainerCommand({ hasCustomImage: false, detectedAgentName: 'bun', warn: (m) => warnings.push(m) }),
    ).toEqual([...DEFAULT_CONTAINER_COMMAND])
    expect(warnings).toHaveLength(0)
  })

  test('custom image maps the detected agent to its invoker', () => {
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'pnpm' })).toEqual(['pnpm', 'exec'])
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'yarn' })).toEqual(['yarn'])
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'bun' })).toEqual(['bunx'])
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'npm' })).toEqual(['npx'])
  })

  test('custom image with undetectable agent falls back to npx with a warning', () => {
    const warnings: string[] = []
    expect(
      resolveContainerCommand({ hasCustomImage: true, detectedAgentName: null, warn: (m) => warnings.push(m) }),
    ).toEqual(['npx'])
    expect(warnings).toHaveLength(1)
  })

  test('custom image with unknown agent falls back to npx with a warning', () => {
    const warnings: string[] = []
    expect(
      resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'deno', warn: (m) => warnings.push(m) }),
    ).toEqual(['npx'])
    expect(warnings).toHaveLength(1)
  })
})

describe('rewriteContainerPath', () => {
  const mapping = { from: '/work', to: '/host/proj' }

  test('rewrites the root and descendants', () => {
    expect(rewriteContainerPath('/work', mapping)).toBe('/host/proj')
    expect(rewriteContainerPath('/work/tests/x.spec.ts', mapping)).toBe('/host/proj/tests/x.spec.ts')
  })

  test('leaves unrelated and prefix-like paths alone', () => {
    expect(rewriteContainerPath('/other/x', mapping)).toBe('/other/x')
    expect(rewriteContainerPath('/workspace/x', mapping)).toBe('/workspace/x')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && bun test docker-support.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/server/docker-support.ts`**

```ts
import { spawn } from 'child_process'

import { detect } from 'package-manager-detector/detect'

export interface DockerExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type DockerExec = (args: string[]) => Promise<DockerExecResult>

export function createDockerExec(): DockerExec {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        })
      })
    })
}

export async function probeDockerDaemon(exec: DockerExec): Promise<boolean> {
  try {
    const result = await exec(['info'])
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function isDockerImagePresent(exec: DockerExec, image: string): Promise<boolean> {
  try {
    const result = await exec(['image', 'inspect', image])
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function pullDockerImage(exec: DockerExec, image: string): Promise<boolean> {
  try {
    const result = await exec(['pull', image])
    return result.exitCode === 0
  } catch {
    return false
  }
}

export async function forceRemoveContainer(exec: DockerExec, name: string): Promise<void> {
  try {
    await exec(['rm', '-f', name])
  } catch {
    // Best-effort cleanup — the container may already be gone.
  }
}

export function resolveDockerImage(options: { image?: string; version: string | null }): string | null {
  if (options.image !== undefined && options.image !== '') return options.image
  if (options.version === null) return null
  return `mcr.microsoft.com/playwright:v${options.version}-noble`
}

/**
 * Container-side invokers per package manager, mirroring
 * `package-manager-detector`'s `execute-local` resolution. Only these four
 * agents are supported inside containers; anything else falls back to npx.
 * Module-private: consumed only by resolveContainerCommand.
 */
const CONTAINER_INVOKERS: Record<string, readonly string[]> = {
  npm: ['npx'],
  pnpm: ['pnpm', 'exec'],
  yarn: ['yarn'],
  bun: ['bunx'],
}

export const DEFAULT_CONTAINER_COMMAND: readonly string[] = ['npx']

export function resolveContainerCommand(input: {
  command?: string[]
  hasCustomImage: boolean
  detectedAgentName?: string | null
  warn?: (message: string) => void
}): string[] {
  if (input.command !== undefined && input.command.length > 0) return input.command
  // The default MS Playwright image only guarantees Node/npm.
  if (!input.hasCustomImage) return [...DEFAULT_CONTAINER_COMMAND]
  if (input.detectedAgentName === undefined || input.detectedAgentName === null) {
    input.warn?.('Could not detect a package manager for the custom docker image; falling back to npx.')
    return [...DEFAULT_CONTAINER_COMMAND]
  }
  const invoker = CONTAINER_INVOKERS[input.detectedAgentName]
  if (invoker === undefined) {
    input.warn?.(`Package manager "${input.detectedAgentName}" is not supported in docker mode; falling back to npx.`)
    return [...DEFAULT_CONTAINER_COMMAND]
  }
  return [...invoker]
}

export interface DetectedAgent {
  name: string
  agent: string
}

export type DetectAgent = (cwd: string) => Promise<DetectedAgent | null>

export const detectProjectAgent: DetectAgent = async (cwd) => {
  try {
    const result = await detect({ cwd, strategies: ['lockfile', 'packageManager-field'] })
    return result === null ? null : { name: result.name, agent: result.agent }
  } catch {
    return null
  }
}

/**
 * Maps an absolute path from the container's mount namespace back to the host.
 * Only exact matches and direct descendants of `mapping.from` are rewritten;
 * prefix lookalikes like `/workspace` are left untouched.
 */
export function rewriteContainerPath(path: string, mapping: { from: string; to: string }): string {
  if (path === mapping.from) return mapping.to
  if (path.startsWith(`${mapping.from}/`)) return mapping.to + path.slice(mapping.from.length)
  return path
}
```

- [ ] **Step 4: Run tests**

Run: `cd tests && bun test docker-support.test.ts`
Expected: PASS

Run: `bun run typecheck && bun run lint`
Expected: clean (note: `spawn` from `child_process` and `detect` are already used elsewhere in the repo — `run-controller.ts` and `run-launcher.ts` — so no new dependency)

- [ ] **Step 5: Commit**

```bash
bunx oxfmt --write src/server/docker-support.ts tests/docker-support.test.ts
git add src/server/docker-support.ts tests/docker-support.test.ts
git commit -m "feat(server): docker CLI helpers and container command resolution"
```

---

### Task 6: DockerLauncher

**Files:**

- Modify: `src/server/run-controller.ts` — export `resolvePlaywrightVersion` (currently private at lines 100-111)
- Create: `src/server/docker-launcher.ts`
- Test: `tests/docker-launcher.test.ts`

**Interfaces:**

- Consumes: `RunLauncher`/`LaunchSpec`/`LaunchParams` (Task 2); `DockerExec`, probes, `resolveDockerImage`, `resolveContainerCommand`, `detectProjectAgent`, `forceRemoveContainer`, `DEFAULT_CONTAINER_COMMAND` (Task 5); `resolvePlaywrightVersion` (exported this task).
- Produces:
  - `DockerOptions` = `{ image?: string; platform?: 'linux/amd64' | 'linux/arm64'; command?: string[]; extraArgs?: string[] }`
  - `DOCKER_WORK_DIR` = `'/work'` (consumed by `app.ts` for the path mapping and by tests)
  - `DockerUnavailableError`
  - `createDockerLauncher(options: DockerLauncherOptions): RunLauncher` where `DockerLauncherOptions` = `{ port: number; docker?: DockerOptions; getPlaywrightVersion?: (cwd: string) => string | null; exec?: DockerExec; detectAgent?: DetectAgent; env?: Record<string, string | undefined>; containerName?: string; workDir?: string; warn?: (message: string) => void }`

- [ ] **Step 1: Write the failing tests**

Create `tests/docker-launcher.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { createDockerLauncher, DockerUnavailableError, DOCKER_WORK_DIR } from '../src/server/docker-launcher'
import type { DockerExec, DockerExecResult } from '../src/server/docker-support'
import type { RunContext } from '../src/server/run-controller'

const CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

const ok: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }
const fail: DockerExecResult = { exitCode: 1, stdout: '', stderr: 'no' }

function execScript(handlers: Record<string, DockerExecResult>): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: DockerExec = (args) => {
    calls.push(args)
    const key = args.slice(0, 2).join(' ')
    return Promise.resolve(handlers[key] ?? handlers[args[0]!] ?? fail)
  }
  return { exec, calls }
}

function makeLauncher(overrides: Partial<Parameters<typeof createDockerLauncher>[0]> = {}) {
  const { exec, calls } =
    overrides.exec === undefined ? execScript({ info: ok, 'image inspect': ok }) : { exec: overrides.exec, calls: [] }
  const launcher = createDockerLauncher({
    port: 3000,
    getPlaywrightVersion: () => '1.59.0',
    env: {},
    containerName: 'test-container',
    exec,
    ...overrides,
  })
  return { launcher, calls }
}

const noopProgress = (): void => {}

describe('DockerLauncher.prepare', () => {
  test('throws DockerUnavailableError and marks unavailable when the daemon is down', async () => {
    const { launcher } = makeLauncher({ exec: () => Promise.resolve(fail) })
    await expect(launcher.prepare!({ ctx: CTX, onProgress: noopProgress })).rejects.toBeInstanceOf(
      DockerUnavailableError,
    )
    expect(launcher.available).toBe(false)
  })

  test('marks available and skips the pull when the image is present', async () => {
    const { exec, calls } = execScript({ info: ok, 'image inspect': ok })
    const launcher = createDockerLauncher({
      port: 3000,
      getPlaywrightVersion: () => '1.59.0',
      env: {},
      containerName: 'c',
      exec,
    })
    const phases: string[] = []
    await launcher.prepare!({ ctx: CTX, onProgress: (p) => phases.push(p) })
    expect(launcher.available).toBe(true)
    expect(calls.some((c) => c[0] === 'pull')).toBe(false)
    expect(phases).toHaveLength(0)
  })

  test('pulls the image with a pulling phase when missing', async () => {
    const { exec, calls } = execScript({ info: ok, 'image inspect': fail, pull: ok })
    const launcher = createDockerLauncher({
      port: 3000,
      getPlaywrightVersion: () => '1.59.0',
      env: {},
      containerName: 'c',
      exec,
    })
    const phases: string[] = []
    await launcher.prepare!({ ctx: CTX, onProgress: (p) => phases.push(p) })
    expect(calls).toContainEqual(['pull', 'mcr.microsoft.com/playwright:v1.59.0-noble'])
    expect(phases).toEqual(['pulling'])
  })

  test('fails prepare when the image cannot be resolved', async () => {
    const { launcher } = makeLauncher({ getPlaywrightVersion: () => null })
    await expect(launcher.prepare!({ ctx: CTX, onProgress: noopProgress })).rejects.toThrow('docker.image')
  })

  test('resets after failure so a retry re-probes', async () => {
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
    })
    await expect(launcher.prepare!({ ctx: CTX, onProgress: noopProgress })).rejects.toBeInstanceOf(
      DockerUnavailableError,
    )
    daemonUp = true
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    expect(launcher.available).toBe(true)
  })
})

describe('DockerLauncher.launch', () => {
  test('builds the full docker run arg vector with defaults', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const spec = launcher.launch({ ctx: CTX, playwrightArgs: ['test', '--config', '/proj/playwright.config.ts'] })
    expect(spec.cmd).toBe('docker')
    expect(spec.args).toEqual([
      'run',
      '--rm',
      '--init',
      '--name',
      'test-container',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--ipc=host',
      '-v',
      `/proj:${DOCKER_WORK_DIR}:rw`,
      '-w',
      DOCKER_WORK_DIR,
      '-e',
      'CRVY_RPRTR_SERVER_URL=ws://host.docker.internal:3000',
      '-e',
      'CRVY_RPRTR_PORTABLE_ARTIFACTS=1',
      '-e',
      'TZ=UTC',
      '-e',
      'LANG=C.UTF-8',
      '-e',
      'LC_ALL=C.UTF-8',
      '-e',
      'PLAYWRIGHT_HTML_OPEN=never',
      'mcr.microsoft.com/playwright:v1.59.0-noble',
      'npx',
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
    ])
    expect(spec.env.CI).toBeUndefined()
  })

  test('passes user env through as name-only -e flags and filters the denylist', async () => {
    const { launcher } = makeLauncher({
      env: {
        API_KEY: 'secret',
        CI: 'true',
        PLAYWRIGHT_BROWSERS_PATH: '/host/cache',
        TZ: 'Berlin',
        CRVY_RPRTR_SERVER_URL: 'ws://evil',
        EMPTY: undefined,
      } as Record<string, string | undefined>,
    })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const spec = launcher.launch({ ctx: CTX, playwrightArgs: ['test'] })
    expect(spec.args).toContainEqual('-e')
    const envFlags = spec.args.filter((a, i) => i > 0 && spec.args[i - 1] === '-e')
    expect(envFlags).toContain('API_KEY')
    expect(envFlags).not.toContain('CI')
    expect(envFlags).not.toContain('PLAYWRIGHT_BROWSERS_PATH')
    expect(envFlags).not.toContain('TZ')
    expect(envFlags).not.toContain('CRVY_RPRTR_SERVER_URL')
    expect(envFlags).not.toContain('EMPTY')
    // The pinned values still come from explicit -e KEY=VALUE flags.
    expect(spec.args).toContain('TZ=UTC')
    expect(spec.args).toContain('CRVY_RPRTR_SERVER_URL=ws://host.docker.internal:3000')
  })

  test('includes --platform only when configured', async () => {
    const without = makeLauncher()
    await without.launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    expect(without.launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args).not.toContain('--platform')

    const withPlatform = makeLauncher({ docker: { platform: 'linux/amd64' } })
    await withPlatform.launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = withPlatform.launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args
    const idx = args.indexOf('--platform')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('linux/amd64')
  })

  test('extraArgs are appended before the image', async () => {
    const { launcher } = makeLauncher({ docker: { extraArgs: ['--memory', '2g'] } })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args
    const memoryIdx = args.indexOf('--memory')
    const imageIdx = args.indexOf('mcr.microsoft.com/playwright:v1.59.0-noble')
    expect(memoryIdx).toBeGreaterThan(-1)
    expect(memoryIdx).toBeLessThan(imageIdx)
  })

  test('custom image with detected pnpm uses pnpm exec inside the container', async () => {
    const { launcher } = makeLauncher({
      docker: { image: 'custom/pw-bun:1' },
      detectAgent: () => Promise.resolve({ name: 'pnpm', agent: 'pnpm' }),
    })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args
    const imageIdx = args.indexOf('custom/pw-bun:1')
    expect(args.slice(imageIdx + 1, imageIdx + 4)).toEqual(['pnpm', 'exec', 'playwright'])
  })

  test('explicit docker.command is used verbatim', async () => {
    const { launcher } = makeLauncher({
      docker: { image: 'custom/img:1', command: ['bunx'] },
      detectAgent: () => Promise.resolve({ name: 'npm', agent: 'npm' }),
    })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args
    const imageIdx = args.indexOf('custom/img:1')
    expect(args.slice(imageIdx + 1, imageIdx + 3)).toEqual(['bunx', 'playwright'])
  })

  test('custom image with undetectable agent falls back to npx and warns', async () => {
    const warnings: string[] = []
    const { launcher } = makeLauncher({
      docker: { image: 'custom/img:1' },
      detectAgent: () => Promise.resolve(null),
      warn: (m) => warnings.push(m),
    })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args
    const imageIdx = args.indexOf('custom/img:1')
    expect(args.slice(imageIdx + 1, imageIdx + 3)).toEqual(['npx', 'playwright'])
    expect(warnings).toHaveLength(1)
  })

  test('default image keeps npx even for a bun project', async () => {
    const { launcher } = makeLauncher({
      detectAgent: () => Promise.resolve({ name: 'bun', agent: 'bun' }),
    })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({ ctx: CTX, playwrightArgs: ['test'] }).args
    const imageIdx = args.indexOf('mcr.microsoft.com/playwright:v1.59.0-noble')
    expect(args.slice(imageIdx + 1, imageIdx + 3)).toEqual(['npx', 'playwright'])
  })
})

describe('DockerLauncher.onForceKill', () => {
  test('issues docker rm -f for the named container', async () => {
    const { exec, calls } = execScript({ info: ok, 'image inspect': ok, rm: ok })
    const launcher = createDockerLauncher({
      port: 3000,
      getPlaywrightVersion: () => '1.59.0',
      env: {},
      containerName: 'doomed',
      exec,
    })
    launcher.onForceKill!()
    // fire-and-forget: give the promise a tick
    await Promise.resolve()
    expect(calls).toContainEqual(['rm', '-f', 'doomed'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && bun test docker-launcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Export `resolvePlaywrightVersion` and create the launcher**

In `src/server/run-controller.ts`, change line 100 `function resolvePlaywrightVersion(` to `export function resolvePlaywrightVersion(`.

Create `src/server/docker-launcher.ts`:

```ts
import {
  createDockerExec,
  detectProjectAgent,
  forceRemoveContainer,
  isDockerImagePresent,
  probeDockerDaemon,
  pullDockerImage,
  resolveContainerCommand,
  resolveDockerImage,
  DEFAULT_CONTAINER_COMMAND,
  type DetectAgent,
  type DockerExec,
} from './docker-support.ts'
import type { RunContext } from './run-controller.ts'
import { resolvePlaywrightVersion } from './run-controller.ts'
import type { LaunchParams, LaunchSpec, RunLauncher } from './run-launcher.ts'

export const DOCKER_WORK_DIR = '/work'

/** Module-private: only the arg vector and server URL built here use it. */
const DOCKER_HOST_GATEWAY = 'host.docker.internal'

export interface DockerOptions {
  image?: string
  platform?: 'linux/amd64' | 'linux/arm64'
  command?: string[]
  extraArgs?: string[]
}

export interface DockerLauncherOptions {
  port: number
  docker?: DockerOptions
  getPlaywrightVersion?: (cwd: string) => string | null
  exec?: DockerExec
  detectAgent?: DetectAgent
  env?: Record<string, string | undefined>
  containerName?: string
  workDir?: string
  warn?: (message: string) => void
}

/** Never propagated into the container: host-specific or launcher-pinned values. */
const ENV_DENYLIST = new Set([
  'CI',
  'PLAYWRIGHT_BROWSERS_PATH',
  'CRVY_RPRTR_SERVER_URL',
  'CRVY_RPRTR_PORTABLE_ARTIFACTS',
  'TZ',
  'LANG',
  'LC_ALL',
  'PLAYWRIGHT_HTML_OPEN',
])

export class DockerUnavailableError extends Error {
  constructor() {
    super('Docker daemon is not available')
    this.name = 'DockerUnavailableError'
  }
}

export function createDockerLauncher(options: DockerLauncherOptions): RunLauncher {
  const exec = options.exec ?? createDockerExec()
  const workDir = options.workDir ?? DOCKER_WORK_DIR
  const containerName = options.containerName ?? `crvy-rprtr-run-${process.pid}`
  const baseEnv = options.env ?? process.env
  const getVersion = options.getPlaywrightVersion ?? resolvePlaywrightVersion
  const warn = options.warn ?? ((message: string): void => console.warn(`[crvy-rprtr] ${message}`))

  let available: boolean | undefined
  let prepared: Promise<void> | null = null
  let resolvedImage: string | null = null
  let resolvedCommand: readonly string[] = options.docker?.command ?? DEFAULT_CONTAINER_COMMAND

  async function prepareOnce(ctx: RunContext, onProgress: (phase: string) => void): Promise<void> {
    if (!(await probeDockerDaemon(exec))) {
      available = false
      throw new DockerUnavailableError()
    }
    available = true

    resolvedImage = resolveDockerImage({ image: options.docker?.image, version: getVersion(ctx.cwd) })
    if (resolvedImage === null) {
      throw new Error('Could not resolve the installed @playwright/test version; set docker.image explicitly.')
    }

    resolvedCommand = resolveContainerCommand({
      command: options.docker?.command,
      hasCustomImage: options.docker?.image !== undefined,
      detectedAgentName: options.docker?.image === undefined ? 'npm' : await detectAgentName(ctx.cwd),
      warn,
    })

    if (!(await isDockerImagePresent(exec, resolvedImage))) {
      onProgress('pulling')
      if (!(await pullDockerImage(exec, resolvedImage))) {
        throw new Error(`Failed to pull docker image: ${resolvedImage}`)
      }
    }
  }

  async function detectAgentName(cwd: string): Promise<string | null> {
    const detected = await (options.detectAgent ?? detectProjectAgent)(cwd)
    return detected?.name ?? null
  }

  return {
    mode: 'docker',
    get available(): boolean | undefined {
      return available
    },
    prepare({ ctx, onProgress }): Promise<void> {
      if (prepared === null) {
        prepared = prepareOnce(ctx, onProgress).catch((error: unknown) => {
          // Reset so a later run re-probes after the user fixes the problem.
          prepared = null
          throw error
        })
      }
      return prepared
    },
    launch({ ctx, playwrightArgs }: LaunchParams): LaunchSpec {
      const image = resolvedImage ?? resolveDockerImage({ image: options.docker?.image, version: getVersion(ctx.cwd) })
      if (image === null) {
        throw new Error('Could not resolve the docker image; run prepare() first or set docker.image.')
      }

      const args = [
        'run',
        '--rm',
        '--init',
        '--name',
        containerName,
        '--add-host',
        `${DOCKER_HOST_GATEWAY}:host-gateway`,
        '--ipc=host',
      ]
      if (options.docker?.platform !== undefined) {
        args.push('--platform', options.docker.platform)
      }
      args.push('-v', `${ctx.cwd}:${workDir}:rw`, '-w', workDir)
      args.push('-e', `CRVY_RPRTR_SERVER_URL=ws://${DOCKER_HOST_GATEWAY}:${options.port}`)
      args.push('-e', 'CRVY_RPRTR_PORTABLE_ARTIFACTS=1')
      args.push('-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
      args.push('-e', 'PLAYWRIGHT_HTML_OPEN=never')
      for (const [key, value] of Object.entries(baseEnv)) {
        if (ENV_DENYLIST.has(key) || value === undefined) continue
        args.push('-e', key)
      }
      if (options.docker?.extraArgs !== undefined) args.push(...options.docker.extraArgs)
      args.push(image, ...resolvedCommand, 'playwright', ...playwrightArgs)

      const env: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(baseEnv)) {
        if (key === 'CI') continue
        env[key] = value
      }
      return { cmd: 'docker', args, env }
    },
    onForceKill(): void {
      void forceRemoveContainer(exec, containerName)
    },
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd tests && bun test docker-launcher.test.ts docker-support.test.ts`
Expected: PASS

Run: `bun run typecheck && bun run lint`
Expected: clean

- [ ] **Step 5: Commit**

```bash
bunx oxfmt --write src/server/docker-launcher.ts src/server/run-controller.ts tests/docker-launcher.test.ts
git add src/server/docker-launcher.ts src/server/run-controller.ts tests/docker-launcher.test.ts
git commit -m "feat(server): DockerLauncher spawning playwright runs in containers"
```

---

### Task 7: Mode resolution, server wiring, and CLI flags

**Files:**

- Create: `src/server/run-mode.ts`
- Modify: `src/server/app.ts` (ServerOptions, launcher selection, `runInfo`/`containerPathMapping`)
- Modify: `src/server/routes-context.ts` (options), `src/server/routes.ts` (`RoutesContext`, `/api/report`)
- Modify: `src/schemas.ts:249-256` (`ReportApiResponseSchema`)
- Modify: `src/cli.ts` (flags, help)
- Test: `tests/run-mode.test.ts` (new), `tests/cli.test.ts` (extend)

**Interfaces:**

- Consumes: `createDockerLauncher`, `DockerOptions`, `DOCKER_WORK_DIR` (Task 6); `createDockerExec`, `probeDockerDaemon` (Task 5); `createLocalLauncher` (Task 2).
- Produces:
  - `RunMode` = `'local' | 'docker' | 'auto'`, `ResolvedRunMode` = `'local' | 'docker'`
  - `resolveRunMode(options: { runMode: RunMode; isCI: boolean; probeDocker: () => Promise<boolean>; warn?: (message: string) => void }): Promise<ResolvedRunMode>`
  - `ServerOptions.runMode?: RunMode`; `ServerOptions.docker?: DockerOptions`
  - `RoutesContext.runInfo?: { mode: ResolvedRunMode }`; `RoutesContext.containerPathMapping?: { from: string; to: string }`
  - `/api/report` response gains `runMode?: 'local' | 'docker'`
  - CLI: `--run-mode`, `--docker-image`, `--docker-platform`

- [ ] **Step 1: Write the failing tests**

Create `tests/run-mode.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { resolveRunMode } from '../src/server/run-mode'

describe('resolveRunMode', () => {
  test('explicit local never probes docker', async () => {
    let probed = false
    const mode = await resolveRunMode({
      runMode: 'local',
      isCI: false,
      probeDocker: () => {
        probed = true
        return Promise.resolve(true)
      },
    })
    expect(mode).toBe('local')
    expect(probed).toBe(false)
  })

  test('explicit docker never probes at resolution time', async () => {
    let probed = false
    const mode = await resolveRunMode({
      runMode: 'docker',
      isCI: false,
      probeDocker: () => {
        probed = true
        return Promise.resolve(false)
      },
    })
    expect(mode).toBe('docker')
    expect(probed).toBe(false)
  })

  test('auto resolves to local on CI without probing', async () => {
    let probed = false
    const mode = await resolveRunMode({
      runMode: 'auto',
      isCI: true,
      probeDocker: () => {
        probed = true
        return Promise.resolve(true)
      },
    })
    expect(mode).toBe('local')
    expect(probed).toBe(false)
  })

  test('auto resolves to docker when the daemon is reachable', async () => {
    const mode = await resolveRunMode({ runMode: 'auto', isCI: false, probeDocker: () => Promise.resolve(true) })
    expect(mode).toBe('docker')
  })

  test('auto falls back to local with a warning when the daemon is down', async () => {
    const warnings: string[] = []
    const mode = await resolveRunMode({
      runMode: 'auto',
      isCI: false,
      probeDocker: () => Promise.resolve(false),
      warn: (m) => warnings.push(m),
    })
    expect(mode).toBe('local')
    expect(warnings).toHaveLength(1)
  })
})
```

Add to `tests/cli.test.ts` inside `describe('resolveCliOptions')`:

```ts
test('--run-mode accepts local, docker, auto', () => {
  expect(resolveCliOptions(['--run-mode', 'docker']).runMode).toBe('docker')
  expect(resolveCliOptions(['--run-mode', 'local']).runMode).toBe('local')
  expect(resolveCliOptions(['--run-mode', 'auto']).runMode).toBe('auto')
})

test('--run-mode rejects unknown values', () => {
  expect(() => resolveCliOptions(['--run-mode', 'podman'])).toThrow('Invalid --run-mode')
})

test('runMode is undefined when omitted', () => {
  expect(resolveCliOptions([]).runMode).toBeUndefined()
})

test('--docker-image and --docker-platform assemble the docker options', () => {
  expect(resolveCliOptions(['--docker-image', 'custom/img:1', '--docker-platform', 'linux/arm64']).docker).toEqual({
    image: 'custom/img:1',
    platform: 'linux/arm64',
  })
})

test('--docker-platform rejects unknown values', () => {
  expect(() => resolveCliOptions(['--docker-platform', 'windows'])).toThrow('Invalid --docker-platform')
})

test('docker options are undefined when no docker flags are given', () => {
  expect(resolveCliOptions([]).docker).toBeUndefined()
})
```

And extend the HELP_TEXT token loop's test by adding a dedicated test:

```ts
test('HELP_TEXT documents the docker flags', () => {
  for (const token of ['--run-mode', '--docker-image', '--docker-platform']) {
    expect(HELP_TEXT).toContain(token)
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tests && bun test run-mode.test.ts cli.test.ts`
Expected: FAIL — `run-mode` module missing; new CLI flags unimplemented.

- [ ] **Step 3: Create `src/server/run-mode.ts`**

```ts
export type RunMode = 'local' | 'docker' | 'auto'
export type ResolvedRunMode = 'local' | 'docker'

export interface ResolveRunModeOptions {
  runMode: RunMode
  isCI: boolean
  probeDocker: () => Promise<boolean>
  warn?: (message: string) => void
}

/**
 * Resolves the effective run mode. Explicit modes never probe; auto runs local
 * on CI (the runner already is the pinned environment) and otherwise probes
 * the docker daemon once, warning when it falls back to local.
 */
export async function resolveRunMode(options: ResolveRunModeOptions): Promise<ResolvedRunMode> {
  if (options.runMode === 'local') return 'local'
  if (options.runMode === 'docker') return 'docker'
  if (options.isCI) return 'local'
  if (await options.probeDocker()) return 'docker'
  options.warn?.(
    'Docker daemon unavailable — running tests locally; screenshots may differ from CI. Use --run-mode local to silence this warning.',
  )
  return 'local'
}
```

- [ ] **Step 4: Wire the server**

1. In `src/server/routes.ts`, extend `RoutesContext` (lines 10-29) with:

```ts
  runInfo?: { mode: 'local' | 'docker' }
  containerPathMapping?: { from: string; to: string }
```

and in `handleApiReport` (lines 56-61), include the mode:

```ts
function handleApiReport(ctx: RoutesContext): Response {
  return Response.json({
    ...ctx.reportData,
    runEnabled: ctx.runContext !== undefined,
    runMode: ctx.runInfo?.mode,
  })
}
```

2. In `src/server/routes-context.ts`, extend `RoutesContextOptions` and the returned object:

```ts
interface RoutesContextOptions {
  outputDir?: string
  playwrightSnapshotDir?: string
  configDir?: string
  playwrightTestDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
  runInfo?: { mode: 'local' | 'docker' }
  containerPathMapping?: { from: string; to: string }
}
```

and in the returned context object, add:

```ts
    runInfo: options.runInfo,
    containerPathMapping: options.containerPathMapping,
```

3. In `src/schemas.ts`, extend `ReportApiResponseSchema` (lines 249-254):

```ts
export const ReportApiResponseSchema = z.object({
  tests: z.record(z.string(), TestDataSchema),
  isUpdateMode: z.boolean().optional(),
  isRunning: z.boolean().optional(),
  runEnabled: z.boolean().optional(),
  runMode: z.enum(['local', 'docker']).optional(),
})
```

4. In `src/server/app.ts`:
   - Add imports:

```ts
import { isCI } from '../ci.ts'
import { createDockerLauncher, DOCKER_WORK_DIR, type DockerOptions } from './docker-launcher.ts'
import { createDockerExec, probeDockerDaemon } from './docker-support.ts'
import { resolveRunMode, type ResolvedRunMode, type RunMode } from './run-mode.ts'
```

- Extend `ServerOptions` (after line 56):

```ts
  /** Execution backend for UI-triggered runs. Default 'auto'. */
  runMode?: RunMode
  /** Docker backend settings; only used when the resolved mode is 'docker'. */
  docker?: DockerOptions
```

- In `createServerApp`, replace the Task-2 local-launcher construction (`const launcher: RunLauncher = createLocalLauncher({ port })`) with:

```ts
const dockerExec = createDockerExec()
const resolvedRunMode: ResolvedRunMode = await resolveRunMode({
  runMode: options.runMode ?? 'auto',
  isCI: isCI(),
  probeDocker: () => probeDockerDaemon(dockerExec),
})
const launcher: RunLauncher =
  resolvedRunMode === 'docker'
    ? createDockerLauncher({ port, docker: options.docker, exec: dockerExec })
    : createLocalLauncher({ port })
```

- Pass the new routes-context options where `createRoutesContext(...)` is called (line 250):

```ts
const routesContext = createRoutesContext(reportData, staticDir, persistence.saveReport, {
  ...options,
  runInfo: { mode: resolvedRunMode },
  containerPathMapping: resolvedRunMode === 'docker' ? { from: DOCKER_WORK_DIR, to: process.cwd() } : undefined,
})
```

- [ ] **Step 5: Add the CLI flags**

In `src/cli.ts`:

1. Add to the imports:

```ts
import type { DockerOptions } from './server/docker-launcher.ts'
import type { RunMode } from './server/run-mode.ts'
```

2. Extend `ResolvedCliOptions`:

```ts
interface ResolvedCliOptions extends ServerOptions {
  port: number
  screenshotDir: string
  reportPath: string
  outputDir: string
  runMode?: RunMode
  docker?: DockerOptions
}
```

3. Add to HELP_TEXT after the `--config` line:

```
  --run-mode <mode>              Test run backend: local, docker, or auto (default: auto)
  --docker-image <image>         Docker image for docker mode (default: official Playwright image matching the installed @playwright/test version)
  --docker-platform <platform>   Container platform: linux/amd64 or linux/arm64 (default: host architecture)
```

4. Add to the `parseArgs` options object:

```ts
      'run-mode': { type: 'string' },
      'docker-image': { type: 'string' },
      'docker-platform': { type: 'string' },
```

5. Extend `resolveCliOptions` before the return:

```ts
const runMode = values['run-mode']
if (runMode !== undefined && runMode !== 'local' && runMode !== 'docker' && runMode !== 'auto') {
  throw new TypeError(`Invalid --run-mode: ${runMode} (expected local, docker, or auto)`)
}
const dockerPlatform = values['docker-platform']
if (dockerPlatform !== undefined && dockerPlatform !== 'linux/amd64' && dockerPlatform !== 'linux/arm64') {
  throw new TypeError(`Invalid --docker-platform: ${dockerPlatform} (expected linux/amd64 or linux/arm64)`)
}
const docker: DockerOptions = {}
if (values['docker-image'] !== undefined) docker.image = values['docker-image']
if (dockerPlatform !== undefined) docker.platform = dockerPlatform
const hasDockerOptions = values['docker-image'] !== undefined || dockerPlatform !== undefined
```

and extend the returned object:

```ts
return {
  port: parseInt(values.port ?? `${DEFAULT_PORT}`, 10),
  screenshotDir,
  reportPath,
  outputDir: values['output-dir'] ?? DEFAULT_OUTPUT_DIR,
  playwrightConfig: values.config,
  ...(runMode !== undefined ? { runMode } : {}),
  ...(hasDockerOptions ? { docker } : {}),
}
```

- [ ] **Step 6: Run tests**

Run: `cd tests && bun test run-mode.test.ts cli.test.ts`
Expected: PASS

Run: `cd tests && bun test server-routes.test.ts server-handlers.test.ts`
Expected: PASS (additive report field, no breaking route changes)

Run: `bun run typecheck && bun run lint`
Expected: clean

- [ ] **Step 7: Commit**

```bash
bunx oxfmt --write src/server/run-mode.ts src/server/app.ts src/server/routes.ts src/server/routes-context.ts src/schemas.ts src/cli.ts tests/run-mode.test.ts tests/cli.test.ts
git add src/server/run-mode.ts src/server/app.ts src/server/routes.ts src/server/routes-context.ts src/schemas.ts src/cli.ts tests/run-mode.test.ts tests/cli.test.ts
git commit -m "feat(server): run-mode resolution, docker launcher wiring, and docker CLI flags"
```

---

### Task 8: Register container-path rewrite

**Files:**

- Modify: `src/server/handlers.ts:121-161` (`handleRegister`)
- Test: `tests/register-container-paths.test.ts`

**Interfaces:**

- Consumes: `rewriteContainerPath` (Task 5), `RoutesContext.containerPathMapping` (Task 7).
- Produces: when `containerPathMapping` is set, `handleRegister` stores host paths for `cwd`, `configFile`, `playwrightSnapshotDir`, `playwrightTestDir` in `runContext`, `approvalRouting`, and `artifactRoots`.

- [ ] **Step 1: Write the failing test**

Create `tests/register-container-paths.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'

import { handleRegister, type HandlerContext } from '../src/server/handlers'
import type { RunController } from '../src/server/run-controller'
import type { RoutesContext } from '../src/server/routes'

function createCtx(mapping?: { from: string; to: string }): { ctx: HandlerContext; routesContext: RoutesContext } {
  const routesContext: RoutesContext = {
    reportData: {
      isRunning: false,
      tests: {},
      browsers: ['chromium'],
      isUpdateMode: false,
      screenshotDir: './screenshots',
    },
    staticDir: '.',
    saveReport: () => Promise.resolve(),
    artifactRoots: [],
    approvalRouting: { configDir: '/host/proj' },
    containerPathMapping: mapping,
  }
  const ctx: HandlerContext = {
    reportData: routesContext.reportData,
    wsClients: new Set(),
    currentRunIds: new Set(),
    isFilteredRun: false,
    saveReport: () => Promise.resolve(),
    scheduleReportSave: () => {},
    approvalRouting: routesContext.approvalRouting,
    routesContext,
    runController: {} as RunController,
  }
  return { ctx, routesContext }
}

const REGISTER_DATA = {
  playwrightSnapshotDir: '/work/tests/__screenshots__',
  playwrightTestDir: '/work/tests',
  configFile: '/work/playwright.config.ts',
  cwd: '/work',
}

describe('handleRegister container path mapping', () => {
  test('rewrites container paths to host paths when a mapping is set', () => {
    const { ctx, routesContext } = createCtx({ from: '/work', to: '/host/proj' })
    handleRegister(ctx, REGISTER_DATA)

    expect(routesContext.runContext).toEqual({
      configFile: '/host/proj/playwright.config.ts',
      cwd: '/host/proj',
    })
    expect(routesContext.approvalRouting?.playwrightSnapshotDir).toBe('/host/proj/tests/__screenshots__')
    expect(routesContext.approvalRouting?.playwrightTestDir).toBe('/host/proj/tests')
    expect(routesContext.artifactRoots).toContain('/host/proj/tests/__screenshots__')
    expect(routesContext.artifactRoots).toContain('/host/proj/tests')
  })

  test('stores reporter paths unchanged when no mapping is set', () => {
    const { ctx, routesContext } = createCtx()
    handleRegister(ctx, REGISTER_DATA)

    expect(routesContext.runContext).toEqual({ configFile: '/work/playwright.config.ts', cwd: '/work' })
    expect(routesContext.approvalRouting?.playwrightSnapshotDir).toBe('/work/tests/__screenshots__')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tests && bun test register-container-paths.test.ts`
Expected: FAIL — first test gets `/work/...` paths stored unchanged.

- [ ] **Step 3: Implement the rewrite**

In `src/server/handlers.ts`, add the import:

```ts
import { rewriteContainerPath } from './docker-support.ts'
```

and change `handleRegister`'s signature and first lines to:

```ts
export function handleRegister(ctx: HandlerContext, rawData: RegisterData): void {
  const mapping = ctx.routesContext.containerPathMapping
  const data: RegisterData =
    mapping === undefined
      ? rawData
      : {
          ...rawData,
          playwrightSnapshotDir:
            rawData.playwrightSnapshotDir === undefined
              ? undefined
              : rewriteContainerPath(rawData.playwrightSnapshotDir, mapping),
          playwrightTestDir:
            rawData.playwrightTestDir === undefined
              ? undefined
              : rewriteContainerPath(rawData.playwrightTestDir, mapping),
          configFile:
            rawData.configFile === undefined ? undefined : rewriteContainerPath(rawData.configFile, mapping),
          cwd: rawData.cwd === undefined ? undefined : rewriteContainerPath(rawData.cwd, mapping),
        }
```

The rest of the function (from `const roots: string[] = []` onward) is unchanged and now operates on the rewritten `data`.

- [ ] **Step 4: Run tests**

Run: `cd tests && bun test register-container-paths.test.ts server-handlers.test.ts`
Expected: PASS

Run: `bun run typecheck && bun run lint`
Expected: clean

- [ ] **Step 5: Commit**

```bash
bunx oxfmt --write src/server/handlers.ts tests/register-container-paths.test.ts
git add src/server/handlers.ts tests/register-container-paths.test.ts
git commit -m "fix(server): rewrite container paths in reporter register payloads"
```

---

### Task 9: UI — mode badge, update-baselines action, pulling state

**Files:**

- Modify: `src/index.ts` (InitialState, loadReportData, mount props)
- Modify: `src/client/App.svelte` (props, `RunFilters`, `isPreparing`, run-status handling, `handleUpdate`)
- Modify: `src/client/components/Sidebar.svelte` (props, badge, update button)

**Interfaces:**

- Consumes: `/api/report`'s `runMode` (Task 7); run-status `mode`/`phase` (Task 4); run body `update` (Task 3).
- Produces: no server-facing names. UI behavior: badge shows `docker`/`local` next to the title when runs are enabled; a second run button triggers `{ update: true }`; while `phase === 'pulling'` both run buttons are disabled and a status line shows "Pulling Docker image…".

Note: no component test harness exists in this repo; verification is typecheck + lint + build + the unchanged e2e fixture suite (the fixture is static HTML, so these component changes do not alter snapshots).

- [ ] **Step 1: Thread `runMode` through the bootstrap**

In `src/index.ts`:

1. Extend `InitialState` (after line 18):

```ts
  runMode?: 'local' | 'docker'
```

2. In `loadReportData`, add to the returned object:

```ts
    runMode: parsed.runMode,
```

3. In the `mount(App, { … })` props, add:

```ts
    runMode: initialState.runMode,
```

- [ ] **Step 2: Update `src/client/App.svelte`**

1. Extend the `RunFilters` interface (lines 42-44):

```ts
interface RunFilters {
  tests?: RunTestDescriptor[]
  update?: boolean
}
```

2. Extend `Props` (after line 53) and the destructuring (line 59):

```ts
    runMode?: 'local' | 'docker';
```

3. Add preparing state after `let runMessage …` (line 65):

```ts
let isPreparing = $state(false)
```

4. Extend the `run-status` case (lines 440-449):

```ts
        case 'run-status': {
          if (msg.data.phase === 'pulling') {
            isPreparing = true;
            runMessage = 'Pulling Docker image…';
            break;
          }
          isPreparing = false;
          if (msg.data.running) {
            isRunning = true;
            runMessage = null;
          } else {
            isRunning = false;
            finalizeRunSnapshot();
          }
          break;
        }
```

5. Add the update handler next to `handleStop` (line 366):

```ts
async function handleUpdate(): Promise<void> {
  await handleStart({ update: true })
}
```

6. Pass the new props to `<Sidebar … />` (after `onStart={handleStart}`):

```svelte
    onUpdate={handleUpdate}
    {isPreparing}
    {runMode}
```

- [ ] **Step 3: Update `src/client/components/Sidebar.svelte`**

1. Extend `Props` and the destructure:

```ts
    runMode?: 'local' | 'docker';
    isPreparing?: boolean;
    onUpdate: () => void;
```

2. Add the badge right after the `<h1 …>Crvy Rprtr</h1>` line:

```svelte
        {#if runEnabled && runMode !== undefined}
          <div class="text-[10px] uppercase tracking-wide text-fg-muted mb-1">
            {runMode}
          </div>
        {/if}
```

3. Replace the run-button block (lines 123-139) with:

```svelte
      {#if runEnabled}
        <div class="mt-1 flex gap-1">
          {#if isRunning}
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-error cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Stop tests"
              onclick={onStop}
            >&#9632;</button>
          {:else}
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-success cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Start tests"
              disabled={isPreparing === true}
              onclick={onStart}
            >&#9654;</button>
            <button
              class="size-9 flex items-center justify-center bg-surface-input border border-edge rounded text-success cursor-pointer text-sm transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Run and update baselines"
              title="Run & update baselines"
              disabled={isPreparing === true}
              onclick={onUpdate}
            >&#9654;&#8635;</button>
          {/if}
        </div>
      {/if}
```

- [ ] **Step 4: Verify**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: clean; `dist/` rebuilt.

Run the e2e suite to confirm the unchanged fixture keeps snapshots green:

Run: `bun run test:playwright`
Expected: PASS (fixture untouched, so no snapshot diffs)

- [ ] **Step 5: Commit**

```bash
bunx oxfmt --write src/index.ts src/client/App.svelte src/client/components/Sidebar.svelte
git add src/index.ts src/client/App.svelte src/client/components/Sidebar.svelte
git commit -m "feat(ui): run mode badge, update-baselines action, and image-pull state"
```

---

### Task 10: CI-gated docker smoke test

**Files:**

- Create: `tests/fixtures/docker-smoke/package.json`, `tests/fixtures/docker-smoke/playwright.config.ts`, `tests/fixtures/docker-smoke/tests/basic.spec.ts`
- Create: `tests/docker-smoke.test.ts`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml` (new `docker-smoke` job)

**Interfaces:**

- Consumes: the full feature (Tasks 1-9). Guarded by env `CRVY_DOCKER_SMOKE=1`; skipped by default so the normal `bun test *.test.ts` glob is unaffected.

- [ ] **Step 1: Create the fixture project**

`tests/fixtures/docker-smoke/package.json`:

```json
{
  "name": "crvy-rprtr-docker-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@crvy/rprtr": "file:./crvy-rprtr.tgz",
    "@playwright/test": "1.59.0"
  }
}
```

`tests/fixtures/docker-smoke/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  reporter: [['@crvy/rprtr']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
```

`tests/fixtures/docker-smoke/tests/basic.spec.ts`:

```ts
import { expect, test } from '@playwright/test'

test('docker smoke passes', () => {
  expect(1 + 1).toBe(2)
})
```

(A page-less test: no browser launch needed, so the smoke stays fast even though the image carries Chromium.)

Append to `.gitignore`:

```
tests/fixtures/docker-smoke/node_modules/
tests/fixtures/docker-smoke/package-lock.json
tests/fixtures/docker-smoke/crvy-rprtr.tgz
tests/fixtures/docker-smoke/screenshots/
tests/fixtures/docker-smoke/report.json
tests/fixtures/docker-smoke/test-results/
```

- [ ] **Step 2: Write the smoke test**

Create `tests/docker-smoke.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'net'
import { join } from 'path'

const SMOKE_ENABLED = process.env.CRVY_DOCKER_SMOKE === '1'
const fixtureDir = join(import.meta.dir, 'fixtures', 'docker-smoke')
const distDir = join(import.meta.dir, '..', 'dist')

interface RunningProcess {
  process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  stdoutPromise: Promise<string>
  stderrPromise: Promise<string>
}

const runningProcesses: RunningProcess[] = []

function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream === null ? Promise.resolve('') : new Response(stream).text()
}

function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a TCP port'))
        return
      }
      server.close((error) => (error !== undefined ? reject(error) : resolve(address.port)))
    })
  })
}

function spawnProcess(command: string[], cwd: string): RunningProcess {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const subprocess = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd, env })
  const running = {
    process: subprocess,
    stdoutPromise: readStream(subprocess.stdout),
    stderrPromise: readStream(subprocess.stderr),
  }
  runningProcesses.push(running)
  return running
}

async function waitForServer(port: number, running: RunningProcess): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/report`
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  const [stdout, stderr] = await Promise.all([running.stdoutPromise, running.stderrPromise])
  throw new Error(`Server did not start on port ${port}\n${stdout.trim()}\n${stderr.trim()}`)
}

interface ReportShape {
  tests?: Record<string, { status?: string }>
  runMode?: string
}

afterEach(async () => {
  while (runningProcesses.length > 0) {
    const running = runningProcesses.pop()
    if (running !== undefined) {
      running.process.kill()
      await running.process.exited
    }
  }
})

describe('docker smoke', () => {
  test.skipIf(!SMOKE_ENABLED)(
    'a playwright run inside the container round-trips to the host server',
    async () => {
      const port = await reservePort()
      const server = spawnProcess(
        ['node', join(distDir, 'cli.js'), '--port', `${port}`, '--run-mode', 'docker'],
        fixtureDir,
      )
      await waitForServer(port, server)

      const runResponse = await fetch(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(runResponse.status).toBe(200)

      // First run may include a docker pull — allow generous polling.
      const deadline = Date.now() + 240_000
      let report: ReportShape = {}
      while (Date.now() < deadline) {
        const response = await fetch(`http://127.0.0.1:${port}/api/report`)
        report = (await response.json()) as ReportShape
        const tests = Object.values(report.tests ?? {})
        if (tests.length > 0 && tests.every((t) => t.status === 'success' || t.status === 'failed')) break
        await Bun.sleep(2000)
      }

      expect(report.runMode).toBe('docker')
      const tests = Object.values(report.tests ?? {})
      expect(tests.length).toBeGreaterThan(0)
      expect(tests.every((t) => t.status === 'success')).toBe(true)
    },
    300_000,
  )
})
```

- [ ] **Step 3: Verify the test skips by default**

Run: `cd tests && bun test docker-smoke.test.ts`
Expected: PASS with 1 skipped (`CRVY_DOCKER_SMOKE` unset).

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`, insert a new job after `playwright-tests` (after line 102):

```yaml
docker-smoke:
  name: Docker Smoke
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v4
      with:
        lfs: true
        submodules: recursive

    - name: Setup Bun
      uses: oven-sh/setup-bun@v2
      with:
        bun-version: latest

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: 22

    - name: Install dependencies
      run: bun install

    - name: Build project
      run: bun run build

    - name: Prepare fixture
      run: |
        npm pack --pack-destination tests/fixtures/docker-smoke
        mv tests/fixtures/docker-smoke/crvy-rprtr-*.tgz tests/fixtures/docker-smoke/crvy-rprtr.tgz
        cd tests/fixtures/docker-smoke && npm install

    - name: Run docker smoke test
      run: cd tests && bun test docker-smoke.test.ts
      env:
        CRVY_DOCKER_SMOKE: '1'
```

(`npm pack` runs the repo's `prepare` script, which is a no-op-safe hook copy; the tarball is renamed to the stable name the fixture's `package.json` references; `npm install` on a `file:` tarball copies real files, so the container's bind mount sees a self-contained `node_modules`.)

- [ ] **Step 5: Local verification of what can be verified**

Run: `bun run typecheck && bun run lint`
Expected: clean.

If Docker Desktop is running locally, optionally verify end-to-end:

Run: `bun run build && npm pack --pack-destination tests/fixtures/docker-smoke && mv tests/fixtures/docker-smoke/crvy-rprtr-*.tgz tests/fixtures/docker-smoke/crvy-rprtr.tgz && cd tests/fixtures/docker-smoke && npm install && cd ../.. && cd tests && CRVY_DOCKER_SMOKE=1 bun test docker-smoke.test.ts`
Expected: PASS (downloads the image on first run).

- [ ] **Step 6: Commit**

```bash
bunx oxfmt --write tests/docker-smoke.test.ts tests/fixtures/docker-smoke/playwright.config.ts tests/fixtures/docker-smoke/tests/basic.spec.ts tests/fixtures/docker-smoke/package.json .gitignore .github/workflows/ci.yml
git add tests/docker-smoke.test.ts tests/fixtures/docker-smoke .gitignore .github/workflows/ci.yml
git commit -m "test: CI-gated docker smoke test for containerized runs"
```

---

### Task 11: README documentation

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add the Docker mode section**

Insert after the "Cross-OS Artifact Loading" section (after line 123):

````markdown
## Docker Mode

Run Playwright browsers inside a pinned Docker container so screenshot baselines are reproducible across machines — no local browser or system-dependency installation required.

```bash
npx crvy-rprtr --run-mode docker
```
````

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

Notes:

- Baselines are architecture-specific. A baseline generated on Apple Silicon (arm64) will not necessarily match an amd64 CI runner; pin `--docker-platform` if your team mixes architectures.
- If your `playwright.config.ts` uses `webServer`, that server now starts inside the container: it must bind `0.0.0.0`, and hosts it references must resolve inside the container.
- Timezone and locale are pinned (`TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`) so date/number rendering in screenshots is stable; override via `docker.extraArgs` if you need a different locale under test.
- The "Run & update baselines" button (▶↻) regenerates baselines inside the container, keeping generation and verification in the same image.

````

- [ ] **Step 2: Commit**

```bash
bunx oxfmt --write README.md
git add README.md
git commit -m "docs: docker mode usage and options"
````

---

## Verification Checklist (whole plan)

1. `cd tests && bun test *.test.ts` — all unit tests pass (docker-smoke skips).
2. `bun run typecheck && bun run lint` — clean.
3. `bun run test:playwright` — e2e snapshots unaffected.
4. `bun run knip` — no unused exports (all new exports are consumed by wiring tasks).
5. CI: new `docker-smoke` job passes on `ubuntu-latest`.
