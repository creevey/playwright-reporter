import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { WebSocketServer, type WebSocket } from 'ws'

import { CrvyRprtr } from '../src/reporter'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2G0K0AAAAASUVORK5CYII=',
  'base64',
)

interface ReceivedMessage {
  type: string
  data: {
    id?: string
    attachments?: Array<{ name: string; path: string }>
  }
}

function makeFakeTest(id: string): {
  id: string
  title: string
  location: { file: string; line: number; column: number }
  parent: {
    title: string
    type: string
    project: () => { name: string }
    parent: undefined
  }
} {
  return {
    id,
    title: 'visual test',
    location: { file: 'tests/visual.spec.ts', line: 3, column: 1 },
    parent: {
      title: 'Suite',
      type: 'describe',
      project: (): { name: string } => ({ name: 'chromium' }),
      parent: undefined,
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await Bun.sleep(25)
  }
  throw new Error('waitFor timed out')
}

describe('portable artifacts mode', () => {
  const savedFlag = process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS
    else process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS = savedFlag
  })

  test('copies attachments into screenshotDir with relative paths while streaming live', async () => {
    process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS = '1'
    delete process.env.CI

    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-portable-'))
    const screenshotDir = join(tempDir, 'screenshots')
    const attachmentPath = join(tempDir, 'actual.png')
    await writeFile(attachmentPath, TINY_PNG)

    const received: ReceivedMessage[] = []
    const sockets = new Set<WebSocket>()
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      sockets.add(ws)
      ws.on('message', (raw) => {
        received.push(JSON.parse((raw as Buffer).toString()) as ReceivedMessage)
      })
    })
    const address = wss.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected pipe address')
    const port = address.port

    try {
      const reporter = new CrvyRprtr({ serverUrl: `ws://127.0.0.1:${port}`, screenshotDir })
      // onBegin triggers connect() when not in CI mode.
      reporter.onBegin(
        { configFile: undefined, rootDir: tempDir, projects: [] } as never,
        { allTests: () => [] } as never,
      )

      await waitFor(() => sockets.size === 1)

      const fakeTest = makeFakeTest('test-1')
      reporter.onTestBegin(fakeTest as never)
      await reporter.onTestEnd(
        fakeTest as never,
        {
          status: 'failed',
          errors: [{ message: 'mismatch' }],
          duration: 5,
          steps: [],
          attachments: [{ name: 'actual.png', path: attachmentPath, contentType: 'image/png' }],
        } as never,
      )

      await waitFor(() => received.some((m) => m.type === 'test-end'))
      await reporter.onEnd({ status: 'failed' } as never)

      const testEnd = received.find((m) => m.type === 'test-end')
      expect(testEnd).toBeDefined()
      const attachments = testEnd!.data.attachments ?? []
      expect(attachments).toHaveLength(1)
      // Relative path under screenshotDir — no absolute container/host path leaks.
      expect(attachments[0]!.path).toBe('test-1/actual.png')
      expect(attachments[0]!.path.startsWith('/')).toBe(false)
      expect(existsSync(join(screenshotDir, 'test-1', 'actual.png'))).toBe(true)
    } finally {
      for (const ws of sockets) ws.close()
      wss.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps native absolute-path attachments when the flag is unset', async () => {
    delete process.env.CRVY_RPRTR_PORTABLE_ARTIFACTS
    delete process.env.CI

    const tempDir = await mkdtemp(join(tmpdir(), 'crvy-portable-off-'))
    const attachmentPath = join(tempDir, 'actual.png')
    await writeFile(attachmentPath, TINY_PNG)

    const received: ReceivedMessage[] = []
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        received.push(JSON.parse((raw as Buffer).toString()) as ReceivedMessage)
      })
    })
    const address = wss.address()
    if (address === null || typeof address === 'string') throw new Error('unexpected pipe address')
    const port = address.port

    try {
      const reporter = new CrvyRprtr({ serverUrl: `ws://127.0.0.1:${port}` })
      reporter.onBegin(
        { configFile: undefined, rootDir: tempDir, projects: [] } as never,
        { allTests: () => [] } as never,
      )

      const fakeTest = makeFakeTest('test-2')
      reporter.onTestBegin(fakeTest as never)
      await reporter.onTestEnd(
        fakeTest as never,
        {
          status: 'failed',
          errors: [],
          duration: 1,
          steps: [],
          attachments: [{ name: 'actual.png', path: attachmentPath, contentType: 'image/png' }],
        } as never,
      )

      await waitFor(() => received.some((m) => m.type === 'test-end'))
      await reporter.onEnd({ status: 'failed' } as never)

      const testEnd = received.find((m) => m.type === 'test-end')
      expect(testEnd!.data.attachments?.[0]?.path).toBe(attachmentPath)
    } finally {
      wss.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
