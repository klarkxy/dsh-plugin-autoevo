import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { POLICY_VERSION, type MechanicalFacts, type ReviewRecord } from '../../src/contracts.js'
import {
  DshSemanticReviewerHost,
  REVIEWER_SUBMIT_TOOL,
  REVIEWER_VERSION,
  ReviewerSubmissionGate,
  mintReviewerRequest,
  parseReviewerSubmitArgs,
  requirementHashFor,
  reviewerDenyReason,
  reviewerInstruction,
  validateReviewerRunInput,
  type BoundedReviewFile,
  type ReviewerHostBinding,
  type ReviewerRunInput,
} from '../../src/semantic-reviewer.js'

const SNAPSHOT = '1'.repeat(64)
const CANDIDATE = '2'.repeat(64)
const FILE_HASH = '3'.repeat(64)
const FILE_TEXT = 'hello world\n'

function mechanicalFacts(overrides: Partial<MechanicalFacts> = {}): MechanicalFacts {
  return {
    fit: 'full',
    missingCapabilities: [],
    staticRisk: 'low',
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    manifest: {
      kind: 'bundle',
      packageName: '@acme/calculator',
      materializable: true,
      installSpec: `github:acme/calculator#${'a'.repeat(40)}`,
    },
    truncated: false,
    findings: [],
    evidenceHashes: [],
    semanticContextRequired: false,
    ...overrides,
  }
}

function reviewFixture(): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/calculator',
      requestedRef: 'main',
      commit: 'a'.repeat(40),
      defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'README.md', sha256: FILE_HASH, bytes: FILE_TEXT.length }],
    manifest: {
      kind: 'bundle',
      packageName: '@acme/calculator',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: ['calculator'],
    },
    fit: 'full',
    confidence: 0.8,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'ok', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: [],
    findings: [],
    recommendation: 'use',
    installSpec: `github:acme/calculator#${'a'.repeat(40)}`,
    mechanicalFacts: mechanicalFacts(),
  }
}

function files(): BoundedReviewFile[] {
  return [{ path: 'README.md', sha256: FILE_HASH, bytes: FILE_TEXT.length, text: FILE_TEXT }]
}

function binding(review = reviewFixture()): ReviewerHostBinding {
  return {
    workflowId: `workflow_${'c'.repeat(24)}`,
    review,
    snapshotDigest: SNAPSHOT,
    candidateDigest: CANDIDATE,
    requirementHash: requirementHashFor(review.requirement),
  }
}

function openGate(review = reviewFixture()): ReviewerSubmissionGate {
  const current = binding(review)
  const gate = new ReviewerSubmissionGate(current, mintReviewerRequest({
    workflowId: current.workflowId,
    review,
    snapshotDigest: SNAPSHOT,
    candidateDigest: CANDIDATE,
    createdAt: '2026-08-19T00:00:00.000Z',
  }))
  gate.markRunning('2026-08-19T00:00:01.000Z')
  return gate
}

function runInput(parent: Agent, overrides: Partial<ReviewerRunInput> = {}): ReviewerRunInput {
  const review = reviewFixture()
  return {
    parent,
    workflowId: `workflow_${'c'.repeat(24)}`,
    review,
    candidateDigest: CANDIDATE,
    snapshotDigest: SNAPSHOT,
    files: files(),
    timeoutMs: 5_000,
    ...overrides,
  }
}

