import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { expect, test } from '@playwright/test'

const isPlaywright = (): boolean =>
  process.env.PLAYWRIGHT_WORKER_INDEX !== undefined ||
  process.env.PW_TEST !== undefined ||
  process.env.PLAYWRIGHT_TEST !== undefined

if (isPlaywright()) {
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2G0K0AAAAASUVORK5CYII=',
    'base64',
  )

  test('opens the generated report artifact directly from disk', async ({ page }) => {
    const { CrvyRprtr } = await import('../../src/reporter')
    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-report-artifact-browser-'))

    try {
      const screenshotDir = join(tempDir, 'screenshots')
      const reportHtmlPath = join(tempDir, 'crvy-rprtr.html')
      const offlineReportPath = join(tempDir, 'crvy-rprtr-0.json')
      const actualPath = join(tempDir, 'actual.png')
      const expectedPath = join(tempDir, 'expected.png')
      const diffPath = join(tempDir, 'diff.png')

      await Promise.all([
        writeFile(actualPath, TINY_PNG),
        writeFile(expectedPath, TINY_PNG),
        writeFile(diffPath, TINY_PNG),
      ])

      const reporter = new CrvyRprtr({
        serverUrl: 'ws://localhost:9999',
        screenshotDir,
        offlineReportPath,
        reportHtmlPath,
        // Artifact emission is CI-gated in the reporter; pin it so the spec is hermetic.
        ci: true,
      })

      type TestReporter = {
        connect: () => void
        onTestBegin: (test: object) => void
        onTestEnd: (test: object, result: object) => Promise<void>
        onEnd: (result: { status: string }) => Promise<void>
      }
      const reporterAny = reporter as unknown as TestReporter

      reporterAny.connect()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100)
      })

      reporterAny.onTestBegin({
        id: 'test-1',
        title: 'Visual diff test',
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
          title: 'Visual diff test',
          location: { file: 'test.spec.ts', line: 10 },
          parent: {
            title: 'Suite',
            type: 'describe',
            project: () => ({ name: 'chromium' }),
            parent: undefined,
          },
        },
        {
          status: 'failed',
          errors: [{ message: 'Screenshot mismatch' }],
          duration: 100,
          steps: [],
          attachments: [
            { name: 'view-actual.png', path: actualPath, contentType: 'image/png' },
            { name: 'view-expected.png', path: expectedPath, contentType: 'image/png' },
            { name: 'view-diff.png', path: diffPath, contentType: 'image/png' },
          ],
        },
      )

      await reporterAny.onEnd({ status: 'failed' })

      const fileUrl = pathToFileURL(reportHtmlPath)
      fileUrl.searchParams.set('testPath[0]', 'Suite')
      fileUrl.searchParams.set('testPath[1]', 'Visual diff test')
      fileUrl.searchParams.set('testPath[2]', 'chromium')

      await page.goto(fileUrl.href)

      await expect(page.getByRole('heading', { name: 'Visual diff test' })).toBeVisible()
      await expect(page.getByText('This artifact is read-only.')).toBeVisible()
      await expect(page.locator('img[alt="Actual"]')).toBeVisible()
      await expect(page.locator('img[alt="Diff"]')).toBeVisible()
      await expect(page.locator('img[alt="Expected"]')).toBeVisible()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
}
