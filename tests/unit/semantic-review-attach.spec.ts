import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type ReviewRecord, type ReviewerVerdict } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { evaluatePluginContent } from '../../src/review/review.js'
import {
  attachSemanticReview,
  CapabilityEvolutionService,
  reviewCandidateDigest,
  reviewSnapshotDigest,
} from '../../src/service.js'
import type { SemanticReviewerHost, SemanticReviewerResult } from '../../src/semantic-reviewer.js'
import { requirementHashFor } from '../../src/semantic-reviewer.js'
import { StateStore } from '../../src/state/store.js'
import type { WorkflowExec, WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary = trackTempDirs()

const loaderPatch = '- insert:\n    - id: calculator\n      name: calculator\n'

function agent(): Agent {
  return {
    id: 'parent-session',
    options: {},
    session: { header: { id: 'parent-session', cwd: 'C:/workspace', version: 0, createdAt: 0, delegationDepth: 0 } },
    ctx: { get: () => undefined },
  } as unknown as Agent
}

function exec(): WorkflowExec {
  return { agent: agent() }
}

function lowRiskReview() {
  const files = [
    { path: 'package.json', content: Buffer.from(JSON.stringify({
      name: '@acme/calculator',
      license: 'MIT',
      dsh: { bundle: { patch: './cordis.patch.yml', tools: ['calculator'] } },
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
    })) },
    { path: 'cordis.patch.yml', content: Buffer.from(loaderPatch) },
    { path: 'src/index.ts', content: Buffer.from('export const calculate = () => 1') },
  ]
  const record = evaluatePluginContent({
    resolutionId: `resolution_${'b'.repeat(24)}`,
    runtimeVersion: '0.1.0-rc.6',
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/calculator',
      requestedRef: 'main',
      commit: 'a'.repeat(40),
      defaultBranch: 'main',
    },
    files,
  })
  return { record, files }
}

function highRiskReview() {
  const files = [
    { path: 'package.json', content: Buffer.from(JSON.stringify({
      name: '@acme/calculator',
      license: 'MIT',
      dsh: { bundle: { patch: './cordis.patch.yml', tools: ['calculator'] } },
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
    })) },
    { path: 'cordis.patch.yml', content: Buffer.from(loaderPatch) },
    { path: 'src/run.ts', content: Buffer.from('export function apply() { eval("1") }') },
  ]
  const record = evaluatePluginContent({
    resolutionId: `resolution_${'b'.repeat(24)}`,
    runtimeVersion: '0.1.0-rc.6',
    requirement: 'calculator',
    sourceSnapshot: {
      kind: 'github',
      repository: 'acme/calculator',
      requestedRef: 'main',
      commit: 'a'.repeat(40),
      defaultBranch: 'main',
    },
    files,
  })
  return { record, files }
}

function workflowFor(review: ReviewRecord, digest = '4'.repeat(64)): WorkflowRecord {
  return {
    schemaVersion: 2,
    id: `workflow_${'d'.repeat(24)}`,
    policyVersion: POLICY_VERSION,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    requirement: review.requirement,
    status: 'running',
    cursor: 'review_github',
    generation: 1,
    candidateSnapshot: review.sourceSnapshot.kind === 'github'
      ? [{
          id: `candidate_${'e'.repeat(24)}`,
          index: 1,
          kind: 'remote',
          name: 'calculator',
          identity: review.sourceSnapshot.repository,
          repository: review.sourceSnapshot.repository,
          digest,
        }]
      : [],
  }
}

