import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2G0K0AAAAASUVORK5CYII=',
  'base64',
)
// Artifact files are content-addressed: the on-disk name is the sha1 of the contents.
const TINY_PNG_ARTIFACT_NAME = `${createHash('sha1').update(TINY_PNG).digest('hex')}.png`

describe('Report artifact generation', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crvy-rprtr-report-artifact-'))
  })

  afterEach(async () => {
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('reporter writes a browser-openable static artifact with relative asset paths', async () => {
    const { CrvyRprtr } = await import('../src/reporter')

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
    await Bun.sleep(100)

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

    expect(existsSync(reportHtmlPath)).toBe(true)
    expect(existsSync(offlineReportPath)).toBe(true)

    const html = await readFile(reportHtmlPath, 'utf8')

    expect(html).toContain('<style>')
    expect(html).toContain('<script type="module">')
    expect(html).toContain(`./screenshots/test-1/${TINY_PNG_ARTIFACT_NAME}`)
    expect(html).toContain('This artifact is read-only')
    expect(html).toContain('"approvalEnabled":false')
  })
})
