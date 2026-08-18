import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { OfflineReportSchema, safeParse } from '../src/schemas'
import type { OfflineReport } from '../src/schemas'

const TEST_WORKER_INDEX = '99'
const TEST_REPORT_PATH = `./crvy-rprtr-${TEST_WORKER_INDEX}.json`
const TEST_ARTIFACT_PATH = './test-crvy-rprtr.html'
const TEST_SCREENSHOT_DIR = './test-offline-screenshots'
const TEST_DIR = join(process.cwd(), 'tests')
const TEST_FILE = join(TEST_DIR, 'example.spec.ts')
const TEST_SNAPSHOT_DIR = join(TEST_DIR, 'example.spec.ts-snapshots')

function createProject(name: string): { name: string; testDir: string; snapshotDir: string } {
  return {
    name,
    testDir: TEST_DIR,
    snapshotDir: TEST_DIR,
  }
}

// Artifact files are content-addressed (Playwright HTML-reporter pattern): the on-disk
// name is the sha1 of the file contents, so paths stay pure ASCII on any static host.
function contentHashName(content: string): string {
  return `${createHash('sha1').update(content).digest('hex')}.png`
}

function assertValidOfflineReport(value: unknown): OfflineReport {
  const parsed = safeParse(OfflineReportSchema, value)
  if (parsed === null) {
    throw new Error('Invalid offline report format')
  }
  return parsed
}

async function readOfflineReport(): Promise<OfflineReport> {
  const reportContent = await readFile(TEST_REPORT_PATH, 'utf-8')
  const parsed: unknown = JSON.parse(reportContent)
  return assertValidOfflineReport(parsed)
}