describe('semantic reviewer submission gate', () => {
  it('locks the first exact submit and fills Host identity fields', () => {
    const gate = openGate()
    const review = reviewFixture()
    const verdict = gate.submit({
      verdict: 'approved',
      evidence: ['lexical facts match the requirement'],
      conditions: ['keep read-only'],
      semantic_coverage: ['full'],
    }, 'reviewer-session')
    expect(verdict).toMatchObject({
      requestId: gate.request.id,
      reviewId: review.id,
      requirementHash: requirementHashFor('calculator'),
      snapshotDigest: SNAPSHOT,
      candidateDigest: CANDIDATE,
      reviewerSessionId: 'reviewer-session',
      reviewerVersion: REVIEWER_VERSION,
      decision: 'approved',
      evidence: ['lexical facts match the requirement'],
      conditions: ['keep read-only'],
      semanticCoverage: 'full',
    })
    expect(gate.request.status).toBe('completed')
    expect(verdict).not.toHaveProperty('authorization')
    expect(verdict).not.toHaveProperty('lease')
    expect(verdict).not.toHaveProperty('installSpec')
    expect(verdict).not.toHaveProperty('endpoint')
  })

  it('rejects forged Host fields and a second submit', () => {
    const gate = openGate()
    expect(() => parseReviewerSubmitArgs({
      verdict: 'approved',
      evidence: [],
      conditions: [],
      semantic_coverage: ['full'],
      requestId: 'forged',
    })).toThrow(/does not accept Host-owned or authorization fields/i)
    expect(() => parseReviewerSubmitArgs({
      verdict: 'approved',
      evidence: [],
      conditions: [],
      semantic_coverage: ['full'],
      authorization: { state: 'use_review' },
    })).toThrow(/does not accept Host-owned or authorization fields/i)
    expect(() => parseReviewerSubmitArgs({
      verdict: 'approved',
      evidence: [],
      conditions: [],
      semantic_coverage: ['full'],
      installSpec: 'github:acme/calculator',
    })).toThrow(/does not accept Host-owned or authorization fields/i)
    gate.submit({
      verdict: 'rejected',
      evidence: ['missing capability'],
      conditions: [],
      semantic_coverage: ['partial'],
    }, 'reviewer-session')
    expect(() => gate.submit({
      verdict: 'approved',
      evidence: ['retry'],
      conditions: [],
      semantic_coverage: ['full'],
    }, 'reviewer-session')).toThrow(/already locked/i)
  })

  it('rejects wrong digest and file hash or bytes before a session starts', () => {
    const parent = { ctx: { get: () => undefined } } as unknown as Agent
    const review = reviewFixture()
    expect(() => validateReviewerRunInput(runInput(parent, { snapshotDigest: 'not-a-digest' }))).toThrow(/64-character hex digests/i)
    expect(() => validateReviewerRunInput(runInput(parent, {
      files: [{ path: 'README.md', sha256: '9'.repeat(64), bytes: FILE_TEXT.length, text: FILE_TEXT }],
    }))).toThrow(/path\/sha256\/bytes/i)
    expect(() => validateReviewerRunInput(runInput(parent, {
      files: [{ path: 'README.md', sha256: FILE_HASH, bytes: 1, text: FILE_TEXT }],
    }))).toThrow(/path\/sha256\/bytes/i)
    const { mechanicalFacts: _omittedMechanicalFacts, ...reviewWithoutMechanicalFacts } = review
    expect(() => validateReviewerRunInput(runInput(parent, {
      review: reviewWithoutMechanicalFacts,
    }))).toThrow(/mechanicalFacts/i)
  })

  it.each<{
    scenario: string
    close: (gate: ReviewerSubmissionGate) => { decision: string }
    status?: string
    lateSubmitError?: RegExp
  }>([
    {
      scenario: 'timeout',
      close: (gate) => gate.closeTimedOut('reviewer-session'),
      status: 'timed_out',
      lateSubmitError: /no longer accepting submissions/i,
    },
    {
      scenario: 'cancel',
      close: (gate) => gate.closeCancelled('reviewer-session'),
      status: 'cancelled',
    },
    {
      scenario: 'missing submit',
      close: (gate) => gate.closeMissingSubmit('reviewer-session'),
      status: 'completed',
    },
    {
      scenario: 'dispose',
      close: (gate) => {
        gate.dispose()
        return { decision: 'disposed' }
      },
      lateSubmitError: /handle was disposed/i,
    },
  ])('returns uncertain after $scenario and rejects a late submit', ({ close, status, lateSubmitError }) => {
    const gate = openGate()
    const verdict = close(gate)
    if (status !== undefined) {
      expect(verdict.decision).toBe('uncertain')
      expect(gate.request.status).toBe(status)
    }
    if (lateSubmitError !== undefined) {
      expect(() => gate.submit({
        verdict: 'approved',
        evidence: ['late'],
        conditions: [],
        semantic_coverage: ['full'],
      }, 'reviewer-session')).toThrow(lateSubmitError)
    }
  })
})

