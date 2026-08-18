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
  it('denies new definitions outside evolution mode even with a stale create authorization', async () => {
    const guard = outsideModeGuard()
    resolveAs(guard, authorization('create_authorized'))
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
      reason: expect.stringContaining('call capability_workflow'),
    })
    expect(next).not.toHaveBeenCalled()
    expect(guard.guard(execution('call-final'))).toContain('call capability_workflow')
  })

  it.each(['reuse_local', 'selection_required', 'confirmation_required', 'modify_review', 'use_review', 'market_required', 'stopped', 'create_authorized'] as const)(
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

  it('never grants parent-session cordis_define after create_authorized', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('create_authorized'))
    const first = execution('call-first')
    await expect(guard.preExecute(first, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
    expect(guard.guard(first)).toMatch(/managed git source|workspace-write|not permitted/i)
    guard.result(first, failure)
    const retry = execution('call-retry')
    await expect(guard.preExecute(retry, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('keeps create_authorized denied even after loading the creator skill', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('create_authorized'))
    const skill = skillExecution('call-skill')
    await expect(guard.preExecute(skill, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    guard.result(skill, creatorSkillSuccess)
    const exec = execution('call-after-skill')
    await expect(guard.preExecute(exec, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
    expect(guard.guard(exec)).toMatch(/managed git source|not permitted/i)
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
    resolveAs(guard, authorization('create_authorized'), agent)
    resolveAs(guard, authorization('create_authorized'), otherAgent)

    const inMode = execution('call-real-mode')
    await expect(guard.preExecute(inMode, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
    expect(guard.guard(inMode)).toMatch(/managed git source|not permitted/i)

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

  it('clears prior authorization bookkeeping when a new resolution starts', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('create_authorized'))
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
    expect(guard.applyResolutionAuthorization(agent, authorization('create_authorized'), staleGeneration)).toBe(false)
    expect(guard.authorization(agent)).toEqual(current)
    expect((await guard.preExecute(execution('call-stale'), async () => ({ kind: 'allow' }))).kind).toBe('deny')
  })

  it('only lets reviews update the active in-memory resolution for the same Agent', () => {
    const guard = inModeGuard()
    const active = { ...authorization('selection_required'), resolutionId: `resolution_${'c'.repeat(24)}` }
    resolveAs(guard, active)
    const foreign = { ...authorization('create_authorized'), resolutionId: `resolution_${'d'.repeat(24)}` }
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

describe('evolution protocol automaton', () => {
  function tool(name: string, args: Record<string, unknown> = {}, extra: Partial<ToolExecution> = {}): ToolExecution {
    return {
      ...execution(`call-${name}`, 'new', name),
      arguments: args,
      ...extra,
    } as unknown as ToolExecution
  }

  it('denies a model-direct find_dsh_plugin and allows a nested parent call', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const direct = tool('find_dsh_plugin', { query: 'screenshot' })
    await expect(guard.preExecute(direct, next)).resolves.toEqual({
      kind: 'deny',
      reason: expect.stringContaining('capability_workflow_resume'),
    })
    expect(guard.guard(direct)).toContain('capability_workflow_resume')
    expect(next).not.toHaveBeenCalled()

    const nested = {
      ...tool('find_dsh_plugin', { query: 'screenshot' }),
      parent: Symbol('parent'),
    } as unknown as ToolExecution
    await expect(guard.preExecute(nested, next)).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(nested)).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('does not intercept find_dsh_plugin outside evolution mode', async () => {
    const guard = outsideModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(tool('find_dsh_plugin'), next)).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(tool('find_dsh_plugin'))).toBeUndefined()
  })

  it('denies web_search only while waiting for a user choice', async () => {
    const guard = inModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(tool('web_search'), next)).resolves.toEqual({ kind: 'allow' })

    resolveAs(guard, authorization('selection_required'))
    await expect(guard.preExecute(tool('web_search'), next)).resolves.toMatchObject({ kind: 'deny' })
    expect(guard.guard(tool('web_search'))).toContain('Discovery is finished')

    resolveAs(guard, authorization('use_review'))
    await expect(guard.preExecute(tool('web_search'), next)).resolves.toEqual({ kind: 'allow' })
  })

  it('denies dsh plugin add in the shell and leaves ordinary commands alone', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(guard.preExecute(tool('pwsh', {
      command: 'dsh plugin --profile web add github:Yts1919/dsh-vision-complete',
    }), next)).resolves.toEqual({
      kind: 'deny',
      reason: 'Install only via the capability workflow after review.',
    })
    await expect(guard.preExecute(tool('pwsh', { command: 'Get-ChildItem' }), next)).resolves.toEqual({ kind: 'allow' })
    expect(_testing.isDshPluginAddCommand('dsh plugin add foo')).toBe(true)
    expect(_testing.isDshPluginAddCommand('Get-ChildItem')).toBe(false)
  })

  it('remembers the user-facing turn text and ignores runtime-context injections', () => {
    const guard = inModeGuard()
    guard.rememberUserMessage(agent, {
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
    })
    expect(guard.lastUserMessage(agent)).toBeUndefined()
    guard.rememberUserMessage(agent, {
      content: [
        { type: 'text', text: '<system-reminder>\nA skill is available\n' },
        { type: 'text', text: '具体看看3，我希望右键生成长图。' },
      ],
    })
    expect(guard.lastUserMessage(agent)).toBe('具体看看3,我希望右键生成长图。')
    resolveAs(guard, authorization('selection_required'))
    expect(guard.lastUserMessage(agent)).toBe('具体看看3,我希望右键生成长图。')
    expect(_testing.extractUserFacingText({
      content: [{ type: 'text', text: '<system-reminder>hidden' }],
    })).toBe('')
  })
})
