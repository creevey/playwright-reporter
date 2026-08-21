import { describe, expect, test } from 'bun:test'

import type { ContainerPathMapping } from '../src/server/docker-support'
import {
  RunController,
  type ChildProcessLike,
  type RunContext,
  type RunControllerDeps,
  resolveReporterDefault,
  gteMinor,
  buildTestListEntries,
} from '../src/server/run-controller'
import type { LaunchParams, LaunchSpec } from '../src/server/run-launcher'
import type { ClientWebSocketMessage } from '../src/types'

interface StubChild {
  killed: string[]
  exitEmitters: Array<(code: number | null) => void>
  errorEmitters: Array<(err: Error) => void>
}

function createStubChild(): StubChild & ChildProcessLike {
  const exitEmitters: Array<(code: number | null) => void> = []
  const errorEmitters: Array<(err: Error) => void> = []
  const killed: string[] = []
  return {
    killed,
    exitEmitters,
    errorEmitters,
    on(event: 'exit' | 'error', cb: ((code: number | null) => void) | ((err: Error) => void)): void {
      if (event === 'exit') exitEmitters.push(cb as (code: number | null) => void)
      if (event === 'error') errorEmitters.push(cb as (err: Error) => void)
    },
    kill(sig: string): void {
      killed.push(sig)
    },
  }
}

interface Fixture {
  controller: RunController
  child: ReturnType<typeof createStubChild>
  broadcasts: ClientWebSocketMessage[]
  runningFlag: { value: boolean }
  filteredCalls: boolean[]
  spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>
  setResolveLaunch: (fn: ((cwd: string, args: string[]) => { cmd: string; args: string[] }) | null) => void
  advanceTimer: (ms: number) => void
  setRunContext: (ctx: RunContext | null) => void
  writtenTempFiles: Array<{ path: string; content: string }>
  deletedTempFiles: string[]
  setPlaywrightVersion: (version: string | null) => void
  setSpawnThrows: (flag: boolean) => void
  saveReportCalls: { value: number }
  setLauncherAvailable: (value: boolean | undefined) => void
}

