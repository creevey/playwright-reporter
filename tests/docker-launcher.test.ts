import { describe, expect, test } from 'bun:test'

import { createDockerLauncher, DockerUnavailableError, DOCKER_WORK_DIR } from '../src/server/docker-launcher'
import type { DockerExec, DockerExecResult } from '../src/server/docker-support'
import type { RunContext } from '../src/server/run-controller'
import type { RunLauncher } from '../src/server/run-launcher'

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

function makeLauncher(overrides: Partial<Parameters<typeof createDockerLauncher>[0]> = {}): {
  launcher: RunLauncher
  calls: string[][]
} {
  const { exec, calls } =
    overrides.exec === undefined ? execScript({ info: ok, 'image inspect': ok }) : { exec: overrides.exec, calls: [] }
  const launcher = createDockerLauncher({
    port: 3000,
    getPlaywrightVersion: () => '1.59.0',
    env: {},
    containerName: 'test-container',
    platform: 'linux',
    exec,
    ...overrides,
  })
  return { launcher, calls }
}

const noopProgress = (): void => {}

/**
 * Captures the rejection of `promise` so callers can assert on it without
 * `await expect(...).rejects.*` (which trips oxlint's `await-thenable` because
 * bun:test's `.rejects` accessor is typed as a non-Promise `Matchers<unknown>`).
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject, but it resolved')
}

describe('DockerLauncher.prepare', () => {
  test('throws DockerUnavailableError and marks unavailable when the daemon is down', async () => {
    const { launcher } = makeLauncher({ exec: () => Promise.resolve(fail) })
    const error = await rejectionOf(launcher.prepare!({ ctx: CTX, onProgress: noopProgress }))
    expect(error).toBeInstanceOf(DockerUnavailableError)
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
    const error = await rejectionOf(launcher.prepare!({ ctx: CTX, onProgress: noopProgress }))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('docker.image')
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
    const error = await rejectionOf(launcher.prepare!({ ctx: CTX, onProgress: noopProgress }))
    expect(error).toBeInstanceOf(DockerUnavailableError)
    daemonUp = true
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    expect(launcher.available).toBe(true)
  })

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
      `${DOCKER_WORK_DIR}/playwright.config.ts`,
    ])
    expect(spec.env.CI).toBeUndefined()
  })

  test('rewrites --config under ctx.cwd to the container work dir', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', '--config', '/proj/nested/playwright.config.ts'],
    }).args
    const idx = args.indexOf('--config')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe(`${DOCKER_WORK_DIR}/nested/playwright.config.ts`)
  })

  test('rewrites --reporter under ctx.cwd to the container work dir', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', '--reporter', '/proj/node_modules/@crvy/rprtr/dist/reporter.cjs'],
    }).args
    const idx = args.indexOf('--reporter')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe(`${DOCKER_WORK_DIR}/node_modules/@crvy/rprtr/dist/reporter.cjs`)
  })

  test('replaces --reporter outside ctx.cwd with the bare @crvy/rprtr specifier', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', '--reporter', '/usr/local/share/@crvy/rprtr/dist/reporter.cjs'],
    }).args
    const idx = args.indexOf('--reporter')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('@crvy/rprtr')
  })

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

  test('passes non-path positional and flag args through unchanged', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', 'tests/foo.spec.ts:3', '--project=chromium', '--update-snapshots'],
    }).args
    const imageIdx = args.indexOf('mcr.microsoft.com/playwright:v1.59.0-noble')
    const tail = args.slice(imageIdx + 3)
    expect(tail).toEqual(['test', 'tests/foo.spec.ts:3', '--project=chromium', '--update-snapshots'])
  })

  test('passes equals-form path flags through unrewritten (run-controller never emits them)', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', '--config=/proj/playwright.config.ts'],
    }).args
    expect(args).toContain('--config=/proj/playwright.config.ts')
    expect(args).not.toContain(`${DOCKER_WORK_DIR}/playwright.config.ts`)
  })

  test('rewrites each occurrence of a repeated path flag', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', '--config', '/proj/a.config.ts', '--config', '/proj/nested/b.config.ts'],
    }).args
    const first = args.indexOf('--config')
    const second = args.indexOf('--config', first + 1)
    expect(args[first + 1]).toBe(`${DOCKER_WORK_DIR}/a.config.ts`)
    expect(args[second + 1]).toBe(`${DOCKER_WORK_DIR}/nested/b.config.ts`)
  })

  test('drops a dangling trailing path flag (run-controller never emits one)', async () => {
    const { launcher } = makeLauncher()
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({ ctx: CTX, playwrightArgs: ['test', '--config'] }).args
    expect(args).not.toContain('--config')
  })

  test('warns and passes through when --config resolves outside ctx.cwd', async () => {
    const warnings: string[] = []
    const { launcher } = makeLauncher({ warn: (m) => warnings.push(m) })
    await launcher.prepare!({ ctx: CTX, onProgress: noopProgress })
    const args = launcher.launch({
      ctx: CTX,
      playwrightArgs: ['test', '--config', '/etc/elsewhere/playwright.config.ts'],
    }).args
    const idx = args.indexOf('--config')
    expect(args[idx + 1]).toBe('/etc/elsewhere/playwright.config.ts')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('--config')
    expect(warnings[0]).toContain('/etc/elsewhere/playwright.config.ts')
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
        PATH: 'C:\\Windows\\system32;C:\\Windows',
        Path: 'C:\\Windows\\system32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
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
    expect(envFlags).not.toContain('PATH')
    expect(envFlags).not.toContain('Path')
    expect(envFlags).not.toContain('SystemRoot')
    expect(envFlags).not.toContain('TEMP')
    expect(envFlags).not.toContain('APPDATA')
    expect(envFlags).not.toContain('ProgramFiles(x86)')
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