function fakeHost(
  decision: ReviewerVerdict['decision'] | 'throw' | 'forge',
  seen: Array<{ snapshotDigest: string; candidateDigest: string; files: string[] }> = [],
): SemanticReviewerHost {
  return {
    async run(input) {
      seen.push({
        snapshotDigest: input.snapshotDigest,
        candidateDigest: input.candidateDigest,
        files: input.files.map((file) => `${file.path}:${file.sha256}:${file.bytes}`),
      })
      if (decision === 'throw') throw new Error('reviewer runtime unavailable')
      const request = {
        id: `reviewer_${'f'.repeat(24)}`,
        workflowId: input.workflowId,
        resolutionId: input.review.resolutionId,
        reviewId: decision === 'forge' ? `review_${'9'.repeat(64)}` : input.review.id,
        requirement: input.review.requirement,
        snapshotDigest: decision === 'forge' ? '8'.repeat(64) : input.snapshotDigest,
        candidateDigest: decision === 'forge' ? '7'.repeat(64) : input.candidateDigest,
        status: 'completed' as const,
        createdAt: '2026-08-19T00:00:02.000Z',
        completedAt: '2026-08-19T00:00:03.000Z',
      }
      return {
        request,
        verdict: {
          requestId: request.id,
          reviewId: request.reviewId,
          requirementHash: requirementHashFor(input.review.requirement),
          snapshotDigest: request.snapshotDigest,
          candidateDigest: request.candidateDigest,
          reviewerSessionId: 'reviewer-session',
          reviewerVersion: '1',
          decision: decision === 'forge' ? 'approved' : decision,
          evidence: [`host:${decision}`],
          conditions: [],
          semanticCoverage: 'partial',
          createdAt: '2026-08-19T00:00:03.000Z',
        },
      } satisfies SemanticReviewerResult
    },
  }
}

describe('attachSemanticReview', () => {
  it('skips the reviewer child when mechanical facts do not need one', async () => {
    const { record, files } = lowRiskReview()
    const seen: Array<{ snapshotDigest: string; candidateDigest: string; files: string[] }> = []
    const attached = await attachSemanticReview({
      host: fakeHost('approved', seen),
      review: record,
      files,
      exec: exec(),
      timeoutMs: 1_000,
    })
    expect(seen).toEqual([])
    expect(attached.reviewerRequest).toBeUndefined()
    expect(attached.reviewerVerdict).toBeUndefined()
    expect(attached.reviewerRequestId).toBeUndefined()
  })

  it('passes exact files and digests and persists approved, rejected, and uncertain verdicts', async () => {
    const { record, files } = highRiskReview()
    const digest = '4'.repeat(64)
    const current = workflowFor(record, digest)
    for (const decision of ['approved', 'rejected', 'uncertain'] as const) {
      const seen: Array<{ snapshotDigest: string; candidateDigest: string; files: string[] }> = []
      const attached = await attachSemanticReview({
        host: fakeHost(decision, seen),
        review: record,
        files,
        exec: exec(),
        workflow: current,
        timeoutMs: 1_000,
      })
      expect(seen).toEqual([{
        snapshotDigest: reviewSnapshotDigest(record),
        candidateDigest: digest,
        files: record.inspectedFiles.map((item) => `${item.path}:${item.sha256}:${item.bytes}`),
      }])
      expect(attached.reviewerRequest?.status).toBe('completed')
      expect(attached.reviewerVerdict?.decision).toBe(decision)
      expect(attached.reviewerRequestId).toBe(attached.reviewerRequest?.id)
    }
  })

  it('rejects a forged or wrong-digest host response', async () => {
    const { record, files } = highRiskReview()
    await expect(attachSemanticReview({
      host: fakeHost('forge'),
      review: record,
      files,
      exec: exec(),
      timeoutMs: 1_000,
    })).rejects.toThrow(/digest mismatch|not bound to this review/i)
  })

  it('converts infrastructure failure to Host-minted uncertain instead of approved', async () => {
    const { record, files } = highRiskReview()
    const attached = await attachSemanticReview({
      host: fakeHost('throw'),
      review: record,
      files,
      exec: exec(),
      timeoutMs: 1_000,
    })
    expect(attached.reviewerVerdict?.decision).toBe('uncertain')
    expect(attached.reviewerVerdict?.evidence.join(' ')).toMatch(/unavailable/i)
    expect(attached.reviewerVerdict?.decision).not.toBe('approved')
    expect(reviewCandidateDigest(record)).toMatch(/^[a-f0-9]{64}$/u)
  })
})

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root)
}

function commandResult(stdout = '') {
  return { exitCode: 0, signal: null, stdout, stderr: '' }
}

