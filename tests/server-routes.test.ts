import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

import { createServerApp } from '../src/server/app'
import { handleHttpRequest, isPathWithinRoots } from '../src/server/routes'
import type { RunController } from '../src/server/run-controller'
import type { TestData } from '../src/types'

const TMP_DIR = join(process.cwd(), 'test-approval-routing')
const SCREENSHOT_DIR = join(TMP_DIR, 'screenshots')
const SNAPSHOT_DIR = join(TMP_DIR, 'snapshots')
const PLAYWRIGHT_TEST_DIR = join(TMP_DIR, 'tests')
const TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'example.spec.ts')
const NESTED_TEST_FILE = join(PLAYWRIGHT_TEST_DIR, 'nested', 'example.spec.ts')
const PLAYWRIGHT_CONFIG_DIR = join(TMP_DIR, 'playwright-config')
const CONFIGURED_PLAYWRIGHT_TEST_DIR = join(PLAYWRIGHT_CONFIG_DIR, 'tests')
const CONFIGURED_NESTED_TEST_FILE = join(CONFIGURED_PLAYWRIGHT_TEST_DIR, 'nested', 'example.spec.ts')
const RELATIVE_SNAPSHOT_DIR = 'test-approval-routing-relative-snapshots'
const CUSTOM_TEMPLATE = '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}'

function createContext(tests: Record<string, TestData>): Parameters<typeof handleHttpRequest>[0] {
  return {
    reportData: {
      isRunning: false,
      tests,
      browsers: ['chromium'],
      isUpdateMode: false,
      screenshotDir: SCREENSHOT_DIR,
    },
    staticDir: './dist',
    saveReport: async (): Promise<void> => {},
    approvalRouting: {
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    },
  }
}

function createStubRunController(
  startResult: { ok: true } | { ok: false; reason: 'no-config' | 'already-running' | 'no-tests' } = { ok: true },
  stopResult: { ok: true } | { ok: false; reason: 'not-running' } = { ok: true },
): RunController {
  return {
    start: () => startResult,
    stop: () => stopResult,
    prepareRun: (): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
    dispose: () => {},
    isRunning: false,
  } as unknown as RunController
}

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
  await rm(join(process.cwd(), RELATIVE_SNAPSHOT_DIR), {
    recursive: true,
    force: true,
  })
})

