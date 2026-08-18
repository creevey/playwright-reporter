import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { extname, join } from 'path'

import pLimit from 'p-limit'

import { log, logError } from './debug-log.ts'
import { writeReportArtifact } from './report-artifact.ts'
import type { AttachmentData } from './reporter-utils.ts'
import type { ResolvedBaselineTarget } from './snapshot-path-resolver.ts'

const MAX_CONCURRENT_FILE_OPS = 5

export type RunEvent = { type: 'test-begin' | 'test-end' | 'run-end'; data: unknown }

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-_]/g, '_')
}

// Content-addressed artifact naming (Playwright HTML-reporter pattern): the on-disk
// name is the sha1 of the file contents, so artifact paths stay pure ASCII and resolve
// on any static file host (GitLab Pages, nginx, ...) without percent-encoding.
async function writeContentAddressedCopy(sourcePath: string, destDir: string): Promise<string> {
  const contents = await readFile(sourcePath)
  const artifactName = `${createHash('sha1').update(contents).digest('hex')}${extname(sourcePath) || '.png'}`
  await mkdir(destDir, { recursive: true })
  await writeFile(join(destDir, artifactName), contents)
  return artifactName
}

export async function copyResolvedBaseline(
  safeTestId: string,
  testScreenshotDir: string,
  target: ResolvedBaselineTarget,
  savedAttachments: AttachmentData[],
): Promise<void> {
  const attachmentName = `${target.attachmentBaseName}-expected.png`
  try {
    const artifactName = await writeContentAddressedCopy(target.snapshotPath, testScreenshotDir)
    savedAttachments.push({ name: attachmentName, path: `${safeTestId}/${artifactName}`, contentType: 'image/png' })
    log(`[CrvyRprtr] Attached baseline: ${target.snapshotPath}`)
  } catch {}
}

export async function saveAttachments(
  screenshotDir: string,
  testId: string,
  result: { attachments: { contentType?: string; path?: string; name: string }[] },
): Promise<AttachmentData[]> {
  const savedAttachments: AttachmentData[] = []
  const safeTestId = sanitizeId(testId)
  const testScreenshotDir = join(screenshotDir, safeTestId)
  const limit = pLimit(MAX_CONCURRENT_FILE_OPS)
  await Promise.all(
    result.attachments
      .filter(
        (attachment): attachment is typeof attachment & { path: string } =>
          attachment.contentType === 'image/png' && attachment.path !== undefined,
      )
      .map((attachment) =>
        limit(async () => {
          try {
            const artifactName = await writeContentAddressedCopy(attachment.path, testScreenshotDir)
            savedAttachments.push({
              name: attachment.name,
              path: `${safeTestId}/${artifactName}`,
              contentType: attachment.contentType ?? 'image/png',
            })
            log(`[CrvyRprtr] Saved screenshot: ${join(testScreenshotDir, artifactName)}`)
          } catch (error) {
            logError(`[CrvyRprtr] Failed to save screenshot: ${attachment.path}`, error)
            savedAttachments.push({
              name: attachment.name,
              path: attachment.path,
              contentType: attachment.contentType ?? 'image/png',
            })
          }
        }),
      ),
  )
  return savedAttachments
}

export async function writeOfflineReport(
  runEvents: RunEvent[],
  offlineReportPath: string,
  workerIndex: number,
): Promise<void> {
  if (runEvents.length === 0) {
    log('[CrvyRprtr] No offline events to write')
    return
  }
  try {
    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      workers: workerIndex + 1,
      events: runEvents.map((event) => ({ ...event, timestamp: Date.now(), workerIndex })),
    }
    await writeFile(offlineReportPath, JSON.stringify(report, null, 2))
    log(`[CrvyRprtr] Wrote offline report: ${offlineReportPath}`)
  } catch (error) {
    logError('[CrvyRprtr] Failed to write offline report:', error)
  }
}

export async function writeStaticArtifact(
  runEvents: RunEvent[],
  screenshotDir: string,
  reportHtmlPath: string,
): Promise<void> {
  try {
    await writeReportArtifact({ events: runEvents, screenshotDir, reportHtmlPath })
    log(`[CrvyRprtr] Wrote report artifact: ${reportHtmlPath}`)
  } catch (error) {
    logError('[CrvyRprtr] Failed to write report artifact:', error)
  }
}