function createFixture(
  initialCtx: RunContext | null = null,
  resolveReporter: (cwd: string) => string | null = () => null,
  containerPathMapping?: ContainerPathMapping,
): Fixture {
  let runCtx: RunContext | null = initialCtx
  const broadcasts: ClientWebSocketMessage[] = []
  const runningFlag = { value: false }
  const filteredCalls: boolean[] = []
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  const pendingTimers: Array<{ fireAt: number; fn: () => void }> = []
  let now = 0
  let resolveLaunch: ((cwd: string, args: string[]) => { cmd: string; args: string[] }) | null = null
  let launcherAvailable: boolean | undefined
  const writtenTempFiles: Array<{ path: string; content: string }> = []
  const deletedTempFiles: string[] = []
  let playwrightVersion: string | null = null
  let spawnThrows = false
  const saveReportCalls = { value: 0 }
  const child = createStubChild()
  const deps: RunControllerDeps = {
    getRunContext: (): RunContext | null => runCtx,
    port: 3000,
    broadcast: (msg): void => {
      broadcasts.push(msg)
    },
    setReportRunning: (running): void => {
      runningFlag.value = running
    },
    setRunFiltered: (filtered): void => {
      filteredCalls.push(filtered)
    },
    spawn: (cmd, args, opts): ChildProcessLike => {
      spawnCalls.push({ cmd, args, opts })
      if (spawnThrows) throw new Error('spawn failed synchronously')
      return child
    },
    timers: {
      setTimeout: (fn, ms?): unknown => {
        const handle = { fireAt: now + (ms ?? 0), fn }
        pendingTimers.push(handle)
        return handle as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (handle): void => {
        const i = pendingTimers.indexOf(handle as { fireAt: number; fn: () => void })
        if (i >= 0) pendingTimers.splice(i, 1)
      },
    },
    resolveReporter,
    containerPathMapping,
    launcher: {
      mode: 'local' as const,
      get available(): boolean | undefined {
        return launcherAvailable
      },
      launch: ({ ctx, playwrightArgs }: LaunchParams): LaunchSpec => {
        const resolved = resolveLaunch?.(ctx.cwd, playwrightArgs) ?? {
          cmd: 'npx',
          args: ['playwright', ...playwrightArgs],
        }
        return { cmd: resolved.cmd, args: resolved.args, env: { STUB_ENV: '1' } }
      },
    },
    writeTempFile: (content: string): string => {
      const path = `/tmp/crvy-rprtr-test-list-${writtenTempFiles.length}.txt`
      writtenTempFiles.push({ path, content })
      return path
    },
    deleteTempFile: (path: string): void => {
      deletedTempFiles.push(path)
    },
    getPlaywrightVersion: (): string | null => playwrightVersion,
    saveReport: (): Promise<void> => {
      saveReportCalls.value++
      return Promise.resolve()
    },
  }
  const controller = new RunController(deps)
  return {
    controller,
    child,
    broadcasts,
    runningFlag,
    filteredCalls,
    spawnCalls,
    setResolveLaunch: (fn): void => {
      resolveLaunch = fn
    },
    advanceTimer: (ms): void => {
      now += ms
      for (const t of pendingTimers.splice(0)) {
        if (t.fireAt <= now) t.fn()
        else pendingTimers.push(t)
      }
    },
    setRunContext: (ctx): void => {
      runCtx = ctx
    },
    writtenTempFiles,
    deletedTempFiles,
    setPlaywrightVersion: (version): void => {
      playwrightVersion = version
    },
    setSpawnThrows: (flag): void => {
      spawnThrows = flag
    },
    saveReportCalls,
    setLauncherAvailable: (value): void => {
      launcherAvailable = value
    },
  }
}

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

describe('RunController.start', () => {
  test('refuses when no config registered', () => {
    const f = createFixture(null)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: false, reason: 'no-config' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.broadcasts).toHaveLength(0)
    expect(f.runningFlag.value).toBe(false)
  })

  test('spawns with --config and cwd on happy path', () => {
    const f = createFixture(SAMPLE_CTX)
    const result = f.controller.start({})
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls).toHaveLength(1)
    const { cmd, args, opts } = f.spawnCalls[0]!
    expect(cmd).toBe('npx')
    expect(args).toEqual(['playwright', 'test', '--config', '/proj/playwright.config.ts'])
    expect(opts.cwd).toBe('/proj')
    const env = opts.env as Record<string, string | undefined>
    expect(env.STUB_ENV).toBe('1')
    expect(f.runningFlag.value).toBe(true)
    expect(f.broadcasts).toEqual([{ type: 'run-status', data: { running: true, mode: 'local' } }])
    expect(f.controller.isRunning).toBe(true)
  })

  test('adds --reporter when resolveReporter returns a path', () => {
    const f = createFixture(SAMPLE_CTX, () => '/abs/path/to/reporter.js')
    f.controller.start({})
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--reporter',
      '/abs/path/to/reporter.js',
    ])
  })

  test('omits --reporter when resolveReporter returns null', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({})
    expect(f.spawnCalls[0]!.args).toEqual(['playwright', 'test', '--config', '/proj/playwright.config.ts'])
  })

  test('uses the injected package-manager launcher when provided', () => {
    const f = createFixture(SAMPLE_CTX)
    f.setResolveLaunch((_cwd, args) => ({ cmd: 'pnpm', args: ['exec', 'playwright', ...args] }))
    f.controller.start({})
    expect(f.spawnCalls[0]!.cmd).toBe('pnpm')
    expect(f.spawnCalls[0]!.args).toEqual(['exec', 'playwright', 'test', '--config', '/proj/playwright.config.ts'])
  })

  test('refuses when already running', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    const second = f.controller.start({})
    expect(second).toEqual({ ok: false, reason: 'already-running' })
    expect(f.spawnCalls).toHaveLength(1)
  })

  test('single descriptor becomes positional file:line:column with --project', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({
      tests: [
        { file: 'tests/foo.spec.ts', line: 42, column: 11, projectName: 'chromium', titlePath: ['suite', 'foo'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--project=chromium',
      'tests/foo.spec.ts:42:11',
    ])
  })

  test('docker mode routes a single descriptor through --test-list with rewritten paths', () => {
    // Positional file:line filters are host paths and cannot resolve inside the
    // container, so docker runs use --test-list even for a single test. Entries are
    // relative to Playwright's rootDir, which --test-list matches against.
    const f = createFixture(
      { configFile: '/proj/playwright.config.ts', cwd: '/proj', rootDir: '/proj/tests' },
      () => null,
      { from: '/work', to: '/proj' },
    )
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [{ file: '/work/tests/foo.spec.ts', line: 42, projectName: 'chromium', titlePath: ['foo'] }],
    })

    expect(f.spawnCalls[0]!.args).toContain('--test-list')
    expect(f.spawnCalls[0]!.args).not.toContain('/proj/tests/foo.spec.ts:42')
    expect(f.writtenTempFiles[0]!.content).toBe('[chromium] \u203a foo.spec.ts:42 \u203a foo')
  })

  test('seeded run context without rootDir emits candidate test-list entries', () => {
    // Fresh server + report.json from a prior session: no register has arrived, so
    // Playwright's rootDir is unknown. Entries must cover every plausible base or the
    // run silently matches zero tests (exit 0, no output).
    const f = createFixture(SAMPLE_CTX, () => null, { from: '/work', to: '/proj' })
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [{ file: '/work/tests/foo.spec.ts', line: 42, projectName: 'chromium', titlePath: ['foo'] }],
    })

    expect(f.writtenTempFiles[0]!.content).toBe(
      ['[chromium] \u203a tests/foo.spec.ts:42 \u203a foo', '[chromium] \u203a foo.spec.ts:42 \u203a foo'].join('\n'),
    )
  })

  test('multiple descriptors become positional args with shared --project', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, column: 3, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      '--project=chromium',
      'a.spec.ts:1',
      'b.spec.ts:2:3',
    ])
  })

  test('multiple descriptors with mixed projects omit --project', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, projectName: 'firefox', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).toEqual([
      'playwright',
      'test',
      '--config',
      '/proj/playwright.config.ts',
      'a.spec.ts:1',
      'b.spec.ts:2',
    ])
  })

  test('empty tests array returns no-tests without spawning', () => {
    const f = createFixture(SAMPLE_CTX)
    const result = f.controller.start({ tests: [] })
    expect(result).toEqual({ ok: false, reason: 'no-tests' })
    expect(f.spawnCalls).toHaveLength(0)
    expect(f.broadcasts).toHaveLength(0)
  })

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
})

