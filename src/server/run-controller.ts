import { spawn } from 'child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import type { RunTestDescriptor } from '../schemas.ts'
import type { ClientWebSocketMessage } from '../types.ts'
import { type RunLauncher } from './run-launcher.ts'

export { resolvePlaywrightLaunch } from './run-launcher.ts'

export interface RunContext {
  configFile: string
  cwd: string
}

export interface RunFilters {
  tests?: RunTestDescriptor[]
  update?: boolean
}

export type StartResult =
  | { ok: true }
  | { ok: false; reason: 'no-config' | 'already-running' | 'no-tests' | 'docker-unavailable' }

export type StopResult = { ok: true } | { ok: false; reason: 'not-running' }

export interface ChildProcessLike {
  on(event: 'exit', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal: string): void
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: Record<string, unknown>): ChildProcessLike
}

export interface RunControllerDeps {
  getRunContext(): RunContext | null
  port: number
  broadcast(message: ClientWebSocketMessage): void
  setReportRunning(running: boolean): void
  /** Records whether the in-progress run is filtered, so run-end can preserve unrelated tests. */
  setRunFiltered?(filtered: boolean): void
  /** Flushes pending report writes on child exit so an interrupted run still persists. */
  saveReport?: () => Promise<void>
  spawn: SpawnLike
  timers: {
    setTimeout: (fn: () => void, ms?: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
  resolveReporter?: (cwd: string) => string | null
  /** Builds the launch command and environment for a run. */
  launcher: RunLauncher
  /** Injectable seams for the version-gated `--test-list` path (Playwright >= 1.56). */
  getPlaywrightVersion?: (cwd: string) => string | null
  writeTempFile?: (content: string) => string
  deleteTempFile?: (path: string) => void
}

const STOP_GRACE_MS = 5000

const KNOWN_SIGNALS: Record<string, NodeJS.Signals> = {
  SIGTERM: 'SIGTERM',
  SIGKILL: 'SIGKILL',
}

function sharedProject(tests: RunTestDescriptor[]): string | undefined {
  const names = new Set(tests.map((t) => t.projectName ?? ''))
  if (names.size === 1) {
    const name = [...names][0]
    return name === '' ? undefined : name
  }
  return undefined
}

/** `MAJOR.MINOR` threshold check using only leading digits; ignores pre-release suffixes. False for unparseable input. */
export function gteMinor(version: string, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const maj = parseInt(match[1]!, 10)
  const min = parseInt(match[2]!, 10)
  if (maj !== major) return maj > major
  return min >= minor
}

/** Reads the installed `@playwright/test` version from cwd; null when unresolvable (→ positional fallback). */
export function resolvePlaywrightVersion(cwd: string): string | null {
  try {
    const req = createRequire(join(cwd, 'package.json'))
    const pkgPath = req.resolve('@playwright/test/package.json')
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
      ? pkg.version
      : null
  } catch {
    return null
  }
}

// Builds `--test-list` lines mirroring `playwright test --list`. Pass `rootDir` (= RunContext.cwd)
// to rewrite absolute paths from Playwright 1.59+ — `--test-list` matches `path.relative(rootDir, ...)`.
export function buildTestListEntries(tests: RunTestDescriptor[], rootDir?: string): string[] {
  return tests.map((d) => {
    const file = rootDir !== undefined && isAbsolute(d.file) ? relative(rootDir, d.file) || d.file : d.file
    const loc = d.column === undefined ? `${file}:${d.line}` : `${file}:${d.line}:${d.column}`
    const title = d.titlePath.join(' \u203a ')
    const prefix = d.projectName !== undefined && d.projectName !== '' ? `[${d.projectName}] \u203a ` : ''
    return `${prefix}${loc} \u203a ${title}`
  })
}

function defaultWriteTempFile(content: string): string {
  const path = join(tmpdir(), `crvy-rprtr-test-list-${process.pid}-${Date.now()}.txt`)
  writeFileSync(path, content, 'utf8')
  return path
}

function defaultDeleteTempFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Ignore — the file may already be removed (e.g. double exit/error).
  }
}

export function resolveReporterDefault(cwd: string): string | null {
  try {
    return createRequire(join(cwd, 'package.json')).resolve('@crvy/rprtr')
  } catch {
    // Not installed in the project; fall through to the server's own package.
  }
  try {
    return createRequire(import.meta.url).resolve('@crvy/rprtr')
  } catch {
    return null
  }
}

export class RunController {
  private child: ChildProcessLike | null = null
  private sigkillTimer: unknown = null
  private testListPath: string | null = null

  constructor(private readonly deps: RunControllerDeps) {}

  get isRunning(): boolean {
    return this.child !== null
  }

  private supportsTestList(cwd: string): boolean {
    const getVersion = this.deps.getPlaywrightVersion ?? resolvePlaywrightVersion
    const version = getVersion(cwd)
    return version !== null && gteMinor(version, 1, 56)
  }

  private cleanupTempFile(): void {
    if (this.testListPath !== null) {
      const del = this.deps.deleteTempFile ?? defaultDeleteTempFile
      del(this.testListPath)
      this.testListPath = null
    }
  }

