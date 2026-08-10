import { describe, expect, test } from 'bun:test'

import { RunRequestBodySchema, RunResponseSchema, WebSocketMessageSchema, safeParse } from '../src/schemas'
import type { RunController } from '../src/server/run-controller'
import { handleRunRoutes } from '../src/server/run-routes'

describe('RunRequestBodySchema', () => {
  test('accepts update flag', () => {
    const parsed = safeParse(RunRequestBodySchema, { update: true })
    expect(parsed).toEqual({ update: true })
  })

  test('accepts tests with update', () => {
    const parsed = safeParse(RunRequestBodySchema, {
      update: true,
      tests: [{ file: 'a.spec.ts', line: 1, titlePath: ['t'] }],
    })
    expect(parsed?.update).toBe(true)
    expect(parsed?.tests).toHaveLength(1)
  })

  test('accepts empty body', () => {
    expect(safeParse(RunRequestBodySchema, {})).toEqual({})
  })
})

describe('RunResponseSchema', () => {
  test('accepts docker-unavailable reason', () => {
    const parsed = safeParse(RunResponseSchema, { ok: false, reason: 'docker-unavailable' })
    expect(parsed).toEqual({ ok: false, reason: 'docker-unavailable' })
  })
})

describe('handleRunRoutes docker-unavailable mapping', () => {
  test('returns 409 when the controller reports docker-unavailable', async () => {
    const fakeController = {
      start: (): { ok: false; reason: 'docker-unavailable' } => ({
        ok: false as const,
        reason: 'docker-unavailable' as const,
      }),
      stop: (): { ok: false; reason: 'not-running' } => ({ ok: false as const, reason: 'not-running' as const }),
      prepareRun: (): Promise<{ ok: true }> => Promise.resolve({ ok: true as const }),
    }
    const response = await handleRunRoutes(
      '/api/run',
      'POST',
      fakeController as unknown as RunController,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
    )
    expect(response).not.toBeNull()
    expect(response!.status).toBe(409)
    expect(await response!.json()).toEqual({ ok: false, reason: 'docker-unavailable' })
  })

  test('returns 409 and skips start when prepareRun reports docker-unavailable', async () => {
    const fakeController = {
      start: (): never => {
        throw new Error('start must not be called when preparation fails')
      },
      stop: (): { ok: false; reason: 'not-running' } => ({ ok: false as const, reason: 'not-running' as const }),
      prepareRun: (): Promise<{ ok: false; reason: 'docker-unavailable' }> =>
        Promise.resolve({ ok: false as const, reason: 'docker-unavailable' as const }),
    }
    const response = await handleRunRoutes(
      '/api/run',
      'POST',
      fakeController as unknown as RunController,
      new Request('http://localhost/api/run', { method: 'POST', body: '{}' }),
    )
    expect(response).not.toBeNull()
    expect(response!.status).toBe(409)
    expect(await response!.json()).toEqual({ ok: false, reason: 'docker-unavailable' })
  })
})

describe('WebSocketMessageSchema run-status', () => {
  test('accepts mode and phase', () => {
    const parsed = safeParse(WebSocketMessageSchema, {
      type: 'run-status',
      data: { running: true, mode: 'docker', phase: 'pulling' },
    })
    expect(parsed).toEqual({ type: 'run-status', data: { running: true, mode: 'docker', phase: 'pulling' } })
  })

  test('still accepts the bare payload', () => {
    const parsed = safeParse(WebSocketMessageSchema, { type: 'run-status', data: { running: false } })
    expect(parsed).toEqual({ type: 'run-status', data: { running: false } })
  })
})
