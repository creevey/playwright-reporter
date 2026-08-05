import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'net'
import { join } from 'path'

const SMOKE_ENABLED = process.env.CRVY_DOCKER_SMOKE === '1'
const fixtureDir = join(import.meta.dir, 'fixtures', 'docker-smoke')
const distDir = join(import.meta.dir, '..', 'dist')

interface RunningProcess {
  process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  stdoutPromise: Promise<string>
  stderrPromise: Promise<string>
}

const runningProcesses: RunningProcess[] = []

function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream === null ? Promise.resolve('') : new Response(stream).text()
}

function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a TCP port'))
        return
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
    })
  })
}

function spawnProcess(command: string[], cwd: string): RunningProcess {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const subprocess = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd, env })
  const running = {
    process: subprocess,
    stdoutPromise: readStream(subprocess.stdout),
    stderrPromise: readStream(subprocess.stderr),
  }
  runningProcesses.push(running)
  return running
}

async function waitForServer(port: number, running: RunningProcess): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/report`
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  const [stdout, stderr] = await Promise.all([running.stdoutPromise, running.stderrPromise])
  throw new Error(`Server did not start on port ${port}\n${stdout.trim()}\n${stderr.trim()}`)
}

interface ReportShape {
  tests?: Record<string, { status?: string }>
  runMode?: string
}

afterEach(async () => {
  while (runningProcesses.length > 0) {
    const running = runningProcesses.pop()
    if (running !== undefined) {
      running.process.kill()
      await running.process.exited
    }
  }
})

describe('docker smoke', () => {
  test.skipIf(!SMOKE_ENABLED)(
    'a playwright run inside the container round-trips to the host server',
    async () => {
      const port = await reservePort()
      const server = spawnProcess(
        ['node', join(distDir, 'cli.js'), '--port', `${port}`, '--run-mode', 'docker'],
        fixtureDir,
      )
      await waitForServer(port, server)

      const runResponse = await fetch(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(runResponse.status).toBe(200)

      // First run may include a docker pull — allow generous polling.
      const deadline = Date.now() + 240_000
      let report: ReportShape = {}
      while (Date.now() < deadline) {
        const response = await fetch(`http://127.0.0.1:${port}/api/report`)
        report = (await response.json()) as ReportShape
        const tests = Object.values(report.tests ?? {})
        if (tests.length > 0 && tests.every((t) => t.status === 'success' || t.status === 'failed')) break
        await Bun.sleep(2000)
      }

      expect(report.runMode).toBe('docker')
      const tests = Object.values(report.tests ?? {})
      expect(tests.length).toBeGreaterThan(0)
      expect(tests.every((t) => t.status === 'success')).toBe(true)
    },
    300_000,
  )
})
