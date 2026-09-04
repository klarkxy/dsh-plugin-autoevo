import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type {
  ActionCommitment,
  DecisionReceipt,
  ReviewRecord,
  SelectionReceipt,
} from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { POLICY_VERSION } from '../../src/contracts.js'
import { PluginInstaller } from '../../src/lifecycle/install.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { StateStore } from '../../src/state/store.js'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trustedUserMessage } from '../helpers/trusted-user-message.js'
import {
  frozenManifestDigest,
  isDirectlyUsableReview,
  reviewCandidateDigest,
  reviewSnapshotDigest,
} from '../../src/review/direct-use.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const COMMIT = 'c'.repeat(40)
const CANDIDATE_DIGEST = 'f'.repeat(64)

function agent(sessionId = 'session-install'): Agent {
  return {
    id: sessionId,
    session: { header: { id: sessionId, cwd: 'C:/workspace', version: 0, createdAt: 0 } },
  } as unknown as Agent
}

function githubReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(64)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/one',
      requestedRef: 'main',
      commit: COMMIT,
      defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'package.json', sha256: 'e'.repeat(64), bytes: 8 }],
    manifest: {
      kind: 'bundle',
      packageName: 'dsh-one',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: ['calculator'],
    },
    fit: 'partial',
    confidence: 0.6,
    securityRisk: 'high',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'unknown', reason: 'no runtime', runtimeVersion: null },
    missingCapabilities: ['scientific notation'],
    findings: [
      { code: 'prompt_injection', severity: 'block', source: 'README.md', detail: 'instruction text' },
      { code: 'process_execution', severity: 'block', source: 'src/run.ts', detail: 'spawn' },
    ],
    recommendation: 'modify',
    installSpec: 'file:C:/workspace/review-artifacts/commitment/package/dsh-one.tgz',
    artifact: { sha256: 'f'.repeat(64), bytes: 8, entryCount: 1, ownedRoot: 'C:/workspace/review-artifacts/commitment' },
    ...overrides,
  }
}

function workflowFor(review: ReviewRecord): WorkflowRecord {
  const candidateId = `candidate_${'e'.repeat(24)}`
  return {
    schemaVersion: 2,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    requirement: review.requirement,
    status: 'running',
    cursor: 'install_verify',
    generation: 2,
    candidateSnapshot: [{
      id: candidateId,
      index: 1,
      kind: 'remote',
      name: 'one',
      identity: 'acme/one',
      repository: 'acme/one',
      digest: CANDIDATE_DIGEST,
    }],
    reviewedCandidateIds: [candidateId],
    reviewIdsByCandidate: { [candidateId]: review.id },
    lastReviewId: review.id,
    pendingInstall: { targetProfile: 'web', retention: 'temporary' },
  }
}

function receiptFor(
  guard: CreationGuard,
  session: Agent,
  workflow: WorkflowRecord,
): SelectionReceipt {
  const turnId = guard.currentTurnId(session)!
  const candidateId = workflow.candidateSnapshot![0]!.id
  return {
    id: `selection_${'1'.repeat(24)}`,
    workflowId: workflow.id,
    interruptId: `interrupt_${'2'.repeat(24)}`,
    snapshotDigest: '3'.repeat(64),
    kind: 'use_this',
    candidateIds: [candidateId],
    candidateDigests: { [candidateId]: CANDIDATE_DIGEST },
    hostTurnId: turnId,
    ownerSessionId: 'session-install',
    bootId: guard.bootId,
    createdAt: '2026-08-19T00:00:04.000Z',
  }
}

function commitmentFor(
  receipt: SelectionReceipt,
  review: ReviewRecord,
  workflow: WorkflowRecord,
): ActionCommitment {
  const candidateId = workflow.candidateSnapshot![0]!.id
  return {
    id: `commitment_${'4'.repeat(24)}`,
    selectionReceiptId: receipt.id,
    snapshotDigest: receipt.snapshotDigest,
    candidateId,
    candidateDigest: reviewCandidateDigest(review, workflow),
    requestedAction: 'use_this',
    retention: 'temporary',
    endpoint: { kind: 'none' },
    allowedParameterConstraints: {},
    createdAt: '2026-08-19T00:00:04.000Z',
    reviewId: review.id,
    reviewSnapshotDigest: reviewSnapshotDigest(review),
    frozenManifestDigest: frozenManifestDigest(review),
    targetProfile: 'web',
    ...(review.installSpec !== undefined ? { frozenInstallSpec: review.installSpec } : {}),
  }
}

function decisionReceipt(review: ReviewRecord): DecisionReceipt {
  return {
    id: `decision_${'5'.repeat(24)}`,
    phase: 'gate2',
    action: 'use_this',
    selectedRepositories: ['acme/one'],
    reviewId: review.id,
    reviewIdentity: review.sourceSnapshot.kind === 'github' ? review.sourceSnapshot.commit : 'x',
    optionId: 'use_this',
    createdAt: '2026-08-19T00:00:04.000Z',
  }
}

