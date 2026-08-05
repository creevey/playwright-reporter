import { z } from 'zod'

export * from './schemas/http.ts'

// Location schema
export const LocationSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number().optional(),
})

export type Location = z.infer<typeof LocationSchema>

export const VisualSourceSchema = z.enum(['comparison', 'baseline-only', 'declared-only'])

export type VisualSource = z.infer<typeof VisualSourceSchema>

// Images schema
export const ImagesSchema = z.object({
  actual: z.string().optional(),
  expect: z.string().optional(),
  diff: z.string().optional(),
  error: z.string().optional(),
  source: VisualSourceSchema.optional(),
})

export type Images = z.infer<typeof ImagesSchema>

export const ScreenshotDeclarationSchema = z.discriminatedUnion('kind', [
  z.object({
    visualName: z.string(),
    kind: z.literal('named'),
    declaredName: z.string(),
    snapshotBaseName: z.string(),
    occurrenceIndex: z.number(),
  }),
  z.object({
    visualName: z.string(),
    kind: z.literal('unnamed'),
    occurrenceIndex: z.number(),
  }),
])

export type ScreenshotDeclaration = z.infer<typeof ScreenshotDeclarationSchema>

// Attachment schema
export const AttachmentSchema = z.object({
  name: z.string(),
  path: z.string(),
  contentType: z.string(),
})

export type Attachment = z.infer<typeof AttachmentSchema>

// Test status enum
export const TestStatusSchema = z.enum(['unknown', 'pending', 'running', 'failed', 'approved', 'success', 'retrying'])

export type TestStatus = z.infer<typeof TestStatusSchema>

export const TestResultStatusSchema = z.enum(['failed', 'success', 'pending'])

export type TestResultStatus = z.infer<typeof TestResultStatusSchema>

// Test result schema
export const TestResultSchema = z.object({
  status: TestResultStatusSchema,
  retries: z.number(),
  images: z.record(z.string(), ImagesSchema).optional(),
  visualDeclarations: z.array(ScreenshotDeclarationSchema).optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
})

export type TestResult = z.infer<typeof TestResultSchema>

// Test data schema
export const TestDataSchema = z.object({
  id: z.string(),
  titlePath: z.array(z.string()),
  browser: z.string(),
  projectName: z.string().optional(),
  title: z.string(),
  skip: z.union([z.boolean(), z.string()]).optional(),
  retries: z.number().optional(),
  status: TestStatusSchema.optional(),
  results: z.array(TestResultSchema).optional(),
  approved: z.record(z.string(), z.number()).nullable().optional(),
  attachments: z.array(AttachmentSchema).optional(),
  location: LocationSchema.optional(),
})

export type TestData = z.infer<typeof TestDataSchema>

// Crvy Rprtr test schema (extends TestData)
export const CrvyRprtrTestSchema = TestDataSchema.extend({
  checked: z.boolean(),
})

export type CrvyRprtrTest = z.infer<typeof CrvyRprtrTestSchema>

// Crvy Rprtr suite type (recursive)
export interface CrvyRprtrSuite {
  path: string[]
  skip: boolean
  status?: TestStatus
  opened: boolean
  checked: boolean
  indeterminate: boolean
  children?: Partial<Record<string, CrvyRprtrSuite | CrvyRprtrTest>>
}

// Crvy Rprtr suite schema (recursive) - explicitly typed to maintain type safety
export const CrvyRprtrSuiteSchema: z.ZodType<CrvyRprtrSuite> = z.lazy(() =>
  z.object({
    path: z.array(z.string()),
    skip: z.boolean(),
    status: TestStatusSchema.optional(),
    opened: z.boolean(),
    checked: z.boolean(),
    indeterminate: z.boolean(),
    children: z.record(z.string(), z.union([CrvyRprtrSuiteSchema, CrvyRprtrTestSchema])).optional(),
  }),
)

// WebSocket message types

// Incoming: reporter -> server. data is parsed per-type by the handler.
export const IncomingWebSocketMessageSchema = z.object({
  type: z.enum(['test-begin', 'test-end', 'run-end', 'approve', 'sync', 'register']),
  data: z.unknown(),
})
export type IncomingWebSocketMessage = z.infer<typeof IncomingWebSocketMessageSchema>