function fileBlob(text: string): string {
  return Buffer.from(text).toString('base64')
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
      if (/repos\/[^/]+\/[^/]+$/.test(joined)) return commandResult(JSON.stringify({ default_branch: 'main' }))
      return commandResult()
    },
  }
}

const grokFiles = {
  'package.json': JSON.stringify({
    name: 'dsh-xai',
    license: 'MIT',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
  }, null, 2),
  'cordis.patch.yml': '- id: xai\n  name: dsh-xai\n',
  'README.md': 'xAI Grok SuperGrok OAuth for DeepSeek Harness\n',
  'lib/index.js': "export function apply() { eval('1') }\n",
}

describe('service selected review attachment', () => {
  it('reviews only selected repositories and attaches an independent reviewer result to each', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-review-attach-'))
    temporary.push(root)
    const seenRepos: string[] = []
    const host: SemanticReviewerHost = {
      async run(input) {
        const repo = input.review.sourceSnapshot.kind === 'github' ? input.review.sourceSnapshot.repository : 'local'
        seenRepos.push(repo)
        return {
          request: {
            id: `reviewer_${hash24(repo)}`,
            workflowId: input.workflowId,
            resolutionId: input.review.resolutionId,
            reviewId: input.review.id,
            requirement: input.review.requirement,
            snapshotDigest: input.snapshotDigest,
            candidateDigest: input.candidateDigest,
            status: 'completed',
            createdAt: '2026-08-19T00:00:02.000Z',
            completedAt: '2026-08-19T00:00:03.000Z',
          },
          verdict: {
            requestId: `reviewer_${hash24(repo)}`,
            reviewId: input.review.id,
            requirementHash: requirementHashFor(input.review.requirement),
            snapshotDigest: input.snapshotDigest,
            candidateDigest: input.candidateDigest,
            reviewerSessionId: 'reviewer-session',
            reviewerVersion: '1',
            decision: 'rejected',
            evidence: [repo],
            conditions: [],
            semanticCoverage: 'partial',
            createdAt: '2026-08-19T00:00:03.000Z',
          },
        }
      },
    }
    const resolution = {
      schemaVersion: 2 as const,
      id: `resolution_${'b'.repeat(24)}`,
      policyVersion: POLICY_VERSION,
      createdAt: '2026-08-19T00:00:00.000Z',
      requirement: 'grok',
      cwd: root,
      decision: 'inspect_remote' as const,
      localCandidates: [],
      remoteCandidates: [
        { repository: 'MirDie/dsh-xai', name: 'dsh-xai', description: 'xAI Grok', stars: 3, updatedAt: null, topics: [] },
        { repository: 'acme/other', name: 'other', description: 'other', stars: 1, updatedAt: null, topics: [] },
      ],
      remoteDiscoveryComplete: true,
      authorization: { state: 'selection_required' as const, resolutionId: `resolution_${'b'.repeat(24)}`, reason: 'wait' },
      selectedRepositories: ['MirDie/dsh-xai'],
      queries: [],
      reasons: [],
    }
    const store = new StateStore(root)
    await store.put('resolutions', resolution)
    const serviceWithStore = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      config(root),
      ghRunner(grokFiles),
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      undefined,
      host,
    )
    const result = await serviceWithStore.reviewGithubBatch(
      resolution,
      ['MirDie/dsh-xai'],
      'fixed',
      exec(),
    )
    expect(result.reviews).toHaveLength(1)
    expect(result.reviews[0]?.sourceSnapshot).toMatchObject({ repository: 'MirDie/dsh-xai' })
    expect(result.reviews[0]?.reviewerVerdict?.decision).toBeUndefined()
    expect(seenRepos).toEqual([])
    await expect(serviceWithStore.reviewGithubBatch(
      resolution,
      ['acme/other'],
      'fixed',
      exec(),
    )).rejects.toThrow(/was not selected for read-only review/i)
  })
})

function hash24(value: string): string {
  return value.replace(/[^a-f0-9]/giu, 'a').toLowerCase().padEnd(24, 'a').slice(0, 24)
}
