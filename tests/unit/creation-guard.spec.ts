import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CreationGuard } from '../../src/creation-guard.js'
import type { ResolutionAuthorization } from '../../src/contracts.js'

const agent = {} as Agent
const otherAgent = {} as Agent

function execution(callId: string, kind: 'new' | 'existing' = 'new', name = 'cordis_define'): ToolExecution {
  return {
    callId,
    rootCallId: callId,
    name,
    arguments: name === 'cordis_define' ? { plugin: { kind } } : {},
    agent,
    token: Symbol(callId),
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function authorization(state: ResolutionAuthorization['state']): ResolutionAuthorization {
  return { state, resolutionId: `resolution_${'a'.repeat(24)}`, reason: `state is ${state}` }
}

function resolveAs(guard: CreationGuard, value: ResolutionAuthorization, target = agent): number {
  const generation = guard.beginResolution(target)
  expect(generation).toBeTypeOf('number')
  expect(guard.applyResolutionAuthorization(target, value, generation)).toBe(true)
  return generation!
}

const success = { isError: false, value: {}, content: [] } as unknown as ToolExecutionResult
const failure = { isError: true, error: { message: 'failed' }, content: [] } as unknown as ToolExecutionResult

describe('new Cordis Plugin creation guard', () => {
  it('denies an unresolved new definition with actionable feedback', async () => {
    const guard = new CreationGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(execution('call-1'), next)).resolves.toEqual({
      kind: 'deny',
      reason: expect.stringContaining('call capability_resolve'),
    })
    expect(next).not.toHaveBeenCalled()
    expect(guard.guard(execution('call-final'))).toContain('call capability_resolve')
  })

  it.each(['reuse_required', 'review_required', 'modify_required'] as const)(
    'keeps new definitions blocked in %s',
    async (state) => {
      const guard = new CreationGuard()
      resolveAs(guard, authorization(state))
      const decision = await guard.preExecute(execution(`call-${state}`), async () => ({ kind: 'allow' }))
      expect(decision.kind).toBe('deny')
      if (decision.kind === 'deny') expect(decision.reason).toContain(authorization(state).resolutionId)
    },
  )

  it('does not gate existing Plugin repair or unrelated tools', async () => {
    const guard = new CreationGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(execution('call-existing', 'existing'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(guard.preExecute(execution('call-pwsh', 'new', 'pwsh'), next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('reserves one scratch grant, restores it after failure, and consumes it after success', async () => {
    const guard = new CreationGuard()
    resolveAs(guard, authorization('scratch_ready'))
    const first = execution('call-first')
    await expect(guard.preExecute(first, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(first)).toBeUndefined()

    const concurrent = await guard.preExecute(execution('call-concurrent'), async () => ({ kind: 'allow' }))
    expect(concurrent.kind).toBe('deny')

    guard.result(first, failure)
    const retry = execution('call-retry')
    await expect(guard.preExecute(retry, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    guard.result(retry, success)

    const consumed = await guard.preExecute(execution('call-after-success'), async () => ({ kind: 'allow' }))
    expect(consumed.kind).toBe('deny')
    if (consumed.kind === 'deny') expect(consumed.reason).toContain('consumed')
  })

  it('revokes an unconsumed grant when a new resolution starts', async () => {
    const guard = new CreationGuard()
    resolveAs(guard, authorization('scratch_ready'))
    guard.beginResolution(agent)
    const decision = await guard.preExecute(execution('call-revoked'), async () => ({ kind: 'allow' }))
    expect(decision.kind).toBe('deny')
  })

  it('ignores a stale resolution completion after a newer resolution starts', async () => {
    const guard = new CreationGuard()
    const staleGeneration = guard.beginResolution(agent)!
    const currentGeneration = guard.beginResolution(agent)!
    const current = { ...authorization('reuse_required'), resolutionId: `resolution_${'b'.repeat(24)}` }
    expect(guard.applyResolutionAuthorization(agent, current, currentGeneration)).toBe(true)
    expect(guard.applyResolutionAuthorization(agent, authorization('scratch_ready'), staleGeneration)).toBe(false)
    expect(guard.authorization(agent)).toEqual(current)
    expect((await guard.preExecute(execution('call-stale'), async () => ({ kind: 'allow' }))).kind).toBe('deny')
  })

  it('only lets reviews update the active in-memory resolution for the same Agent', () => {
    const guard = new CreationGuard()
    const active = { ...authorization('review_required'), resolutionId: `resolution_${'c'.repeat(24)}` }
    resolveAs(guard, active)
    const foreign = { ...authorization('scratch_ready'), resolutionId: `resolution_${'d'.repeat(24)}` }
    expect(guard.applyReviewAuthorization(agent, foreign)).toBe(false)
    expect(guard.applyReviewAuthorization(otherAgent, active)).toBe(false)
    expect(guard.authorization(agent)).toEqual(active)
  })

  it('keeps Agent-less tool execution outside this Agent-scoped gate', async () => {
    const guard = new CreationGuard()
    const exec = { ...execution('call-agentless'), agent: undefined } as unknown as ToolExecution
    await expect(guard.preExecute(exec, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(exec)).toBeUndefined()
  })
})
