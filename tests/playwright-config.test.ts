import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { resolvePlaywrightConfig, resolveSeedConfigFile } from '../src/server/playwright-config'

const TMP = join(process.cwd(), 'test-playwright-config')

afterEach(async (): Promise<void> => {
  await rm(TMP, { recursive: true, force: true })
})

describe('resolvePlaywrightConfig', () => {
  test('returns null when no playwright config is present', async () => {
    await mkdir(TMP, { recursive: true })
    expect(await resolvePlaywrightConfig(TMP)).toBeNull()
  })

  test('discovers playwright.config.ts', async () => {
    await mkdir(TMP, { recursive: true })
    await writeFile(join(TMP, 'playwright.config.ts'), 'export default {}')
    expect(await resolvePlaywrightConfig(TMP)).toBe(join(TMP, 'playwright.config.ts'))
  })

  test('prefers .ts over .js', async () => {
    await mkdir(TMP, { recursive: true })
    await writeFile(join(TMP, 'playwright.config.js'), 'module.exports = {}')
    await writeFile(join(TMP, 'playwright.config.ts'), 'export default {}')
    expect(await resolvePlaywrightConfig(TMP)).toBe(join(TMP, 'playwright.config.ts'))
  })

  test('falls back to .js when .ts is absent', async () => {
    await mkdir(TMP, { recursive: true })
    await writeFile(join(TMP, 'playwright.config.mjs'), 'module.exports = {}')
    expect(await resolvePlaywrightConfig(TMP)).toBe(join(TMP, 'playwright.config.mjs'))
  })
})

describe('resolveSeedConfigFile', () => {
  test('resolves a relative --config option against cwd', async () => {
    await mkdir(TMP, { recursive: true })
    await writeFile(join(TMP, 'playwright.config.ts'), 'export default {}')

    expect(await resolveSeedConfigFile('./playwright.config.ts', TMP)).toBe(join(TMP, 'playwright.config.ts'))
  })

  test('keeps an absolute --config option unchanged', async () => {
    const absolute = join(TMP, 'custom.config.ts')

    expect(await resolveSeedConfigFile(absolute, TMP)).toBe(absolute)
  })
})
