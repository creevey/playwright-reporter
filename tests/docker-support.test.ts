import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_CONTAINER_COMMAND,
  probeDockerDaemon,
  isDockerImagePresent,
  pullDockerImage,
  forceRemoveContainer,
  resolveContainerCommand,
  resolveDockerImage,
  rewriteContainerPath,
  type DockerExec,
  type DockerExecResult,
} from '../src/server/docker-support'

function fakeExec(script: Array<{ match: string[]; result: DockerExecResult }>): {
  exec: DockerExec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: DockerExec = (args) => {
    calls.push(args)
    const entry = script.find((s) => s.match.every((m, i) => args[i] === m))
    if (entry === undefined)
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: `unexpected: ${args.join(' ')}` })
    return Promise.resolve(entry.result)
  }
  return { exec, calls }
}

const ok: DockerExecResult = { exitCode: 0, stdout: '', stderr: '' }
const fail: DockerExecResult = { exitCode: 1, stdout: '', stderr: 'boom' }

describe('probeDockerDaemon', () => {
  test('true when docker info succeeds', async () => {
    const { exec } = fakeExec([{ match: ['info'], result: ok }])
    expect(await probeDockerDaemon(exec)).toBe(true)
  })

  test('false when docker info fails', async () => {
    const { exec } = fakeExec([{ match: ['info'], result: fail }])
    expect(await probeDockerDaemon(exec)).toBe(false)
  })

  test('false when docker binary is missing (exec throws)', async () => {
    const exec: DockerExec = () => Promise.reject(new Error('ENOENT'))
    expect(await probeDockerDaemon(exec)).toBe(false)
  })
})

describe('isDockerImagePresent / pullDockerImage', () => {
  test('image inspect exit code drives presence', async () => {
    const present = fakeExec([{ match: ['image', 'inspect', 'img:1'], result: ok }])
    expect(await isDockerImagePresent(present.exec, 'img:1')).toBe(true)
    const missing = fakeExec([{ match: ['image', 'inspect', 'img:1'], result: fail }])
    expect(await isDockerImagePresent(missing.exec, 'img:1')).toBe(false)
  })

  test('pull success and failure', async () => {
    const good = fakeExec([{ match: ['pull', 'img:1'], result: ok }])
    expect(await pullDockerImage(good.exec, 'img:1')).toBe(true)
    const bad = fakeExec([{ match: ['pull', 'img:1'], result: fail }])
    expect(await pullDockerImage(bad.exec, 'img:1')).toBe(false)
  })
})

describe('forceRemoveContainer', () => {
  test('issues docker rm -f and never throws', async () => {
    const { exec, calls } = fakeExec([{ match: ['rm', '-f', 'c1'], result: fail }])
    await forceRemoveContainer(exec, 'c1')
    expect(calls).toEqual([['rm', '-f', 'c1']])
    const throwing: DockerExec = () => Promise.reject(new Error('gone'))
    await forceRemoveContainer(throwing, 'c1')
  })
})

describe('resolveDockerImage', () => {
  test('explicit image wins', () => {
    expect(resolveDockerImage({ image: 'custom/img:1', version: '1.59.0' })).toBe('custom/img:1')
  })

  test('derives the official tag from the installed version', () => {
    expect(resolveDockerImage({ version: '1.59.0' })).toBe('mcr.microsoft.com/playwright:v1.59.0-noble')
  })

  test('null when neither image nor version is resolvable', () => {
    expect(resolveDockerImage({ version: null })).toBeNull()
  })
})

describe('resolveContainerCommand', () => {
  test('explicit command wins over everything', () => {
    expect(resolveContainerCommand({ command: ['bunx'], hasCustomImage: true, detectedAgentName: 'npm' })).toEqual([
      'bunx',
    ])
  })

  test('default image always uses npx regardless of detected agent', () => {
    const warnings: string[] = []
    expect(
      resolveContainerCommand({ hasCustomImage: false, detectedAgentName: 'bun', warn: (m) => warnings.push(m) }),
    ).toEqual([...DEFAULT_CONTAINER_COMMAND])
    expect(warnings).toHaveLength(0)
  })

  test('custom image maps the detected agent to its invoker', () => {
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'pnpm' })).toEqual(['pnpm', 'exec'])
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'yarn' })).toEqual(['yarn'])
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'bun' })).toEqual(['bunx'])
    expect(resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'npm' })).toEqual(['npx'])
  })

  test('custom image with undetectable agent falls back to npx with a warning', () => {
    const warnings: string[] = []
    expect(
      resolveContainerCommand({ hasCustomImage: true, detectedAgentName: null, warn: (m) => warnings.push(m) }),
    ).toEqual(['npx'])
    expect(warnings).toHaveLength(1)
  })

  test('custom image with unknown agent falls back to npx with a warning', () => {
    const warnings: string[] = []
    expect(
      resolveContainerCommand({ hasCustomImage: true, detectedAgentName: 'deno', warn: (m) => warnings.push(m) }),
    ).toEqual(['npx'])
    expect(warnings).toHaveLength(1)
  })
})

describe('rewriteContainerPath', () => {
  const mapping = { from: '/work', to: '/host/proj' }

  test('rewrites the root and descendants', () => {
    expect(rewriteContainerPath('/work', mapping)).toBe('/host/proj')
    expect(rewriteContainerPath('/work/tests/x.spec.ts', mapping)).toBe('/host/proj/tests/x.spec.ts')
  })

  test('leaves unrelated and prefix-like paths alone', () => {
    expect(rewriteContainerPath('/other/x', mapping)).toBe('/other/x')
    expect(rewriteContainerPath('/workspace/x', mapping)).toBe('/workspace/x')
  })
})
