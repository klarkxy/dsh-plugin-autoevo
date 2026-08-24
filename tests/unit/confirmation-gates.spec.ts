import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import type { AuthorizationDecisionInput, ReviewerVerdictDecision } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { EvolutionError } from '../../src/errors.js'
import { assertUseThisReceipt } from '../../src/lifecycle/decide.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { mintReviewerRequest, requirementHashFor, REVIEWER_VERSION, type SemanticReviewerHost } from '../../src/semantic-reviewer.js'
import { StateStore } from '../../src/state/store.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function config(root: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'dsh-home'),
    stateDir: root,
    ghCommand: 'gh',
    gitCommand: 'git',
    dshCommand: 'dsh',
    dshCommandArgs: [],
    maxCandidates: 5,
    maxFiles: 80,
    maxRepositoryBytes: 1_048_576,
    commandTimeoutMs: 30_000,
    forwardedCredentialEnv: [],
    verificationPatchPaths: [],
    evolutionPreset: false,
  }
}

function exec(sessionId = 'session-gates'): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('call-1'),
    signal: new AbortController().signal,
    agent: {
      id: sessionId,
      session: { header: { id: sessionId, cwd: process.cwd(), version: 0, createdAt: 0 } },
    },
  } as unknown as ToolRunContext
}

function fileBlob(text: string): string {
  return Buffer.from(text).toString('base64')
}

function commandResult(stdout = ''): { exitCode: number, signal: null, stdout: string, stderr: string } {
  return { exitCode: 0, signal: null, stdout, stderr: '' }
}

