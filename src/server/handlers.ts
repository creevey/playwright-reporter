import { existsSync } from 'fs'
import { dirname, resolve } from 'path'

import { applyTestBeginEvent, applyTestEndEvent, finalizeRunEvent } from '../report-state.ts'
import type { RegisterData, TestBeginData, TestEndData } from '../schemas.ts'
import type { ClientWebSocketMessage, TestData } from '../types.ts'
import { resolveBaselineSnapshotPath, type ApprovalRouting } from './artifact-routes.ts'
import { rewriteContainerPath, type ContainerPathMapping } from './docker-support.ts'
import type { RoutesContext } from './routes.ts'
import type { RunController } from './run-controller.ts'
import { broadcastToBrowsers } from './utils.ts'
import type { RuntimeWebSocket } from './ws.ts'

export interface HandlerContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
  }
  wsClients: Set<RuntimeWebSocket>
  currentRunIds: Set<string>
  // True when the in-progress run was started with a filter (a subset of tests),
  // so run-end must NOT cull tests that were not part of this run.
  isFilteredRun: boolean
  saveReport: () => Promise<void>
  /** Debounced persistence; used after in-memory mutations so a crash or
   * interrupted run (no `run-end`) still leaves the latest state on disk. */
  scheduleReportSave: () => void
  approvalRouting?: ApprovalRouting
  routesContext: RoutesContext
  runController: RunController
}

export function handleTestBegin(ctx: HandlerContext, data: TestBeginData): void {
  const test = applyTestBeginEvent(ctx, data)
  ctx.reportData.isRunning = true
  ctx.scheduleReportSave()
  console.log(`  ▶ [${test.browser ?? '?'}] ${test.title}`)
  const message: ClientWebSocketMessage = { type: 'test-begin', data: test }
  broadcastToBrowsers(ctx.wsClients, message)
}

function enrichDeclaredBaselines(ctx: HandlerContext, test: TestData): void {
  const retry = (test.results?.length ?? 0) - 1
  const images = test.results?.[retry]?.images
  if (retry < 0 || images === undefined) {
    return
  }

  for (const [visualName, image] of Object.entries(images)) {
    if (image === undefined || image.source !== 'declared-only') {
      continue
    }

    const snapshotPath = resolveBaselineSnapshotPath(ctx.approvalRouting, test, retry, visualName)
    if (snapshotPath === null || !existsSync(snapshotPath)) {
      continue
    }

    image.expect = `/baseline/${encodeURIComponent(test.id)}/${retry}/${encodeURIComponent(visualName)}`
    image.source = 'baseline-only'
  }
}

export function handleTestEnd(ctx: HandlerContext, data: TestEndData): void {
  const result = applyTestEndEvent(ctx, data)
  if (result === null) {
    console.error('[Server] test-end for unknown test id:', data.id)
    return
  }
  const { test, diffCount } = result
  if (data.status === 'passed') {
    enrichDeclaredBaselines(ctx, test)
  }
  const icon = data.status === 'passed' ? '✓' : data.status === 'skipped' ? '–' : '✗'
  const dur = data.duration === null || data.duration === undefined ? '' : ` (${data.duration}ms)`
  const diffNote = diffCount > 0 ? ` [${diffCount} diff(s)]` : ''
  const errNote = data.error !== null && data.error !== undefined ? `\n    Error: ${data.error}` : ''
  console.log(`  ${icon} [${test.browser}] ${test.title}${dur}${diffNote}${errNote}`)
  ctx.scheduleReportSave()
  const message: ClientWebSocketMessage = { type: 'test-update', data: test }
  broadcastToBrowsers(ctx.wsClients, message)
}

export async function handleRunEnd(
  ctx: HandlerContext,
  data: { status: 'passed' | 'failed' | 'skipped' },
): Promise<void> {
  const removedTestIds = ctx.isFilteredRun
    ? []
    : Object.keys(ctx.reportData.tests).filter((id) => !ctx.currentRunIds.has(id))
  const { passed, failed, pending } = finalizeRunEvent(ctx, { preserveNonCurrent: ctx.isFilteredRun })
  await ctx.saveReport()
  console.log(`\nRun complete — ${passed} passed, ${failed} failed, ${pending} skipped`)
  const message: ClientWebSocketMessage = {
    type: 'run-end',
    data: { status: data.status, removedTestIds },
  }
  broadcastToBrowsers(ctx.wsClients, message)
}

