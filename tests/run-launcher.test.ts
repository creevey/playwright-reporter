import { describe, expect, test } from 'bun:test'

import type { RunContext } from '../src/server/run-controller'
import {
  buildSpawnEnv,
  createLocalLauncher,
  resolvePlaywrightLaunch,
  type LaunchParams,
} from '../src/server/run-launcher'

const SAMPLE_CTX: RunContext = { configFile: '/proj/playwright.config.ts', cwd: '/proj' }

function params(playwrightArgs: string[]): LaunchParams {
  return { ctx: SAMPLE_CTX, playwrightArgs }
}

describe('buildSpawnEnv', () => {
  test('strips CI and sets reporter URL and HTML_OPEN', () => {
    const env = buildSpawnEnv(3000, { CI: 'true', KEEP_ME: '1' })
    expect(env.CI).toBeUndefined()
    expect(env.KEEP_ME).toBe('1')
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(env.PLAYWRIGHT_HTML_OPEN).toBe('never')
  })

  test('defaults to process.env', () => {
    const env = buildSpawnEnv(4100)
    expect(env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:4100')
  })
})

describe('resolvePlaywrightLaunch', () => {
  test('falls back to npx when no package manager is detectable', () => {
    const saved = process.env.npm_config_user_agent
    try {
      delete process.env.npm_config_user_agent
      const result = resolvePlaywrightLaunch('/any/cwd', ['test', '--config', 'x.ts'])
      expect(result.cmd).toBe('npx')
      expect(result.args).toEqual(['playwright', 'test', '--config', 'x.ts'])
    } finally {
      if (saved !== undefined) process.env.npm_config_user_agent = saved
    }
  })
})

describe('createLocalLauncher', () => {
  test('mode is local and available is undefined', () => {
    const launcher = createLocalLauncher({ port: 3000, env: {} })
    expect(launcher.mode).toBe('local')
    expect(launcher.available).toBeUndefined()
  })

  test('launch resolves the command and attaches the spawn env', () => {
    const launcher = createLocalLauncher({
      port: 3000,
      env: { CI: 'true' },
      resolveLaunch: (cwd, args) => ({ cmd: 'pnpm', args: ['exec', 'playwright', ...args] }),
    })
    const spec = launcher.launch(params(['test', '--config', 'x.ts']))
    expect(spec.cmd).toBe('pnpm')
    expect(spec.args).toEqual(['exec', 'playwright', 'test', '--config', 'x.ts'])
    expect(spec.env.CRVY_RPRTR_SERVER_URL).toBe('ws://localhost:3000')
    expect(spec.env.CI).toBeUndefined()
  })

  test('launch defaults to the package-manager-aware resolver', () => {
    const saved = process.env.npm_config_user_agent
    try {
      delete process.env.npm_config_user_agent
      const launcher = createLocalLauncher({ port: 3000, env: {} })
      const spec = launcher.launch(params(['test']))
      expect(spec.cmd).toBe('npx')
      expect(spec.args).toEqual(['playwright', 'test'])
    } finally {
      if (saved !== undefined) process.env.npm_config_user_agent = saved
    }
  })
})