describe('approval routing', () => {
  test('approve writes to the resolver-selected custom-template target', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-1'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-1', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-1': {
        id: 'test-1',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-1/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-1', retry: 0, image: 'header' }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-1']?.approved).toEqual({ header: 0 })
  })

  test('approve uses configured testDir for nested test-file templates', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-nested'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts'), {
      recursive: true,
    })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-nested', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts', 'header.png'), 'nested baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'flat baseline image')

    const tests: Record<string, TestData> = {
      'test-nested': {
        id: 'test-nested',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: NESTED_TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-nested/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-nested', retry: 0, image: 'header' }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'flat baseline image',
    )
    expect(tests['test-nested']?.approved).toEqual({ header: 0 })
  })

  test('approve resolves relative snapshot paths against the configured configDir instead of the server cwd', async () => {
    const configuredSnapshotDir = join(
      PLAYWRIGHT_CONFIG_DIR,
      RELATIVE_SNAPSHOT_DIR,
      'chromium',
      'nested',
      'example.spec.ts',
    )
    const cwdSnapshotDir = join(process.cwd(), RELATIVE_SNAPSHOT_DIR, 'chromium', 'nested', 'example.spec.ts')
    const reportPath = join(TMP_DIR, 'report.json')

    await mkdir(join(SCREENSHOT_DIR, 'test-config-dir'), { recursive: true })
    await mkdir(configuredSnapshotDir, { recursive: true })
    await mkdir(cwdSnapshotDir, { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-config-dir', 'header-actual.png'), 'actual image')
    await writeFile(join(configuredSnapshotDir, 'header.png'), 'configured baseline image')
    await writeFile(join(cwdSnapshotDir, 'header.png'), 'cwd baseline image')

    const tests: Record<string, TestData> = {
      'test-config-dir': {
        id: 'test-config-dir',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: CONFIGURED_NESTED_TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-config-dir/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    await writeFile(reportPath, JSON.stringify({ tests }))

    const app = await createServerApp({
      reportPath,
      screenshotDir: SCREENSHOT_DIR,
      staticDir: './dist',
      configDir: PLAYWRIGHT_CONFIG_DIR,
      playwrightTestDir: CONFIGURED_PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: RELATIVE_SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    try {
      const response = await app.handleRequest(
        new Request('http://localhost/api/approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 'test-config-dir',
            retry: 0,
            image: 'header',
          }),
        }),
      )

      expect(response.status).toBe(200)
      expect(await readFile(join(configuredSnapshotDir, 'header.png'), 'utf-8')).toBe('actual image')
      expect(await readFile(join(cwdSnapshotDir, 'header.png'), 'utf-8')).toBe('cwd baseline image')
    } finally {
      await app.close()
    }
  })

  test('approve writes an unnamed screenshot to its anonymous baseline target', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-unnamed'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-unnamed', 'anonymous-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'Suite-visual-pass-1.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-unnamed': {
        id: 'test-unnamed',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              '__unnamed-screenshot-1': {
                actual: '/screenshots/test-unnamed/anonymous-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: '__unnamed-screenshot-1',
                kind: 'unnamed',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'test-unnamed',
          retry: 0,
          image: '__unnamed-screenshot-1',
        }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'Suite-visual-pass-1.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-unnamed']?.approved).toEqual({
      '__unnamed-screenshot-1': 0,
    })
  })

  test('approve writes duplicate named screenshots to the matching occurrence target', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-duplicate'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-duplicate', 'header-1-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'first baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header-1.png'), 'second baseline image')

    const tests: Record<string, TestData> = {
      'test-duplicate': {
        id: 'test-duplicate',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'header-1': {
                actual: '/screenshots/test-duplicate/header-1-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
              {
                visualName: 'header-1',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 2,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'test-duplicate',
          retry: 0,
          image: 'header-1',
        }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'first baseline image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header-1.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-duplicate']?.approved).toEqual({ 'header-1': 0 })
  })

  test('approve resolves slash-containing names when exactly one candidate exists', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-slash'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-slash', 'dir-header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-slash': {
        id: 'test-slash',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'dir/header': {
                actual: '/screenshots/test-slash/dir-header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'dir/header',
                kind: 'named',
                declaredName: 'dir/header',
                snapshotBaseName: 'dir/header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'test-slash',
          retry: 0,
          image: 'dir/header',
        }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(tests['test-slash']?.approved).toEqual({ 'dir/header': 0 })
  })

  test('approve fails when exact resolution is ambiguous', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-ambiguous'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-ambiguous', 'dir-header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'string baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'array baseline')

    const tests: Record<string, TestData> = {
      'test-ambiguous': {
        id: 'test-ambiguous',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'dir/header': {
                actual: '/screenshots/test-ambiguous/dir-header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'dir/header',
                kind: 'named',
                declaredName: 'dir/header',
                snapshotBaseName: 'dir/header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'test-ambiguous',
          retry: 0,
          image: 'dir/header',
        }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      success: false,
      error: 'Could not resolve approval target',
    })
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'utf-8')).toBe(
      'string baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'array baseline',
    )
    expect(tests['test-ambiguous']?.approved).toBeUndefined()
  })

  test('approve with /file URL decodes the absolute path and writes to the baseline', async () => {
    const nativeActual = join(TMP_DIR, 'native', 'header-actual.png')
    await mkdir(dirname(nativeActual), { recursive: true })
    await writeFile(nativeActual, 'actual image')
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-1': {
        id: 'test-1',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: `/file/${encodeURIComponent(nativeActual)}`,
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-1', retry: 0, image: 'header' }),
      }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf8')).toBe('actual image')
    expect(tests['test-1']?.approved).toEqual({ header: 0 })
  })

  test('approve ignores GET and DELETE requests without mutating approval state or files', async () => {
    const assertApproveMethodDoesNotMutate = async (method: 'GET' | 'DELETE'): Promise<void> => {
      const testId = `test-${method.toLowerCase()}`
      const baselinePath = join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png')

      await mkdir(join(SCREENSHOT_DIR, testId), { recursive: true })
      await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
        recursive: true,
      })
      await writeFile(join(SCREENSHOT_DIR, testId, 'header-actual.png'), `${method} actual image`)
      await writeFile(baselinePath, `${method} baseline image`)

      const tests: Record<string, TestData> = {
        [testId]: {
          id: testId,
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
          results: [
            {
              status: 'failed',
              retries: 0,
              images: {
                header: {
                  actual: `/screenshots/${testId}/header-actual.png`,
                },
              },
              visualDeclarations: [
                {
                  visualName: 'header',
                  kind: 'named',
                  declaredName: 'header',
                  snapshotBaseName: 'header',
                  occurrenceIndex: 1,
                },
              ],
            },
          ],
        },
      }

      const response = await handleHttpRequest(
        {
          ...createContext(tests),
          saveReport: (): Promise<void> =>
            Promise.reject(new Error('saveReport should not be called for non-POST approve requests')),
        },
        new Request('http://localhost/api/approve', {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: testId, retry: 0, image: 'header' }),
        }),
        createStubRunController(),
      )

      expect(response.status).toBe(404)
      expect(await readFile(baselinePath, 'utf-8')).toBe(`${method} baseline image`)
      expect(tests[testId]?.approved).toBeUndefined()
    }

    await assertApproveMethodDoesNotMutate('GET')
    await assertApproveMethodDoesNotMutate('DELETE')
  })

  test('approve-all ignores GET requests without mutating approval state or files', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-success'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-success', 'header-actual.png'), 'actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-success': {
        id: 'test-success',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-success/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve-all', { method: 'GET' }),
      createStubRunController(),
    )

    expect(response.status).toBe(404)
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'baseline image',
    )
    expect(tests['test-success']?.approved).toBeUndefined()
  })

  test('approve-all reports mixed outcomes and only records approvals for successful copies', async () => {
    await mkdir(join(SCREENSHOT_DIR, 'test-success'), { recursive: true })
    await mkdir(join(SCREENSHOT_DIR, 'test-ambiguous'), { recursive: true })
    await mkdir(join(SCREENSHOT_DIR, 'test-failed'), { recursive: true })
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir'), {
      recursive: true,
    })
    await writeFile(join(SCREENSHOT_DIR, 'test-success', 'header-actual.png'), 'actual image')
    await writeFile(join(SCREENSHOT_DIR, 'test-ambiguous', 'dir-header-actual.png'), 'ambiguous actual image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'missing.png'), 'failed baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'string baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'array baseline')
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'no-actual.png'), 'no actual baseline')

    const tests: Record<string, TestData> = {
      'test-success': {
        id: 'test-success',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              header: {
                actual: '/screenshots/test-success/header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
      'test-ambiguous': {
        id: 'test-ambiguous',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'dir/header': {
                actual: '/screenshots/test-ambiguous/dir-header-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'dir/header',
                kind: 'named',
                declaredName: 'dir/header',
                snapshotBaseName: 'dir/header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
      'test-failed': {
        id: 'test-failed',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              missing: {
                actual: '/screenshots/test-failed/missing-actual.png',
              },
            },
            visualDeclarations: [
              {
                visualName: 'missing',
                kind: 'named',
                declaredName: 'missing',
                snapshotBaseName: 'missing',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
      'test-no-actual': {
        id: 'test-no-actual',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'failed',
            retries: 0,
            images: {
              'no-actual': {},
            },
            visualDeclarations: [
              {
                visualName: 'no-actual',
                kind: 'named',
                declaredName: 'no-actual',
                snapshotBaseName: 'no-actual',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const response = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/api/approve-all', { method: 'POST' }),
      createStubRunController(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: false,
      approved: 1,
      unresolved: 2,
      failed: 1,
    })
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'utf-8')).toBe(
      'actual image',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'missing.png'), 'utf-8')).toBe(
      'failed baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir-header.png'), 'utf-8')).toBe(
      'string baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'dir', 'header.png'), 'utf-8')).toBe(
      'array baseline',
    )
    expect(await readFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'no-actual.png'), 'utf-8')).toBe(
      'no actual baseline',
    )
    expect(tests['test-success']?.approved).toEqual({ header: 0 })
    expect(tests['test-ambiguous']?.approved).toBeUndefined()
    expect(tests['test-failed']?.approved).toBeUndefined()
    expect(tests['test-no-actual']?.approved).toBeUndefined()
  })
})