  start(filters: RunFilters): StartResult {
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: false, reason: 'no-config' }
    if (this.child !== null) return { ok: false, reason: 'already-running' }
    if (filters.tests !== undefined && filters.tests.length === 0) return { ok: false, reason: 'no-tests' }
    if (this.deps.launcher.available === false) return { ok: false, reason: 'docker-unavailable' }

    const resolveReporter = this.deps.resolveReporter ?? resolveReporterDefault
    const reporterModule = resolveReporter(ctx.cwd)
    const tests = filters.tests
    const useTestList = tests !== undefined && tests.length > 1 && this.supportsTestList(ctx.cwd)

    const args = ['test', '--config', ctx.configFile]
    if (reporterModule !== null) args.push('--reporter', reporterModule)
    if (filters.update === true) args.push('--update-snapshots')
    if (useTestList && tests !== undefined) {
      const content = buildTestListEntries(tests, ctx.cwd).join('\n')
      const writeTemp = this.deps.writeTempFile ?? defaultWriteTempFile
      this.testListPath = writeTemp(content)
      args.push('--test-list', this.testListPath)
    } else if (tests !== undefined && tests.length > 0) {
      const project = sharedProject(tests)
      // `--project=name` not `--project name`: --project is variadic, so the space form swallows
      // the next positional filter as another project name ("Project not found").
      if (project !== undefined) args.push(`--project=${project}`)
      for (const d of tests) {
        args.push(d.column === undefined ? `${d.file}:${d.line}` : `${d.file}:${d.line}:${d.column}`)
      }
    }

    const spec = this.deps.launcher.launch({ ctx, playwrightArgs: args })
    let child: ChildProcessLike
    try {
      child = this.deps.spawn(spec.cmd, spec.args, { cwd: ctx.cwd, env: spec.env, stdio: 'inherit' })
    } catch (err) {
      this.cleanupTempFile()
      throw err
    }
    this.child = child
    child.on('exit', (code) => {
      this.handleChildExit(code)
    })
    child.on('error', () => {
      this.handleChildExit(null)
    })
    this.deps.setReportRunning(true)
    this.deps.setRunFiltered?.(filters.tests !== undefined)
    this.deps.broadcast({ type: 'run-status', data: { running: true, mode: this.deps.launcher.mode } })
    return { ok: true }
  }

  stop(): StopResult {
    if (this.child === null) return { ok: false, reason: 'not-running' }
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.child.kill('SIGTERM')
    this.sigkillTimer = this.deps.timers.setTimeout(() => {
      if (this.child !== null) {
        this.child.kill('SIGKILL')
        this.deps.launcher.onForceKill?.()
      }
    }, STOP_GRACE_MS)
    return { ok: true }
  }

  async prepareRun(): Promise<{ ok: true } | { ok: false; reason: 'docker-unavailable' }> {
    const launcher = this.deps.launcher
    if (launcher.prepare === undefined) return { ok: true }
    const ctx = this.deps.getRunContext()
    if (ctx === null) return { ok: true }
    try {
      await launcher.prepare({
        ctx,
        onProgress: (phase) => {
          this.deps.broadcast({ type: 'run-status', data: { running: true, mode: launcher.mode, phase } })
        },
      })
      return { ok: true }
    } catch (error) {
      this.deps.broadcast({ type: 'run-status', data: { running: false, mode: launcher.mode } })
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[RunController] run preparation failed: ${message}`)
      return { ok: false, reason: 'docker-unavailable' }
    }
  }

  dispose(): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child.kill('SIGKILL')
    this.deps.launcher.onForceKill?.()
    this.cleanupTempFile()
  }

  private handleChildExit(code: number | null): void {
    if (this.child === null) return
    if (this.sigkillTimer !== null) this.deps.timers.clearTimeout(this.sigkillTimer)
    this.sigkillTimer = null
    this.child = null
    this.cleanupTempFile()
    if (code !== null && code !== 0) console.warn(`[RunController] playwright test exited with code ${code}`)
    this.deps.setReportRunning(false)
    this.deps.broadcast({ type: 'run-status', data: { running: false, mode: this.deps.launcher.mode } })
    void this.deps.saveReport?.()
  }
}

export function createRealSpawn(): SpawnLike {
  return (cmd, args, opts): ChildProcessLike => {
    const cp = spawn(cmd, args, opts)
    return {
      on: (event, cb) => cp.on(event, cb),
      kill: (signal) => {
        const sig = KNOWN_SIGNALS[signal]
        if (sig !== undefined) cp.kill(sig)
      },
    }
  }
}

export function createRealTimers(): RunControllerDeps['timers'] {
  const pending: NodeJS.Timeout[] = []
  return {
    setTimeout: (fn, ms?): unknown => {
      const id = setTimeout(fn, ms)
      pending.push(id)
      return id
    },
    clearTimeout: (): void => {
      for (const h of pending.splice(0)) clearTimeout(h)
    },
  }
}