describe('semantic reviewer instruction and tool boundary', () => {
  it('marks repository text as untrusted data and forbids authorization in a read-only session', () => {
    const review = reviewFixture()
    const text = reviewerInstruction({
      requirement: review.requirement,
      mechanicalFacts: review.mechanicalFacts!,
      manifest: review.manifest,
      files: files(),
    })
    expect(text).toMatch(/untrusted data/i)
    expect(text).toMatch(/read-only/i)
    expect(text).toMatch(/not authorization|Do not authorize/i)
    expect(text).toContain('===== BEGIN UNTRUSTED REPOSITORY DATA =====')
    expect(text).toContain(FILE_TEXT)
    expect(text).toContain(REVIEWER_SUBMIT_TOOL)
    expect(reviewerDenyReason(REVIEWER_SUBMIT_TOOL)).toBeUndefined()
    expect(reviewerDenyReason('read')).toMatch(/only "autoevo_submit_review"|only autoevo_submit_review/i)
    expect(reviewerDenyReason('capability_workflow')).toMatch(/AutoEvo decision tools/i)
    expect(reviewerDenyReason('write')).toMatch(/denies/i)
    expect(reviewerDenyReason('pwsh')).toMatch(/denies/i)
    expect(reviewerDenyReason('web_search')).toMatch(/denies/i)
    expect(reviewerDenyReason('subagent')).toMatch(/denies/i)
  })
})

function parentAgent(cwd: string, ctx: Context): Agent {
  return {
    id: 'parent-session',
    options: { provider: 'test', model: 'test-model' },
    session: { header: { id: 'parent-session', cwd, version: 0, createdAt: 0, delegationDepth: 0 } },
    ctx,
  } as unknown as Agent
}

function reviewerRuntime(cwd: string, lifecycle: {
  whenIdle?: (submit: (args: Record<string, unknown>) => Promise<unknown>) => Promise<void>
} = {}) {
  const disposed = vi.fn(async () => undefined)
  const followups: UserMessage[] = []
  const modes: string[] = []
  let createOptions: CreateAgentOptions | undefined
  let submit: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
  const agents = {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      createOptions = options
      const session = {
        id: options.sessionId,
        header: {
          id: options.sessionId,
          cwd: options.meta?.cwd,
          parentSession: options.meta?.parentSession,
          origin: options.meta?.origin,
          delegationDepth: options.meta?.delegationDepth,
          version: 0,
          createdAt: 0,
        },
        append(_type: string, data: { mode: string }) { modes.push(data.mode) },
        deriveMessages: () => [],
      } as unknown as Session
      const child = {
        id: options.sessionId,
        options: options.agentOptions ?? {},
        session,
        followup(message: UserMessage) { followups.push(message) },
        async whenIdle() {
          await lifecycle.whenIdle?.(async (args) => {
            if (!submit) throw new Error('submit tool was not registered')
            return submit(args)
          })
        },
      } as unknown as Agent
      await options.setup?.({
        agent: child,
        on: () => undefined,
        tools: {
          register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) {
            if (tool.name === REVIEWER_SUBMIT_TOOL) submit = tool.execute
          },
          guard: () => undefined,
        },
        systemPrompt: { section: () => undefined },
      } as unknown as Context)
      return { agent: child, dispose: disposed }
    },
    isOwnedBy: () => true,
  } as unknown as AgentRegistry
  const ctx = {
    get(name: string) { return name === 'agents' ? agents : undefined },
  } as unknown as Context
  return { ctx, disposed, followups, modes, get createOptions() { return createOptions } }
}

describe('DshSemanticReviewerHost lifecycle', () => {
  it('creates a read-only owned reviewer, accepts one submit, and always disposes', async () => {
    const cwd = 'C:/workspace/app'
    const live = reviewerRuntime(cwd, {
      async whenIdle(submit) {
        await submit({
          verdict: 'uncertain',
          evidence: ['static facts are incomplete'],
          conditions: [],
          semantic_coverage: ['partial'],
        })
      },
    })
    const host = new DshSemanticReviewerHost(live.ctx)
    const result = await host.run(runInput(parentAgent(cwd, live.ctx)))
    expect(live.createOptions?.meta).toMatchObject({
      cwd: expect.stringContaining('workspace'),
      parentSession: 'parent-session',
      origin: 'subagent',
      delegationDepth: 1,
    })
    expect(live.modes).toEqual(['read-only'])
    expect(result.request.status).toBe('completed')
    expect(result.verdict.decision).toBe('uncertain')
    expect(result.verdict.reviewerVersion).toBe(REVIEWER_VERSION)
    expect(result.verdict).not.toHaveProperty('authorization')
    expect(result.verdict).not.toHaveProperty('installSpec')
    expect(result.verdict).not.toHaveProperty('endpoint')
    expect(result.verdict).not.toHaveProperty('lease')
    const instruction = live.followups[0]?.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? ''
    expect(instruction).toMatch(/untrusted data/i)
    expect(live.disposed).toHaveBeenCalledTimes(1)
  })
})
