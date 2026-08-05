import { describe, expect, test } from 'bun:test'

import { handleRegister, type HandlerContext } from '../src/server/handlers'
import type { RoutesContext } from '../src/server/routes'
import type { RunController } from '../src/server/run-controller'

function createCtx(mapping?: { from: string; to: string }): { ctx: HandlerContext; routesContext: RoutesContext } {
  const routesContext: RoutesContext = {
    reportData: {
      isRunning: false,
      tests: {},
      browsers: ['chromium'],
      isUpdateMode: false,
      screenshotDir: './screenshots',
    },
    staticDir: '.',
    saveReport: () => Promise.resolve(),
    artifactRoots: [],
    approvalRouting: { configDir: '/host/proj' },
    containerPathMapping: mapping,
  }
  const ctx: HandlerContext = {
    reportData: routesContext.reportData,
    wsClients: new Set(),
    currentRunIds: new Set(),
    isFilteredRun: false,
    saveReport: () => Promise.resolve(),
    scheduleReportSave: () => {},
    approvalRouting: routesContext.approvalRouting,
    routesContext,
    runController: {} as RunController,
  }
  return { ctx, routesContext }
}

const REGISTER_DATA = {
  playwrightSnapshotDir: '/work/tests/__screenshots__',
  playwrightTestDir: '/work/tests',
  configFile: '/work/playwright.config.ts',
  cwd: '/work',
}

describe('handleRegister container path mapping', () => {
  test('rewrites container paths to host paths when a mapping is set', () => {
    const { ctx, routesContext } = createCtx({ from: '/work', to: '/host/proj' })
    handleRegister(ctx, REGISTER_DATA)

    expect(routesContext.runContext).toEqual({
      configFile: '/host/proj/playwright.config.ts',
      cwd: '/host/proj',
    })
    expect(routesContext.approvalRouting?.playwrightSnapshotDir).toBe('/host/proj/tests/__screenshots__')
    expect(routesContext.approvalRouting?.playwrightTestDir).toBe('/host/proj/tests')
    expect(routesContext.artifactRoots).toContain('/host/proj/tests/__screenshots__')
    expect(routesContext.artifactRoots).toContain('/host/proj/tests')
  })

  test('stores reporter paths unchanged when no mapping is set', () => {
    const { ctx, routesContext } = createCtx()
    handleRegister(ctx, REGISTER_DATA)

    expect(routesContext.runContext).toEqual({ configFile: '/work/playwright.config.ts', cwd: '/work' })
    expect(routesContext.approvalRouting?.playwrightSnapshotDir).toBe('/work/tests/__screenshots__')
  })
})
