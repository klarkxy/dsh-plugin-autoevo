import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ExecutionLease } from '../../src/contracts.js'
import { ExecutionGuard } from '../../src/execution-guard.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { probeWorkspaceWriteSandbox } from '../../src/sandbox-probe.js'

function exec(name: string, args: Record<string, unknown> = {}): ToolExecution {
  return {
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    name,
    arguments: args,
    token: Symbol(name),
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

describe('parent execution boundaries', () => {
  const parent = new ExecutionGuard({ role: 'parent' })

  it('allows only AutoEvo decisions and explicit read-only discovery helpers', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const name of ['capability_workflow', 'capability_workflow_resume', 'plugin_remove', 'read', 'fs_search', 'web_search']) {
      await expect(parent.preExecute(exec(name), next)).resolves.toEqual({ kind: 'allow' })
    }
    expect(parent.guard(exec('mystery_writer'))).toMatch(/unrecognized tool/i)
  })

  it('denies write, shell, Cordis, delegation, plugin mutation, and aliases', () => {
    for (const name of ['write', 'edit', 'dsh_fs_write', 'file-edit']) {
      expect(parent.guard(exec(name))).toMatch(/filesystem write\/edit/i)
    }
    expect(parent.guard(exec('pwsh', { command: 'Get-ChildItem' }))).toMatch(/denies shell/i)
    expect(parent.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(parent.guard(exec('subagent'))).toMatch(/delegation/i)
    expect(parent.guard(exec('plugin_install'))).toMatch(/plugin install\/remove/i)
  })
})

function lease(partial: Pick<ExecutionLease, 'endpoint' | 'allowedParameterConstraints'>): ExecutionLease {
  return {
    id: `lease_${'a'.repeat(24)}`,
    commitmentId: `commitment_${'b'.repeat(24)}`,
    selectionReceiptId: `selection_${'c'.repeat(24)}`,
    workflowId: `workflow_${'d'.repeat(24)}`,
    ownerSessionId: 'session-lease',
    bootId: 'boot_lease',
    hostTurnId: `turn_${'e'.repeat(24)}`,
    interruptId: `interrupt_${'f'.repeat(24)}`,
    snapshotDigest: '1'.repeat(64),
    requestedAction: 'reuse_local',
    createdAt: '2026-08-19T00:00:00.000Z',
    ...partial,
  }
}

describe('parent exact-lease allowlist', () => {
  it('denies ordinary tools when no lease resolver is configured', () => {
    const parent = new ExecutionGuard({ role: 'parent' })
    expect(parent.guard(exec('calculator'))).toMatch(/unrecognized tool/i)
  })

  it('allows only the exact leased tool name', () => {
    const parent = new ExecutionGuard({
      role: 'parent',
      resolveLease: () => lease({
        endpoint: { kind: 'exact_tool', name: 'calculator' },
        allowedParameterConstraints: {},
      }),
    })
    expect(parent.guard(exec('calculator'))).toBeUndefined()
    expect(parent.guard(exec('weather'))).toMatch(/unrecognized tool/i)
  })

  it('allows bridge tools only when the exact target is present in real arguments', () => {
    const parent = new ExecutionGuard({
      role: 'parent',
      resolveLease: () => lease({
        endpoint: {
          kind: 'bridge',
          tools: ['tool_search', 'tool_describe', 'tool_call'],
          target: 'telegram_send',
        },
        allowedParameterConstraints: { exactTarget: 'telegram_send' },
      }),
    })
    expect(parent.guard(exec('tool_search', { query: 'telegram_send' }))).toBeUndefined()
    expect(parent.guard(exec('tool_describe', { name: 'telegram_send' }))).toBeUndefined()
    expect(parent.guard(exec('tool_call', { name: 'telegram_send', arguments: { text: 'hi' } }))).toBeUndefined()
  })

  it('rejects a swapped or missing bridge target', () => {
    const parent = new ExecutionGuard({
      role: 'parent',
      resolveLease: () => lease({
        endpoint: {
          kind: 'bridge',
          tools: ['tool_search', 'tool_describe', 'tool_call'],
          target: 'telegram_send',
        },
        allowedParameterConstraints: { exactTarget: 'telegram_send' },
      }),
    })
    expect(parent.guard(exec('tool_call', { name: 'weather' }))).toMatch(/unrecognized tool/i)
    expect(parent.guard(exec('tool_search', { query: 'telegram' }))).toMatch(/unrecognized tool/i)
    expect(parent.guard(exec('tool_describe', {}))).toMatch(/unrecognized tool/i)
    expect(parent.guard(exec('tool_call', { arguments: { text: 'hi' } }))).toMatch(/unrecognized tool/i)
  })

  it('still denies shell and write even when a forged lease names them', () => {
    const shell = new ExecutionGuard({
      role: 'parent',
      resolveLease: () => lease({
        endpoint: { kind: 'exact_tool', name: 'pwsh' },
        allowedParameterConstraints: {},
      }),
    })
    expect(shell.guard(exec('pwsh', { command: 'Get-ChildItem' }))).toMatch(/denies shell/i)
    const write = new ExecutionGuard({
      role: 'parent',
      resolveLease: () => lease({
        endpoint: { kind: 'exact_tool', name: 'write' },
        allowedParameterConstraints: {},
      }),
    })
    expect(write.guard(exec('write'))).toMatch(/filesystem write\/edit/i)
  })

  it('denies ordinary tools when the resolver returns undefined for an invalid or expired lease', () => {
    const parent = new ExecutionGuard({
      role: 'parent',
      resolveLease: () => undefined,
    })
    expect(parent.guard(exec('calculator'))).toMatch(/unrecognized tool/i)
    expect(parent.guard(exec('tool_call', { name: 'telegram_send' }))).toMatch(/unrecognized tool/i)
  })
})

describe('child execution boundaries', () => {
  const child = new ExecutionGuard({ role: 'child' })

  it('denies decisions, mutation, delegation, publication, commits, and unknown direct tools', () => {
    expect(child.guard(exec('capability_workflow'))).toMatch(/AutoEvo decision tools/i)
    expect(child.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('subagent_fork'))).toMatch(/nested agent\/subagent\/workflow/i)
    expect(child.guard(exec('plugin_install'))).toMatch(/plugin install\/remove/i)
    expect(child.guard(exec('pwsh', { command: 'git push origin HEAD' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: 'git -c alias.ship=push ship origin HEAD' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: 'git status; git push origin HEAD' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: "& 'git' commit -am unsafe" }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: 'pwsh -Command "git push origin HEAD"' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: '& (Get-Command git) push origin HEAD' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: 'C:\\ProgramData\\Git\\git.exe push origin HEAD' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('bash', { command: 'gh pr create' }))).toMatch(/GitHub CLI/i)
    expect(child.guard(exec('bash', { command: 'pnpm publish' }))).toMatch(/publication/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm install --store-dir .pnpm-store' }))).toMatch(/dependency installation/i)
    expect(child.guard(exec('bash', { command: 'npx vitest run' }))).toMatch(/dependency installation/i)
    expect(child.guard(exec('external_mutator'))).toMatch(/unrecognized tool/i)
  })

  it('allows the Code Mode transport, in-repo filesystem work, shell tests, and read-only git inspection', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const call of [exec('run_code'), exec('write'), exec('read'), exec('pwsh', { command: 'pnpm test' }), exec('bash', { command: 'git diff --check' })]) {
      await expect(child.preExecute(call, next)).resolves.toEqual({ kind: 'allow' })
    }
  })
})

