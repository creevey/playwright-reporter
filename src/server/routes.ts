import { join } from 'path'

import { ApproveRequestBodySchema, safeParse } from '../schemas.ts'
import type { TestData } from '../types.ts'
import { handleArtifactRoute, resolveBaselineSnapshotPath } from './artifact-routes.ts'
import type { ContainerPathMapping } from './docker-support.ts'
import { copyFilePortable, respondWithFile } from './file-utils.ts'
import type { RunController } from './run-controller.ts'
import { handleRunRoutes } from './run-routes.ts'

export interface RoutesContext {
  reportData: {
    isRunning: boolean
    tests: Record<string, TestData>
    browsers: string[]
    isUpdateMode: boolean
    screenshotDir: string
  }
  staticDir: string
  saveReport: () => Promise<void>
  artifactRoots?: string[]
  approvalRouting?: {
    configDir: string
    playwrightTestDir?: string
    playwrightSnapshotDir?: string
    playwrightSnapshotPathTemplate?: string
    playwrightToHaveScreenshotPathTemplate?: string
  }
  runContext?: { configFile: string; cwd: string }
  runInfo?: { mode: 'local' | 'docker' }
  containerPathMapping?: ContainerPathMapping
}

export { isPathWithinRoots, isWebSocketUpgradeRequest, LIVE_UPDATES_WEBSOCKET_PATH } from './utils.ts'

async function handleRoot(ctx: RoutesContext): Promise<Response> {
  const html = await respondWithFile(join(ctx.staticDir, 'index.html'), 'text/html')
  return html ?? new Response('Not Found', { status: 404 })
}

async function handleAppCss(): Promise<Response> {
  const css = await respondWithFile('./src/client/app.css', 'text/css')
  return css ?? new Response('Not Found', { status: 404 })
}

async function handleSrcFiles(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/src/'.length)
  const filePath = `./src/${path}`
  const contentType =
    filePath.endsWith('.ts') || filePath.endsWith('.tsx')
      ? 'application/javascript'
      : filePath.endsWith('.css')
        ? 'text/css'
        : 'text/plain'
  const file = await respondWithFile(filePath, contentType)
  return file ?? new Response('Not Found', { status: 404 })
}

function handleApiReport(ctx: RoutesContext): Response {
  return Response.json({
    ...ctx.reportData,
    runEnabled: ctx.runContext !== undefined,
    runMode: ctx.runInfo?.mode,
  })
}

const APPROVAL_TARGET_ERROR = 'Could not resolve approval target'

function actualPathFromUrl(ctx: RoutesContext, actualUrl: string): string {
  if (actualUrl.startsWith('/screenshots/')) {
    return join(ctx.reportData.screenshotDir, actualUrl.slice('/screenshots/'.length))
  }
  if (actualUrl.startsWith('/file/')) {
    return decodeURIComponent(actualUrl.slice('/file/'.length))
  }
  return actualUrl
}

async function handleApiApprove(ctx: RoutesContext, req: Request): Promise<Response> {
  try {
    const rawBody: unknown = await req.json()
    const parsed = safeParse(ApproveRequestBodySchema, rawBody)
    if (!parsed) {
      console.error('Invalid approve request body', rawBody)
      return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 })
    }
    const { id, retry, image } = parsed

    const test = ctx.reportData.tests[id]
    if (test === undefined) {
      return Response.json({ success: false, error: 'Test not found' }, { status: 404 })
    }

    const actualUrl = test.results?.[retry]?.images?.[image]?.actual
    if (actualUrl === undefined) {
      return Response.json({ success: false, error: 'Actual image not found' }, { status: 409 })
    }

    const snapshotPath = resolveBaselineSnapshotPath(ctx.approvalRouting, test, retry, image)
    if (snapshotPath === null) {
      return Response.json({ success: false, error: APPROVAL_TARGET_ERROR }, { status: 409 })
    }

    try {
      await copyFilePortable(actualPathFromUrl(ctx, actualUrl), snapshotPath)
      test.approved = { ...(test.approved ?? {}), [image]: retry }
      await ctx.saveReport()
      console.log(`  ✔ Updated baseline: ${snapshotPath}`)
      console.log(`  ✔ Approved [${test.browser}] ${test.title} — ${image}`)
      return Response.json({ success: true })
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`  ✗ Failed to update baseline: ${errorMsg}`)
      return Response.json({ success: false, error: 'Failed to update baseline' }, { status: 500 })
    }
  } catch {
    return Response.json({ success: false, error: 'Invalid request' }, { status: 400 })
  }
}

type BulkApprovalOutcome =
  | {
      kind: 'approved'
      imageName: string
      retry: number
      snapshotPath: string
      test: TestData
    }
  | { kind: 'unresolved' }
  | { kind: 'failed' }

type BulkApprovalCounts = { approved: number; unresolved: number; failed: number }

