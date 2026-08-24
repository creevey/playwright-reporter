import { spawn } from 'child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

import { detect } from 'package-manager-detector/detect'

import type { RunContext } from './run-controller.ts'

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

/** Maps an absolute path prefix in the container's mount namespace to its host equivalent. */
export interface ContainerPathMapping {
  from: string
  to: string
}

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

export type Warn = (message: string) => void

/** Module-private: fixed container-side target for the host `--test-list` tmpfile mount. */
const CONTAINER_TEST_LIST_PATH = '/tmp/crvy-rprtr-test-list.txt'

/** Bare specifier substituted when `--reporter` resolved outside the project on the host. */
const REPORTER_BARE_SPECIFIER = '@crvy/rprtr'

/** Module-private: path-valued playwright arg flags emitted by run-controller in space-separated form. */
const PATH_FLAGS = new Set(['--config', '--reporter', '--test-list'])

interface RewrittenArgs {
  args: string[]
  /** Extra `-v <host>:<container>:ro` bind mounts (e.g. the host --test-list tmpfile onto its fixed container path). */
  bindMounts: string[]
}

/**
 * Translates host paths in playwright args so they resolve inside the container.
 * - `--config` / `--reporter` under ctx.cwd → `${workDir}/...`.
 * - `--reporter` outside ctx.cwd (resolved from the server's own package) → bare `@crvy/rprtr`.
 * - `--test-list` outside ctx.cwd (host tmpdir) → fixed container path (`CONTAINER_TEST_LIST_PATH`), plus a read-only bind mount of the host file onto it.
 * - `--config` outside ctx.cwd → value unchanged plus a warning (the container cannot see it).
 * Equals-form (`--flag=value`) and dangling trailing flags are NOT rewritten; run-controller emits pairs only.
 */
export function rewritePlaywrightArgs(
  playwrightArgs: string[],
  ctx: RunContext,
  workDir: string,
  warn: Warn,
): RewrittenArgs {
  const args: string[] = []
  const bindMounts: string[] = []
  for (let i = 0; i < playwrightArgs.length; i++) {
    const flag = playwrightArgs[i]!
    if (!PATH_FLAGS.has(flag)) {
      args.push(flag)
      continue
    }
    const value = playwrightArgs[i + 1]
    if (value === undefined) break
    i += 1
    args.push(flag)
    const rewritten = rewriteContainerPath(value, { from: ctx.cwd, to: workDir })
    if (flag === '--reporter' && rewritten === value) {
      args.push(REPORTER_BARE_SPECIFIER)
    } else if (flag === '--test-list' && rewritten === value) {
      args.push(CONTAINER_TEST_LIST_PATH)
      bindMounts.push(`${value}:${CONTAINER_TEST_LIST_PATH}:ro`)
    } else {
      if (flag === '--config' && rewritten === value) {
        warn(`--config "${value}" is outside the project directory and will not resolve inside the container.`)
      }
      args.push(rewritten)
    }
  }
  return { args, bindMounts }
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

/**
 * Docker run-mode reports carry container-side test file paths (`/work/...`);
 * run descriptors from the UI must be mapped back to host paths before they
 * feed `--test-list` / positional filters resolved against the host `ctx.cwd`.
 */
export function rewriteContainerTestDescriptors<T extends { readonly file: string }>(
  tests: T[] | undefined,
  mapping: ContainerPathMapping | undefined,
): T[] | undefined {
  if (tests === undefined || mapping === undefined) return tests
  return tests.map((d) => ({ ...d, file: rewriteContainerPath(d.file, mapping) }))
}

type TestListDescriptor = {
  readonly file: string
  readonly line: number
  readonly column?: number
  readonly projectName?: string
  readonly titlePath: readonly string[]
}

function testListEntry(d: TestListDescriptor, file: string): string {
  const loc = d.column === undefined ? `${file}:${d.line}` : `${file}:${d.line}:${d.column}`
  const title = d.titlePath.join(' \u203a ')
  const prefix = d.projectName !== undefined && d.projectName !== '' ? `[${d.projectName}] \u203a ` : ''
  return `${prefix}${loc} \u203a ${title}`
}

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
