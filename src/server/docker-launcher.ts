import {
  createDockerExec,
  detectProjectAgent,
  forceRemoveContainer,
  isDockerImagePresent,
  probeDockerDaemon,
  pullDockerImage,
  resolveContainerCommand,
  resolveDockerImage,
  rewriteContainerPath,
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

interface LauncherState {
  available: boolean | undefined
  prepared: Promise<void> | null
  image: string | null
  command: readonly string[]
}

interface PrepareDeps {
  docker?: DockerOptions
  getPlaywrightVersion: (cwd: string) => string | null
  detectAgent?: DetectAgent
  warn: (message: string) => void
}

interface LaunchDeps {
  docker?: DockerOptions
  workDir: string
  containerName: string
  port: number
  env: Record<string, string | undefined>
  image: string
  command: readonly string[]
}

function defaultWarn(message: string): void {
  console.warn(`[crvy-rprtr] ${message}`)
}

async function detectAgentName(detect: DetectAgent | undefined, cwd: string): Promise<string | null> {
  const detected = await (detect ?? detectProjectAgent)(cwd)
  return detected?.name ?? null
}

async function prepareDocker(
  state: LauncherState,
  exec: DockerExec,
  ctx: RunContext,
  deps: PrepareDeps,
  onProgress: (phase: string) => void,
): Promise<void> {
  if (!(await probeDockerDaemon(exec))) {
    state.available = false
    throw new DockerUnavailableError()
  }
  state.available = true

  const image = resolveDockerImage({ image: deps.docker?.image, version: deps.getPlaywrightVersion(ctx.cwd) })
  if (image === null) {
    throw new Error('Could not resolve the installed @playwright/test version; set docker.image explicitly.')
  }
  state.image = image

  state.command = resolveContainerCommand({
    command: deps.docker?.command,
    hasCustomImage: deps.docker?.image !== undefined,
    detectedAgentName: deps.docker?.image === undefined ? 'npm' : await detectAgentName(deps.detectAgent, ctx.cwd),
    warn: deps.warn,
  })

  if (!(await isDockerImagePresent(exec, image))) {
    onProgress('pulling')
    if (!(await pullDockerImage(exec, image))) {
      throw new Error(`Failed to pull docker image: ${image}`)
    }
  }
}

/** Bare specifier substituted when `--reporter` resolved outside the project on the host. */
const REPORTER_BARE_SPECIFIER = '@crvy/rprtr'

/** Module-private: path-valued playwright arg flags emitted by run-controller in space-separated form. */
const PATH_FLAGS = new Set(['--config', '--reporter', '--test-list'])

interface RewrittenArgs {
  args: string[]
  /** Extra `-v <path>:<path>:ro` host paths (e.g. host tmpdir files) the container must see verbatim. */
  bindMounts: string[]
}

/**
 * Module-private: translates host paths in playwright args so they resolve inside the container.
 * - `--config` / `--reporter` under ctx.cwd → `${workDir}/...`.
 * - `--reporter` outside ctx.cwd (resolved from the server's own package) → bare `@crvy/rprtr`.
 * - `--test-list` outside ctx.cwd (host tmpdir) → value unchanged, plus a same-path read-only bind mount.
 */
function rewritePlaywrightArgs(playwrightArgs: string[], ctx: RunContext, workDir: string): RewrittenArgs {
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
      args.push(value)
      bindMounts.push(`${value}:${value}:ro`)
    } else {
      args.push(rewritten)
    }
  }
  return { args, bindMounts }
}

function buildDockerRunArgs(ctx: RunContext, playwrightArgs: string[], deps: LaunchDeps): string[] {
  const { args: rewrittenArgs, bindMounts } = rewritePlaywrightArgs(playwrightArgs, ctx, deps.workDir)
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    deps.containerName,
    '--add-host',
    `${DOCKER_HOST_GATEWAY}:host-gateway`,
    '--ipc=host',
  ]
  if (deps.docker?.platform !== undefined) {
    args.push('--platform', deps.docker.platform)
  }
  args.push('-v', `${ctx.cwd}:${deps.workDir}:rw`, '-w', deps.workDir)
  for (const mount of bindMounts) {
    args.push('-v', mount)
  }
  args.push('-e', `CRVY_RPRTR_SERVER_URL=ws://${DOCKER_HOST_GATEWAY}:${deps.port}`)
  args.push('-e', 'CRVY_RPRTR_PORTABLE_ARTIFACTS=1')
  args.push('-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
  args.push('-e', 'PLAYWRIGHT_HTML_OPEN=never')
  for (const [key, value] of Object.entries(deps.env)) {
    if (ENV_DENYLIST.has(key) || value === undefined) continue
    args.push('-e', key)
  }
  if (deps.docker?.extraArgs !== undefined) args.push(...deps.docker.extraArgs)
  args.push(deps.image, ...deps.command, 'playwright', ...rewrittenArgs)
  return args
}

function stripCi(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CI') continue
    out[key] = value
  }
  return out
}

interface LauncherDeps {
  exec: DockerExec
  workDir: string
  containerName: string
  baseEnv: Record<string, string | undefined>
  getVersion: (cwd: string) => string | null
  detectAgent: DetectAgent | undefined
  warn: (message: string) => void
  docker?: DockerOptions
  port: number
}

function createState(docker?: DockerOptions): LauncherState {
  return {
    available: undefined,
    prepared: null,
    image: null,
    command: docker?.command ?? DEFAULT_CONTAINER_COMMAND,
  }
}

function buildLauncher(state: LauncherState, deps: LauncherDeps): RunLauncher {
  return {
    mode: 'docker',
    get available(): boolean | undefined {
      return state.available
    },
    prepare({ ctx, onProgress }): Promise<void> {
      state.prepared ??= prepareDocker(
        state,
        deps.exec,
        ctx,
        {
          docker: deps.docker,
          getPlaywrightVersion: deps.getVersion,
          detectAgent: deps.detectAgent,
          warn: deps.warn,
        },
        onProgress,
      ).catch((error: unknown) => {
        // Reset so a later run re-probes after the user fixes the problem.
        state.prepared = null
        throw error
      })
      return state.prepared
    },
    launch({ ctx, playwrightArgs }: LaunchParams): LaunchSpec {
      const image = state.image ?? resolveDockerImage({ image: deps.docker?.image, version: deps.getVersion(ctx.cwd) })
      if (image === null) {
        throw new Error('Could not resolve the docker image; run prepare() first or set docker.image.')
      }
      const args = buildDockerRunArgs(ctx, playwrightArgs, {
        docker: deps.docker,
        workDir: deps.workDir,
        containerName: deps.containerName,
        port: deps.port,
        env: deps.baseEnv,
        image,
        command: state.command,
      })
      return { cmd: 'docker', args, env: stripCi(deps.baseEnv) }
    },
    onForceKill(): void {
      void forceRemoveContainer(deps.exec, deps.containerName)
    },
  }
}

export function createDockerLauncher(options: DockerLauncherOptions): RunLauncher {
  return buildLauncher(createState(options.docker), {
    exec: options.exec ?? createDockerExec(),
    workDir: options.workDir ?? DOCKER_WORK_DIR,
    containerName: options.containerName ?? `crvy-rprtr-run-${process.pid}`,
    baseEnv: options.env ?? process.env,
    getVersion: options.getPlaywrightVersion ?? resolvePlaywrightVersion,
    detectAgent: options.detectAgent,
    warn: options.warn ?? defaultWarn,
    docker: options.docker,
    port: options.port,
  })
}