describe('RunController.start run scope signaling', () => {
  test('signals an unfiltered run when tests is absent', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    expect(f.filteredCalls).toEqual([false])
  })

  test('signals a filtered run when tests is provided', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({ tests: [{ file: 'a.spec.ts', line: 1, titlePath: ['t'] }] })
    expect(f.filteredCalls).toEqual([true])
  })
})

describe('RunController child exit', () => {
  test('resets state on clean exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.runningFlag.value).toBe(false)
    expect(f.broadcasts).toEqual([
      { type: 'run-status', data: { running: true, mode: 'local' } },
      { type: 'run-status', data: { running: false, mode: 'local' } },
    ])
    expect(f.controller.isRunning).toBe(false)
  })

  test('resets state on nonzero exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.exitEmitters.forEach((cb) => cb(1))
    expect(f.runningFlag.value).toBe(false)
    expect(f.controller.isRunning).toBe(false)
  })

  test('treats spawn error event as immediate exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    expect(f.runningFlag.value).toBe(false)
    expect(f.controller.isRunning).toBe(false)
    expect(f.broadcasts).toContainEqual({ type: 'run-status', data: { running: false, mode: 'local' } })
  })

  test('cleans up exactly once when error is followed by exit', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    f.child.exitEmitters.forEach((cb) => cb(1))
    expect(f.runningFlag.value).toBe(false)
    expect(f.controller.isRunning).toBe(false)
    expect(f.broadcasts.filter((m) => m.type === 'run-status' && !m.data.running)).toHaveLength(1)
  })

  test('flushes the report on exit so an interrupted run still persists', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.saveReportCalls.value = 0
    f.child.exitEmitters.forEach((cb) => cb(0))
    // The exit handler fire-and-forgets the save; let it resolve.
    await Promise.resolve()
    await Promise.resolve()
    expect(f.saveReportCalls.value).toBe(1)
  })

  test('flushes the report on spawn error event', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.saveReportCalls.value = 0
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    await Promise.resolve()
    await Promise.resolve()
    expect(f.saveReportCalls.value).toBe(1)
  })

  test('does not double-flush when error is followed by exit', async () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.child.errorEmitters.forEach((cb) => cb(new Error('ENOENT')))
    f.child.exitEmitters.forEach((cb) => cb(1))
    await Promise.resolve()
    await Promise.resolve()
    expect(f.saveReportCalls.value).toBe(1)
  })
})

