import { isCI } from '../ci.ts'
import { createDockerLauncher, DOCKER_WORK_DIR, type DockerOptions } from './docker-launcher.ts'
import { createDockerExec, probeDockerDaemon } from './docker-support.ts'
import type { RoutesContextOptions } from './routes-context.ts'
import { createLocalLauncher, type RunLauncher } from './run-launcher.ts'
import { resolveRunMode, type RunMode } from './run-mode.ts'

export interface ResolvedRunBackend {
  launcher: RunLauncher
  routesContextOptions: RoutesContextOptions
}

interface ResolveRunBackendOptions {
  runMode?: RunMode
  docker?: DockerOptions
  port: number
}

/**
 * Resolves the run mode (auto-probes the docker daemon once) and selects the
 * matching launcher. The docker exec is shared between the probe and the
 * launcher so the daemon is hit at most once during auto resolution. Also
 * builds the routes-context options carrying `runInfo` and (in docker mode)
 * the host↔container path mapping.
 */
export async function resolveRunBackend(options: ResolveRunBackendOptions): Promise<ResolvedRunBackend> {
  const dockerExec = createDockerExec()
  const resolvedRunMode = await resolveRunMode({
    runMode: options.runMode ?? 'auto',
    isCI: isCI(),
    probeDocker: () => probeDockerDaemon(dockerExec),
  })
  const launcher: RunLauncher =
    resolvedRunMode === 'docker'
      ? createDockerLauncher({ port: options.port, docker: options.docker, exec: dockerExec })
      : createLocalLauncher({ port: options.port })
  return {
    launcher,
    routesContextOptions: {
      runInfo: { mode: resolvedRunMode },
      containerPathMapping: resolvedRunMode === 'docker' ? { from: DOCKER_WORK_DIR, to: process.cwd() } : undefined,
    },
  }
}
