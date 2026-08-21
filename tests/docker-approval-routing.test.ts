import { describe, expect, test } from 'bun:test'

import type { RunTestDescriptor } from '../src/schemas'
import { resolveBaselineSnapshotPath } from '../src/server/artifact-routes'
import { rewriteContainerTestDescriptors } from '../src/server/docker-support'
import { buildTestListEntries } from '../src/server/run-controller'
import type { TestData } from '../src/types'

function makeTest(file: string): TestData {
  return {
    id: 'test-1',
    titlePath: [],
    browser: 'chromium',
    projectName: 'chromium',
    title: 'hero visual',
    location: { file, line: 3 },
    results: [
      {
        status: 'failed',
        retries: 0,
        visualDeclarations: [
          {
            visualName: 'hero',
            kind: 'named',
            declaredName: 'hero',
            snapshotBaseName: 'hero',
            occurrenceIndex: 1,
          },
        ],
      },
    ],
  }
}

describe('resolveBaselineSnapshotPath in docker mode', () => {
  const routing = {
    configDir: '/host/proj',
    playwrightTestDir: '/host/proj/tests',
    playwrightSnapshotDir: '/host/proj/tests',
    containerPathMapping: { from: '/work', to: '/host/proj' },
  } as const

  test('rewrites container test file paths to host paths with linux suffix', () => {
    const path = resolveBaselineSnapshotPath(routing, makeTest('/work/tests/visual.spec.ts'), 0, 'hero')

    expect(path).toBe('/host/proj/tests/visual.spec.ts-snapshots/hero-chromium-linux.png')
  })

  test('keeps host test files with host platform suffix when mapping is set', () => {
    const path = resolveBaselineSnapshotPath(routing, makeTest('/host/proj/tests/visual.spec.ts'), 0, 'hero')

    expect(path).toBe(`/host/proj/tests/visual.spec.ts-snapshots/hero-chromium-${process.platform}.png`)
  })

  test('no mapping keeps current behavior', () => {
    const path = resolveBaselineSnapshotPath(
      {
        configDir: '/host/proj',
        playwrightTestDir: '/host/proj/tests',
        playwrightSnapshotDir: '/host/proj/tests',
      },
      makeTest('/host/proj/tests/visual.spec.ts'),
      0,
      'hero',
    )

    expect(path).toBe(`/host/proj/tests/visual.spec.ts-snapshots/hero-chromium-${process.platform}.png`)
  })
})

describe('rewriteContainerTestDescriptors', () => {
  const descriptor = (file: string): RunTestDescriptor => ({
    file,
    line: 3,
    titlePath: ['hero visual'],
    projectName: 'chromium',
  })

  test('rewrites container file paths to host paths', () => {
    const rewritten = rewriteContainerTestDescriptors([descriptor('/work/tests/visual.spec.ts')], {
      from: '/work',
      to: '/host/proj',
    })

    expect(rewritten![0]?.file).toBe('/host/proj/tests/visual.spec.ts')
  })

  test('passes host paths through unchanged', () => {
    const rewritten = rewriteContainerTestDescriptors([descriptor('/host/proj/tests/visual.spec.ts')], {
      from: '/work',
      to: '/host/proj',
    })

    expect(rewritten![0]?.file).toBe('/host/proj/tests/visual.spec.ts')
  })

  test('no mapping returns the same descriptors', () => {
    const tests = [descriptor('/work/tests/visual.spec.ts')]

    expect(rewriteContainerTestDescriptors(tests, undefined)).toBe(tests)
  })

  test('rewritten descriptors produce rootDir-relative test-list entries', () => {
    const rewritten = rewriteContainerTestDescriptors(
      [descriptor('/work/tests/visual.spec.ts'), descriptor('/work/tests/basic.spec.ts')],
      { from: '/work', to: '/host/proj' },
    )

    // --test-list matches paths relative to Playwright's rootDir (= testDir when unset),
    // not the project root the container mounts.
    const entries = buildTestListEntries(rewritten!, '/host/proj/tests')
    expect(entries[0]).toBe('[chromium] \u203a visual.spec.ts:3 \u203a hero visual')
    expect(entries[1]).toBe('[chromium] \u203a basic.spec.ts:3 \u203a hero visual')
  })

  test('unknown rootDir emits one candidate entry per plausible base', () => {
    // Before any register, the server only knows cwd — Playwright's rootDir may be any
    // ancestor of the file down to cwd. Non-matching --test-list entries are ignored
    // silently, so emitting all candidates runs the test regardless of the true base.
    const entries = buildTestListEntries(
      [descriptor('/host/proj/tests/screenshots/a.spec.ts')],
      undefined,
      '/host/proj',
    )

    expect(entries).toEqual([
      '[chromium] \u203a tests/screenshots/a.spec.ts:3 \u203a hero visual',
      '[chromium] \u203a screenshots/a.spec.ts:3 \u203a hero visual',
      '[chromium] \u203a a.spec.ts:3 \u203a hero visual',
    ])
  })

  test('unknown rootDir keeps relative descriptor files as single entries', () => {
    const entries = buildTestListEntries([descriptor('tests/a.spec.ts')], undefined)

    expect(entries).toEqual(['[chromium] \u203a tests/a.spec.ts:3 \u203a hero visual'])
  })
})