function officialStack(cwd: string, options: { mode?: string; root?: string; fsEscape?: boolean; shellEscape?: boolean } = {}) {
  const contains = (parent: string, candidate: string) => {
    const relative = path.relative(parent, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
  const policy = {
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: options.root ?? cwd,
    sessionId: 'child-session',
  }
  const fs = {
    sandboxMode: 'read-only',
    async resolve(candidate: string) { return candidate },
    contains,
    async writeText(candidate: string, body: string) {
      const inside = contains(cwd, candidate)
      if (!inside && !options.fsEscape) throw new Error('FS_SANDBOX_DENIED')
      await writeFile(candidate, body)
      return { version: 'v1' }
    },
  } as unknown as FileSystem
  const sandbox = {
    confine(argv: readonly string[]) {
      return { argv: [...argv], enforcement: 'partial' as const, denialSignatures: [], runnerFailureRules: [] }
    },
  } as unknown as SandboxProvider
  const runner: CommandRunner = {
    async run(request) {
      const candidate = request.argv.at(-1)!
      const inside = contains(cwd, candidate)
      if (!inside && !options.shellEscape) return { exitCode: 1, signal: null, stdout: '', stderr: 'denied' }
      await writeFile(candidate, 'shell probe\n')
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    },
  }
  return {
    sandbox,
    sandboxPolicy: { resolve: () => policy } as unknown as SandboxPolicyService,
    fs,
    runner,
  }
}

describe('official DSH workspace-write sandbox probe', () => {
  let cwd: string
  const session = {} as Session
  beforeAll(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-source-')) })
  afterAll(async () => rm(cwd, { recursive: true, force: true }))

  it('fails closed on missing services, wrong mode, and wrong root', async () => {
    await expect(probeWorkspaceWriteSandbox(undefined, session, cwd)).rejects.toThrow(/official DSH sandbox/i)
    await expect(probeWorkspaceWriteSandbox(officialStack(cwd, { mode: 'read-only' }), session, cwd)).rejects.toThrow(/workspace-write/i)
    await expect(probeWorkspaceWriteSandbox(officialStack(cwd, { root: path.resolve('C:/tmp/other') }), session, cwd)).rejects.toThrow(/workspaceRoot/i)
  })

  it('rejects accepted filesystem or shell escapes', async () => {
    await expect(probeWorkspaceWriteSandbox(officialStack(cwd, { fsEscape: true }), session, cwd)).rejects.toThrow(/filesystem sandbox accepted/i)
    await expect(probeWorkspaceWriteSandbox(officialStack(cwd, { shellEscape: true }), session, cwd)).rejects.toThrow(/shell sandbox accepted/i)
  })

  it('accepts official service shapes and records partial integrity isolation', async () => {
    const result = await probeWorkspaceWriteSandbox(officialStack(cwd), session, cwd)
    expect(result).toMatchObject({ ok: true, mode: 'workspace-write', cwd, enforcement: 'partial', isolation: 'integrity-partial' })
  })
})