describe('Offline Mode', () => {
  const originalWorkerIndex = process.env.TEST_WORKER_INDEX

  beforeEach(() => {
    process.env.TEST_WORKER_INDEX = TEST_WORKER_INDEX
    try {
      if (existsSync(TEST_REPORT_PATH)) {
        unlinkSync(TEST_REPORT_PATH)
      }
      if (existsSync(TEST_ARTIFACT_PATH)) {
        unlinkSync(TEST_ARTIFACT_PATH)
      }
    } catch {}
  })

  afterEach(async () => {
    try {
      await rm(TEST_SCREENSHOT_DIR, { recursive: true, force: true })
      await rm(TEST_SNAPSHOT_DIR, { recursive: true, force: true })
      if (existsSync(TEST_REPORT_PATH)) {
        await rm(TEST_REPORT_PATH)
      }
      if (existsSync(TEST_ARTIFACT_PATH)) {
        await rm(TEST_ARTIFACT_PATH)
      }
    } catch {}
    process.env.TEST_WORKER_INDEX = originalWorkerIndex
  })

  // Reframed: originally tested offline mode via WS failure; now tests that CI mode writes
  // the portable artifact at onEnd regardless of WS state. The reporter is constructed with
  // ci: true so artifacts are written unconditionally at onEnd.
  test('reporter enters offline mode when WebSocket server unavailable', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      serverUrl: 'ws://localhost:9999',
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    // Cast to access private methods for testing
    type TestReporter = {
      connect: () => void
      onTestBegin: (test: object) => void
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }
    const reporterAny = reporter as unknown as TestReporter

    reporterAny.connect()

    await Bun.sleep(100)

    // Simulate test events via the public API
    reporterAny.onTestBegin({
      id: 'test-1',
      title: 'Test 1',
      location: { file: 'test.spec.ts', line: 10 },
      parent: {
        title: 'Suite',
        type: 'describe',
        project: () => ({ name: 'chromium' }),
        parent: undefined,
      },
    })

    await reporterAny.onTestEnd(
      {
        id: 'test-1',
        title: 'Test 1',
        location: { file: 'test.spec.ts', line: 10 },
        parent: {
          title: 'Suite',
          type: 'describe',
          project: () => ({ name: 'chromium' }),
          parent: undefined,
        },
      },
      { status: 'passed', errors: [], duration: 100, attachments: [], steps: [] },
    )

    await reporterAny.onEnd({ status: 'passed' })

    expect(existsSync(TEST_REPORT_PATH)).toBe(true)

    const reportContent = await readFile(TEST_REPORT_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(reportContent)

    const report = assertValidOfflineReport(parsed)

    expect(report.version).toBe(1)
    expect(report.workers).toBe(100)
    expect(report.events).toHaveLength(3)
    expect(report.events[0]?.type).toBe('test-begin')
    expect(report.events[1]?.type).toBe('test-end')
    expect(report.events[2]?.type).toBe('run-end')
  })

  // Reframed: originally tested offline mode with no events; now tests that CI mode writes
  // the run-end event even with no test events at onEnd.
  test('offline report contains run-end event even with no other events', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      serverUrl: 'ws://localhost:9999',
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    type TestReporter = {
      connect: () => void
      onEnd: (result: { status: string }) => Promise<void>
    }
    const reporterAny = reporter as unknown as TestReporter

    reporterAny.connect()

    await Bun.sleep(100)

    await reporterAny.onEnd({ status: 'passed' })

    expect(existsSync(TEST_REPORT_PATH)).toBe(true)

    const reportContent = await readFile(TEST_REPORT_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(reportContent)

    const report = assertValidOfflineReport(parsed)

    expect(report.version).toBe(1)
    expect(report.events).toHaveLength(1)
    expect(report.events[0]?.type).toBe('run-end')
  })

  // Reframed: originally tested that WebSocket unavailability in runtime triggers offline
  // mode and artifact writing. Now tests that CI mode writes artifacts at onEnd regardless
  // of WebSocket availability in the runtime.
  test('reporter enters offline mode when WebSocket is unavailable in the runtime', async () => {
    const { CrvyRprtr } = await import('../src/reporter')
    const originalWebSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
    Object.defineProperty(globalThis, 'WebSocket', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    try {
      const reporter = new CrvyRprtr({
        serverUrl: 'ws://localhost:3000',
        screenshotDir: TEST_SCREENSHOT_DIR,
        reportHtmlPath: TEST_ARTIFACT_PATH,
        ci: true,
      })

      type TestReporter = {
        connect: () => void
        onEnd: (result: { status: string }) => Promise<void>
      }
      const reporterAny = reporter as unknown as TestReporter

      reporterAny.connect()
      await reporterAny.onEnd({ status: 'passed' })

      expect(existsSync(TEST_REPORT_PATH)).toBe(true)

      const reportContent = await readFile(TEST_REPORT_PATH, 'utf-8')
      const parsed: unknown = JSON.parse(reportContent)
      const report = assertValidOfflineReport(parsed)

      expect(report.events).toHaveLength(1)
      expect(report.events[0]?.type).toBe('run-end')
    } finally {
      if (originalWebSocketDescriptor !== undefined) {
        Object.defineProperty(globalThis, 'WebSocket', originalWebSocketDescriptor)
      }
    }
  })

  test('includes visualNames for named screenshot steps without attachments', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    const sent: unknown[] = []

    type TestReporter = {
      send: (message: unknown) => void
      onTestEnd: (test: object, result: object) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter
    reporterAny.send = (message: unknown): void => {
      sent.push(message)
    }

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-named',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(header.png)"', steps: [] }],
          },
        ],
      },
    )

    expect(sent).toHaveLength(1)
    expect((sent[0] as { data: { visualNames: string[] } }).data.visualNames).toEqual(['header'])
  })

  test('includes visualDeclarations in the test-end payload', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    const sent: unknown[] = []

    type TestReporter = {
      send: (message: unknown) => void
      onTestEnd: (test: object, result: object) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter
    reporterAny.send = (message: unknown): void => {
      sent.push(message)
    }

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-declarations',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [
              { title: 'Expect "toHaveScreenshot(header.png)"', steps: [] },
              { title: 'Expect "toHaveScreenshot"', steps: [] },
            ],
          },
        ],
      },
    )

    expect(sent).toHaveLength(1)
    expect((sent[0] as { data: { visualDeclarations: unknown[] } }).data.visualDeclarations).toEqual([
      {
        visualName: 'header',
        kind: 'named',
        declaredName: 'header',
        snapshotBaseName: 'header',
        occurrenceIndex: 1,
      },
      {
        visualName: 'visual-pass-1',
        kind: 'unnamed',
        occurrenceIndex: 1,
      },
    ])
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode). Asserts via offline
  // report that the rewritten attachment path points to the copied baseline file.
  test('copies a named screenshot baseline with a .png-suffixed attachment path', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, `header-chromium-${process.platform}.png`), 'baseline image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-named-copy',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (
      testEndEvent as { data: { visualNames: string[]; attachments: Array<{ name: string; path: string }> } }
    ).data.attachments
    const visualNames = (testEndEvent as { data: { visualNames: string[] } }).data.visualNames
    expect(visualNames).toEqual(['header'])
    expect(attachments).toMatchObject([
      {
        name: 'header-expected.png',
        path: `test-visual-named-copy/${contentHashName('baseline image')}`,
      },
    ])
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode).
  test('copies a named screenshot baseline using an explicit toHaveScreenshot path template', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const customSnapshotDir = join(TEST_SNAPSHOT_DIR, 'custom-layout')
    await mkdir(join(customSnapshotDir, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(customSnapshotDir, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      playwrightSnapshotDir: customSnapshotDir,
      playwrightToHaveScreenshotPathTemplate: '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}',
      ci: true,
    })

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-custom-template',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (testEndEvent as { data: { attachments: Array<{ name: string; path: string }> } }).data
      .attachments
    expect(attachments).toMatchObject([
      {
        name: 'header-expected.png',
        path: `test-visual-custom-template/${contentHashName('baseline image')}`,
      },
    ])
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode).
  test('copies an unnamed screenshot baseline using titlePath metadata from onTestBegin', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, `Suite-visual-pass-1-chromium-${process.platform}.png`), 'baseline image')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    type TestReporter = {
      onTestBegin: (test: object) => void
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    reporterAny.onTestBegin({
      id: 'test-visual-unnamed-copy',
      title: 'visual pass',
      titlePath: () => ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass'],
      location: { file: TEST_FILE, line: 10 },
      parent: {
        title: 'Suite',
        type: 'describe',
        project: () => createProject('chromium'),
        parent: undefined,
      },
    })

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-unnamed-copy',
        title: 'visual pass',
        titlePath: () => ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass'],
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (testEndEvent as { data: { attachments: Array<{ name: string; path: string }> } }).data
      .attachments
    expect(attachments).toMatchObject([
      {
        name: 'Suite-visual-pass-1-expected.png',
        path: `test-visual-unnamed-copy/${contentHashName('baseline image')}`,
      },
    ])
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode).
  test('copies a named screenshot baseline when the project name is empty', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, `header-${process.platform}.png`), 'baseline image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-empty-project',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject(''),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (testEndEvent as { data: { attachments: Array<{ name: string; path: string }> } }).data
      .attachments
    expect(attachments).toMatchObject([
      {
        name: 'header-expected.png',
        path: `test-visual-empty-project/${contentHashName('baseline image')}`,
      },
    ])
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode). Filesystem check retained.
  test('copies a named screenshot baseline for multi-segment screenshot names', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(join(TEST_SNAPSHOT_DIR, 'dir'), { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, 'dir', `header-chromium-${process.platform}.png`), 'baseline image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-nested-copy',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(dir/header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const data = (
      testEndEvent as { data: { visualNames: string[]; attachments: Array<{ name: string; path: string }> } }
    ).data
    expect(data.visualNames).toEqual(['dir/header'])
    expect(data.attachments).toMatchObject([
      {
        name: 'dir/header-expected.png',
        path: `test-visual-nested-copy/${contentHashName('baseline image')}`,
      },
    ])
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'test-visual-nested-copy', contentHashName('baseline image')))).toBe(
      true,
    )
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode). Filesystem check retained.
  test('stores copied baselines under ASCII content-hash paths for unsafe characters in screenshot names', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(join(TEST_SNAPSHOT_DIR, 'dir'), { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, 'dir', `header:mobile-chromium-${process.platform}.png`), 'baseline image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-nested-unsafe-copy',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(dir/header:mobile.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const data = (
      testEndEvent as { data: { visualNames: string[]; attachments: Array<{ name: string; path: string }> } }
    ).data
    expect(data.visualNames).toEqual(['dir/header:mobile'])
    expect(data.attachments).toMatchObject([
      {
        name: 'dir/header:mobile-expected.png',
        path: `test-visual-nested-unsafe-copy/${contentHashName('baseline image')}`,
      },
    ])
    expect(
      existsSync(join(TEST_SCREENSHOT_DIR, 'test-visual-nested-unsafe-copy', contentHashName('baseline image'))),
    ).toBe(true)
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode). Filesystem checks retained.
  test('keeps traversal-named copied baselines inside the per-test screenshot directory', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, `-header-chromium-${process.platform}.png`), 'baseline image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-traversal-copy',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(../header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (testEndEvent as { data: { attachments: Array<{ name: string; path: string }> } }).data
      .attachments
    expect(attachments).toMatchObject([
      {
        name: '../header-expected.png',
        path: `test-visual-traversal-copy/${contentHashName('baseline image')}`,
      },
    ])
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'test-visual-traversal-copy', contentHashName('baseline image')))).toBe(
      true,
    )
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'header-expected.png'))).toBe(false)
  })

  // Migrated: attachment saving + path rewriting now happens at onEnd (CI mode). Filesystem checks retained.
  test('keeps traversal-named PNG attachments inside the per-test screenshot directory', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(TEST_SCREENSHOT_DIR, { recursive: true })
    const sourceAttachmentPath = join(TEST_SCREENSHOT_DIR, 'source-header.png')
    await writeFile(sourceAttachmentPath, 'attachment image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-attachment-traversal-save',
        title: 'attachment path stays local',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [
          {
            name: '../header.png',
            path: sourceAttachmentPath,
            contentType: 'image/png',
          },
        ],
        steps: [],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (testEndEvent as { data: { attachments: Array<{ name: string; path: string }> } }).data
      .attachments
    expect(attachments).toMatchObject([
      {
        name: '../header.png',
        path: `test-attachment-traversal-save/${contentHashName('attachment image')}`,
      },
    ])
    expect(
      existsSync(join(TEST_SCREENSHOT_DIR, 'test-attachment-traversal-save', contentHashName('attachment image'))),
    ).toBe(true)
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'header.png'))).toBe(false)
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode).
  test('keeps slash-named and flat copied baselines distinct under content-hash paths', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(join(TEST_SNAPSHOT_DIR, 'dir'), { recursive: true })
    await writeFile(
      join(TEST_SNAPSHOT_DIR, 'dir', `header:mobile-chromium-${process.platform}.png`),
      'nested baseline image',
    )

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-collision-proof-nested',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(dir/header:mobile.png)"', steps: [] }],
          },
        ],
      },
    )

    await writeFile(
      join(TEST_SNAPSHOT_DIR, `dir-header-mobile-chromium-${process.platform}.png`),
      'flat baseline image',
    )

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-collision-proof-flat',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(dir-header-mobile.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const attachmentPaths = report.events
      .filter((event) => event.type === 'test-end')
      .flatMap((event) =>
        ((event as { data?: { attachments?: Array<{ path: string }> } }).data?.attachments ?? []).map(
          (attachment) => attachment.path,
        ),
      )

    expect(attachmentPaths).toContain(`test-visual-collision-proof-nested/${contentHashName('nested baseline image')}`)
    expect(attachmentPaths).toContain(`test-visual-collision-proof-flat/${contentHashName('flat baseline image')}`)
  })

  // Migrated: copying + path rewriting now happens at onEnd (CI mode).
  test('normalizes Windows-style screenshot names to forward slashes in offline attachments', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(join(TEST_SNAPSHOT_DIR, 'dir'), { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, 'dir', `header-chromium-${process.platform}.png`), 'baseline image')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-windows-nested-copy',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(dir\\header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const data = (
      testEndEvent as { data: { visualNames: string[]; attachments: Array<{ name: string; path: string }> } }
    ).data
    expect(data.visualNames).toEqual(['dir/header'])
    expect(data.attachments).toMatchObject([
      {
        name: 'dir/header-expected.png',
        path: `test-visual-windows-nested-copy/${contentHashName('baseline image')}`,
      },
    ])
  })

  // Regression: Cyrillic (non-ASCII) names previously produced percent-encoded artifact
  // filenames that standard static file servers (e.g. GitLab Pages) could not resolve.
  test('stores artifacts under ASCII content-hash paths for Cyrillic screenshot names', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, `привет-chromium-${process.platform}.png`), 'cyrillic baseline')
    await mkdir(TEST_SCREENSHOT_DIR, { recursive: true })
    const sourceAttachmentPath = join(TEST_SCREENSHOT_DIR, 'source-cyrillic.png')
    await writeFile(sourceAttachmentPath, 'cyrillic actual')

    type TestReporter = {
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-cyrillic',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [
          {
            name: 'привет-actual.png',
            path: sourceAttachmentPath,
            contentType: 'image/png',
          },
        ],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(привет.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')
    expect(testEndEvent).toBeDefined()
    const attachments = (testEndEvent as { data: { attachments: Array<{ name: string; path: string }> } }).data
      .attachments

    // Display names keep the raw (Cyrillic) names; artifact paths are content-addressed.
    expect(attachments).toMatchObject([
      {
        name: 'привет-actual.png',
        path: `test-visual-cyrillic/${contentHashName('cyrillic actual')}`,
      },
      {
        name: 'привет-expected.png',
        path: `test-visual-cyrillic/${contentHashName('cyrillic baseline')}`,
      },
    ])

    for (const attachment of attachments) {
      // Artifact paths must stay pure ASCII so any static file server can resolve them.
      expect(attachment.path).toMatch(/^[A-Za-z0-9-_]+\/[0-9a-f]{40}\.png$/)
    }
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'test-visual-cyrillic', contentHashName('cyrillic actual')))).toBe(true)
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'test-visual-cyrillic', contentHashName('cyrillic baseline')))).toBe(
      true,
    )
  })

  // Migrated: artifacts written at onEnd because ci: true; connect() call removed as it is
  // no longer needed to trigger artifact writing in CI mode.
  test('writes a synthetic visualName for unnamed screenshot steps into the offline payload', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      serverUrl: 'ws://localhost:9999',
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: true,
    })

    type TestReporter = {
      onTestBegin: (test: object) => void
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    reporterAny.onTestBegin({
      id: 'test-visual-unnamed',
      title: 'visual pass',
      location: { file: TEST_FILE, line: 10 },
      parent: {
        title: 'Suite',
        type: 'describe',
        project: () => createProject('chromium'),
        parent: undefined,
      },
    })

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-unnamed',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    const report = await readOfflineReport()
    const testEndEvent = report.events.find((event) => event.type === 'test-end')

    expect(testEndEvent).toBeDefined()
    expect((testEndEvent as { data: { visualNames: string[] } }).data.visualNames).toEqual(['Suite-visual-pass-1'])
  })

  // Part C: non-CI path — reporter with ci: false copies nothing and writes no artifacts.
  test('local (non-CI) reporter writes no artifacts and copies no baselines', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

    const reporter = new CrvyRprtr({
      serverUrl: 'ws://localhost:19999',
      screenshotDir: TEST_SCREENSHOT_DIR,
      reportHtmlPath: TEST_ARTIFACT_PATH,
      ci: false,
    })

    await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
    await writeFile(join(TEST_SNAPSHOT_DIR, `header-chromium-${process.platform}.png`), 'baseline image')
    await mkdir(TEST_SCREENSHOT_DIR, { recursive: true })

    type TestReporter = {
      onTestBegin: (test: object) => void
      onTestEnd: (test: object, result: object) => Promise<void>
      onEnd: (result: { status: string }) => Promise<void>
    }

    const reporterAny = reporter as unknown as TestReporter

    reporterAny.onTestBegin({
      id: 'test-visual-named-copy',
      title: 'visual pass',
      location: { file: TEST_FILE, line: 10 },
      parent: {
        title: '',
        type: 'describe',
        project: () => createProject('chromium'),
        parent: undefined,
      },
    })

    await reporterAny.onTestEnd(
      {
        id: 'test-visual-named-copy',
        title: 'visual pass',
        location: { file: TEST_FILE, line: 10 },
        parent: {
          project: () => createProject('chromium'),
        },
      },
      {
        status: 'passed',
        errors: [],
        duration: 100,
        attachments: [],
        steps: [
          {
            title: 'outer step',
            steps: [{ title: 'Expect "toHaveScreenshot(header.png)"', steps: [] }],
          },
        ],
      },
    )

    await reporterAny.onEnd({ status: 'passed' })

    // No portable artifact files written in local mode
    expect(existsSync(TEST_REPORT_PATH)).toBe(false)
    expect(existsSync(TEST_ARTIFACT_PATH)).toBe(false)

    // No baseline copy under the screenshot dir
    expect(existsSync(join(TEST_SCREENSHOT_DIR, 'test-visual-named-copy', 'header-expected.png'))).toBe(false)
  })
})
