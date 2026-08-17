import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CreationGuard, _testing } from '../../src/creation-guard.js'
import type { ResolutionAuthorization } from '../../src/contracts.js'
import { OUTSIDE_EVOLUTION_MODE_DENIAL } from '../../src/evolution-contracts.js'
import {
  CREATOR_SKILL_MARKER,
  CREATOR_SKILL_NAME,
  CREATOR_SKILL_PROVIDER,
  OFFICIAL_CREATOR_SKILL_NAME,
} from '../../src/creator-skill.js'

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

function skillExecution(callId: string, skillName = CREATOR_SKILL_NAME): ToolExecution {
  return {
    ...execution(callId, 'new', 'skill'),
    arguments: { name: skillName },
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

function inModeGuard(): CreationGuard {
  return new CreationGuard({ isEvolutionMode: () => true })
}

function outsideModeGuard(): CreationGuard {
  return new CreationGuard({ isEvolutionMode: () => false })
}

const success = { isError: false, value: {}, content: [] } as unknown as ToolExecutionResult
const failure = { isError: true, error: { message: 'failed' }, content: [] } as unknown as ToolExecutionResult
const creatorSkillSuccess: ToolExecutionResult = {
  isError: false,
  value: {
    name: CREATOR_SKILL_NAME,
    provider: CREATOR_SKILL_PROVIDER,
    content: `# Creator\n${CREATOR_SKILL_MARKER}`,
  },
  content: [],
} as unknown as ToolExecutionResult

describe('new Cordis Plugin creation guard', () => {
  it('denies new definitions outside evolution mode even with a stale scratch grant', async () => {
    const guard = outsideModeGuard()
    resolveAs(guard, authorization('scratch_ready'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const exec = execution('call-outside')
    await expect(guard.preExecute(exec, next)).resolves.toEqual({
      kind: 'deny',
      reason: OUTSIDE_EVOLUTION_MODE_DENIAL,
    })
    expect(next).not.toHaveBeenCalled()
    expect(guard.guard(exec)).toBe(OUTSIDE_EVOLUTION_MODE_DENIAL)
    expect(_testing.outsideEvolutionModeReason()).toBe(OUTSIDE_EVOLUTION_MODE_DENIAL)
  })

  it('denies an unresolved new definition in evolution mode with actionable feedback', async () => {
    const guard = inModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(execution('call-1'), next)).resolves.toEqual({
      kind: 'deny',
      reason: expect.stringContaining('call capability_resolve'),
    })
    expect(next).not.toHaveBeenCalled()
    expect(guard.guard(execution('call-final'))).toContain('call capability_resolve')
  })

  it.each(['reuse_local', 'selection_required', 'confirmation_required', 'modify_review', 'use_review', 'market_required', 'stopped'] as const)(
    'keeps new definitions blocked in evolution mode for %s',
    async (state) => {
      const guard = inModeGuard()
      resolveAs(guard, authorization(state))
      const decision = await guard.preExecute(execution(`call-${state}`), async () => ({ kind: 'allow' }))
      expect(decision.kind).toBe('deny')
      if (decision.kind === 'deny') expect(decision.reason).toContain(authorization(state).resolutionId)
      expect(guard.guard(execution(`call-${state}-guard`))).toContain(authorization(state).resolutionId)
    },
  )

  it('reserves one scratch grant, restores it after failure, and consumes it after success', async () => {
    const guard = inModeGuard()
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

  it('does not require a creator skill result before scratch grant works', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('scratch_ready'))
    const exec = execution('call-no-skill')
    await expect(guard.preExecute(exec, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(exec)).toBeUndefined()
  })

  it('does not block official creator skill loads', async () => {
    const guard = inModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const official = skillExecution('call-official-skill', OFFICIAL_CREATOR_SKILL_NAME)
    await expect(guard.preExecute(official, next)).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(official)).toBeUndefined()

    const replacement = skillExecution('call-replacement-skill', CREATOR_SKILL_NAME)
    await expect(guard.preExecute(replacement, next)).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(replacement)).toBeUndefined()
    // Skill results are ignored for authorization; no creator-skill bookkeeping remains.
    guard.result(replacement, creatorSkillSuccess)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('denies same-id foreign preset agents when isEvolutionMode returns false', async () => {
    const guard = new CreationGuard({
      isEvolutionMode: (target) => target === agent,
    })
    resolveAs(guard, authorization('scratch_ready'), agent)
    resolveAs(guard, authorization('scratch_ready'), otherAgent)

    const allowed = execution('call-real-mode')
    await expect(guard.preExecute(allowed, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })

    const foreign = {
      ...execution('call-foreign'),
      agent: otherAgent,
    } as unknown as ToolExecution
    const decision = await guard.preExecute(foreign, async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'deny', reason: OUTSIDE_EVOLUTION_MODE_DENIAL })
    expect(guard.guard(foreign)).toBe(OUTSIDE_EVOLUTION_MODE_DENIAL)
  })

  it('does not gate existing Plugin repair or unrelated tools', async () => {
    const guard = outsideModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(execution('call-existing', 'existing'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(guard.preExecute(execution('call-pwsh', 'new', 'pwsh'), next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(2)
    expect(guard.guard(execution('call-existing', 'existing'))).toBeUndefined()
    expect(guard.guard(execution('call-pwsh', 'new', 'pwsh'))).toBeUndefined()
  })

  it('revokes an unconsumed grant when a new resolution starts', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('scratch_ready'))
    guard.beginResolution(agent)
    const decision = await guard.preExecute(execution('call-revoked'), async () => ({ kind: 'allow' }))
    expect(decision.kind).toBe('deny')
  })

  it('ignores a stale resolution completion after a newer resolution starts', async () => {
    const guard = inModeGuard()
    const staleGeneration = guard.beginResolution(agent)!
    const currentGeneration = guard.beginResolution(agent)!
    const current = { ...authorization('reuse_local'), resolutionId: `resolution_${'b'.repeat(24)}` }
    expect(guard.applyResolutionAuthorization(agent, current, currentGeneration)).toBe(true)
    expect(guard.applyResolutionAuthorization(agent, authorization('scratch_ready'), staleGeneration)).toBe(false)
    expect(guard.authorization(agent)).toEqual(current)
    expect((await guard.preExecute(execution('call-stale'), async () => ({ kind: 'allow' }))).kind).toBe('deny')
  })

  it('only lets reviews update the active in-memory resolution for the same Agent', () => {
    const guard = inModeGuard()
    const active = { ...authorization('selection_required'), resolutionId: `resolution_${'c'.repeat(24)}` }
    resolveAs(guard, active)
    const foreign = { ...authorization('scratch_ready'), resolutionId: `resolution_${'d'.repeat(24)}` }
    expect(guard.applyReviewAuthorization(agent, foreign)).toBe(false)
    expect(guard.applyReviewAuthorization(otherAgent, active)).toBe(false)
    expect(guard.authorization(agent)).toEqual(active)
  })

  it('keeps Agent-less tool execution outside this Agent-scoped gate', async () => {
    const guard = outsideModeGuard()
    const exec = { ...execution('call-agentless'), agent: undefined } as unknown as ToolExecution
    await expect(guard.preExecute(exec, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(exec)).toBeUndefined()
  })
})
