import type { ContainerPathMapping } from './docker-support.ts'
import type { RoutesContext } from './routes.ts'

type ReportDataShape = RoutesContext['reportData']

export interface RoutesContextOptions {
  outputDir?: string
  playwrightSnapshotDir?: string
  configDir?: string
  playwrightTestDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
  runInfo?: { mode: 'local' | 'docker' }
  containerPathMapping?: ContainerPathMapping
}

export function createRoutesContext(
  reportData: ReportDataShape,
  staticDir: string,
  saveReport: () => Promise<void>,
  options: RoutesContextOptions,
): RoutesContext {
  // Artifact directories only — NOT the test source tree. Failure artifacts come from
  // outputDir; baselines are served via the /baseline route, not this allowlist.
  const artifactRoots = [reportData.screenshotDir, options.outputDir, options.playwrightSnapshotDir].filter(
    (root): root is string => root !== undefined && root !== '',
  )

  return {
    reportData,
    staticDir,
    saveReport,
    artifactRoots,
    approvalRouting: {
      configDir: options.configDir ?? process.cwd(),
      playwrightTestDir: options.playwrightTestDir,
      playwrightSnapshotDir: options.playwrightSnapshotDir,
      playwrightSnapshotPathTemplate: options.playwrightSnapshotPathTemplate,
      playwrightToHaveScreenshotPathTemplate: options.playwrightToHaveScreenshotPathTemplate,
      containerPathMapping: options.containerPathMapping,
    },
    runContext: undefined,
    runInfo: options.runInfo,
    containerPathMapping: options.containerPathMapping,
  }
}