describe('GET /baseline', () => {
  test('resolves and serves the baseline for a stored declaration', async () => {
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-1': {
        id: 'test-1',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'success',
            retries: 0,
            images: { header: { source: 'declared-only' } },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const res = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/baseline/test-1/0/header'),
      createStubRunController(),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('baseline image')
  })

  test('returns 404 when the test is unknown', async () => {
    const res = await handleHttpRequest(
      createContext({}),
      new Request('http://localhost/baseline/missing/0/header'),
      createStubRunController(),
    )
    expect(res.status).toBe(404)
  })

  test('returns 404 for malformed percent-encoding in the visual name', async () => {
    const res = await handleHttpRequest(
      createContext({}),
      new Request('http://localhost/baseline/test-1/0/%GG'),
      createStubRunController(),
    )
    expect(res.status).toBe(404)
  })

  test('returns 404 for a non-numeric retry segment', async () => {
    const res = await handleHttpRequest(
      createContext({}),
      new Request('http://localhost/baseline/test-1/abc/header'),
      createStubRunController(),
    )
    expect(res.status).toBe(404)
  })

  test('returns 404 for an empty visual name (trailing slash)', async () => {
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-1': {
        id: 'test-1',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'success',
            retries: 0,
            images: { header: { source: 'declared-only' } },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    const res = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/baseline/test-1/0/'),
      createStubRunController(),
    )
    expect(res.status).toBe(404)
  })

  test('returns 404 for an empty retry segment even when the baseline exists', async () => {
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const tests: Record<string, TestData> = {
      'test-1': {
        id: 'test-1',
        title: 'visual pass',
        titlePath: ['Suite'],
        browser: 'chromium',
        location: { file: TEST_FILE, line: 10 },
        results: [
          {
            status: 'success',
            retries: 0,
            images: { header: { source: 'declared-only' } },
            visualDeclarations: [
              {
                visualName: 'header',
                kind: 'named',
                declaredName: 'header',
                snapshotBaseName: 'header',
                occurrenceIndex: 1,
              },
            ],
          },
        ],
      },
    }

    // Double slash => empty retry segment. Must be rejected, not treated as retry 0.
    const res = await handleHttpRequest(
      createContext(tests),
      new Request('http://localhost/baseline/test-1//header'),
      createStubRunController(),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /file', () => {
  const ROOT = join(TMP_DIR, 'allowed')

  test('serves a file inside an allowed root', async () => {
    await mkdir(ROOT, { recursive: true })
    await writeFile(join(ROOT, 'a.png'), 'image-bytes')
    const ctx = { ...createContext({}), artifactRoots: [ROOT] }

    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(join(ROOT, 'a.png'))}`),
      createStubRunController(),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('image-bytes')
  })

  test('returns 404 for a path outside every allowed root', async () => {
    await mkdir(TMP_DIR, { recursive: true })
    await writeFile(join(TMP_DIR, 'secret.png'), 'secret')
    const ctx = { ...createContext({}), artifactRoots: [ROOT] }

    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(join(TMP_DIR, 'secret.png'))}`),
      createStubRunController(),
    )

    expect(res.status).toBe(404)
  })

  test('returns 404 for a missing file inside an allowed root', async () => {
    await mkdir(ROOT, { recursive: true })
    const ctx = { ...createContext({}), artifactRoots: [ROOT] }

    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(join(ROOT, 'does-not-exist.png'))}`),
      createStubRunController(),
    )

    expect(res.status).toBe(404)
  })

  test('returns 404 for a symlink inside an allowed root that escapes to outside', async () => {
    await mkdir(ROOT, { recursive: true })
    await mkdir(TMP_DIR, { recursive: true })
    await writeFile(join(TMP_DIR, 'outside-secret.png'), 'outside-secret')
    // symlink inside ROOT pointing to a file outside ROOT
    const symlinkPath = join(ROOT, 'escape.png')
    await symlink(join(TMP_DIR, 'outside-secret.png'), symlinkPath)
    const ctx = { ...createContext({}), artifactRoots: [ROOT] }

    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(symlinkPath)}`),
      createStubRunController(),
    )

    expect(res.status).toBe(404)
  })

  test('sets X-Content-Type-Options: nosniff on served files', async () => {
    const root = join(TMP_DIR, 'allowed')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'h.png'), 'bytes')
    const ctx = { ...createContext({}), artifactRoots: [root] }

    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(join(root, 'h.png'))}`),
      createStubRunController(),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('returns 404 for a foreign-OS absolute path that cannot resolve locally', async () => {
    const foreignAbs = process.platform === 'win32' ? '/Users/ki/x.png' : 'C:\\Users\\ki\\x.png'
    const ctx = { ...createContext({}), artifactRoots: [TMP_DIR] }

    using warnSpy = spyOn(console, 'warn')
    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(foreignAbs)}`),
      createStubRunController(),
    )

    expect(res.status).toBe(404)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('foreign-OS absolute path')
    expect(warnSpy.mock.calls[0]?.[0]).toContain(foreignAbs)
  })

  test('does not log a foreign-OS warning for a same-OS missing file', async () => {
    const sameOsMissing = join(TMP_DIR, 'definitely-not-present.png')
    const ctx = { ...createContext({}), artifactRoots: [TMP_DIR] }

    using warnSpy = spyOn(console, 'warn')
    const res = await handleHttpRequest(
      ctx,
      new Request(`http://localhost/file/${encodeURIComponent(sameOsMissing)}`),
      createStubRunController(),
    )

    expect(res.status).toBe(404)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('createServerApp artifact serving', () => {
  test('serves a file under the configured outputDir', async () => {
    const outputDir = join(TMP_DIR, 'test-results')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'shot.png'), 'native-bytes')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      outputDir,
      reportPath: join(TMP_DIR, 'report.json'),
    })

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(outputDir, 'shot.png'))}`),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('native-bytes')
  })

  test('does not serve a file outside the configured roots', async () => {
    const outputDir = join(TMP_DIR, 'test-results')
    await mkdir(outputDir, { recursive: true })
    const outsideDir = join(TMP_DIR, 'outside')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'secret.png'), 'secret-bytes')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      outputDir,
      reportPath: join(TMP_DIR, 'report.json'),
    })

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(outsideDir, 'secret.png'))}`),
    )

    expect(res.status).toBe(404)
  })
})