describe('final use_this Host commitment', () => {
  it('authorizes install for a partial/unknown/high-risk/prompt-regex review with a current commitment', () => {
    const session = agent()
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_install' })
    guard.rememberUserMessage(session, trustedUserMessage('用这个'))
    const bound = githubReview()
    const workflow = workflowFor(bound)
    expect(isDirectlyUsableReview(bound, workflow)).toBe(true)
    const receipt = receiptFor(guard, session, workflow)
    const commitment = commitmentFor(receipt, bound, workflow)
    guard.grantHostSelection(session, receipt, commitment)
    expect(() => guard.assertInstallAuthorized(session, bound, {
      id: bound.resolutionId,
      decisions: [decisionReceipt(bound)],
    }, { workflow, commitment, receipt, retention: 'temporary' })).not.toThrow()
  })

  it('rejects candidate, review, manifest, installSpec, retention, session, boot, and turn swaps', () => {
    const session = agent()
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_install' })
    guard.rememberUserMessage(session, trustedUserMessage('用这个'))
    const bound = githubReview()
    const workflow = workflowFor(bound)
    const receipt = receiptFor(guard, session, workflow)
    const commitment = commitmentFor(receipt, bound, workflow)
    guard.grantHostSelection(session, receipt, commitment)
    const resolution = { id: bound.resolutionId, decisions: [decisionReceipt(bound)] }
    const binding = { workflow, commitment, receipt, retention: 'temporary' as const }

    expect(() => guard.assertInstallAuthorized(session, { ...bound, id: `review_${'f'.repeat(64)}` }, resolution, binding))
      .toThrow(/different review/i)
    expect(() => guard.assertInstallAuthorized(session, {
      ...bound,
      manifest: { ...bound.manifest, packageVersion: '9.9.9' },
    }, resolution, binding)).toThrow(/snapshot digest is stale|manifest or installSpec/i)
    expect(() => guard.assertInstallAuthorized(session, {
      ...bound,
      installSpec: `github:acme/one#${'d'.repeat(40)}`,
    }, resolution, binding)).toThrow(/manifest or installSpec/i)
    expect(() => guard.assertInstallAuthorized(session, bound, resolution, {
      ...binding,
      retention: 'persistent',
    })).toThrow(/retention does not match/i)
    expect(() => guard.assertInstallAuthorized(session, bound, resolution, {
      ...binding,
      commitment: { ...commitment, candidateDigest: '9'.repeat(64) },
    })).toThrow(/does not match the current Host grant|candidate digest is stale/i)

    const other = agent('session-other')
    guard.rememberUserMessage(other, trustedUserMessage('用这个'))
    expect(() => guard.assertInstallAuthorized(other, bound, resolution, binding))
      .toThrow(/different owner session|current Host action commitment/i)

    const restarted = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_other' })
    restarted.rememberUserMessage(session, trustedUserMessage('用这个'))
    expect(() => restarted.assertInstallAuthorized(session, bound, resolution, {
      workflow,
      commitment,
      receipt,
      retention: 'temporary',
    })).toThrow(/service restart|current Host action commitment/i)

    guard.rememberUserMessage(session, trustedUserMessage('还是用这个'))
    expect(() => guard.assertInstallAuthorized(session, bound, resolution, binding))
      .toThrow(/current host user turn/i)
  })

  it('cannot replay the install grant after settlement', () => {
    const session = agent()
    const guard = new CreationGuard({ isEvolutionMode: () => true, bootId: 'boot_install' })
    guard.rememberUserMessage(session, trustedUserMessage('用这个'))
    const bound = githubReview()
    const workflow = workflowFor(bound)
    const receipt = receiptFor(guard, session, workflow)
    const commitment = commitmentFor(receipt, bound, workflow)
    expect(commitment.endpoint).toEqual({ kind: 'none' })
    guard.grantHostSelection(session, receipt, commitment)
    guard.invalidateHostGrant(session)
    expect(() => guard.assertInstallAuthorized(session, bound, {
      id: bound.resolutionId,
      decisions: [decisionReceipt(bound)],
    }, { workflow, receipt, commitment, retention: 'temporary' })).toThrow(/current Host action commitment/i)
  })
})

const temporary = trackTempDirs()

describe('install grant owns usability', () => {
  function exec(): ToolRunContext {
    return {
      callId: 'call-1',
      rootCallId: 'call-1',
      token: Symbol('call-1'),
      signal: new AbortController().signal,
      agent: agent(),
    } as unknown as ToolRunContext
  }

  it('does not re-assert direct use after authorizeInstall; stale policy still fails without a grant owner', async () => {
    const root = path.join((await import('node:os')).tmpdir(), `autoevo-grant-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(root, { recursive: true })
    temporary.push(root)
    const store = new StateStore(root)
    const artifactRoot = path.join(root, 'review-artifacts', 'owned')
    const artifactPath = path.join(artifactRoot, 'package', 'dsh-one.tgz')
    await mkdir(path.dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, 'stale-policy-bytes')
    const stale = githubReview({
      policyVersion: '13',
      installSpec: `file:${artifactPath.replaceAll('\\', '/')}`,
      artifact: {
        sha256: 'f'.repeat(64),
        bytes: 18,
        entryCount: 1,
        ownedRoot: artifactRoot,
      },
    })
    await store.put('reviews', stale)
    const ctx = { get: () => ({ request: async () => 'allowed-once' }) } as unknown as Context
    const launcher = {
      install: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
      profileTargetAbsent: async () => true,
    } as unknown as DshLauncher
    const withoutGrant = new PluginInstaller({ ctx, config: testRuntimeConfig(root), store, launcher })
    await expect(withoutGrant.install({
      reviewId: stale.id,
      targetProfile: 'web',
      retention: 'persistent',
    }, exec())).rejects.toThrow(/predates the current policy/i)

    const withGrant = new PluginInstaller({
      ctx,
      config: testRuntimeConfig(root),
      store,
      launcher,
      authorizeInstall: async () => undefined,
    })
    await expect(withGrant.install({
      reviewId: stale.id,
      targetProfile: 'web',
      retention: 'persistent',
    }, exec())).rejects.toThrow(/frozen reviewed package (?:size|bytes) changed|no longer a regular Host-owned file|escaped its Host-owned root/i)
  })
})
