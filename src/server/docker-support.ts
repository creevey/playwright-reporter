import { spawn } from 'child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

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