describe('declared-only baseline enrichment', () => {
  test('handleTestEnd sets a /baseline expect url when the baseline resolves', async () => {
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 't1',
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
        },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-end',
        data: {
          id: 't1',
          status: 'passed',
          attachments: [],
          visualNames: ['header'],
          visualDeclarations: [
            {
              visualName: 'header',
              kind: 'named',
              declaredName: 'header',
              snapshotBaseName: 'header',
              occurrenceIndex: 1,
            },
          ],
        },
      }),
    )

    const res = await app.handleRequest(new Request('http://localhost/api/report'))
    const body = (await res.json()) as {
      tests: Record<
        string,
        {
          results: {
            images: Record<string, { expect?: string; source?: string }>
          }[]
        }
      >
    }
    const image = body.tests['t1']?.results?.[0]?.images?.['header']
    expect(image?.source).toBe('baseline-only')
    expect(image?.expect).toBe(`/baseline/${encodeURIComponent('t1')}/0/${encodeURIComponent('header')}`)
  })

  test('leaves the image declared-only when no baseline exists on disk', async () => {
    // Use a simple name (no slash) with no baseline file written to disk.
    // resolveBaselineSnapshotPath returns a non-null path for simple names even when the file
    // is absent, so the existsSync guard in enrichDeclaredBaselines is what prevents enrichment.
    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 't1',
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
        },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-end',
        data: {
          id: 't1',
          status: 'passed',
          attachments: [],
          visualNames: ['header'],
          visualDeclarations: [
            {
              visualName: 'header',
              kind: 'named',
              declaredName: 'header',
              snapshotBaseName: 'header',
              occurrenceIndex: 1,
            },
          ],
        },
      }),
    )

    const res = await app.handleRequest(new Request('http://localhost/api/report'))
    const body = (await res.json()) as {
      tests: Record<
        string,
        {
          results: {
            images: Record<string, { expect?: string; source?: string }>
          }[]
        }
      >
    }
    const image = body.tests['t1']?.results?.[0]?.images?.['header']
    expect(image?.source).toBe('declared-only')
    expect(image?.expect).toBeUndefined()
  })

  test('does not enrich a declared-only image when the test status is failed', async () => {
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 't1',
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
        },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-end',
        data: {
          id: 't1',
          status: 'failed',
          attachments: [],
          visualNames: ['header'],
          visualDeclarations: [
            {
              visualName: 'header',
              kind: 'named',
              declaredName: 'header',
              snapshotBaseName: 'header',
              occurrenceIndex: 1,
            },
          ],
        },
      }),
    )

    const res = await app.handleRequest(new Request('http://localhost/api/report'))
    const body = (await res.json()) as {
      tests: Record<
        string,
        {
          results: {
            images: Record<string, { expect?: string; source?: string }>
          }[]
        }
      >
    }
    const image = body.tests['t1']?.results?.[0]?.images?.['header']
    expect(image?.source).toBe('declared-only')
    expect(image?.expect).toBeUndefined()
  })

  test('a failed run superseded by a passed run enriches to /baseline without stale actual', async () => {
    await mkdir(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts'), { recursive: true })
    await writeFile(join(SNAPSHOT_DIR, 'chromium', 'example.spec.ts', 'header.png'), 'baseline image')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightSnapshotDir: SNAPSHOT_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    // Run 1: failed. Playwright attachment: just an actual at an absolute test-results path.
    // In real life this is what Playwright emits on first-run baseline creation.
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 't-failed-then-passed',
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
        },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-end',
        data: {
          id: 't-failed-then-passed',
          status: 'failed',
          attachments: [
            {
              name: 'header-actual.png',
              path: '/tmp/test-results/t-failed-then-passed/header-actual.png',
              contentType: 'image/png',
            },
          ],
          visualNames: ['header'],
          visualDeclarations: [
            {
              visualName: 'header',
              kind: 'named',
              declaredName: 'header',
              snapshotBaseName: 'header',
              occurrenceIndex: 1,
            },
          ],
        },
      }),
    )

    // Sanity: after the failed run the image is a comparison with an /file actual.
    const afterFailed = (await (await app.handleRequest(new Request('http://localhost/api/report'))).json()) as {
      tests: Record<string, { results: { images: Record<string, { actual?: string; source?: string }> }[] }>
    }
    const failedImage = afterFailed.tests['t-failed-then-passed']?.results?.[0]?.images?.['header']
    expect(failedImage?.source).toBe('comparison')
    expect(failedImage?.actual).toContain('/file/')

    // Run 2: passed, no attachments. Playwright wipes test-results before running.
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 't-failed-then-passed',
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
        },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-end',
        data: {
          id: 't-failed-then-passed',
          status: 'passed',
          attachments: [],
          visualNames: ['header'],
          visualDeclarations: [
            {
              visualName: 'header',
              kind: 'named',
              declaredName: 'header',
              snapshotBaseName: 'header',
              occurrenceIndex: 1,
            },
          ],
        },
      }),
    )

    const afterPassed = (await (await app.handleRequest(new Request('http://localhost/api/report'))).json()) as {
      tests: Record<
        string,
        {
          results: {
            images: Record<string, { actual?: string; expect?: string; source?: string }>
          }[]
        }
      >
    }
    const passedImage = afterPassed.tests['t-failed-then-passed']?.results?.[0]?.images?.['header']
    expect(passedImage?.source).toBe('baseline-only')
    expect(passedImage?.expect).toBe(
      `/baseline/${encodeURIComponent('t-failed-then-passed')}/0/${encodeURIComponent('header')}`,
    )
    expect(passedImage?.actual).toBeUndefined()
  })
})

