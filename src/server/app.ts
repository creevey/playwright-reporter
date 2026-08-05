import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { loadOfflineReports } from '../offline-reports.ts'
import {
  IncomingWebSocketMessageSchema,
  LoadedReportDataSchema,
  RegisterDataSchema,
  RunEndDataSchema,
  TestBeginDataSchema,
  TestEndDataSchema,
  safeParse,
  type IncomingWebSocketMessage,
} from '../schemas.ts'
import type { TestData } from '../types.ts'
import { type DockerOptions } from './docker-launcher.ts'
import { fileExists, isDirectory, readJsonFile } from './file-utils.ts'
import {
  handleTestBegin,
  handleTestEnd,
  handleRunEnd,
  handleApprove,
  handleSync,
  handleRegister,
  type HandlerContext,
} from './handlers.ts'
import { resolveRunBackend } from './launcher-resolver.ts'
import { resolvePlaywrightConfig } from './playwright-config.ts'
import { createReportPersistence } from './report-persistence.ts'
import { createRoutesContext } from './routes-context.ts'
import { handleHttpRequest, type RoutesContext } from './routes.ts'
import { type RunLauncher } from './run-launcher.ts'
import { type RunMode } from './run-mode.ts'
import { createCloseHandler, createRunControllerAndHandlers } from './server-factories.ts'
import type { RuntimeWebSocket } from './ws.ts'

export interface ServerOptions {
  port?: number
  screenshotDir?: string
  reportPath?: string
  /** Absolute path to the built web UI assets directory, or its parent directory */
  staticDir?: string
  /**
   * Playwright config path used to seed run support before any reporter
   * registers. When omitted, the server discovers `playwright.config.*` in the
   * working directory. A registering reporter always overrides this.
   */
  playwrightConfig?: string
  configDir?: string
  /**
   * Playwright's outputDir (test-results), where failure artifacts are written. Used as a root in
   * the `/file` serving allowlist. Relative paths are resolved against the server's working
   * directory, so start the server from the same directory the tests ran in.
   */
  outputDir?: string
  playwrightTestDir?: string
  playwrightSnapshotDir?: string
  playwrightSnapshotPathTemplate?: string
  playwrightToHaveScreenshotPathTemplate?: string
  /** Execution backend for UI-triggered runs. Default 'auto'. */
  runMode?: RunMode
  /** Docker backend settings; only used when the resolved mode is 'docker'. */
  docker?: DockerOptions
}

interface ReportData {
  isRunning: boolean
  tests: Record<string, TestData>
  browsers: string[]
  isUpdateMode: boolean
  screenshotDir: string
}

export interface ServerApp {
  port: number
  wsClients: Set<RuntimeWebSocket>
  /** Flushes pending report writes and disposes the run controller. */
  close: () => Promise<void>
  handleRequest: (req: Request) => Promise<Response>
  handleWebSocketMessage: (message: string) => Promise<void>
}

function createReportData(options: ServerOptions): ReportData {
  return {
    isRunning: false,
    tests: {},
    browsers: ['chromium'],
    isUpdateMode: false,
    screenshotDir: options.screenshotDir ?? './screenshots',
  }
}

async function loadReport(reportPath: string, reportData: ReportData): Promise<void> {
  try {
    const raw = await readJsonFile(reportPath)
    if (raw === null) {
      console.log('No report.json found, using empty state')
      return
    }

    const parsed = safeParse(LoadedReportDataSchema, raw)
    if (parsed !== null) {
      reportData.tests = parsed.tests ?? {}
      reportData.isUpdateMode = parsed.isUpdateMode ?? false
    }
  } catch {
    console.log('No report.json found, using empty state')
  }
}

async function handleParsedWebSocketMessage(ctx: HandlerContext, msg: IncomingWebSocketMessage): Promise<void> {
  switch (msg.type) {
    case 'test-begin': {
      const parsed = safeParse(TestBeginDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid test-begin message data', msg.data)
        break
      }

      handleTestBegin(ctx, parsed)
      break
    }
    case 'test-end': {
      const parsed = safeParse(TestEndDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid test-end message data', msg.data)
        break
      }

      handleTestEnd(ctx, parsed)
      break
    }
    case 'run-end': {
      const parsed = safeParse(RunEndDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid run-end message data', msg.data)
        break
      }
      await handleRunEnd(ctx, parsed)
      break
    }
    case 'approve':
      handleApprove()
      break
    case 'sync':
      handleSync(ctx)
      break
    case 'register': {
      const parsed = safeParse(RegisterDataSchema, msg.data)
      if (parsed === null) {
        console.error('Invalid register message data', msg.data)
        break
      }
      handleRegister(ctx, parsed)
      break
    }
  }
}

