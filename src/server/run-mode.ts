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
