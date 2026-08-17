import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { CreationGuard } from '../../src/creation-guard.js'
import { CapabilityEvolutionService } from '../../src/service.js'
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
    communityQualityFilter: false,
    communityReports: false,
    communityQualityEndpoint: '',
    communityQualityTimeoutMs: 2_000,
  }
}

function exec(): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    token: Symbol('call-1'),
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: process.cwd() } } },
  } as unknown as ToolRunContext
}

function fileBlob(text: string): string {
  return Buffer.from(text).toString('base64')
}

function commandResult(stdout = ''): { exitCode: number, signal: null, stdout: string, stderr: string } {
  return { exitCode: 0, signal: null, stdout, stderr: '' }
}

function localCtx(): Context {
  return {
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
    get: () => undefined,
  } as unknown as Context
}

function marketplaceCtx(results: Array<{ name: string, url: string, description: string, stars?: number }>): Context {
  return {
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
    get: () => undefined,
  } as unknown as Context
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
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6 <0.2.0' },
  }, null, 2),
  'cordis.patch.yml': '- id: xai\n  name: dsh-xai\n',
  'README.md': 'xAI Grok SuperGrok OAuth for DeepSeek Harness\n',
  'lib/index.js': 'export function apply() {}\n',
}

const grokHighRisk = {
  ...grokBundle,
  'lib/index.js': "import { spawn } from 'node:child_process'\nexport function apply() { spawn('echo') }\n",
}

describe('conversational confirmation gates', () => {
  it('does not mint scratch after empty completed discovery without create-new', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-empty-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([]),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const resolution = await service.resolve('我需要一个能在dsh里调用grok的能力。', turn)
    expect(resolution.authorization?.state).toBe('selection_required')
    expect(resolution.nextStep).toMatch(/对话|chat|ask_user/u)
    const stopped = await service.decide({
      resolutionId: resolution.id,
      userMessage: '先停',
      action: 'stop',
    }, turn)
    expect(stopped.authorization?.state).toBe('stopped')
    await expect(guard.preExecute({
      callId: 'define-1',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('does not mint scratch from resolve itself', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-resolve-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([]),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const resolution = await service.resolve('我需要一个能在dsh里调用grok的能力。', exec())
    expect(resolution.authorization?.state).toBe('selection_required')
    expect(resolution.authorization?.state).not.toBe('scratch_ready')
    expect(resolution.selectedRepositories ?? []).toEqual([])
  })

  it('rejects review of a repository the user did not select', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-unselected-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }]),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const resolution = await service.resolve('我需要一个能在dsh里调用grok的能力。', turn)
    expect(resolution.selectedRepositories ?? []).toEqual([])
    await expect(service.review({
      resolutionId: resolution.id,
      sourceKind: 'github',
      repository: 'MirDie/dsh-xai',
    }, turn)).rejects.toThrow(/not selected/i)
    const decided = await service.decide({
      resolutionId: resolution.id,
      userMessage: '先看 MirDie/dsh-xai',
      action: 'inspect',
      repositories: ['MirDie/dsh-xai'],
    }, turn)
    expect(decided.selectedRepositories).toEqual(['MirDie/dsh-xai'])
    await expect(service.review({
      resolutionId: resolution.id,
      sourceKind: 'github',
      repository: 'acme/other',
    }, turn)).rejects.toThrow(/not selected/i)
  })

  it('presents full+high at gate 2 instead of auto-scratch, and stop stays stopped', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-high-'))
    temporary.push(root)
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }]),
      config(root),
      ghRunner(grokHighRisk),
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const resolution = await service.resolve('我需要一个能在dsh里调用grok的能力。', turn)
    await service.decide({
      resolutionId: resolution.id,
      userMessage: '审查 MirDie/dsh-xai',
      action: 'inspect',
      repositories: ['MirDie/dsh-xai'],
    }, turn)
    const reviewed = await service.review({
      resolutionId: resolution.id,
      sourceKind: 'github',
      repository: 'MirDie/dsh-xai',
    }, turn)
    expect(reviewed.fit).toBe('full')
    expect(reviewed.securityRisk).toBe('high')
    expect(reviewed.authorization.state).toBe('confirmation_required')
    expect(reviewed.nextStep).toMatch(/对话|chat|ask_user/u)
    const stopped = await service.decide({
      resolutionId: resolution.id,
      userMessage: '先停',
      action: 'stop',
      reviewId: reviewed.id,
    }, turn)
    expect(stopped.authorization?.state).toBe('stopped')
    await expect(guard.preExecute({
      callId: 'define-high',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('grants define only after an explicit create-new chat reply', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-create-'))
    temporary.push(root)
    const turn = exec()
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const service = new CapabilityEvolutionService(
      marketplaceCtx([]),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const resolution = await service.resolve('我需要一个能在dsh里调用grok的能力。', turn)
    await expect(service.decide({
      resolutionId: resolution.id,
      userMessage: '这个仓库看起来不错',
      action: 'create_new',
    }, turn)).rejects.toThrow(/does not match/i)
    const decided = await service.decide({
      resolutionId: resolution.id,
      userMessage: '没有合适的，新建一个',
      action: 'create_new',
    }, turn)
    expect(decided.authorization?.state).toBe('scratch_ready')
    await expect(guard.preExecute({
      callId: 'define-ok',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toEqual({ kind: 'allow' })
  })

  it('lets a local hit still choose create-new, and binds use-this to the reviewed identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-use-'))
    temporary.push(root)
    const agent = exec().agent!
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const localService = new CapabilityEvolutionService(
      localCtx(),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const created = await localService.resolve('run a PowerShell command', { ...exec(), agent })
    expect(created.localCandidates.some((item) => item.name === 'pwsh')).toBe(true)
    expect(created.authorization?.state).toBe('selection_required')
    const allowed = await localService.decide({
      resolutionId: created.id,
      userMessage: 'Create new',
      action: 'create_new',
    }, { ...exec(), agent })
    expect(allowed.authorization?.state).toBe('scratch_ready')

    const useGuard = new CreationGuard({ isEvolutionMode: () => true })
    const useService = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }]),
      config(root),
      ghRunner(grokBundle),
      new StateStore(root),
      useGuard,
    )
    const resolved = await useService.resolve('我需要一个能在dsh里调用grok的能力。', { ...exec(), agent })
    await useService.decide({
      resolutionId: resolved.id,
      userMessage: '审查 MirDie/dsh-xai',
      action: 'inspect',
      repositories: ['MirDie/dsh-xai'],
    }, { ...exec(), agent })
    const reviewed = await useService.review({
      resolutionId: resolved.id,
      sourceKind: 'github',
      repository: 'MirDie/dsh-xai',
    }, { ...exec(), agent })
    expect(reviewed.authorization.state).toBe('confirmation_required')
    const confirmed = await useService.decide({
      resolutionId: resolved.id,
      userMessage: '用这个',
      action: 'use_this',
      reviewId: reviewed.id,
    }, { ...exec(), agent })
    expect(confirmed.authorization?.state).toBe('use_review')
    expect(confirmed.authorization?.reviewId).toBe(reviewed.id)
    expect(() => useGuard.assertInstallAuthorized(agent, reviewed)).not.toThrow()
    expect(() => useGuard.assertInstallAuthorized(agent, { ...reviewed, id: `review_${'f'.repeat(64)}` })).toThrow(/has not chosen/i)
  })
})