function createWebSocketMessageHandler(getHandlerContext: () => HandlerContext): (message: string) => Promise<void> {
  return async function handleWebSocketMessage(message: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(message)
      const wsMessage = safeParse(IncomingWebSocketMessageSchema, parsed)
      if (wsMessage === null) {
        console.error('Invalid WebSocket message: missing or invalid type', parsed)
        return
      }

      await handleParsedWebSocketMessage(getHandlerContext(), wsMessage)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('Invalid WebSocket message:', errorMsg)
    }
  }
}

async function resolveStaticDir(staticDir?: string): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidates =
    staticDir === undefined
      ? [
          currentDir,
          join(currentDir, 'dist'),
          join(currentDir, '..', 'dist'),
          join(currentDir, '..', '..', 'dist'),
          join(currentDir, '..'),
          join(currentDir, '..', '..'),
        ]
      : [staticDir, join(staticDir, 'dist')]

  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await fileExists(join(candidate, 'index.html')),
    })),
  )

  const resolved = resolvedCandidates.find(({ exists }) => exists)
  if (resolved !== undefined) {
    return resolved.candidate
  }

  return candidates[0]!
}

async function resolveReportPath(reportPath: string): Promise<{ reportFile: string; offlineReportDir: string }> {
  if (await isDirectory(reportPath)) {
    return { reportFile: join(reportPath, 'report.json'), offlineReportDir: reportPath }
  }
  return { reportFile: reportPath, offlineReportDir: dirname(reportPath) }
}

async function seedRunContext(routesContext: RoutesContext, options: ServerOptions): Promise<void> {
  if (routesContext.runContext !== undefined) {
    return
  }
  const configFile = options.playwrightConfig ?? (await resolvePlaywrightConfig(process.cwd()))
  if (configFile !== null) {
    routesContext.runContext = { configFile, cwd: process.cwd() }
  }
}

/** Resolves the launcher + routes context (and seeds runContext) so the UI can trigger runs early. */
async function setupRoutesContext(
  options: ServerOptions,
  reportData: ReportData,
  staticDir: string,
  saveReport: () => Promise<void>,
  port: number,
): Promise<{ routesContext: RoutesContext; launcher: RunLauncher }> {
  const { launcher, routesContextOptions } = await resolveRunBackend({
    runMode: options.runMode,
    docker: options.docker,
    port,
  })
  const routesContext = createRoutesContext(reportData, staticDir, saveReport, {
    ...options,
    ...routesContextOptions,
  })
  await seedRunContext(routesContext, options)
  return { routesContext, launcher }
}

export async function createServerApp(options: ServerOptions = {}): Promise<ServerApp> {
  const port = options.port ?? 3000
  const reportData = createReportData(options)
  const reportPathOption = options.reportPath ?? './report.json'
  const { reportFile, offlineReportDir } = await resolveReportPath(reportPathOption)
  const staticDir = await resolveStaticDir(options.staticDir)
  const wsClients = new Set<RuntimeWebSocket>()
  const currentRunIds = new Set<string>()
  const persistence = createReportPersistence(reportFile, reportData)
  const { routesContext, launcher } = await setupRoutesContext(
    options,
    reportData,
    staticDir,
    persistence.saveReport,
    port,
  )
  const { runController, getHandlerContext } = createRunControllerAndHandlers(
    routesContext,
    wsClients,
    reportData,
    currentRunIds,
    port,
    persistence,
    launcher,
  )
  const handleRequest = (req: Request): Promise<Response> => handleHttpRequest(routesContext, req, runController)
  const handleWebSocketMessage = createWebSocketMessageHandler(getHandlerContext)

  await loadReport(reportFile, reportData)
  await loadOfflineReports(reportData, offlineReportDir)

  return {
    port,
    wsClients,
    close: createCloseHandler(persistence, runController),
    handleRequest,
    handleWebSocketMessage,
  }
}
