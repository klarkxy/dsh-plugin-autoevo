import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { POLICY_VERSION, type ResolutionRecord } from '../../src/contracts.js'
import { CreationGuard } from '../../src/creation-guard.js'
import type { ManagedChildHost } from '../../src/managed-child.js'
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/process/runner.js'
import { reviewLocalPlugin } from '../../src/review/review.js'
import { CapabilityEvolutionService } from '../../src/service.js'
import { StateStore } from '../../src/state/store.js'
import type { WorkflowRecord } from '../../src/workflow/contracts.js'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))))

class NativeRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<CommandResult> {
    if (request.argv[0] === 'dsh' && request.argv.includes('--version')) {
      return { exitCode: 0, signal: null, stdout: '0.1.0-rc.6\n', stderr: '' }
    }
    return await new Promise((resolve, reject) => {
      const [command, ...args] = request.argv
      const child = spawn(command, args, {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal: signal as NodeJS.Signals | null, stdout, stderr }))
    })
  }
}

function config(root: string): RuntimeConfig {
  return {
    dshHome: path.join(root, 'dsh-home'),
    stateDir: path.join(root, 'state'),
    sourceDir: path.join(root, 'state', 'sources'),
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

describe('managed modify closure', () => {
  it('uses one focused correction when the original deterministic blocker persists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-modify-e2e-'))
    temporary.push(root)
    const runner = new NativeRunner()
    const cfg = config(root)
    const store = new StateStore(cfg.stateDir)
    const prompts: string[] = []
    let childRuns = 0
    const child: ManagedChildHost = {
      async run(request) {
        prompts.push(request.task)
        childRuns += 1
        if (childRuns === 1) {
          const readme = path.join(request.cwd, 'README.md')
          await writeFile(readme, `${await readFile(readme, 'utf8')}\nFirst attempt changed the wrong surface.\n`)
        } else {
          const pkgPath = path.join(request.cwd, 'package.json')
          const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
          pkg.peerDependencies['@deepseek-ai/dsh-tools'] = '>=0.1.0-rc.6 <0.2.0'
          await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
        }
        return {
          sessionId: `child-${childRuns}`,
          taskResult: 'Tests were not run.\nAUTOEVO_CHILD_COMPLETED',
          sandbox: { ok: true, mode: 'workspace-write', cwd: request.cwd, platform: process.platform, enforcement: 'partial', isolation: 'integrity-partial', note: 'test' },
        }
      },
    }
    const service = new CapabilityEvolutionService(
      { get: () => undefined } as unknown as Context,
      cfg,
      runner,
      store,
      new CreationGuard({ isEvolutionMode: () => true }),
      child,
    )
    const resolutionId = `resolution_${'a'.repeat(24)}`
    const workflowId = `workflow_${'b'.repeat(24)}`
    const initial = await service.sources.initializeCreateSource({ resolutionId, workflowId, packageName: 'dsh-plugin-test' })
    const pkgPath = path.join(initial.path, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    pkg.peerDependencies['@deepseek-ai/dsh-tools'] = 'workspace:^'
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    const incompatibleCommit = await service.sources.finalizeChildCommit({
      sourceId: initial.sourceId,
      workflowId,
      reviewId: `review_${'c'.repeat(64)}`,
      message: 'test: create incompatible baseline',
    })
    const baselineEvidence = await reviewLocalPlugin({
      runner,
      config: cfg,
      workspaceRoot: service.sources.sourceRoot,
      path: initial.path,
      baseReviewId: `review_${'c'.repeat(64)}`,
      lineageRootCommit: initial.baseCommit,
      resolutionId,
      requirement: 'dsh plugin',
      runtimeVersion: '0.1.0-rc.6',
    })
    expect(baselineEvidence.record.compatibility.status).toBe('incompatible')
    const resolution: ResolutionRecord = {
      schemaVersion: 2,
      id: resolutionId,
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      requirement: 'dsh plugin',
      cwd: root,
      decision: 'inspect_remote',
      localCandidates: [],
      remoteCandidates: [],
      remoteDiscoveryComplete: true,
      authorization: { state: 'confirmation_required', resolutionId, reason: 'modify selected', reviewId: baselineEvidence.record.id },
      decisions: [{
        id: `decision_${'d'.repeat(24)}`,
        phase: 'gate2',
        action: 'modify_this',
        selectedRepositories: [],
        reviewId: baselineEvidence.record.id,
        reviewIdentity: baselineEvidence.record.sourceSnapshot.kind === 'local'
          ? baselineEvidence.record.sourceSnapshot.statusHash
          : incompatibleCommit.headCommit,
        userMessage: 'modify_this',
        createdAt: new Date().toISOString(),
      }],
      queries: [],
      reasons: [],
    }
    const workflow: WorkflowRecord = {
      schemaVersion: 2,
      id: workflowId,
      policyVersion: POLICY_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requirement: resolution.requirement,
      status: 'running',
      cursor: 'prepare_modify',
      generation: 1,
      managedSourceId: initial.sourceId,
      lastReviewId: baselineEvidence.record.id,
      lineageTipReviewId: baselineEvidence.record.id,
    }
    const result = await service.prepareModify(
      resolution,
      baselineEvidence.record,
      { agent: { id: 'parent', options: {}, session: { header: { id: 'parent', cwd: root, version: 0, createdAt: 0 } } } as unknown as Agent },
      workflow,
    )
    expect(childRuns).toBe(2)
    expect(prompts[0]).toContain('Host-observed modification targets')
    expect(prompts[1]).toContain('single focused correction')
    expect(result.review?.compatibility.status).toBe('compatible')
    expect(workflow.modificationOutcome).toMatchObject({
      contractVersion: 1,
      policyVersion: POLICY_VERSION,
      maxAttempts: 2,
      automaticCorrectionUsed: true,
      status: 'resolved',
      attempts: [
        { attempt: 1, commit: expect.any(String), changedFiles: ['README.md'], changedFilesTruncated: false, checks: { source: 'child_reported', status: 'skipped' } },
        { attempt: 2, commit: expect.any(String), changedFiles: ['package.json'], changedFilesTruncated: false, checks: { source: 'child_reported', status: 'skipped' } },
      ],
      unresolvedBlockers: [],
      introducedBlockers: [],
    })
    expect(workflow.lastReviewId).toBe(result.review?.id)
    expect(workflow.lineageTipReviewId).toBe(result.review?.id)
    expect(workflow.lastFailure).toBeUndefined()
  }, 30_000)
})
