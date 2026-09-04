import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CreationGuard, _testing } from '../../src/creation-guard.js'
import type {
  ResolutionAuthorization,
} from '../../src/contracts.js'
import { ExecutionGuard } from '../../src/execution-guard.js'
import { trustedUserMessage } from '../helpers/trusted-user-message.js'

const CREATOR_SKILL_NAME = 'autoevo-plugin-creator'
const OFFICIAL_CREATOR_SKILL_NAME = 'cordis-plugin-development'

function fakeAgent(id: string): Agent {
  return { id, session: { header: { id, cwd: 'C:/workspace', version: 0, createdAt: 0 } } } as unknown as Agent
}

const agent = fakeAgent('session-guard')
const otherAgent = fakeAgent('session-other')

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

describe('new Cordis Plugin creation guard', () => {
  it('allows official Creator live definitions outside evolution mode', async () => {
    const guard = outsideModeGuard()
    resolveAs(guard, authorization('create_authorized'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const exec = execution('call-outside')
    await expect(guard.preExecute(exec, next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(guard.guard(exec)).toBeUndefined()
  })

  it.each([
    undefined,
    'reuse_local',
    'selection_required',
    'confirmation_required',
    'use_review',
    'market_required',
    'stopped',
    'modify_review',
    'create_authorized',
  ] as const)(
    'leaves live Cordis definitions to the outer ExecutionGuard in evolution mode (%s)',
    async (state) => {
      const guard = inModeGuard()
      if (state) resolveAs(guard, authorization(state))
      guard.setConstructionRoot(agent, state === 'create_authorized' ? 'C:/workspace/.autoevo/sources/new' : undefined)
      const next = vi.fn(async () => ({ kind: 'allow' as const }))
      const exec = execution(`call-${state ?? 'unresolved'}`)
      await expect(guard.preExecute(exec, next)).resolves.toEqual({ kind: 'allow' })
      expect(next).toHaveBeenCalledTimes(1)
      expect(guard.guard(exec)).toBeUndefined()
      // In evolution mode index.ts runs ExecutionGuard first; both parent and constructor roles deny.
      expect(new ExecutionGuard({ role: 'parent' }).guard(exec)).toMatch(/Cordis live mutation/i)
      expect(new ExecutionGuard({ role: 'constructor', allowedRoot: 'C:/managed', cwd: 'C:/managed' }).guard(exec))
        .toMatch(/Cordis mutation/i)
    },
  )

  it('does not block official creator skill loads', async () => {
    const guard = inModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const official = skillExecution('call-official-skill', OFFICIAL_CREATOR_SKILL_NAME)
    await expect(guard.preExecute(official, next)).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(official)).toBeUndefined()

    const replacement = skillExecution('call-replacement-skill', CREATOR_SKILL_NAME)
    await expect(guard.preExecute(replacement, next)).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(replacement)).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('applies protocol denials per Agent according to isEvolutionMode', async () => {
    const guard = new CreationGuard({
      isEvolutionMode: (target) => target === agent,
    })
    resolveAs(guard, authorization('selection_required'), agent)
    resolveAs(guard, authorization('selection_required'), otherAgent)

    const inMode = execution('call-real-mode', 'new', 'find_dsh_plugin')
    await expect(guard.preExecute(inMode, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })

    const foreign = {
      ...execution('call-foreign', 'new', 'find_dsh_plugin'),
      agent: otherAgent,
    } as unknown as ToolExecution
    await expect(guard.preExecute(foreign, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
    expect(guard.guard(foreign)).toBeUndefined()
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

  it('clears prior authorization bookkeeping when a new resolution starts', () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('create_authorized'))
    expect(guard.authorization(agent)).toEqual(authorization('create_authorized'))
    guard.beginResolution(agent)
    expect(guard.authorization(agent)).toBeUndefined()
  })

  it('ignores a stale resolution completion after a newer resolution starts', () => {
    const guard = inModeGuard()
    const staleGeneration = guard.beginResolution(agent)!
    const currentGeneration = guard.beginResolution(agent)!
    const current = { ...authorization('reuse_local'), resolutionId: `resolution_${'b'.repeat(24)}` }
    expect(guard.applyResolutionAuthorization(agent, current, currentGeneration)).toBe(true)
    expect(guard.applyResolutionAuthorization(agent, authorization('create_authorized'), staleGeneration)).toBe(false)
    expect(guard.authorization(agent)).toEqual(current)
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

  it('denies direct and nested find_dsh_plugin calls', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const direct = tool('find_dsh_plugin', { query: 'screenshot' })
    await expect(guard.preExecute(direct, next)).resolves.toEqual({
      kind: 'deny',
      reason: expect.stringMatching(/until the user replies|Do not search/i),
    })
    expect(guard.guard(direct)).toMatch(/until the user replies|Do not search/i)
    expect(next).not.toHaveBeenCalled()

    const nested = {
      ...tool('find_dsh_plugin', { query: 'screenshot' }),
      parent: Symbol('parent'),
    } as unknown as ToolExecution
    await expect(guard.preExecute(nested, next)).resolves.toMatchObject({ kind: 'deny' })
    expect(guard.guard(nested)).toMatch(/until the user replies|Do not search/i)
    expect(next).not.toHaveBeenCalled()
  })

  it('tells the model to resume with navigation after a fresh user reply instead of waiting again', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    guard.setWaiting(agent, 'await_selection', 'turn_issue')
    guard.rememberUserMessage(agent, trustedUserMessage('看看3'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const direct = tool('find_dsh_plugin', { query: 'dsh-plugin-alpha' })
    const denied = await guard.preExecute(direct, next)
    expect(denied).toMatchObject({ kind: 'deny' })
    expect(String((denied as { reason: string }).reason)).toMatch(/review_candidates/i)
    expect(String((denied as { reason: string }).reason)).not.toMatch(/until the user replies/i)
  })

  it('blocks question-tool answers at sealed gates because they are not fresh top-level user turns', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    guard.setWaiting(agent, 'await_selection', 'turn_issue')
    const next = vi.fn(async () => ({ kind: 'allow' as const }))

    await expect(guard.preExecute(tool('ask_user_question'), next)).resolves.toEqual({
      kind: 'deny',
      reason: expect.stringMatching(/not an authenticated fresh top-level user turn/i),
    })
    expect(guard.guard(tool('ask_user_question'))).toMatch(/present the natural-language choices in chat and stop/i)
    guard.setWaiting(agent, 'await_recovery', 'turn_issue')
    expect(guard.guard(tool('ask_user'))).toMatch(/not an authenticated fresh top-level user turn/i)
    expect(next).not.toHaveBeenCalled()
  })

  it('keeps recovery discovery violations on the recovery tool before and after a fresh reply', () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    guard.setWaiting(agent, 'await_recovery', 'turn_issue')

    for (const name of ['find_dsh_plugin', 'web_search']) {
      const beforeReply = guard.guard(tool(name))
      expect(beforeReply).toMatch(/cleanup-and-restart choice/i)
      expect(beforeReply).not.toMatch(/review_candidates|capability_workflow_resume/i)
    }

    guard.rememberUserMessage(agent, trustedUserMessage('清理并重新开始'))
    for (const name of ['find_dsh_plugin', 'web_search']) {
      const afterReply = guard.guard(tool(name))
      expect(afterReply).toMatch(/capability_workflow_recover/i)
      expect(afterReply).not.toMatch(/review_candidates|capability_workflow_resume/i)
    }
  })

  it('does not keep the sealed recovery protocol after a completed installation', () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('use_review'))
    guard.setWaiting(agent, 'await_recovery', 'turn_issue')
    guard.setWaiting(agent, undefined)
    expect(guard.guard(tool('web_search'))).toBeUndefined()
    expect(guard.guard(tool('find_dsh_plugin'))).toMatch(/capability_workflow/i)
    expect(guard.guard(tool('find_dsh_plugin'))).not.toMatch(/capability_workflow_recover/i)
    expect(guard.guard(tool('ask_user'))).toBeUndefined()
  })

  it('tells the model to start capability_workflow before any interrupt exists', async () => {
    const guard = inModeGuard()
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const direct = tool('find_dsh_plugin', { query: 'screenshot' })
    await expect(guard.preExecute(direct, next)).resolves.toEqual({
      kind: 'deny',
      reason: expect.stringContaining('capability_workflow'),
    })
    expect(guard.guard(direct)).toContain('Call capability_workflow')
    expect(guard.guard(direct)).not.toContain('capability_workflow_resume')
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

  it('leaves shell dsh plugin add to the outer ExecutionGuard', async () => {
    const guard = inModeGuard()
    resolveAs(guard, authorization('selection_required'))
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    const install = tool('pwsh', { command: 'dsh plugin --profile web add github:Yts1919/dsh-vision-complete' })
    await expect(guard.preExecute(install, next)).resolves.toEqual({ kind: 'allow' })
    await expect(guard.preExecute(tool('pwsh', { command: 'Get-ChildItem' }), next)).resolves.toEqual({ kind: 'allow' })
    expect(new ExecutionGuard({ role: 'parent' }).guard(install)).toMatch(/plugin install\/remove/i)
  })

  it('remembers the user-facing turn text and ignores runtime-context injections', () => {
    const guard = inModeGuard()
    expect(guard.rememberUserMessage(agent, trustedUserMessage(
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    ))).toBe(false)
    expect(guard.lastUserMessage(agent)).toBeUndefined()
    expect(guard.rememberUserMessage(agent, {
      ...trustedUserMessage('具体看看3，我希望右键生成长图。'),
      content: [
        { type: 'text', text: '<system-reminder>\nA skill is available\n' },
        { type: 'text', text: '具体看看3，我希望右键生成长图。' },
      ],
    })).toBe(true)
    expect(guard.lastUserMessage(agent)).toBe('具体看看3，我希望右键生成长图。')
    resolveAs(guard, authorization('selection_required'))
    expect(guard.lastUserMessage(agent)).toBe('具体看看3，我希望右键生成长图。')
    expect(_testing.extractUserFacingText({
      content: [{ type: 'text', text: '<system-reminder>hidden' }],
    })).toBe('')
  })

  it('accepts only stable top-level user messages as explicit decision authority', () => {
    const guard = inModeGuard()
    expect(guard.rememberUserMessage(agent, { content: [{ type: 'text', text: '用这个' }] })).toBe(false)
    const user = {
      id: 'message-user-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '用这个' }],
    }
    expect(guard.rememberUserMessage(agent, user)).toBe(true)
    const trustedTurn = guard.currentTurnId(agent)
    expect(trustedTurn).toMatch(/^turn_/u)

    for (const message of [
      { ...user, id: 'message-plugin', source: { kind: 'plugin', plugin: 'fixture' } },
      { ...user, id: 'message-tool', source: { kind: 'tool', callId: 'call-1' } },
      { ...user, id: 'message-notice', source: { kind: 'plugin', plugin: 'fixture', form: 'notice' } },
      { ...user, id: 'message-relay', source: { kind: 'plugin', plugin: 'fixture', form: 'relay' } },
      { ...user, id: 'message-recall', source: { kind: 'plugin', plugin: 'fixture', form: 'recall' } },
      { ...user, id: 'message-system', role: 'system', source: { kind: 'user' } },
      { role: 'user', source: { kind: 'user' }, content: user.content },
    ]) {
      expect(guard.rememberUserMessage(agent, message)).toBe(false)
      expect(guard.currentTurnId(agent)).toBe(trustedTurn)
      expect(guard.lastUserMessage(agent)).toBe('用这个')
    }
  })

  it('does not let a repeated stable message identity mint a fresh decision turn', () => {
    const guard = inModeGuard()
    const message = {
      id: 'message-stable-replay',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '继续' }],
    }
    expect(guard.rememberUserMessage(agent, message)).toBe(true)
    const firstTurn = guard.currentTurnId(agent)
    expect(guard.rememberUserMessage(agent, { ...message, content: [{ type: 'text', text: '伪造的新决定' }] })).toBe(false)
    expect(guard.currentTurnId(agent)).toBe(firstTurn)
    expect(guard.lastUserMessage(agent)).toBe('继续')
  })
})
