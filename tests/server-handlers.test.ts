import { beforeEach, describe, expect, test } from 'bun:test'

import { createMutableReportState, applyTestBeginEvent } from '../src/report-state'
import { WebSocketMessageSchema } from '../src/schemas'
import {
  handleRunEnd,
  handleSync,
  handleTestBegin,
  handleTestEnd,
  handleRegister,
  type HandlerContext,
} from '../src/server/handlers'
import type { RuntimeWebSocket } from '../src/server/ws'

class MockWebSocket implements RuntimeWebSocket {
  sent: string[] = []
  send(message: string): void {
    this.sent.push(message)
  }
}

function createContext(): {
  ctx: HandlerContext
  clients: Set<MockWebSocket>
  scheduleCalls: { value: number }
  flushCalls: { value: number }
} {
  const clients = new Set<MockWebSocket>()
  const state = createMutableReportState('./screenshots')
  const scheduleCalls = { value: 0 }
  const flushCalls = { value: 0 }
  const ctx: HandlerContext = {
    reportData: state.reportData,
    wsClients: clients as unknown as Set<RuntimeWebSocket>,
    currentRunIds: state.currentRunIds,
    isFilteredRun: false,
    saveReport: (): Promise<void> => {
      flushCalls.value++
      return Promise.resolve()
    },
    scheduleReportSave: (): void => {
      scheduleCalls.value++
    },
    routesContext: {
      reportData: state.reportData,
      staticDir: './dist',
      saveReport: async (): Promise<void> => {},
    },
    runController: null as unknown as HandlerContext['runController'],
  }
  return { ctx, clients, scheduleCalls, flushCalls }
}

function readMessages(clients: Set<MockWebSocket>): unknown[] {
  const out: unknown[] = []
  for (const c of clients) {
    for (const s of c.sent) out.push(JSON.parse(s))
  }
  return out
}

