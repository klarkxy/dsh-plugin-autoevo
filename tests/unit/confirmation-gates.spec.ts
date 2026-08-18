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

function remember(guard: CreationGuard, agent: ToolRunContext['agent'], text: string): void {
  guard.rememberUserMessage(agent, { content: [{ type: 'text', text }] })
}

async function resumeWith(service: CapabilityEvolutionService, guard: CreationGuard, turn: ToolRunContext, workflowId: string, interruptId: string, text: string) {
  remember(guard, turn.agent, text)
  return service.resume({ workflowId, interruptId }, turn)
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
  it('does not mint create authorization after empty completed discovery without create-new', async () => {
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
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.resolution?.authorization?.state).toBe('selection_required')
    expect(started.workflow.cursor).toBe('await_selection')
    expect(started.nextStep).toMatch(/对话|chat|ask_user|interrupt_id/u)
    const stopped = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '先停')
    expect(stopped.resolution?.authorization?.state).toBe('stopped')
    await expect(guard.preExecute({
      callId: 'define-1',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('does not mint create authorization from start itself', async () => {
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
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', exec())
    expect(started.resolution?.authorization?.state).toBe('selection_required')
    expect(started.resolution?.authorization?.state).not.toBe('create_authorized')
    expect(started.resolution?.selectedRepositories ?? []).toEqual([])
  })

  it('reviews only after a host turn names the repository', async () => {
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
      ghRunner(grokBundle),
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    expect(started.resolution?.selectedRepositories ?? []).toEqual([])
    const reviewed = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '先看 MirDie/dsh-xai')
    expect(reviewed.resolution?.selectedRepositories).toEqual(['MirDie/dsh-xai'])
    expect(reviewed.review?.sourceSnapshot.kind === 'github' && reviewed.review.sourceSnapshot.repository)
      .toBe('MirDie/dsh-xai')
    expect(reviewed.workflow.cursor).toBe('await_confirmation')
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
      }]),
      config(root),
      ghRunner(grokHighRisk),
      new StateStore(root),
      guard,
    )
    const turn = exec()
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    const reviewed = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '审查 MirDie/dsh-xai')
    expect(reviewed.review?.fit).toBe('full')
    expect(reviewed.review?.securityRisk).toBe('high')
    expect(reviewed.resolution?.authorization?.state).toBe('confirmation_required')
    expect(reviewed.nextStep).toMatch(/对话|chat|ask_user|interrupt_id/u)
    const stopped = await resumeWith(service, guard, turn, reviewed.workflow.id, reviewed.workflow.interrupt!.interruptId, '先停')
    expect(stopped.resolution?.authorization?.state).toBe('stopped')
    await expect(guard.preExecute({
      callId: 'define-high',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('records create-authorized only after an explicit create-new chat reply and still denies cordis_define', async () => {
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
    const started = await service.start('我需要一个能在dsh里调用grok的能力。', turn)
    await expect(resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '这个仓库看起来不错'))
      .rejects.toThrow(/Could not resolve a workflow decision/i)
    const decided = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '没有合适的，新建一个')
    expect(decided.resolution?.authorization?.state).toBe('create_authorized')
    expect(decided.workflow.cursor).toBe('create_authorized')
    await expect(guard.preExecute({
      callId: 'define-ok',
      name: 'cordis_define',
      arguments: { plugin: { kind: 'new' } },
      agent: turn.agent,
    } as never, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'deny' })
  })

  it('lets a local hit still choose create-new, and binds use-this to the reviewed identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-gate-use-'))
    temporary.push(root)
    const localTurn = exec('session-local')
    const guard = new CreationGuard({ isEvolutionMode: () => true })
    const localService = new CapabilityEvolutionService(
      localCtx(),
      config(root),
      { run: async () => commandResult('0.1.0-rc.6\n') },
      new StateStore(root),
      guard,
    )
    const created = await localService.start('run a PowerShell command', localTurn)
    expect(created.resolution?.localCandidates.some((item) => item.name === 'pwsh')).toBe(true)
    expect(created.resolution?.authorization?.state).toBe('selection_required')
    const allowed = await resumeWith(localService, guard, localTurn, created.workflow.id, created.workflow.interrupt!.interruptId, 'Create new')
    expect(allowed.resolution?.authorization?.state).toBe('create_authorized')

    const useGuard = new CreationGuard({ isEvolutionMode: () => true })
    const store = new StateStore(root)
    const useService = new CapabilityEvolutionService(
      marketplaceCtx([{
        name: 'dsh-xai',
        url: 'https://github.com/MirDie/dsh-xai',
        description: 'xAI Grok SuperGrok OAuth for DeepSeek Harness',
        stars: 2,
      }]),
      config(root),
      ghRunner(grokBundle),
      store,
      useGuard,
    )
    useService.listInstallProfiles = async () => ['web']
    const useTurn = exec('session-use')
    const resolved = await useService.start('我需要一个能在dsh里调用grok的能力。', useTurn)
    const reviewed = await resumeWith(useService, useGuard, useTurn, resolved.workflow.id, resolved.workflow.interrupt!.interruptId, '审查 MirDie/dsh-xai')
    expect(reviewed.resolution?.authorization?.state).toBe('confirmation_required')
    expect(reviewed.workflow.interrupt?.facts.installProfiles).toEqual(['web'])
    const confirmed = await resumeWith(useService, useGuard, useTurn, reviewed.workflow.id, reviewed.workflow.interrupt!.interruptId, '用这个')
    const stored = await store.getResolution(resolved.resolution!.id)
    expect(stored.decisions?.some((item) => item.action === 'use_this')).toBe(true)
    expect(() => useGuard.assertInstallAuthorized(useTurn.agent, reviewed.review!, stored)).not.toThrow()
    expect(() => useGuard.assertInstallAuthorized(useTurn.agent, { ...reviewed.review!, id: `review_${'f'.repeat(64)}` }, stored)).toThrow(/has not chosen/i)
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
      ]),
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

    remember(guard, turn.agent, '随便看看')
    await expect(service.resume({
      workflowId: started.workflow.id,
      interruptId: started.workflow.interrupt!.interruptId,
    }, turn)).rejects.toThrow(/Could not resolve a workflow decision/i)

    const reviewed = await resumeWith(service, guard, turn, started.workflow.id, started.workflow.interrupt!.interruptId, '具体看看 paicat1/dsh-grok-screenshot')
    expect(reviewed.review?.sourceSnapshot.kind === 'github' && reviewed.review.sourceSnapshot.repository)
      .toBe('paicat1/dsh-grok-screenshot')
    const stored = await store.getResolution(started.resolution!.id)
    expect(stored.selectedRepositories).toEqual(['paicat1/dsh-grok-screenshot'])
    expect(stored.decisions?.some((item) => item.action === 'inspect')).toBe(true)
  })
})
