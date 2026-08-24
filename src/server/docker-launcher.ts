import {
  createDockerExec,
  detectProjectAgent,
  forceRemoveContainer,
  isDockerImagePresent,
  probeDockerDaemon,
  pullDockerImage,
  resolveContainerCommand,
  resolveDockerImage,
  rewritePlaywrightArgs,
  DEFAULT_CONTAINER_COMMAND,
  type DetectAgent,
  type DockerExec,
  type Warn,
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
  warn?: Warn
  /** Injectable host-platform seam for tests; defaults to process.platform. */
  platform?: NodeJS.Platform
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
  warnedWin32: boolean
}

interface PrepareDeps {
  docker?: DockerOptions
  getPlaywrightVersion: (cwd: string) => string | null
  detectAgent?: DetectAgent
  warn: Warn
  platform: NodeJS.Platform
}

interface LaunchDeps {
  docker?: DockerOptions
  workDir: string
  containerName: string
  port: number
  env: Record<string, string | undefined>
  image: string
  command: readonly string[]
  warn: Warn
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
  if (deps.platform === 'win32' && !state.warnedWin32) {
    state.warnedWin32 = true
    deps.warn(
      'Native Windows host detected: docker run mode is experimental on this platform. For CI-identical baselines, run crvy-rprtr from WSL2 with the project stored in the WSL filesystem.',
    )
  }
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

function buildDockerRunArgs(ctx: RunContext, playwrightArgs: string[], deps: LaunchDeps): string[] {
  const { args: rewrittenArgs, bindMounts } = rewritePlaywrightArgs(playwrightArgs, ctx, deps.workDir, deps.warn)
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
  args.push('-e', 'CRVY_RPRTR_PORTABLE_ARTIFACTS=1', '-e', 'TZ=UTC', '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8')
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
  warn: Warn
  platform: NodeJS.Platform
  docker?: DockerOptions
  port: number
}

function createState(docker?: DockerOptions): LauncherState {
  return {
    available: undefined,
    prepared: null,
    image: null,
    command: docker?.command ?? DEFAULT_CONTAINER_COMMAND,
    warnedWin32: false,
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
          platform: deps.platform,
        },
        onProgress,
      ).catch((error: unknown) => {
        // Reset so a later run re-probes after the user fixes the problem.
        state.prepared = null
        state.warnedWin32 = false
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
        warn: deps.warn,
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
    platform: options.platform ?? process.platform,
    docker: options.docker,
    port: options.port,
  })
}
