import { existsSync } from 'fs'
import { realpath } from 'fs/promises'
import { dirname, resolve } from 'path'

import { isForeignAbsolutePath } from '../path-utils.ts'
import { resolveBaselineTargets } from '../snapshot-path-resolver.ts'
import type { TestData } from '../types.ts'
import { rewriteContainerPath } from './docker-support.ts'
import { respondWithFile } from './file-utils.ts'
import type { RoutesContext } from './routes.ts'
import { isPathWithinRoots } from './utils.ts'

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

export async function handleFile(ctx: RoutesContext, req: Request): Promise<Response> {
  const notFound = (): Response => new Response('Not Found', { status: 404 })

  let rawDecoded: string
  let decodedPath: string
  try {
    rawDecoded = decodeURIComponent(new URL(req.url).pathname.slice('/file/'.length))
    decodedPath = resolve(rawDecoded)
  } catch {
    return notFound()
  }

  // Resolve symlinks on BOTH the target and the roots before the containment check:
  // resolve() is lexical, but readFile would follow a symlink out of an allowed root.
  const realTarget = await realpathOrNull(decodedPath)
  if (realTarget === null) {
    // Check the pre-resolve string: resolve() normalizes foreign-OS paths
    // (e.g. "C:\\..." on POSIX) into host-OS form, hiding the foreign origin.
    if (isForeignAbsolutePath(rawDecoded, process.platform)) {
      console.warn(
        `[Crvy Rprtr] /file request resolved to a foreign-OS absolute path that cannot be served on ${process.platform}: ${rawDecoded}`,
      )
    }
    return notFound()
  }

  const realRoots = (await Promise.all((ctx.artifactRoots ?? []).map((root) => realpathOrNull(resolve(root))))).filter(
    (root): root is string => root !== null,
  )

  if (!isPathWithinRoots(realTarget, realRoots)) {
    return notFound()
  }

  try {
    const file = await respondWithFile(realTarget)
    return file ?? notFound()
  } catch {
    // e.g. EISDIR when the resolved target is a directory inside an allowed root.
    return notFound()
  }
}

function reporterTitlePath(test: TestData): readonly string[] {
  const testFile = test.location?.file
  // Index 1 must match the raw Playwright project name ("" for the default
  // project) so the snapshot resolver produces paths Playwright itself used.
  // `projectName` is undefined for data from older reporters; fall back to
  // `browser`, which those reporters populated with the raw project name.
  const projectName = test.projectName ?? test.browser
  return ['', projectName, testFile ?? '', ...test.titlePath, test.title]
}

export type ApprovalRouting = RoutesContext['approvalRouting']

export function resolveBaselineSnapshotPath(
  routing: ApprovalRouting,
  test: TestData,
  retry: number,
  imageName: string,
): string | null {
  const mapping = routing?.containerPathMapping
  // Docker run-mode reporters report container-side test files (`/work/...`); map them
  // back to host paths so the resolver's `relative(testDir, testFile)` stays meaningful.
  const rawTestFile = test.location?.file
  const testFile =
    rawTestFile === undefined || mapping === undefined ? rawTestFile : rewriteContainerPath(rawTestFile, mapping)
  const declaration = test.results?.[retry]?.visualDeclarations?.find((candidate) => candidate.visualName === imageName)

  if (routing === undefined || testFile === undefined || declaration === undefined) {
    return null
  }

  // Baselines from containerized runs carry the container's `-linux` snapshot suffix,
  // not the host platform's.
  const isContainerPath = mapping !== undefined && testFile !== rawTestFile

  const targets = resolveBaselineTargets({
    testFile,
    reporterTitlePath: reporterTitlePath(test),
    declarations: [declaration],
    config: {
      configDir: routing.configDir,
      testDir: routing.playwrightTestDir ?? dirname(testFile),
      snapshotDir: routing.playwrightSnapshotDir ?? dirname(testFile),
      projectName: test.projectName ?? test.browser,
      snapshotSuffix: isContainerPath ? 'linux' : process.platform,
      snapshotPathTemplate: routing.playwrightSnapshotPathTemplate,
      toHaveScreenshotPathTemplate: routing.playwrightToHaveScreenshotPathTemplate,
    },
    snapshotPathExists: existsSync,
  })

  return targets.length === 1 ? (targets[0]?.snapshotPath ?? null) : null
}

export async function handleBaseline(ctx: RoutesContext, req: Request): Promise<Response> {
  const notFound = (): Response => new Response('Not Found', { status: 404 })

  let testId: string
  let retry: number
  let visualName: string
  try {
    const segments = new URL(req.url).pathname.slice('/baseline/'.length).split('/')
    const [rawTestId, retryRaw, ...visualNameParts] = segments
    if (rawTestId === undefined || retryRaw === undefined || !/^\d+$/.test(retryRaw) || visualNameParts.length === 0) {
      return notFound()
    }
    testId = decodeURIComponent(rawTestId)
    retry = Number(retryRaw)
    visualName = decodeURIComponent(visualNameParts.join('/'))
  } catch {
    return notFound()
  }

  const test = ctx.reportData.tests[testId]
  if (test === undefined) {
    return notFound()
  }

  const snapshotPath = resolveBaselineSnapshotPath(ctx.approvalRouting, test, retry, visualName)
  if (snapshotPath === null) {
    return notFound()
  }

  try {
    const file = await respondWithFile(snapshotPath)
    return file ?? notFound()
  } catch {
    return notFound()
  }
}

export function handleArtifactRoute(ctx: RoutesContext, req: Request, pathname: string): Promise<Response> | null {
  if (pathname.startsWith('/file/')) {
    return handleFile(ctx, req)
  }
  if (pathname.startsWith('/baseline/')) {
    return handleBaseline(ctx, req)
  }
  return null
}