describe('RunController.stop', () => {
  test('refuses when not running', () => {
    const f = createFixture(SAMPLE_CTX)
    expect(f.controller.stop()).toEqual({ ok: false, reason: 'not-running' })
  })

  test('sends SIGTERM on happy path', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    expect(f.controller.stop()).toEqual({ ok: true })
    expect(f.child.killed).toEqual(['SIGTERM'])
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.child.killed).toEqual(['SIGTERM'])
  })

  test('escalates to SIGKILL after 5 seconds', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.controller.stop()
    expect(f.child.killed).toEqual(['SIGTERM'])
    f.advanceTimer(4999)
    expect(f.child.killed).toEqual(['SIGTERM'])
    f.advanceTimer(2)
    expect(f.child.killed).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('RunController.dispose', () => {
  test('SIGKILLs the current child immediately', () => {
    const f = createFixture(SAMPLE_CTX)
    f.controller.start({})
    f.controller.dispose()
    expect(f.child.killed).toEqual(['SIGKILL'])
  })
})

// `resolveReporterDefault` has two branches: (1) resolve `@crvy/rprtr` from the
// project cwd, (2) fall back to `import.meta.url` (the server's own module, which
// IS @crvy/rprtr). In the bun test environment branch 1 throws for cwds where the
// package isn't resolvable (verified: `/proj` and nonexistent paths throw), so the
// two tests below cover both branches: test 1 uses a real in-repo cwd where branch 1
// succeeds via package self-referencing; test 2 uses a nonexistent cwd so branch 1
// throws and resolution succeeds only via the import.meta.url fallback.
describe('resolveReporterDefault', () => {
  test('resolves from the project cwd when installed there', () => {
    // `process.cwd()` is the tests/ dir during `cd tests && bun test`; it sits inside
    // the repo where @crvy/rprtr is the self-published package, so branch 1 resolves it.
    expect(resolveReporterDefault(process.cwd())).not.toBeNull()
  })

  test('falls back to the server module location when the project cwd throws', () => {
    // A cwd with no resolvable @crvy/rprtr should still resolve via import.meta.url
    // because the server IS @crvy/rprtr.
    expect(resolveReporterDefault('/nonexistent/project/path')).not.toBeNull()
  })
})

// The expected line below is a real line from
// tests/fixtures/playwright-list-sample.txt (captured via
// `playwright test --list --reporter=list`). It pins the entry format so that
// `buildTestListEntries` stays aligned with Playwright's own `--list` output —
// which is what `--test-list` matches against. The file path in the sample is
// relative to the Playwright `testDir` (here the spec basename).
describe('gteMinor', () => {
  test('true when version meets the threshold', () => {
    expect(gteMinor('1.56.0', 1, 56)).toBe(true)
    expect(gteMinor('1.59.0-beta', 1, 56)).toBe(true)
    expect(gteMinor('2.0.0', 1, 56)).toBe(true)
  })
  test('false when version is below the threshold', () => {
    expect(gteMinor('1.55.0', 1, 56)).toBe(false)
    expect(gteMinor('1.40.1', 1, 56)).toBe(false)
  })
  test('false for unparseable input', () => {
    expect(gteMinor('', 1, 56)).toBe(false)
    expect(gteMinor('not-a-version', 1, 56)).toBe(false)
  })
})

describe('buildTestListEntries', () => {
  test('formats one line per descriptor matching playwright --list shape', () => {
    const entries = buildTestListEntries([
      {
        file: 'offline-artifact.spec.ts',
        line: 19,
        column: 3,
        projectName: 'chromium',
        titlePath: ['opens the generated report artifact directly from disk'],
      },
    ])
    // Exactly matches line 2 of playwright-list-sample.txt (minus leading spaces):
    //   [chromium] › offline-artifact.spec.ts:19:3 › opens the generated report artifact directly from disk
    expect(entries).toEqual([
      '[chromium] \u203a offline-artifact.spec.ts:19:3 \u203a opens the generated report artifact directly from disk',
    ])
  })

  test('omits the project prefix when projectName is empty/absent', () => {
    const entries = buildTestListEntries([{ file: 'tests/foo.spec.ts', line: 10, titlePath: ['does a thing'] }])
    expect(entries).toEqual(['tests/foo.spec.ts:10 \u203a does a thing'])
  })

  test('converts absolute file paths to rootDir-relative when rootDir is provided', () => {
    // Playwright 1.59+ reports test.location.file as an absolute path; --test-list matches
    // against path.relative(config.rootDir, test.location.file), so absolute paths must be
    // converted before being written to the temp file.
    const entries = buildTestListEntries(
      [
        {
          file: '/proj/tests/offline-artifact.spec.ts',
          line: 19,
          column: 3,
          projectName: 'chromium',
          titlePath: ['opens the generated report artifact directly from disk'],
        },
      ],
      '/proj/tests',
    )
    expect(entries).toEqual([
      '[chromium] \u203a offline-artifact.spec.ts:19:3 \u203a opens the generated report artifact directly from disk',
    ])
  })

  test('leaves relative paths unchanged even when rootDir is provided', () => {
    const entries = buildTestListEntries(
      [{ file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] }],
      '/proj/tests',
    )
    expect(entries).toEqual(['[chromium] \u203a a.spec.ts:1 \u203a t1'])
  })
})

