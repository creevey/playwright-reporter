import { z } from 'zod'

// Approve request body schema
export const ApproveRequestBodySchema = z.object({
  id: z.string(),
  retry: z.number(),
  image: z.string(),
})

export type ApproveRequestBody = z.infer<typeof ApproveRequestBodySchema>

export const RunTestDescriptorSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number().optional(),
  projectName: z.string().optional(),
  titlePath: z.array(z.string()),
})

export type RunTestDescriptor = z.infer<typeof RunTestDescriptorSchema>

export const RunRequestBodySchema = z.object({
  tests: z.array(RunTestDescriptorSchema).optional(),
  update: z.boolean().optional(),
})

export type RunRequestBody = z.infer<typeof RunRequestBodySchema>

export const RunResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['no-config', 'already-running', 'no-tests', 'docker-unavailable']),
  }),
])

export type RunResponse = z.infer<typeof RunResponseSchema>

export const StopResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('not-running'),
  }),
])

export type StopResponse = z.infer<typeof StopResponseSchema>
