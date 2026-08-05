#!/usr/bin/env node
import { join } from 'path'
import { parseArgs } from 'util'

import { isDirectExecution } from './is-direct-execution.ts'
import { startServer, type ServerOptions } from './server.ts'
import type { DockerOptions } from './server/docker-launcher.ts'
import type { RunMode } from './server/run-mode.ts'

const DEFAULT_PORT = 3000
const DEFAULT_SCREENSHOT_DIR = './screenshots'
const DEFAULT_REPORT_PATH = './report.json'
const DEFAULT_OUTPUT_DIR = './test-results'

interface ResolvedCliOptions extends ServerOptions {
  port: number
  screenshotDir: string
  reportPath: string
  outputDir: string
  runMode?: RunMode
  docker?: DockerOptions
}

export const HELP_TEXT = `Usage: crvy-rprtr [artifact-dir] [options]

Start the @crvy/rprtr visual regression report UI server.

Arguments:
  artifact-dir                Directory of downloaded CI test artifacts. When set,
                              --report-path defaults to <dir>/report.json and
                              --screenshot-dir defaults to <dir>/screenshots.

Options:
  -p, --port <number>           Server port (default: 3000)
  -s, --screenshot-dir <dir>    Screenshot artifact directory (default: ./screenshots)
  -r, --report-path <path>      Path to report.json (default: ./report.json)
  -o, --output-dir <dir>        Playwright test output directory (default: ./test-results)
  -c, --config <path>           Path to playwright.config.ts, used for approval routing
  --run-mode <mode>             Test run backend: local, docker, or auto (default: auto)
  --docker-image <image>        Docker image for docker mode (default: official Playwright image matching the installed @playwright/test version)
  --docker-platform <platform>  Container platform: linux/amd64 or linux/arm64 (default: host architecture)
  -h, --help                    Show this help message
`

export function printHelp(): void {
  console.log(HELP_TEXT)
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

export function resolveCliOptions(args: string[]): ResolvedCliOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p', default: `${DEFAULT_PORT}` },
      'screenshot-dir': { type: 'string', short: 's' },
      'report-path': { type: 'string', short: 'r' },
      'output-dir': { type: 'string', short: 'o' },
      config: { type: 'string', short: 'c' },
      'run-mode': { type: 'string' },
      'docker-image': { type: 'string' },
      'docker-platform': { type: 'string' },
    },
  })

  if (positionals.length > 1) {
    throw new TypeError(`Expected at most one artifact directory, received ${positionals.length}`)
  }

  const artifactDir = positionals[0]
  const reportPath =
    values['report-path'] ?? (artifactDir === undefined ? DEFAULT_REPORT_PATH : join(artifactDir, 'report.json'))
  const screenshotDir =
    values['screenshot-dir'] ?? (artifactDir === undefined ? DEFAULT_SCREENSHOT_DIR : join(artifactDir, 'screenshots'))

  const runMode = values['run-mode']
  if (runMode !== undefined && runMode !== 'local' && runMode !== 'docker' && runMode !== 'auto') {
    throw new TypeError(`Invalid --run-mode: ${runMode} (expected local, docker, or auto)`)
  }
  const dockerPlatform = values['docker-platform']
  if (dockerPlatform !== undefined && dockerPlatform !== 'linux/amd64' && dockerPlatform !== 'linux/arm64') {
    throw new TypeError(`Invalid --docker-platform: ${dockerPlatform} (expected linux/amd64 or linux/arm64)`)
  }
  const docker: DockerOptions = {}
  if (values['docker-image'] !== undefined) docker.image = values['docker-image']
  if (dockerPlatform !== undefined) docker.platform = dockerPlatform
  const hasDockerOptions = values['docker-image'] !== undefined || dockerPlatform !== undefined

  return {
    port: parseInt(values.port ?? `${DEFAULT_PORT}`, 10),
    screenshotDir,
    reportPath,
    outputDir: values['output-dir'] ?? DEFAULT_OUTPUT_DIR,
    playwrightConfig: values.config,
    ...(runMode === undefined ? {} : { runMode }),
    ...(hasDockerOptions ? { docker } : {}),
  }
}

if (isDirectExecution(import.meta.url)) {
  const args = process.argv.slice(2)

  if (wantsHelp(args)) {
    printHelp()
  } else {
    await startServer(resolveCliOptions(args))
  }
}