describe('isPathWithinRoots', () => {
  const root = join(process.cwd(), 'allowed')

  test('accepts a file inside an allowed root', () => {
    expect(isPathWithinRoots(join(root, 'sub', 'a.png'), [root])).toBe(true)
  })

  test('accepts the root itself', () => {
    expect(isPathWithinRoots(root, [root])).toBe(true)
  })

  test('rejects a path outside every root', () => {
    expect(isPathWithinRoots(join(process.cwd(), 'other', 'a.png'), [root])).toBe(false)
  })

  test('rejects traversal escaping the root', () => {
    expect(isPathWithinRoots(join(root, '..', 'secret.png'), [root])).toBe(false)
  })

  test('rejects a raw un-normalized traversal string', () => {
    expect(isPathWithinRoots(`${root}/../secret.png`, [root])).toBe(false)
  })

  test('rejects all paths when roots is empty (deny-all default)', () => {
    expect(isPathWithinRoots(join(root, 'a.png'), [])).toBe(false)
  })
})

describe('register message', () => {
  test('adds playwrightSnapshotDir to artifactRoots so /file serves from it', async () => {
    const snapshotDir = join(TMP_DIR, 'pw-snapshots')
    await mkdir(snapshotDir, { recursive: true })
    await writeFile(join(snapshotDir, 'test.png'), 'snapshot-image')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'register',
        data: { playwrightSnapshotDir: snapshotDir },
      }),
    )

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(snapshotDir, 'test.png'))}`),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('snapshot-image')
  })

  test('adds playwrightTestDir to artifactRoots', async () => {
    const testDir = join(TMP_DIR, 'pw-test-dir')
    await mkdir(testDir, { recursive: true })
    await writeFile(join(testDir, 'artifact.png'), 'test-artifact')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'register',
        data: { playwrightTestDir: testDir },
      }),
    )

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(testDir, 'artifact.png'))}`),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('test-artifact')
  })

  test('does not duplicate roots on repeated register calls', async () => {
    const snapshotDir = join(TMP_DIR, 'pw-snapshots-dup')
    await mkdir(snapshotDir, { recursive: true })
    await writeFile(join(snapshotDir, 'a.png'), 'img')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'register',
        data: { playwrightSnapshotDir: snapshotDir },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'register',
        data: { playwrightSnapshotDir: snapshotDir },
      }),
    )

    const res = await app.handleRequest(
      new Request(`http://localhost/file/${encodeURIComponent(join(snapshotDir, 'a.png'))}`),
    )
    expect(res.status).toBe(200)
  })

  test('updates approvalRouting with playwrightSnapshotDir', async () => {
    const snapshotDir = join(TMP_DIR, 'pw-snapshots-routing')
    await mkdir(join(snapshotDir, 'chromium', 'example.spec.ts'), {
      recursive: true,
    })
    await mkdir(join(SCREENSHOT_DIR, 'test-1'), { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, 'test-1', 'shot-actual.png'), 'actual')
    await writeFile(join(snapshotDir, 'chromium', 'example.spec.ts', 'shot.png'), 'baseline')

    const app = await createServerApp({
      screenshotDir: SCREENSHOT_DIR,
      reportPath: join(TMP_DIR, 'report.json'),
      configDir: process.cwd(),
      playwrightTestDir: PLAYWRIGHT_TEST_DIR,
      playwrightToHaveScreenshotPathTemplate: CUSTOM_TEMPLATE,
    })

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'register',
        data: { playwrightSnapshotDir: snapshotDir },
      }),
    )

    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-begin',
        data: {
          id: 'test-1',
          title: 'visual pass',
          titlePath: ['Suite'],
          browser: 'chromium',
          location: { file: TEST_FILE, line: 10 },
        },
      }),
    )
    await app.handleWebSocketMessage(
      JSON.stringify({
        type: 'test-end',
        data: {
          id: 'test-1',
          status: 'passed',
          attachments: [],
          visualNames: ['shot'],
          visualDeclarations: [
            {
              visualName: 'shot',
              kind: 'named',
              declaredName: 'shot',
              snapshotBaseName: 'shot',
              occurrenceIndex: 1,
            },
          ],
        },
      }),
    )

    const res = await app.handleRequest(new Request('http://localhost/api/report'))
    const body = (await res.json()) as {
      tests: Record<
        string,
        {
          results: {
            images: Record<string, { expect?: string; source?: string }>
          }[]
        }
      >
    }
    const image = body.tests['test-1']?.results?.[0]?.images?.['shot']
    expect(image?.source).toBe('baseline-only')
    expect(image?.expect).toBe(`/baseline/${encodeURIComponent('test-1')}/0/${encodeURIComponent('shot')}`)
  })
})