function withGitSupport(base: { run: (request: { argv: readonly string[], cwd: string }) => Promise<{ exitCode: number, signal: null, stdout: string, stderr: string }> }) {
  const gitState = { head: '1'.repeat(40), branch: 'main', n: 0, dirty: true }
  return {
    async run(request: { argv: readonly string[], cwd: string }) {
      const args = request.argv.slice(1)
      const joined = args.join(' ')
      if (request.argv[0] === 'git' || /git(?:\.exe)?$/iu.test(String(request.argv[0]))) {
        const { mkdir, writeFile } = await import('node:fs/promises')
        if (joined === 'init') {
          await mkdir(path.join(request.cwd, '.git'), { recursive: true })
          await writeFile(path.join(request.cwd, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
          return commandResult()
        }
        if (joined.startsWith('checkout -B')) {
          gitState.branch = args[2]!
          return commandResult()
        }
        if (joined === 'status --porcelain') return commandResult(gitState.dirty ? '?? scaffold\n' : '')
        if (joined === 'rev-parse HEAD') return commandResult(`${gitState.head}\n`)
        if (joined === 'rev-parse --abbrev-ref HEAD') return commandResult(`${gitState.branch}\n`)
        if (joined.includes('rev-parse --show-toplevel')) return commandResult(`${request.cwd}\n`)
        if (joined.includes('rev-parse HEAD')) return commandResult(`${gitState.head}\n`)
        if (joined.includes('merge-base --is-ancestor')) return commandResult()
        if (joined.includes('status --porcelain=v1 --untracked-files=all')) return commandResult()
        if (joined === 'add -A') return commandResult()
        if (args.includes('commit')) {
          gitState.n += 1
          gitState.head = String((gitState.n % 9) + 1).repeat(40)
          gitState.dirty = false
          return commandResult()
        }
        return commandResult()
      }
      return base.run(request)
    },
  }
}

function remember(guard: CreationGuard, agent: ToolRunContext['agent'], text: string): void {
  guard.rememberUserMessage(agent, { content: [{ type: 'text', text }] })
}

async function resumeWith(
  service: CapabilityEvolutionService,
  guard: CreationGuard,
  turn: ToolRunContext,
  workflowId: string,
  interruptId: string,
  text: string,
  decision: AuthorizationDecisionInput,
) {
  remember(guard, turn.agent, text)
  return service.resume({ workflowId, interruptId, decision }, turn)
}

async function navigateWith(
  service: CapabilityEvolutionService,
  guard: CreationGuard,
  turn: ToolRunContext,
  workflowId: string,
  interruptId: string,
  kind: 'review_candidates' | 'review_existing' | 'search_more' | 'reuse_local' | 'stop',
  candidateIds: string[] = [],
  reviewMode: 'fixed' | 'adaptive' = 'fixed',
) {
  remember(guard, turn.agent, `请${kind}`)
  return service.resume({
    workflowId,
    interruptId,
    navigation: { kind, candidateIds, reviewMode },
  }, turn)
}

async function presentWith(
  service: CapabilityEvolutionService,
  turn: ToolRunContext,
  workflowId: string,
  candidateIds: string[],
) {
  return service.present({ workflowId, candidateIds }, turn)
}

function capableSandbox(_stateDir: string) {
  return {
    filesystem: {
      mode: 'workspace-write' as const,
      bindsManagedCwd: true,
      // Escape probes use cwd/../...; a capable provider must report them as not contained.
      assertContained: async (candidate: string) => !candidate.includes('..') && !candidate.includes('escape-probe'),
    },
    shell: {
      mode: 'workspace-write' as const,
      bindsManagedCwd: true,
      canWrite: async (candidate: string) => !candidate.includes('..') && !candidate.includes('escape-probe'),
    },
  }
}

function localCtx(stateDir: string): Context {
  const sandbox = capableSandbox(stateDir)
  const baseUrl = testProfileBase(stateDir)
  return {
    baseUrl,
    tools: {
      schemas: () => [{ name: 'pwsh', description: 'Run a PowerShell command' }],
      get: () => undefined,
      execute: async () => ({ isError: false, value: { results: [] }, content: [] }),
      register: () => undefined,
    },
    systemPrompt: {
      assemble: async () => ({ tools: [{ name: 'pwsh' }] }),
    },
    skills: {
      list: async () => [],
    },
    get: (name: string) => (name === 'sandbox' ? sandbox : undefined),
  } as unknown as Context
}

function marketplaceCtx(results: Array<{ name: string, url: string, description: string, stars?: number }>, stateDir: string): Context {
  const sandbox = capableSandbox(stateDir)
  const baseUrl = testProfileBase(stateDir)
  return {
    baseUrl,
    tools: {
      schemas: () => [],
      get: (name: string) => name === 'find_dsh_plugin' ? { name } : undefined,
      execute: async () => ({ isError: false, value: { results }, content: [] }),
      register: () => undefined,
    },
    systemPrompt: {
      assemble: async () => ({ tools: [] }),
    },
    skills: {
      list: async () => [],
    },
    get: (name: string) => (name === 'sandbox' ? sandbox : undefined),
  } as unknown as Context
}

function testProfileBase(stateDir: string): string {
  const baseUrl = path.join(stateDir, 'dsh-home', 'profiles', 'web')
  mkdirSync(baseUrl, { recursive: true })
  writeFileSync(path.join(baseUrl, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dependencies: {} }))
  return baseUrl
}

function ghRunner(files: Record<string, string>) {
  return {
    async run(request: { argv: readonly string[] }) {
      const joined = request.argv.join(' ')
      if (joined.includes('--version')) return commandResult('0.1.0-rc.6\n')
      if (joined.includes('/commits/')) {
        return commandResult(JSON.stringify({ sha: 'a'.repeat(40), commit: { committer: { date: new Date().toISOString() } } }))
      }
      if (joined.includes('/git/trees/')) {
        return commandResult(JSON.stringify({
          tree: Object.keys(files).map((filePath, index) => ({
            path: filePath,
            type: 'blob',
            sha: `${index}`.padStart(40, 'b'),
            size: files[filePath]!.length,
          })),
        }))
      }
      if (joined.includes('/git/blobs/')) {
        const sha = request.argv.at(-1)!.split('/').pop()!
        const index = Number(sha.replace(/^b+/u, '') || '0')
        const filePath = Object.keys(files)[index] ?? Object.keys(files)[0]!
        return commandResult(JSON.stringify({ encoding: 'base64', content: fileBlob(files[filePath]!) }))
      }
      if (/repos\/[^/]+\/[^/]+$/.test(joined)) {
        return commandResult(JSON.stringify({ default_branch: 'main' }))
      }
      return commandResult()
    },
  }
}

const grokBundle = {
  'package.json': JSON.stringify({
    name: 'dsh-xai',
    license: 'MIT',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
  }, null, 2),
  'cordis.patch.yml': '- id: xai\n  name: dsh-xai\n',
  'README.md': 'xAI Grok SuperGrok OAuth for DeepSeek Harness\n',
  'lib/index.js': 'export function apply() {}\n',
}

const grokHighRisk = {
  ...grokBundle,
  'lib/index.js': "export function apply() { eval('1') }\n",
}

function reviewerHost(decision: ReviewerVerdictDecision): SemanticReviewerHost {
  return {
    async run(input) {
      const request = mintReviewerRequest({
        workflowId: input.workflowId,
        review: input.review,
        snapshotDigest: input.snapshotDigest,
        candidateDigest: input.candidateDigest,
      })
      const completedAt = '2026-08-19T00:00:03.000Z'
      return {
        request: { ...request, status: 'completed', startedAt: request.createdAt, completedAt },
        verdict: {
          requestId: request.id,
          reviewId: input.review.id,
          requirementHash: requirementHashFor(input.review.requirement),
          snapshotDigest: input.snapshotDigest,
          candidateDigest: input.candidateDigest,
          reviewerSessionId: 'reviewer-session',
          reviewerVersion: REVIEWER_VERSION,
          decision,
          evidence: [],
          conditions: [],
          semanticCoverage: 'partial',
          createdAt: completedAt,
        },
      }
    },
  }
}

describe('conversational confirmation gates', () => {
  it('does not mint create authorization after empty completed discovery without create-new', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-empty-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([], root),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.resolution?.authorization?.state).toBe('selection_required')
    expect(started.workflow.cursor).toBe('await_confirmation')
    expect(started.workflow.interrupt?.kind).toBe('await_confirmation')
    expect(started.workflow.interrupt?.options.map((item) => item.id)).toEqual(expect.arrayContaining([
      'create_new',
      'stop',
    ]))
    const stopped = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '先停', { action: 'stop' })
    expect(stopped.resolution?.authorization?.state).toBe('stopped')
    await expect(guard.preExecute({
      callId: 'define-1',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })
  })

  it('does not mint create authorization from start itself', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-resolve-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([], root),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', exec())
    expect(started.resolution?.authorization?.state).toBe('selection_required')
    expect(started.resolution?.authorization?.state).not.toBe('create_authorized')
    expect(started.resolution?.selectedRepositories ?? []).toEqual([])
    expect(started.workflow.cursor).toBe('await_confirmation')
  })

  it('keeps discovery autonomous, then seals an agent-presented shortlist before user selection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-unselected-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }], root),
      config(root),
      ghRunner(grokBundle),
      new StateStore(root),
      guard,
    )
    service.listInstallProfiles = async () => ['web']
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.workflow.cursor).toBe('await_discovery')
    expect(started.workflow.interrupt).toBeUndefined()
    expect(started.workflow.discoveryPool).toHaveLength(1)
    expect(started.review).toBeUndefined()
    const candidateId = started.workflow.discoveryPool!.find((item) => item.repository === 'MirDie/dsh-xai')!.id
    const presented = await presentWith(service, turn, started.workflow.id, [candidateId])
    expect(presented.workflow.cursor).toBe('await_selection')
    expect(presented.workflow.candidateSnapshot?.map((item) => item.id)).toEqual([candidateId])
    expect(presented.workflow.interrupt?.options.map((item) => item.id)).toContain('review_candidates')
    expect(presented.workflow.interrupt?.options.map((item) => item.id)).not.toContain('use_this')
    expect(presented.workflow.interrupt?.options.find((item) => item.id === 'review_candidates')?.candidateIds)
      .toEqual([candidateId])
    const reviewed = await navigateWith(service, guard, turn, presented.workflow.id, presented.workflow.interrupt!.interruptId, 'review_candidates', [candidateId])
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.review?.sourceSnapshot.kind === 'github' && reviewed.review.sourceSnapshot.repository)
      .toBe('MirDie/dsh-xai')
    expect(reviewed.workflow.interrupt?.options.map((item) => item.id)).toContain('use_this')
  })

  it('rejects a Gate-1 use_this decision without consuming the interrupt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-direct-install-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }], root),
      config(root),
      ghRunner(grokBundle),
      new StateStore(root),
      guard,
    )
    service.listInstallProfiles = async () => ['web']
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    const candidateId = started.workflow.discoveryPool![0]!.id
    const presented = await presentWith(service, turn, started.workflow.id, [candidateId])

    const reviewed = await resumeWith(
      service,
      guard,
      turn,
      presented.workflow.id,
      presented.workflow.interrupt!.interruptId,
      '直接装这个',
      { action: 'use_this', candidateId },
    )

    expect(reviewed.status).toBe('invalid_resume')
    expect(reviewed.workflow.cursor).toBe('await_selection')
    expect(reviewed.workflow.interrupt?.interruptId).toBe(presented.workflow.interrupt!.interruptId)
    expect(reviewed.workflow.consumedInterruptIds ?? []).not.toContain(presented.workflow.interrupt!.interruptId)
    expect(reviewed.workflow.executionLease).toBeUndefined()
    expect(reviewed.installation).toBeUndefined()
  })

  it('seals the third discovery candidate for a natural-language third-choice review', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-look-at-3-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([
        {
          name: 'dsh-xai',
          url: 'https://github.com/MirDie/dsh-xai',
          description: 'xAI Grok SuperGrok / X Premium OAuth',
          stars: 3,
        },
        {
          name: 'dsh-grok-screenshot',
          url: 'https://github.com/paicat1/dsh-grok-screenshot',
          description: 'grok screenshot',
          stars: 1,
        },
        {
          name: 'dsh-grok-third',
          url: 'https://github.com/acme/dsh-grok-third',
          description: 'third grok candidate',
          stars: 1,
        },
      ], root),
      config(root),
      ghRunner(grokBundle),
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.workflow.cursor).toBe('await_discovery')
    const presentedIds = started.workflow.discoveryPool!.map((item) => item.id)
    const presented = await presentWith(service, turn, started.workflow.id, presentedIds)
    expect(presented.workflow.candidateSnapshot?.map((item) => item.index)).toEqual([1, 2, 3])
    const thirdCandidate = presented.workflow.candidateSnapshot![2]!
    const thirdId = thirdCandidate.id
    const reviewed = await navigateWith(service, guard, turn, presented.workflow.id, presented.workflow.interrupt!.interruptId, 'review_candidates', [thirdId])
    expect(reviewed.status).not.toBe('invalid_resume')
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.review?.sourceSnapshot.kind === 'github' && reviewed.review.sourceSnapshot.repository)
      .toBe(thirdCandidate.repository)
  })

  it('presents full+high at confirmation instead of auto-create, and stop stays stopped', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-high-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }], root),
      config(root),
      ghRunner(grokHighRisk),
      new StateStore(root),
      guard,
      undefined,
      reviewerHost('uncertain'),
    )
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.workflow.cursor).toBe('await_discovery')
    const candidateId = started.workflow.discoveryPool!.find((item) => item.repository === 'MirDie/dsh-xai')!.id
    const presented = await presentWith(service, turn, started.workflow.id, [candidateId])
    const reviewed = await navigateWith(service, guard, turn, presented.workflow.id, presented.workflow.interrupt!.interruptId, 'review_candidates', [candidateId])
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.review?.fit).toBe('full')
    expect(reviewed.review?.securityRisk).toBe('high')
    expect(reviewed.workflow.interrupt?.facts.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'dynamic_evaluation',
        severity: 'block',
        evidenceKind: 'static_review',
        observed: true,
      }),
    ]))
    expect(reviewed.workflow.interrupt?.facts.securityInterpretationRule).toMatch(/Never invent a justification/i)
    expect(reviewed.resolution?.authorization?.state).toBe('confirmation_required')
    expect(reviewed.workflow.interrupt?.options.map((item) => item.id)).not.toContain('use_this')
    expect(reviewed.workflow.interrupt?.options.map((item) => item.id)).toContain('modify_this')
    const stopped = await resumeWith(service, guard, turn, reviewed.workflow.id, reviewed.workflow.interrupt!.interruptId, '先停', { action: 'stop' })
    expect(stopped.resolution?.authorization?.state).toBe('stopped')
    await expect(guard.preExecute({
      callId: 'define-high',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'allow' })
  })

  it('exposes use_this for a high-risk review with an exact approved verdict and defaults retention to temporary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-approved-high-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const store = new StateStore(root)
    const service = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }], root),
      config(root),
      ghRunner(grokHighRisk),
      store,
      guard,
      undefined,
      reviewerHost('approved'),
    )
    service.listInstallProfiles = async () => ['web']
    const turn = exec('session-approved-high')
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.workflow.cursor).toBe('await_discovery')
    const candidateId = started.workflow.discoveryPool!.find((item) => item.repository === 'MirDie/dsh-xai')!.id
    const presented = await presentWith(service, turn, started.workflow.id, [candidateId])
    const reviewed = await navigateWith(service, guard, turn, presented.workflow.id, presented.workflow.interrupt!.interruptId, 'review_candidates', [candidateId])
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.review?.securityRisk).toBe('high')
    expect(reviewed.review?.reviewerVerdict?.decision).toBeUndefined()
    expect(reviewed.workflow.executionLease).toBeUndefined()
    const optionIds = reviewed.workflow.interrupt?.options.map((item) => item.id) ?? []
    expect(optionIds[0]).not.toBe('use_this')
    expect(optionIds.indexOf('search_more')).toBeLessThan(optionIds.indexOf('modify_this'))
    expect(optionIds).toContain('stop')
    expect(reviewed.workflow.interrupt?.kind).toBe('await_confirmation')

    const blocked = await resumeWith(service, guard, turn, reviewed.workflow.id, reviewed.workflow.interrupt!.interruptId, '用这个', {
      action: 'use_this',
      candidateId,
    })
    expect(blocked.status).toBe('invalid_resume')
  })

  it('records create-authorized only after an explicit create-new chat reply and still denies cordis_define', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-create-'))
    temporary.push(root)
    const turn = exec()
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const store = new StateStore(root)
    const service = new CapabilityEvolutionService(
      marketplaceCtx([], root),
      config(root),
      withGitSupport({ run: async () => commandResult('0.1.0-rc.6\n') }),
      store,
      guard,
    )
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    const rejected = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '这个仓库看起来不错', {
      action: 'use_this',
      candidateId: `candidate_${'f'.repeat(24)}`,
    })
    expect(rejected.status).toBe('invalid_resume')
    expect(rejected.resumeHint).toMatch(/not available/i)
    expect(rejected.workflow.cursor).toBe(started.workflow.cursor)
    await expect(resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '没有合适的，新建一个', { action: 'create_new' }))
      .rejects.toThrow(/Agent|managed modify\/create|without changing|construction tools|construction runtime/i)
    expect((await store.getResolution(started.resolution!.id)).authorization?.state).toBe('create_authorized')
    await expect(guard.preExecute({
      callId: 'define-ok',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('reuses a strict local hit without an authorization receipt, and binds use-this to the reviewed identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-use-'))
    temporary.push(root)
    const localTurn = exec('session-local')
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const localStore = new StateStore(root)
    const localService = new CapabilityEvolutionService(
      localCtx(root),
      config(root),
      withGitSupport({ run: async () => commandResult('0.1.0-rc.6\n') }),
      localStore,
      guard,
    )
    const created = await localService.start('run a PowerShell command', localTurn)
    expect(created.resolution?.localCandidates.some((item) => item.name === 'pwsh')).toBe(true)
    expect(created.resolution?.authorization?.state).toBe('selection_required')
    expect(created.workflow.cursor).toBe('await_discovery')
    const localCandidateId = created.workflow.discoveryPool!.find((item) => item.localName === 'pwsh')!.id
    const localPresented = await presentWith(localService, localTurn, created.workflow.id, [localCandidateId])
    const reused = await navigateWith(localService, guard, localTurn, localPresented.workflow.id, localPresented.workflow.interrupt!.interruptId, 'reuse_local', [localCandidateId])
    expect(reused.resolution?.authorization?.state).toBe('reuse_local')
    expect((await localStore.getResolution(created.resolution!.id)).decisions ?? []).toEqual([])
    expect(reused.workflow.selectionReceipt).toMatchObject({
      kind: 'reuse_local',
      candidateIds: [localCandidateId],
    })
    expect(reused.workflow.actionCommitment).toMatchObject({
      candidateId: localCandidateId,
      candidateDigest: reused.workflow.selectionReceipt?.candidateDigests[localCandidateId],
      requestedAction: 'reuse_local',
      endpoint: { kind: 'exact_tool', name: 'pwsh' },
    })
    expect(reused.workflow.executionLease).toMatchObject({
      candidateId: localCandidateId,
      candidateDigest: reused.workflow.actionCommitment?.candidateDigest,
      endpoint: { kind: 'exact_tool', name: 'pwsh' },
    })

    const useGuard = new CreationGuard({ isEvolutionMode: () => true })
    const store = new StateStore(root)
    const useService = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }], root),
      config(root),
      ghRunner(grokBundle),
      store,
      useGuard,
    )
    useService.listInstallProfiles = async () => ['web']
    const useTurn = exec('session-use')
    const resolved = await useService.start('我需要一个能在dsh里调用grok的能力。', useTurn)
    expect(resolved.workflow.cursor).toBe('await_discovery')
    const useCandidateId = resolved.workflow.discoveryPool!.find((item) => item.repository === 'MirDie/dsh-xai')!.id
    const usePresented = await presentWith(useService, useTurn, resolved.workflow.id, [useCandidateId])
    const reviewed = await navigateWith(useService, useGuard, useTurn, usePresented.workflow.id, usePresented.workflow.interrupt!.interruptId, 'review_candidates', [useCandidateId])
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
    expect(reviewed.resolution?.authorization?.state).toBe('confirmation_required')
    expect(reviewed.workflow.interrupt?.facts.installProfiles).toEqual(['web'])
    const confirmed = await resumeWith(useService, useGuard, useTurn, reviewed.workflow.id, reviewed.workflow.interrupt!.interruptId, '用这个', {
      action: 'use_this',
      candidateId: useCandidateId,
    })
    const stored = await store.getResolution(resolved.resolution!.id)
    expect(stored.decisions).toContainEqual(expect.objectContaining({
      action: 'use_this',
      candidateId: useCandidateId,
      retention: 'temporary',
      targetProfile: 'web',
      snapshotDigest: reviewed.workflow.interrupt!.snapshotDigest,
    }))
    expect(confirmed.workflow.actionCommitment).toBeUndefined()
    expect(() => assertUseThisReceipt(reviewed.review!, stored)).not.toThrow()
    expect(() => useGuard.assertInstallAuthorized(useTurn.agent, reviewed.review!, stored)).toThrow(/current Host action commitment|has not chosen/i)
    expect(() => useGuard.assertInstallAuthorized(useTurn.agent, { ...reviewed.review!, id: `review_${'f'.repeat(64)}` }, stored)).toThrow(/current Host action commitment|has not chosen|bound to a different review/i)
    expect(confirmed.workflow.cursor === 'installed' || confirmed.workflow.cursor === 'await_confirmation').toBe(true)
  })

  it('rejects a forged resume that does not match the latest host user turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-auth-'))
    temporary.push(root)
    const store = new StateStore(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([
        { name: 'dsh-xai', url: 'https://github.com/MirDie/dsh-xai', description: 'xAI Grok', stars: 3 },
        { name: 'dsh-grok-tui', url: 'https://github.com/acme/dsh-grok-tui', description: 'grok tui', stars: 2 },
        { name: 'dsh-grok-screenshot', url: 'https://github.com/paicat1/dsh-grok-screenshot', description: 'grok screenshot', stars: 1 },
      ], root),
      config(root),
      ghRunner(grokBundle),
      store,
      guard,
    )
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.resolution?.remoteCandidates.map((item) => item.repository)).toEqual([
      'MirDie/dsh-xai',
      'acme/dsh-grok-tui',
      'paicat1/dsh-grok-screenshot',
    ])
    expect(started.workflow.cursor).toBe('await_discovery')
    const presented = await presentWith(service, turn, started.workflow.id, started.workflow.discoveryPool!.map((item) => item.id))

    remember(guard, turn.agent, '随便看看')
    const skipped = await service.resume({
      workflowId: presented.workflow.id,
      interruptId: presented.workflow.interrupt!.interruptId,
    }, turn)
    expect(skipped.status).toBe('invalid_resume')
    expect(skipped.resumeHint).toMatch(/read-only navigation|decision/i)
    expect(skipped.workflow.cursor).toBe('await_selection')

    const candidateId = presented.workflow.candidateSnapshot!.find((item) => item.repository === 'paicat1/dsh-grok-screenshot')!.id
    const reviewed = await navigateWith(service, guard, turn, presented.workflow.id, presented.workflow.interrupt!.interruptId, 'review_candidates', [candidateId])
    expect(reviewed.workflow.selectionReceipt?.kind).toBe('review_candidates')
    expect(reviewed.workflow.actionCommitment?.endpoint).toEqual({ kind: 'none' })
    expect(reviewed.workflow.executionLease).toBeUndefined()
    expect(reviewed.review?.sourceSnapshot.kind === 'github' && reviewed.review.sourceSnapshot.repository)
      .toBe('paicat1/dsh-grok-screenshot')
    const stored = await store.getResolution(started.resolution!.id)
    expect(stored.selectedRepositories).toEqual(['paicat1/dsh-grok-screenshot'])
    expect(stored.decisions ?? []).toEqual([])
  })

  it('reviews multiple snapshot candidates in one navigation and mints a SelectionReceipt without a DecisionReceipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-batch-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const store = new StateStore(root)
    const service = new CapabilityEvolutionService(
      marketplaceCtx([
        { name: 'dsh-xai', url: 'https://github.com/MirDie/dsh-xai', description: 'xAI Grok', stars: 3 },
        { name: 'dsh-grok-alt', url: 'https://github.com/acme/dsh-grok-alt', description: 'Alternative Grok integration', stars: 2 },
      ], root),
      config(root),
      ghRunner(grokBundle),
      store,
      guard,
    )
    service.listInstallProfiles = async () => ['web']
    const turn = exec('session-batch')
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.workflow.cursor).toBe('await_discovery')
    const presented = await presentWith(service, turn, started.workflow.id, started.workflow.discoveryPool!.map((item) => item.id))
    const ids = presented.workflow.candidateSnapshot!.map((item) => item.id)
    const reviewed = await navigateWith(
      service,
      guard,
      turn,
      presented.workflow.id,
      presented.workflow.interrupt!.interruptId,
      'review_candidates',
      ids,
      'fixed',
    )
    expect(reviewed.reviews).toHaveLength(2)
    expect(reviewed.workflow.reviewedCandidateIds).toEqual(expect.arrayContaining(ids))
    expect((await store.getResolution(started.resolution!.id)).decisions ?? []).toEqual([])
    expect(reviewed.workflow.selectionReceipt).toMatchObject({ kind: 'review_candidates', candidateIds: ids })
    expect(reviewed.workflow.actionCommitment?.endpoint).toEqual({ kind: 'none' })
    expect(reviewed.workflow.executionLease).toBeUndefined()

    const selectedCandidateId = ids[1]!
    const selectedReviewId = reviewed.workflow.reviewIdsByCandidate![selectedCandidateId]!
    let installedReviewId: string | undefined
    service.installReviewed = async (review) => {
      installedReviewId = review.id
      throw new EvolutionError('command_failed', 'focused test stop')
    }
    remember(guard, turn.agent, '用第 2 个')
    const selected = await service.resume({
      workflowId: reviewed.workflow.id,
      interruptId: reviewed.workflow.interrupt!.interruptId,
      decision: { action: 'use_this', candidateId: selectedCandidateId },
    }, turn)
    expect(installedReviewId).toBe(selectedReviewId)
    expect(selected.workflow.lastReviewId).toBe(selectedReviewId)
    expect((await store.getResolution(started.resolution!.id)).decisions).toContainEqual(expect.objectContaining({
      action: 'use_this',
      candidateId: selectedCandidateId,
      reviewId: selectedReviewId,
    }))
  })

  it('supports compare-another navigation from confirmation while preserving prior reviews', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-adaptive-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const store = new StateStore(root)
    const service = new CapabilityEvolutionService(
      marketplaceCtx([
        { name: 'dsh-xai', url: 'https://github.com/MirDie/dsh-xai', description: 'xAI Grok', stars: 3 },
        { name: 'dsh-grok-alt', url: 'https://github.com/acme/dsh-grok-alt', description: 'Alternative Grok integration', stars: 2 },
        { name: 'dsh-grok-third', url: 'https://github.com/acme/dsh-grok-third', description: 'Third Grok integration', stars: 1 },
      ], root),
      config(root),
      ghRunner(grokHighRisk),
      store,
      guard,
      undefined,
      reviewerHost('uncertain'),
    )
    const turn = exec('session-adaptive')
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.workflow.cursor).toBe('await_discovery')
    const presented = await presentWith(service, turn, started.workflow.id, started.workflow.discoveryPool!.map((item) => item.id))
    const ids = presented.workflow.candidateSnapshot!.map((item) => item.id)
    const first = await navigateWith(service, guard, turn, presented.workflow.id, presented.workflow.interrupt!.interruptId, 'review_candidates', [ids[0]!])
    const compared = await navigateWith(service, guard, turn, first.workflow.id, first.workflow.interrupt!.interruptId, 'review_candidates', ids.slice(1), 'adaptive')
    expect(compared.reviews).toHaveLength(3)
    expect(compared.workflow.reviewedCandidateIds).toEqual(expect.arrayContaining(ids))
    expect((await store.getResolution(started.resolution!.id)).decisions ?? []).toEqual([])

    const selectedCandidateId = ids[1]!
    const selectedReviewId = compared.workflow.reviewIdsByCandidate![selectedCandidateId]!
    remember(guard, turn.agent, '在 2 上改')
    const modified = await service.resume({
      workflowId: compared.workflow.id,
      interruptId: compared.workflow.interrupt!.interruptId,
      decision: { action: 'modify_this', candidateId: selectedCandidateId },
    }, turn)
    expect(modified.workflow.lastReviewId).toBe(selectedReviewId)
    expect(modified.review?.id).toBe(selectedReviewId)
    const selectedWorkflow = await store.getWorkflow(compared.workflow.id)
    expect(selectedWorkflow.lastReviewId).toBe(selectedReviewId)
    expect(selectedWorkflow.lineageTipReviewId).toBe(selectedReviewId)
    expect((await store.getResolution(started.resolution!.id)).decisions).toContainEqual(expect.objectContaining({
      action: 'modify_this',
      candidateId: selectedCandidateId,
      reviewId: selectedReviewId,
    }))
  })
})