// Outgoing: server -> client. data carries fully-resolved test data so the
// client can apply updates incrementally without re-fetching /api/report.
export const WebSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('test-begin'), data: TestDataSchema }),
  z.object({ type: z.literal('test-update'), data: TestDataSchema }),
  z.object({
    type: z.literal('run-end'),
    data: z.object({
      status: z.enum(['passed', 'failed', 'skipped']),
      removedTestIds: z.array(z.string()),
    }),
  }),
  z.object({
    type: z.literal('sync'),
    data: z.object({
      tests: z.record(z.string(), TestDataSchema),
      isUpdateMode: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal('approve'), data: z.unknown() }),
  z.object({
    type: z.literal('run-status'),
    data: z.object({
      running: z.boolean(),
      mode: z.enum(['local', 'docker']).optional(),
      phase: z.string().optional(),
    }),
  }),
])

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>

// Test begin data schema
export const TestBeginDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  titlePath: z.array(z.string()),
  browser: z.string(),
  projectName: z.string().optional(),
  location: LocationSchema,
})

export type TestBeginData = z.infer<typeof TestBeginDataSchema>

// Test end data schema
export const TestEndDataSchema = z.object({
  id: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  attachments: z.array(AttachmentSchema),
  visualNames: z.array(z.string()).default([]),
  visualDeclarations: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.array(ScreenshotDeclarationSchema).optional(),
  ),
  error: z.string().optional(),
  duration: z.number().optional(),
})

export type TestEndData = z.infer<typeof TestEndDataSchema>

// Run end data schema (reporter -> server)
export const RunEndDataSchema = z.object({
  status: z.enum(['passed', 'failed', 'skipped']),
})
export type RunEndData = z.infer<typeof RunEndDataSchema>

// Register data schema (reporter -> server, sent on connect)
export const RegisterDataSchema = z.object({
  playwrightSnapshotDir: z.string().optional(),
  playwrightTestDir: z.string().optional(),
  playwrightSnapshotPathTemplate: z.string().optional(),
  playwrightToHaveScreenshotPathTemplate: z.string().optional(),
  configFile: z.string().optional(),
  cwd: z.string().optional(),
})
export type RegisterData = z.infer<typeof RegisterDataSchema>

// Report data schema
export const ReportDataSchema = z.object({
  isRunning: z.boolean(),
  tests: z.record(z.string(), TestDataSchema),
  browsers: z.array(z.string()),
  isUpdateMode: z.boolean(),
  screenshotDir: z.string(),
})

export type ReportData = z.infer<typeof ReportDataSchema>

// Loaded report data schema (partial)
export const LoadedReportDataSchema = z.object({
  tests: z.record(z.string(), TestDataSchema).optional(),
  isUpdateMode: z.boolean().optional(),
})

export type LoadedReportData = z.infer<typeof LoadedReportDataSchema>

// Offline event schema
export const OfflineEventSchema = z.object({
  type: z.enum(['test-begin', 'test-end', 'run-end']),
  data: z.unknown(),
  timestamp: z.number(),
  workerIndex: z.number(),
})

export type OfflineEvent = z.infer<typeof OfflineEventSchema>

// Offline report schema
export const OfflineReportSchema = z.object({
  version: z.number(),
  generatedAt: z.string(),
  workers: z.number(),
  events: z.array(OfflineEventSchema),
})

export type OfflineReport = z.infer<typeof OfflineReportSchema>

// Report API response schema
export const ReportApiResponseSchema = z.object({
  tests: z.record(z.string(), TestDataSchema),
  isUpdateMode: z.boolean().optional(),
  isRunning: z.boolean().optional(),
  runEnabled: z.boolean().optional(),
  runMode: z.enum(['local', 'docker']).optional(),
})

export type ReportApiResponse = z.infer<typeof ReportApiResponseSchema>

export const ClientBootstrapDataSchema = z.object({
  report: ReportApiResponseSchema.extend({
    isUpdateMode: z.boolean(),
  }),
  liveUpdates: z.boolean(),
  approvalEnabled: z.boolean(),
  approvalMessage: z.string().optional(),
  runEnabled: z.boolean().optional(),
  isRunning: z.boolean().optional(),
})

export type ClientBootstrapData = z.infer<typeof ClientBootstrapDataSchema>

// View modes
export const ImagesViewModeSchema = z.enum(['side-by-side', 'swap', 'slide', 'blend'])

export type ImagesViewMode = z.infer<typeof ImagesViewModeSchema>

// Helper function to safely parse with zod
export function safeParse<T>(schema: z.ZodType<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  return null
}

// Helper function to parse or throw
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, errorMessage: string): T {
  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }
  throw new Error(`${errorMessage}: ${result.error.message}`)
}
