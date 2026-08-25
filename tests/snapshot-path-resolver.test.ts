import { describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { basename, join } from 'path'

import {
  playwrightAnonymousVisualName,
  resolveBaselineTargets,
  sanitizeForFilePath,
  withResolvedVisualNames,
} from '../src/snapshot-path-resolver'

const TEST_DIR = join(process.cwd(), 'tests')
const TEST_FILE = join(TEST_DIR, 'example.spec.ts')
const REPORTER_TITLE_PATH = ['', 'chromium', 'example.spec.ts', 'Suite', 'visual pass']
type ResolveBaselineTargetsInput = Parameters<typeof resolveBaselineTargets>[0]

describe('sanitizeForFilePath', () => {
  test('collapses consecutive unsafe characters into a single dash', () => {
    expect(sanitizeForFilePath('header::mobile')).toBe('header-mobile')
  })
})

describe('resolveBaselineTargets', () => {
  test('resolves a named screenshot with the default Playwright screenshot layout', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header',
        attachmentBaseName: 'header',
        artifactBaseName: 'header',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-chromium-${process.platform}.png`),
      },
    ])
  })

  test('resolves a named screenshot with an explicit toHaveScreenshot path template', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: join(TEST_DIR, 'custom-snapshots'),
        projectName: 'chromium',
        snapshotSuffix: process.platform,
        toHaveScreenshotPathTemplate: '{snapshotDir}/{projectName}/{testFilePath}/{arg}{ext}',
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header',
        attachmentBaseName: 'header',
        artifactBaseName: 'header',
        snapshotPath: join(TEST_DIR, 'custom-snapshots', 'chromium', 'example.spec.ts', 'header.png'),
      },
    ])
  })

  test('keeps stable visual and attachment names while exposing a filesystem-safe artifact base', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header:mobile',
          kind: 'named',
          declaredName: 'header:mobile',
          snapshotBaseName: 'header:mobile',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header:mobile',
        attachmentBaseName: 'header:mobile',
        artifactBaseName: 'header-mobile',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-mobile-chromium-${process.platform}.png`),
      },
    ])
  })

  test('uses occurrence indexes to resolve duplicate named screenshots to distinct baselines', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        },
        {
          visualName: 'header-1',
          kind: 'named',
          declaredName: 'header',
          snapshotBaseName: 'header',
          occurrenceIndex: 2,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([
      {
        visualName: 'header',
        attachmentBaseName: 'header',
        artifactBaseName: 'header',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-chromium-${process.platform}.png`),
      },
      {
        visualName: 'header-1',
        attachmentBaseName: 'header-1',
        artifactBaseName: 'header-1',
        snapshotPath: join(TEST_DIR, 'example.spec.ts-snapshots', `header-1-chromium-${process.platform}.png`),
      },
    ])
  })

  test('resolves an unnamed screenshot using Playwright anonymous naming rules', () => {
    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    }
    const targets = resolveBaselineTargets(input)

    expect(targets).toEqual([
      {
        visualName: '__unnamed-screenshot-1',
        attachmentBaseName: '__unnamed-screenshot-1',
        artifactBaseName: '-unnamed-screenshot-1',
        snapshotPath: join(
          TEST_DIR,
          'example.spec.ts-snapshots',
          `Suite-visual-pass-1-chromium-${process.platform}.png`,
        ),
      },
    ])
  })

  test('resolves multiple unnamed screenshots in one test using incrementing anonymous indexes', () => {
    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
        {
          visualName: '__unnamed-screenshot-2',
          kind: 'unnamed',
          occurrenceIndex: 2,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    }
    const targets = resolveBaselineTargets(input)

    expect(targets).toEqual([
      {
        visualName: '__unnamed-screenshot-1',
        attachmentBaseName: '__unnamed-screenshot-1',
        artifactBaseName: '-unnamed-screenshot-1',
        snapshotPath: join(
          TEST_DIR,
          'example.spec.ts-snapshots',
          `Suite-visual-pass-1-chromium-${process.platform}.png`,
        ),
      },
      {
        visualName: '__unnamed-screenshot-2',
        attachmentBaseName: '__unnamed-screenshot-2',
        artifactBaseName: '-unnamed-screenshot-2',
        snapshotPath: join(
          TEST_DIR,
          'example.spec.ts-snapshots',
          `Suite-visual-pass-2-chromium-${process.platform}.png`,
        ),
      },
    ])
  })

  test('trims long unnamed screenshot titles with the same hash format Playwright uses', () => {
    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: [
        '',
        'chromium',
        'example.spec.ts',
        'A suite title that is intentionally very long to exercise trimming',
        'and an equally long test title to force a hashed anonymous screenshot name',
      ],
      declarations: [
        {
          visualName: '__unnamed-screenshot-1',
          kind: 'unnamed',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    }
    const target = resolveBaselineTargets(input)[0]

    expect(target).toBeDefined()
    expect(basename(target!.snapshotPath)).toMatch(/-[0-9a-f]{5}-/)
    expect(basename(target!.snapshotPath)).toEndWith(`-chromium-${process.platform}.png`)
  })

  test('returns no target for malformed named declarations instead of treating them as unnamed', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'header',
          kind: 'named',
          snapshotBaseName: 'header',
          occurrenceIndex: 1,
        } as unknown as ResolveBaselineTargetsInput['declarations'][number],
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([])
  })

  test('returns no target for slash-containing names when no existence callback is provided', () => {
    const targets = resolveBaselineTargets({
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          snapshotBaseName: 'dir/header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
    })

    expect(targets).toEqual([])
  })

  test('resolves the string-call variant when it is the only existing slash-name candidate', () => {
    const stringVariantPath = join(TEST_DIR, 'example.spec.ts-snapshots', `dir-header-chromium-${process.platform}.png`)

    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          snapshotBaseName: 'dir/header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === stringVariantPath,
    }
    const targets = resolveBaselineTargets(input)

    expect(targets).toEqual([
      {
        visualName: 'dir/header',
        attachmentBaseName: 'dir/header',
        artifactBaseName: 'dir-header',
        snapshotPath: stringVariantPath,
      },
    ])
  })

  test('resolves the array-call variant when it is the only existing slash-name candidate', () => {
    const arrayVariantPath = join(
      TEST_DIR,
      'example.spec.ts-snapshots',
      'dir',
      `header-chromium-${process.platform}.png`,
    )

    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          snapshotBaseName: 'dir/header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === arrayVariantPath,
    }
    const targets = resolveBaselineTargets(input)

    expect(targets).toEqual([
      {
        visualName: 'dir/header',
        attachmentBaseName: 'dir/header',
        artifactBaseName: 'dir-header',
        snapshotPath: arrayVariantPath,
      },
    ])
  })

  test('returns no target for slash-containing names when both slash-name candidates exist', () => {
    const stringVariantPath = join(TEST_DIR, 'example.spec.ts-snapshots', `dir-header-chromium-${process.platform}.png`)
    const arrayVariantPath = join(
      TEST_DIR,
      'example.spec.ts-snapshots',
      'dir',
      `header-chromium-${process.platform}.png`,
    )

    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header',
          kind: 'named',
          declaredName: 'dir/header.png',
          snapshotBaseName: 'dir/header',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === stringVariantPath || snapshotPath === arrayVariantPath,
    }
    const targets = resolveBaselineTargets(input)

    expect(targets).toEqual([])
  })

  test('preserves the array-call filename when slash-name segments contain unsafe characters', () => {
    const arrayVariantPath = join(
      TEST_DIR,
      'example.spec.ts-snapshots',
      'dir',
      `header:mobile-chromium-${process.platform}.png`,
    )

    const input: ResolveBaselineTargetsInput = {
      testFile: TEST_FILE,
      reporterTitlePath: REPORTER_TITLE_PATH,
      declarations: [
        {
          visualName: 'dir/header:mobile',
          kind: 'named',
          declaredName: 'dir/header:mobile.png',
          snapshotBaseName: 'dir/header:mobile',
          occurrenceIndex: 1,
        },
      ],
      config: {
        configDir: process.cwd(),
        testDir: TEST_DIR,
        snapshotDir: TEST_DIR,
        projectName: 'chromium',
        snapshotSuffix: process.platform,
      },
      snapshotPathExists: (snapshotPath) => snapshotPath === arrayVariantPath,
    }
    const targets = resolveBaselineTargets(input)

    expect(targets).toEqual([
      {
        visualName: 'dir/header:mobile',
        attachmentBaseName: 'dir/header:mobile',
        artifactBaseName: 'dir-header-mobile',
        snapshotPath: arrayVariantPath,
      },
    ])
  })
})

describe('withResolvedVisualNames', () => {
  test('rewrites unnamed declarations to the real auto-name', () => {
    expect(
      withResolvedVisualNames(
        [{ visualName: '__unnamed-screenshot-1', kind: 'unnamed', occurrenceIndex: 1 }],
        REPORTER_TITLE_PATH,
      ),
    ).toEqual([{ visualName: 'Suite-visual-pass-1', kind: 'unnamed', occurrenceIndex: 1 }])
  })

  test('leaves named declarations untouched', () => {
    const named = {
      visualName: 'header',
      kind: 'named' as const,
      declaredName: 'header',
      snapshotBaseName: 'header',
      occurrenceIndex: 1,
    }
    expect(withResolvedVisualNames([named], REPORTER_TITLE_PATH)).toEqual([named])
  })

  test('rewrites multiple unnamed declarations by occurrence index', () => {
    expect(
      withResolvedVisualNames(
        [
          { visualName: '__unnamed-screenshot-1', kind: 'unnamed', occurrenceIndex: 1 },
          { visualName: '__unnamed-screenshot-2', kind: 'unnamed', occurrenceIndex: 2 },
        ],
        REPORTER_TITLE_PATH,
      ),
    ).toEqual([
      { visualName: 'Suite-visual-pass-1', kind: 'unnamed', occurrenceIndex: 1 },
      { visualName: 'Suite-visual-pass-2', kind: 'unnamed', occurrenceIndex: 2 },
    ])
  })

  test('keeps the synthetic name when the title path has no test title', () => {
    const unnamed = { visualName: '__unnamed-screenshot-1', kind: 'unnamed' as const, occurrenceIndex: 1 }
    expect(withResolvedVisualNames([unnamed], ['', 'chromium', 'example.spec.ts'])).toEqual([unnamed])
  })
})

describe('playwrightAnonymousVisualName', () => {
  test('reconstructs Playwright auto-name without extension', () => {
    expect(playwrightAnonymousVisualName(REPORTER_TITLE_PATH, 1)).toBe('Suite-visual-pass-1')
  })

  test('increments with occurrence index', () => {
    expect(playwrightAnonymousVisualName(REPORTER_TITLE_PATH, 2)).toBe('Suite-visual-pass-2')
  })

  test('returns null when the title path has no test title', () => {
    expect(playwrightAnonymousVisualName(['', 'chromium', 'example.spec.ts'], 1)).toBeNull()
  })

  test('returns null for a title path shorter than three segments', () => {
    expect(playwrightAnonymousVisualName(['', 'chromium'], 1)).toBeNull()
  })
})

// Reference implementation copied from @playwright/test 1.59.0:
// - lib/worker/testInfo.js _resolveSnapshotPaths, anonymous branch:
//     const fullTitleWithoutSpec = [...this.titlePath.slice(1), index].join(" ");
//     subPath = sanitizeFilePathBeforeExtension(trimLongString(fullTitleWithoutSpec) + ext, ext);
// - lib/util.js trimLongString (default length = 100)
// - playwright-core/lib/server/utils/fileUtils.js sanitizeForFilePath
const PLAYWRIGHT_UNSAFE_FILE_PATH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x2c],
  [0x2e, 0x2f],
  [0x3a, 0x40],
  [0x5b, 0x60],
  [0x7b, 0x7f],
]

function referenceSanitizeForFilePath(value: string): string {
  const characterClass = PLAYWRIGHT_UNSAFE_FILE_PATH_RANGES.map(
    ([start, end]) => `\\u${start.toString(16).padStart(4, '0')}-\\u${end.toString(16).padStart(4, '0')}`,
  ).join('')
  return value.replace(new RegExp(`[${characterClass}]+`, 'g'), '-')
}

function referenceTrimLongString(value: string, length = 100): string {
  if (value.length <= length) {
    return value
  }

  const hash = createHash('sha1').update(value).digest('hex')
  const middle = `-${hash.slice(0, 5)}-`
  const start = Math.floor((length - middle.length) / 2)
  const end = length - middle.length - start

  return value.slice(0, start) + middle + value.slice(-end)
}

function referenceAnonymousVisualName(suitesAndTitle: readonly string[], occurrenceIndex: number): string {
  const fullTitleWithoutSpec = [...suitesAndTitle, occurrenceIndex].join(' ')
  return referenceSanitizeForFilePath(referenceTrimLongString(fullTitleWithoutSpec))
}

function asciiTitlesForJoinedLength(joinedLength: number): [string, string] {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const titleLength = joinedLength - 3
  const suiteTitle = alphabet.repeat(Math.ceil(titleLength / 2)).slice(0, Math.floor(titleLength / 2))
  const testTitle = alphabet.repeat(Math.ceil(titleLength / 2)).slice(0, Math.ceil(titleLength / 2))
  return [suiteTitle, testTitle]
}

const CYRILLIC_ALPHABET = 'Кнопка-ссылка-в-стиле-Экстерна-Borderless-Button-Example'

function cyrillicTitlesForJoinedLength(joinedLength: number): [string, string] {
  const titleLength = joinedLength - 3
  const suiteTitle = CYRILLIC_ALPHABET.repeat(Math.ceil(titleLength / 2)).slice(0, Math.floor(titleLength / 2))
  const testTitle = CYRILLIC_ALPHABET.repeat(Math.ceil(titleLength / 2)).slice(0, Math.ceil(titleLength / 2))
  return [suiteTitle, testTitle]
}

function anonymousNameForTitles(titles: readonly string[], occurrenceIndex = 1): string | null {
  return playwrightAnonymousVisualName(['', 'chromium', 'example.spec.ts', ...titles], occurrenceIndex)
}

describe('playwrightAnonymousVisualName matches the Playwright snapshot naming reference', () => {
  test('keeps an ASCII title between 61 and 100 characters untrimmed', () => {
    const titles = asciiTitlesForJoinedLength(80)
    expect(`${titles.join(' ')} 1`).toHaveLength(80)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('keeps a Cyrillic title between 61 and 100 characters untrimmed', () => {
    const titles = cyrillicTitlesForJoinedLength(90)
    expect(`${titles.join(' ')} 1`).toHaveLength(90)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('sanitizes unsafe characters in a short mixed title without trimming', () => {
    const titles = ['Components: Кнопка-ссылка', 'borderless button: example']
    expect(`${titles.join(' ')} 1`).toHaveLength(54)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('keeps a title of exactly 100 characters untrimmed', () => {
    const titles = asciiTitlesForJoinedLength(100)
    expect(`${titles.join(' ')} 1`).toHaveLength(100)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('trims a title of 101 characters with the Playwright sha1-middle abbreviation', () => {
    const titles = asciiTitlesForJoinedLength(101)
    expect(`${titles.join(' ')} 1`).toHaveLength(101)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('trims a Cyrillic title over 100 characters with the Playwright sha1-middle abbreviation', () => {
    const titles = cyrillicTitlesForJoinedLength(120)
    expect(`${titles.join(' ')} 1`).toHaveLength(120)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('does not count the extension toward the snapshot name limit', () => {
    const titles = asciiTitlesForJoinedLength(97)
    expect(`${titles.join(' ')} 1`).toHaveLength(97)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('hashes the title without the extension when trimming over 100 characters', () => {
    const titles = asciiTitlesForJoinedLength(105)
    expect(`${titles.join(' ')} 1`).toHaveLength(105)
    expect(anonymousNameForTitles(titles)).toBe(referenceAnonymousVisualName(titles, 1))
  })

  test('matches the reference for occurrence indexes other than 1', () => {
    const titles = asciiTitlesForJoinedLength(110)
    expect(anonymousNameForTitles(titles, 4)).toBe(referenceAnonymousVisualName(titles, 4))
  })
})
