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