describe('server broadcast payloads', () => {
  let clients: Set<MockWebSocket>
  let ctx: HandlerContext
  let scheduleCalls: { value: number }
  let flushCalls: { value: number }

  beforeEach(() => {
    const created = createContext()
    ctx = created.ctx
    clients = created.clients
    scheduleCalls = created.scheduleCalls
    flushCalls = created.flushCalls
    clients.add(new MockWebSocket())
  })

  test('handleTestBegin broadcasts a resolved test (status running, no results)', () => {
    handleTestBegin(ctx, {
      id: 'test-1',
      title: 'renders header',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    const messages = readMessages(clients)
    expect(messages).toHaveLength(1)
    const parsed = WebSocketMessageSchema.safeParse(messages[0])
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.type).toBe('test-begin')
    if (parsed.data.type !== 'test-begin') return
    expect(parsed.data.data.id).toBe('test-1')
    expect(parsed.data.data.status).toBe('running')
    expect(parsed.data.data.results).toBeUndefined()
  })

  test('handleTestBegin flips an existing test back to running on re-run', () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'renders header',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })
    handleTestEnd(ctx, {
      id: 'test-1',
      status: 'passed',
      attachments: [],
      visualNames: [],
    })
    clients.forEach((c) => (c.sent = []))

    handleTestBegin(ctx, {
      id: 'test-1',
      title: 'renders header',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    const messages = readMessages(clients)
    expect(messages).toHaveLength(1)
    const parsed = WebSocketMessageSchema.safeParse(messages[0])
    if (!(parsed.success && parsed.data.type === 'test-begin')) {
      throw new Error('expected test-begin message')
    }
    expect(parsed.data.data.status).toBe('running')
  })

  test('handleTestEnd broadcasts the resolved test with status, results, and images', () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'renders header',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })
    clients.forEach((c) => (c.sent = []))

    handleTestEnd(ctx, {
      id: 'test-1',
      status: 'failed',
      attachments: [
        { name: 'header-actual', path: 'test-1/header-actual', contentType: 'image/png' },
        { name: 'header-expected', path: 'test-1/header-expected', contentType: 'image/png' },
        { name: 'header-diff', path: 'test-1/header-diff', contentType: 'image/png' },
      ],
      visualNames: ['header'],
      error: 'mismatch',
      duration: 123,
    })

    const messages = readMessages(clients)
    expect(messages).toHaveLength(1)
    const parsed = WebSocketMessageSchema.safeParse(messages[0])
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.type).toBe('test-update')
    if (parsed.data.type !== 'test-update') return
    const data = parsed.data.data
    expect(data.id).toBe('test-1')
    expect(data.status).toBe('failed')
    expect(data.results).toHaveLength(1)
    const result = data.results?.[0]
    expect(result?.status).toBe('failed')
    expect(result?.images?.['header']?.actual).toBe('/screenshots/test-1/header-actual')
    expect(result?.images?.['header']?.expect).toBe('/screenshots/test-1/header-expected')
    expect(result?.images?.['header']?.diff).toBe('/screenshots/test-1/header-diff')
  })

  test('handleTestEnd schedules a debounced report save', () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'renders header',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })
    scheduleCalls.value = 0

    handleTestEnd(ctx, {
      id: 'test-1',
      status: 'passed',
      attachments: [],
      visualNames: [],
    })

    expect(scheduleCalls.value).toBe(1)
  })

  test('handleTestBegin schedules a debounced report save', () => {
    handleTestBegin(ctx, {
      id: 'test-1',
      title: 'renders header',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'tests/example.spec.ts', line: 10 },
    })

    expect(scheduleCalls.value).toBe(1)
  })

  test('handleTestEnd does not broadcast for unknown test ids', () => {
    handleTestEnd(ctx, {
      id: 'unknown-test',
      status: 'passed',
      attachments: [],
      visualNames: [],
    })

    expect(readMessages(clients)).toHaveLength(0)
  })

  test('handleRunEnd flushes the debounced save', async () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'keeps',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 1 },
    })
    flushCalls.value = 0

    await handleRunEnd(ctx, { status: 'passed' })

    expect(flushCalls.value).toBe(1)
  })

  test('handleRunEnd broadcasts removedTestIds computed from currentRunIds', async () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'keeps',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 1 },
    })
    applyTestBeginEvent(ctx, {
      id: 'test-2',
      title: 'drops',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 2 },
    })
    // Mark only test-1 as part of the current run; test-2 is leftover from a previous run.
    ctx.currentRunIds.delete('test-2')
    clients.forEach((c) => (c.sent = []))

    await handleRunEnd(ctx, { status: 'passed' })

    const messages = readMessages(clients)
    expect(messages).toHaveLength(1)
    const parsed = WebSocketMessageSchema.safeParse(messages[0])
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.type).toBe('run-end')
    if (parsed.data.type !== 'run-end') return
    expect(parsed.data.data.removedTestIds).toEqual(['test-2'])
    expect(parsed.data.data.status).toBe('passed')
  })

  test('handleRunEnd returns no removedTestIds when every test is part of the current run', async () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'keeps',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 1 },
    })
    clients.forEach((c) => (c.sent = []))

    await handleRunEnd(ctx, { status: 'passed' })

    const parsed = WebSocketMessageSchema.safeParse(readMessages(clients)[0])
    if (!(parsed.success && parsed.data.type === 'run-end')) {
      throw new Error('expected run-end message')
    }
    expect(parsed.data.data.removedTestIds).toEqual([])
    expect(ctx.reportData.tests['test-1']).toBeDefined()
  })

  test('handleRunEnd preserves non-current tests and sends no removedTestIds for a filtered run', async () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'in this run',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 1 },
    })
    applyTestBeginEvent(ctx, {
      id: 'test-2',
      title: 'from a previous run',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 2 },
    })
    // test-2 is a leftover that the filtered run did not touch.
    ctx.currentRunIds.delete('test-2')
    ctx.isFilteredRun = true
    clients.forEach((c) => (c.sent = []))

    await handleRunEnd(ctx, { status: 'passed' })

    const parsed = WebSocketMessageSchema.safeParse(readMessages(clients)[0])
    if (!(parsed.success && parsed.data.type === 'run-end')) {
      throw new Error('expected run-end message')
    }
    expect(parsed.data.data.removedTestIds).toEqual([])
    expect(ctx.reportData.tests['test-1']).toBeDefined()
    expect(ctx.reportData.tests['test-2']).toBeDefined()
  })

  test('handleSync broadcasts { tests, isUpdateMode } (no full reportData leakage)', () => {
    applyTestBeginEvent(ctx, {
      id: 'test-1',
      title: 'renders',
      titlePath: ['Suite'],
      browser: 'chromium',
      location: { file: 'a.ts', line: 1 },
    })
    ctx.reportData.isUpdateMode = true
    clients.forEach((c) => (c.sent = []))

    handleSync(ctx)

    const parsed = WebSocketMessageSchema.safeParse(readMessages(clients)[0])
    if (!(parsed.success && parsed.data.type === 'sync')) {
      throw new Error('expected sync message')
    }
    expect(Object.keys(parsed.data.data.tests)).toEqual(['test-1'])
    expect(parsed.data.data.isUpdateMode).toBe(true)
    // Should not leak server-only fields
    const raw = readMessages(clients)[0] as Record<string, unknown>
    const data = raw['data'] as Record<string, unknown>
    expect(data).not.toHaveProperty('screenshotDir')
    expect(data).not.toHaveProperty('browsers')
    expect(data).not.toHaveProperty('isRunning')
  })
})

describe('handleRegister runContext persistence', () => {
  let ctx: HandlerContext

  beforeEach(() => {
    const created = createContext()
    ctx = created.ctx
  })

  test('persists configFile and cwd onto routesContext', () => {
    handleRegister(ctx, {
      configFile: '/proj/playwright.config.ts',
      cwd: '/proj',
    })
    expect(ctx.routesContext.runContext).toEqual({
      configFile: '/proj/playwright.config.ts',
      cwd: '/proj',
      rootDir: '/proj',
    })
  })

  test('does not overwrite runContext when payload omits the fields', () => {
    ctx.routesContext.runContext = { configFile: '/existing.ts', cwd: '/existing' }
    handleRegister(ctx, { playwrightSnapshotDir: '/snapshots' })
    expect(ctx.routesContext.runContext).toEqual({ configFile: '/existing.ts', cwd: '/existing' })
  })

  test('does not set runContext when only one of configFile/cwd is present', () => {
    handleRegister(ctx, { configFile: '/proj/playwright.config.ts' })
    expect(ctx.routesContext.runContext).toBeUndefined()
  })
})