function createBulkApprovalUpdates(ctx: RoutesContext): Array<Promise<BulkApprovalOutcome>> {
  return Object.values(ctx.reportData.tests).flatMap((test) => {
    if (!test.results || test.results.length === 0) {
      return []
    }

    const lastRetry = test.results.length - 1
    const lastResult = test.results[lastRetry]
    if (!lastResult?.images) {
      return []
    }

    return Object.keys(lastResult.images).flatMap((imageName) => {
      const actualUrl = lastResult.images?.[imageName]?.actual
      if (actualUrl === undefined) {
        return [Promise.resolve({ kind: 'unresolved' as const })]
      }

      const snapshotPath = resolveBaselineSnapshotPath(ctx.approvalRouting, test, lastRetry, imageName)
      if (snapshotPath === null) {
        return [Promise.resolve({ kind: 'unresolved' as const })]
      }

      return [
        copyFilePortable(actualPathFromUrl(ctx, actualUrl), snapshotPath)
          .then(
            (): BulkApprovalOutcome => ({
              kind: 'approved',
              imageName,
              retry: lastRetry,
              snapshotPath,
              test,
            }),
          )
          .catch((err: unknown): BulkApprovalOutcome => {
            const errorMsg = err instanceof Error ? err.message : String(err)
            console.error(`  ✗ Failed to update baseline: ${errorMsg}`)
            return { kind: 'failed' }
          }),
      ]
    })
  })
}

function summarizeBulkApprovalOutcomes(outcomes: readonly BulkApprovalOutcome[]): BulkApprovalCounts {
  return outcomes.reduce(
    (summary, outcome) => {
      switch (outcome.kind) {
        case 'approved': {
          outcome.test.approved = { ...(outcome.test.approved ?? {}), [outcome.imageName]: outcome.retry }
          console.log(`  ✔ Updated baseline: ${outcome.snapshotPath}`)
          return { ...summary, approved: summary.approved + 1 }
        }
        case 'unresolved':
          return { ...summary, unresolved: summary.unresolved + 1 }
        case 'failed':
          return { ...summary, failed: summary.failed + 1 }
      }
    },
    { approved: 0, unresolved: 0, failed: 0 },
  )
}

async function handleApiApproveAll(ctx: RoutesContext): Promise<Response> {
  const outcomes = await Promise.all(createBulkApprovalUpdates(ctx))
  const counts = summarizeBulkApprovalOutcomes(outcomes)
  await ctx.saveReport()
  console.log(
    `  ✔ Approved all — approved: ${counts.approved}, unresolved: ${counts.unresolved}, failed: ${counts.failed}`,
  )
  return Response.json({ success: counts.failed === 0, ...counts })
}

async function handleApiImages(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/api/images/'.length)
  const imagePath = `./images/${path}`
  const file = await respondWithFile(imagePath)
  return file ?? Response.json({ error: 'Image not found' }, { status: 404 })
}

async function handleScreenshots(ctx: RoutesContext, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/screenshots/'.length)
  const screenshotPath = `${ctx.reportData.screenshotDir}/${path}`
  const file = await respondWithFile(screenshotPath)
  return file ?? Response.json({ error: 'Screenshot not found' }, { status: 404 })
}

async function handleDist(ctx: RoutesContext, req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.slice('/dist/'.length)
  const filePath = join(ctx.staticDir, path)
  const contentType = filePath.endsWith('.css')
    ? 'text/css'
    : filePath.endsWith('.js')
      ? 'application/javascript'
      : filePath.endsWith('.svelte')
        ? 'text/plain'
        : 'application/octet-stream'
  const file = await respondWithFile(filePath, contentType)
  return file ?? new Response('Not Found', { status: 404 })
}

export function handleHttpRequest(ctx: RoutesContext, req: Request, runController: RunController): Promise<Response> {
  const pathname = new URL(req.url).pathname

  if (pathname === '/') {
    return handleRoot(ctx)
  }

  if (pathname === '/src/client/app.css') {
    return handleAppCss()
  }

  if (pathname.startsWith('/src/')) {
    return handleSrcFiles(req)
  }

  if (pathname === '/api/report') {
    return Promise.resolve(handleApiReport(ctx))
  }

  if (pathname === '/api/approve' && req.method === 'POST') {
    return handleApiApprove(ctx, req)
  }

  if (pathname === '/api/approve-all' && req.method === 'POST') {
    return handleApiApproveAll(ctx)
  }
  const runResponse = handleRunRoutes(pathname, req.method, runController, req)
  if (runResponse !== null) {
    return runResponse
  }

  if (pathname.startsWith('/api/images/')) {
    return handleApiImages(req)
  }

  const artifactResponse = handleArtifactRoute(ctx, req, pathname)
  if (artifactResponse !== null) {
    return artifactResponse
  }

  if (pathname.startsWith('/screenshots/')) {
    return handleScreenshots(ctx, req)
  }

  if (pathname.startsWith('/dist/')) {
    return handleDist(ctx, req)
  }

  return Promise.resolve(new Response('Not Found', { status: 404 }))
}
