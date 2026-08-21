import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'

import type {
  FullConfig,
  FullProject,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import pLimit from 'p-limit'

import { isCI } from './ci.ts'
import { log, logError } from './debug-log.ts'
import {
  type RunEvent,
  copyResolvedBaseline,
  sanitizeId,
  saveAttachments,
  writeOfflineReport,
  writeStaticArtifact,
} from './reporter-artifact-ops.ts'
import {
  collectNativeImageAttachments,
  type CrvyRprtrOptions,
  type PendingPortableArtifact,
} from './reporter-helpers.ts'
import { type AttachmentData, type ScreenshotDeclaration, extractScreenshotDeclarations } from './reporter-utils.ts'
import {
  type ResolvedBaselineTarget,
  type SnapshotResolverInput,
  resolveBaselineTargets,
  withResolvedVisualNames,
} from './snapshot-path-resolver.ts'

export type { CrvyRprtrOptions }

export class CrvyRprtr implements Reporter {
  private ws: WebSocket | null = null
  private serverUrl: string
  private screenshotDir: string
  private queue: string[] = []
  private workerIndex: number
  private offlineReportPath: string
  private reportHtmlPath: string
  private configDir = process.cwd()
  private testMetadata = new Map<string, { reporterTitlePath: string[] }>()
  private playwrightSnapshotDir?: string
  private playwrightSnapshotPathTemplate?: string
  private playwrightToHaveScreenshotPathTemplate?: string
  private isOfflineMode = false
  private runEvents: RunEvent[] = []
  private readonly ci: boolean
  private readonly portableArtifacts = process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS === '1'
  private pendingArtifacts: PendingPortableArtifact[] = []

  constructor(options: CrvyRprtrOptions = {}) {
    this.serverUrl = options.serverUrl ?? process.env.CRVY_RPRTR_SERVER_URL ?? 'ws://localhost:3000'
    this.screenshotDir = options.screenshotDir ?? './screenshots'
    this.workerIndex = parseInt(process.env.TEST_WORKER_INDEX ?? '0', 10) || 0
    this.offlineReportPath = options.offlineReportPath ?? `./crvy-rprtr-${this.workerIndex}.json`
    this.reportHtmlPath = options.reportHtmlPath ?? './crvy-rprtr.html'
    this.playwrightSnapshotDir = options.playwrightSnapshotDir
    this.playwrightSnapshotPathTemplate = options.playwrightSnapshotPathTemplate
    this.playwrightToHaveScreenshotPathTemplate = options.playwrightToHaveScreenshotPathTemplate
    this.ci = options.ci ?? isCI()
    if (this.ci) this.isOfflineMode = true
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.configDir = config.configFile === undefined ? config.rootDir : dirname(config.configFile)
    log(`[CrvyRprtr] Starting run with ${suite.allTests().length} tests`)
    if (!this.ci) {
      this.connect()
      this.sendRegister(config)
    }
  }

  private connect(): void {
    const WebSocketConstructor = globalThis.WebSocket
    if (typeof WebSocketConstructor !== 'function') {
      log('[CrvyRprtr] WebSocket unavailable in current runtime; offline mode enabled')
      this.enableOfflineMode()
      return
    }
    try {
      this.ws = new WebSocketConstructor(this.serverUrl)
      this.ws.onopen = (): void => {
        log('[CrvyRprtr] Connected to Crvy Rprtr server')
        this.isOfflineMode = false
        for (const message of this.queue) this.ws!.send(message)
        this.queue = []
      }
      this.ws.onerror = (error): void => {
        logError('[CrvyRprtr] WebSocket error:', error)
        this.enableOfflineMode()
      }
      this.ws.onclose = (): void => {
        log('[CrvyRprtr] Disconnected from Crvy Rprtr server')
        this.enableOfflineMode()
      }
    } catch (error) {
      logError('[CrvyRprtr] Failed to connect:', error)
      this.enableOfflineMode()
    }
  }
  private enableOfflineMode(): void {
    if (this.isOfflineMode) return
    this.isOfflineMode = true
    log('[CrvyRprtr] Offline mode enabled - events will be queued to file')
  }
  private sendRegister(config: FullConfig): void {
    const snapshotDir = this.playwrightSnapshotDir ?? config.projects[0]?.snapshotDir
    const testDir = this.playwrightSnapshotDir === undefined ? config.projects[0]?.testDir : undefined
    this.send({
      type: 'register',
      data: {
        playwrightSnapshotDir: typeof snapshotDir === 'string' ? snapshotDir : undefined,
        playwrightTestDir: typeof testDir === 'string' ? testDir : undefined,
        playwrightRootDir: typeof config.rootDir === 'string' ? config.rootDir : undefined,
        playwrightSnapshotPathTemplate: this.playwrightSnapshotPathTemplate,
        playwrightToHaveScreenshotPathTemplate: this.playwrightToHaveScreenshotPathTemplate,
        configFile: config.configFile,
        cwd: config.configFile === undefined ? process.cwd() : dirname(config.configFile),
      },
    })
  }

  private describeTitlePath(test: TestCase): string[] {
    const titlePath: string[] = []
    for (let suite: Suite | undefined = test.parent; suite?.type === 'describe'; suite = suite.parent)
      titlePath.unshift(suite.title)
    return titlePath
  }

  /** Resolves a non-empty browser label for UI display, falling back to the
   * configured browser engine since the raw project `name` is `""` for the
   * default project and devices spread `defaultBrowserType` into `use`. */
  private resolveBrowserLabel(project: FullProject | undefined): string {
    const name = project?.name
    if (name !== undefined && name !== '') return name
    return project?.use?.browserName ?? project?.use?.defaultBrowserType ?? 'chromium'
  }

  private reporterTitlePath(test: TestCase): string[] {
    // Index 1 is the raw Playwright project name ("" for the default project).
    return typeof test.titlePath === 'function'
      ? test.titlePath()
      : ['', test.parent.project()?.name ?? '', test.location.file, ...this.describeTitlePath(test), test.title]
  }

  onTestBegin(test: TestCase): void {
    const project = test.parent.project()
    this.testMetadata.set(test.id, {
      reporterTitlePath: this.reporterTitlePath(test),
    })
    this.send({
      type: 'test-begin',
      data: {
        id: test.id,
        title: test.title,
        titlePath: this.describeTitlePath(test),
        browser: this.resolveBrowserLabel(project),
        projectName: project?.name ?? '',
        location: { file: test.location.file, line: test.location.line, column: test.location.column },
      },
    })
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const reporterTitlePath = this.testMetadata.get(test.id)?.reporterTitlePath ?? this.reporterTitlePath(test)
    const screenshotDeclarations = withResolvedVisualNames(
      extractScreenshotDeclarations(result.steps),
      reporterTitlePath,
    )
    const nativeAttachments = collectNativeImageAttachments(result)
    const data = {
      id: test.id,
      title: test.title,
      status: result.status,
      attachments: nativeAttachments,
      visualNames: screenshotDeclarations.map(({ visualName }) => visualName),
      visualDeclarations: screenshotDeclarations,
      error: result.errors.length > 0 ? result.errors[0]?.message : undefined,
      duration: result.duration,
    }
    try {
      if (this.ci) {
        const baselineInput = result.status === 'passed' ? this.baselineInput(test, screenshotDeclarations) : null
        const resolvedTargets = baselineInput === null ? [] : resolveBaselineTargets(baselineInput)
        this.pendingArtifacts.push({
          testId: test.id,
          status: result.status,
          resolvedTargets,
          nativeAttachments,
          eventData: data,
        })
      } else if (this.portableArtifacts) {
        await mkdir(this.screenshotDir, { recursive: true })
        data.attachments = await saveAttachments(this.screenshotDir, test.id, { attachments: nativeAttachments })
      }
      this.send({ type: 'test-end', data })
    } finally {
      this.testMetadata.delete(test.id)
    }
  }

  private baselineInput(test: TestCase, shots: readonly ScreenshotDeclaration[]): SnapshotResolverInput | null {
    const project = test.parent.project()
    const snapshotDir = this.playwrightSnapshotDir ?? project?.snapshotDir
    if (project === undefined || typeof project.testDir !== 'string' || typeof snapshotDir !== 'string') return null
    return {
      testFile: test.location.file,
      reporterTitlePath: this.testMetadata.get(test.id)?.reporterTitlePath ?? this.reporterTitlePath(test),
      declarations: shots,
      config: {
        configDir: this.configDir,
        testDir: project.testDir,
        snapshotDir,
        projectName: project.name,
        snapshotSuffix: process.platform,
        snapshotPathTemplate: this.playwrightSnapshotPathTemplate,
        toHaveScreenshotPathTemplate: this.playwrightToHaveScreenshotPathTemplate,
      },
      snapshotPathExists: existsSync,
    }
  }

  private async copyBaselinesForTargets(
    testId: string,
    status: TestResult['status'],
    resolvedTargets: ResolvedBaselineTarget[],
    savedAttachments: AttachmentData[],
  ): Promise<void> {
    if (status !== 'passed' || resolvedTargets.length === 0) return
    const safeTestId = sanitizeId(testId)
    const testScreenshotDir = join(this.screenshotDir, safeTestId)
    const limit = pLimit(5)
    await Promise.all(
      resolvedTargets.map((target) =>
        limit(() => copyResolvedBaseline(safeTestId, testScreenshotDir, target, savedAttachments)),
      ),
    )
  }
  async onEnd(result: FullResult): Promise<void> {
    this.send({ type: 'run-end', data: { status: result.status } })
    if (this.ci) {
      await mkdir(this.screenshotDir, { recursive: true })
      const limit = pLimit(10)
      await Promise.all(
        this.pendingArtifacts.map((pending) =>
          limit(async () => {
            const savedAttachments = await saveAttachments(this.screenshotDir, pending.testId, {
              attachments: pending.nativeAttachments,
            })
            await this.copyBaselinesForTargets(
              pending.testId,
              pending.status,
              pending.resolvedTargets,
              savedAttachments,
            )
            pending.eventData.attachments = savedAttachments
          }),
        ),
      )
      await writeStaticArtifact(this.runEvents, this.screenshotDir, this.reportHtmlPath)
      await writeOfflineReport(this.runEvents, this.offlineReportPath, this.workerIndex)
    }

    await new Promise<void>((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        resolve()
        return
      }
      this.ws.onclose = (): void => {
        resolve()
      }
      setTimeout(() => {
        this.ws?.close()
        resolve()
      }, 1000)
      this.ws.close()
    })
  }

  private send(message: object): void {
    const event = message as { type?: string; data?: unknown }
    if (event.type === 'test-begin' || event.type === 'test-end' || event.type === 'run-end')
      this.runEvents.push({ type: event.type, data: event.data })
    const payload = JSON.stringify(message)
    if (!this.isOfflineMode) {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload)
      else this.queue.push(payload)
    }
  }
}
export default CrvyRprtr