export function handleApprove(): void {
  // WebSocket approval messages are handled via HTTP /api/approve endpoint
  // This case handles any legacy or client-initiated WebSocket approval messages
  console.log('[Server] Received approve message via WebSocket (handled via HTTP API)')
}

export function handleSync(ctx: HandlerContext): void {
  // Sync messages request a state synchronization
  console.log('[Server] Received sync message')
  const message: ClientWebSocketMessage = {
    type: 'sync',
    data: {
      tests: ctx.reportData.tests,
      isUpdateMode: ctx.reportData.isUpdateMode,
    },
  }
  broadcastToBrowsers(ctx.wsClients, message)
}

function applyContainerPathMapping(rawData: RegisterData, mapping: ContainerPathMapping): RegisterData {
  return {
    ...rawData,
    playwrightSnapshotDir:
      rawData.playwrightSnapshotDir === undefined
        ? undefined
        : rewriteContainerPath(rawData.playwrightSnapshotDir, mapping),
    playwrightTestDir:
      rawData.playwrightTestDir === undefined ? undefined : rewriteContainerPath(rawData.playwrightTestDir, mapping),
    playwrightRootDir:
      rawData.playwrightRootDir === undefined ? undefined : rewriteContainerPath(rawData.playwrightRootDir, mapping),
    configFile: rawData.configFile === undefined ? undefined : rewriteContainerPath(rawData.configFile, mapping),
    cwd: rawData.cwd === undefined ? undefined : rewriteContainerPath(rawData.cwd, mapping),
  }
}

export function handleRegister(ctx: HandlerContext, rawData: RegisterData): void {
  const mapping = ctx.routesContext.containerPathMapping
  const data: RegisterData = mapping === undefined ? rawData : applyContainerPathMapping(rawData, mapping)

  const roots: string[] = []
  if (data.playwrightSnapshotDir !== undefined && data.playwrightSnapshotDir !== '') {
    roots.push(data.playwrightSnapshotDir)
  }
  if (data.playwrightTestDir !== undefined && data.playwrightTestDir !== '') {
    roots.push(data.playwrightTestDir)
  }

  const existing = ctx.routesContext.artifactRoots ?? []
  for (const root of roots) {
    if (!existing.includes(root)) {
      existing.push(root)
    }
  }
  ctx.routesContext.artifactRoots = existing

  if (ctx.routesContext.approvalRouting !== undefined) {
    if (data.playwrightSnapshotDir !== undefined) {
      ctx.routesContext.approvalRouting.playwrightSnapshotDir = data.playwrightSnapshotDir
    }
    if (data.playwrightTestDir !== undefined) {
      ctx.routesContext.approvalRouting.playwrightTestDir = data.playwrightTestDir
    }
    if (data.playwrightSnapshotPathTemplate !== undefined) {
      ctx.routesContext.approvalRouting.playwrightSnapshotPathTemplate = data.playwrightSnapshotPathTemplate
    }
    if (data.playwrightToHaveScreenshotPathTemplate !== undefined) {
      ctx.routesContext.approvalRouting.playwrightToHaveScreenshotPathTemplate =
        data.playwrightToHaveScreenshotPathTemplate
    }
  }

  if (data.configFile !== undefined && data.cwd !== undefined) {
    ctx.routesContext.runContext = buildRunContext(data.configFile, data)
  }

  console.log('[Server] Reporter registered with config:', {
    playwrightSnapshotDir: data.playwrightSnapshotDir,
    playwrightTestDir: data.playwrightTestDir,
    configFile: data.configFile,
    cwd: data.cwd,
  })
}

/**
 * The config dir is the project root the server mounts and spawns in. Older reporters
 * registered Playwright's `rootDir` as cwd — a testDir-derived subdirectory — so derive
 * cwd from the config file instead. `rootDir` keys --test-list entry matching.
 */
function buildRunContext(configFile: string, data: RegisterData): NonNullable<RoutesContext['runContext']> {
  const configDir = dirname(configFile)
  return {
    configFile,
    cwd: configDir,
    rootDir:
      data.playwrightRootDir ??
      (data.playwrightTestDir === undefined ? configDir : resolve(configDir, data.playwrightTestDir)),
  }
}