describe('RunController --test-list path', () => {
  test('suite uses --test-list on Playwright >= 1.56 and cleans up on exit', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.56.0')
    const descriptors = [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
    ]
    const result = f.controller.start({ tests: descriptors })
    expect(result).toEqual({ ok: true })
    expect(f.spawnCalls[0]!.args).toContain('--test-list')
    const listPath = f.spawnCalls[0]!.args[f.spawnCalls[0]!.args.indexOf('--test-list') + 1]!
    expect(f.writtenTempFiles).toHaveLength(1)
    expect(f.writtenTempFiles[0]!.path).toBe(listPath)
    expect(f.writtenTempFiles[0]!.content).toBe(
      '[chromium] \u203a a.spec.ts:1 \u203a t1\n[chromium] \u203a b.spec.ts:2 \u203a t2',
    )
    f.child.exitEmitters.forEach((cb) => cb(0))
    expect(f.deletedTempFiles).toContain(listPath)
  })

  test('suite --test-list rewrites absolute descriptor paths to ctx.cwd-relative entries', () => {
    // Reproduces the silent "Run produced no results" failure on Playwright 1.59+:
    // the reporter forwards test.location.file as absolute, but --test-list matches
    // against path.relative(config.rootDir, test.location.file). The controller must
    // pass ctx.cwd (= config.rootDir from the reporter's register message) through
    // to buildTestListEntries so the temp file contains rootDir-relative paths.
    const f = createFixture({ ...SAMPLE_CTX, cwd: '/proj/tests' }, () => null)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        { file: '/proj/tests/a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: '/proj/tests/b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.writtenTempFiles[0]!.content).toBe(
      '[chromium] \u203a a.spec.ts:1 \u203a t1\n[chromium] \u203a b.spec.ts:2 \u203a t2',
    )
  })

  test('suite falls back to positional args on Playwright < 1.56', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.55.0')
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
      ],
    })
    expect(f.spawnCalls[0]!.args).not.toContain('--test-list')
    expect(f.writtenTempFiles).toHaveLength(0)
    expect(f.spawnCalls[0]!.args).toContain('a.spec.ts:1')
  })

  test('temp file is deleted on dispose', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.59.0')
    f.controller.start({
      tests: [
        { file: 'a.spec.ts', line: 1, titlePath: ['t1'] },
        { file: 'b.spec.ts', line: 2, titlePath: ['t2'] },
      ],
    })
    const listPath = f.spawnCalls[0]!.args[f.spawnCalls[0]!.args.indexOf('--test-list') + 1]!
    f.controller.dispose()
    expect(f.deletedTempFiles).toContain(listPath)
  })

  test('cleans up the temp file and propagates when spawn throws synchronously', () => {
    const f = createFixture(SAMPLE_CTX, () => null)
    f.setPlaywrightVersion('1.56.0')
    f.setSpawnThrows(true)
    const descriptors = [
      { file: 'a.spec.ts', line: 1, projectName: 'chromium', titlePath: ['t1'] },
      { file: 'b.spec.ts', line: 2, projectName: 'chromium', titlePath: ['t2'] },
    ]
    expect(() => f.controller.start({ tests: descriptors })).toThrow('spawn failed synchronously')
    expect(f.writtenTempFiles).toHaveLength(1)
    expect(f.deletedTempFiles).toContain(f.writtenTempFiles[0]!.path)
    expect(f.controller.isRunning).toBe(false)
    expect(f.broadcasts).not.toContainEqual({ type: 'run-status', data: { running: true, mode: 'local' } })
  })
})