describe('run endpoints', () => {
  test('POST /api/run returns 200 on accepted start', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true })
    const res = await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
      stub,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('POST /api/run returns 409 with reason when refused', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: false, reason: 'already-running' })
    const res = await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
      stub,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'already-running' })
  })

  test('POST /api/run passes parsed tests through', async () => {
    const ctx = createContext({})
    let captured: unknown = null
    const stub = {
      start: (filters: unknown) => {
        captured = filters
        return { ok: true }
      },
      stop: () => ({ ok: true }),
      prepareRun: (): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
      dispose: () => {},
      isRunning: false,
    } as unknown as RunController
    await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', {
        method: 'POST',
        body: JSON.stringify({
          tests: [{ file: 'a.spec.ts', line: 5, column: 3, projectName: 'chromium', titlePath: ['t'] }],
        }),
      }),
      stub,
    )
    expect(captured).toEqual({
      tests: [{ file: 'a.spec.ts', line: 5, column: 3, projectName: 'chromium', titlePath: ['t'] }],
    })
  })

  test('POST /api/run returns 400 for empty tests array', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: false, reason: 'no-tests' })
    const res = await handleHttpRequest(
      ctx,
      new Request('http://localhost/api/run', { method: 'POST', body: '{"tests":[]}' }),
      stub,
    )
    expect(res.status).toBe(400)
  })

  test('POST /api/stop returns 200 on accepted stop', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true }, { ok: true })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/stop', { method: 'POST' }), stub)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('POST /api/stop returns 409 when not running', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true }, { ok: false, reason: 'not-running' })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/stop', { method: 'POST' }), stub)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'not-running' })
  })

  test('GET /api/report includes runEnabled=false when no runContext set', async () => {
    const ctx = createContext({})
    const stub = createStubRunController({ ok: true })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/report'), stub)
    const body = (await res.json()) as { runEnabled: boolean }
    expect(body.runEnabled).toBe(false)
  })

  test('GET /api/report includes runEnabled=true when runContext is set', async () => {
    const ctx = createContext({})
    ctx.runContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }
    const stub = createStubRunController({ ok: true })
    const res = await handleHttpRequest(ctx, new Request('http://localhost/api/report'), stub)
    const body = (await res.json()) as { runEnabled: boolean }
    expect(body.runEnabled).toBe(true)
  })

  test('createServerApp seeds runEnabled from an explicit playwrightConfig', async () => {
    const app = await createServerApp({
      reportPath: join(TMP_DIR, 'report.json'),
      playwrightConfig: '/proj/playwright.config.ts',
    })
    const res = await app.handleRequest(new Request('http://localhost/api/report'))
    const body = (await res.json()) as { runEnabled: boolean }
    expect(body.runEnabled).toBe(true)
  })
})
