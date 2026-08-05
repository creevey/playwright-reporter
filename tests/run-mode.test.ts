import { describe, expect, test } from 'bun:test'

import { resolveRunMode } from '../src/server/run-mode'

describe('resolveRunMode', () => {
  test('explicit local never probes docker', async () => {
    let probed = false
    const mode = await resolveRunMode({
      runMode: 'local',
      isCI: false,
      probeDocker: () => {
        probed = true
        return Promise.resolve(true)
      },
    })
    expect(mode).toBe('local')
    expect(probed).toBe(false)
  })

  test('explicit docker never probes at resolution time', async () => {
    let probed = false
    const mode = await resolveRunMode({
      runMode: 'docker',
      isCI: false,
      probeDocker: () => {
        probed = true
        return Promise.resolve(false)
      },
    })
    expect(mode).toBe('docker')
    expect(probed).toBe(false)
  })

  test('auto resolves to local on CI without probing', async () => {
    let probed = false
    const mode = await resolveRunMode({
      runMode: 'auto',
      isCI: true,
      probeDocker: () => {
        probed = true
        return Promise.resolve(true)
      },
    })
    expect(mode).toBe('local')
    expect(probed).toBe(false)
  })

  test('auto resolves to docker when the daemon is reachable', async () => {
    const mode = await resolveRunMode({ runMode: 'auto', isCI: false, probeDocker: () => Promise.resolve(true) })
    expect(mode).toBe('docker')
  })

  test('auto falls back to local with a warning when the daemon is down', async () => {
    const warnings: string[] = []
    const mode = await resolveRunMode({
      runMode: 'auto',
      isCI: false,
      probeDocker: () => Promise.resolve(false),
      warn: (m) => warnings.push(m),
    })
    expect(mode).toBe('local')
    expect(warnings).toHaveLength(1)
  })
})
