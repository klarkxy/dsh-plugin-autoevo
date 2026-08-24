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
import { ExecutionGuard, leaseAllowsExecution } from '../../src/execution-guard.js'
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

  it('reuses official Creator tools and only blocks AutoEvo-owned side effects', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const call of [
      exec('capability_workflow'),
      exec('capability_workflow_resume'),
      exec('plugin_remove'),
      exec('read'),
      exec('read_image'),
      exec('write'),
      exec('edit'),
      exec('glob'),
      exec('grep'),
      exec('pwsh', { command: 'Get-ChildItem' }),
      exec('todo_write'),
      exec('get_goal'),
      exec('create_goal'),
      exec('job_list'),
      exec('exit_plan_mode'),
      exec('ask_user_question'),
      exec('cordis_inspect_self'),
      exec('cordis_define', { plugin: { kind: 'existing' } }),
      exec('cordis_define', { plugin: { kind: 'new' } }),
      exec('cordis_run'),
      exec('subagent'),
      exec('workflow'),
      exec('ralph'),
      exec('calculator'),
    ]) {
      await expect(parent.preExecute(call, next)).resolves.toEqual({ kind: 'allow' })
    }
    expect(parent.guard(exec('plugin_install'))).toMatch(/plugin install\/remove/i)
    expect(parent.guard(exec('pwsh', { command: 'dsh plugin add dsh-xai' }))).toMatch(/plugin install\/remove/i)
    expect(parent.guard(exec('pwsh', { command: 'dsh plugin remove dsh-xai' }))).toMatch(/plugin install\/remove/i)
    expect(parent.guard(exec('bash', { command: 'gh pr create' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'gh pr create --title fix --body ready' }))).toBeUndefined()
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

describe('lease matching helpers', () => {
  it('matches an exact leased tool name', () => {
    const current = lease({
      endpoint: { kind: 'exact_tool', name: 'calculator' },
      allowedParameterConstraints: {},
    })
    expect(leaseAllowsExecution(current, exec('calculator'))).toBe(true)
    expect(leaseAllowsExecution(current, exec('weather'))).toBe(false)
    expect(leaseAllowsExecution(undefined, exec('calculator'))).toBe(false)
  })

  it('matches bridge tools only when the exact target is present in real arguments', () => {
    const current = lease({
      endpoint: {
        kind: 'bridge',
        tools: ['tool_search', 'tool_describe', 'tool_call'],
        target: 'telegram_send',
      },
      allowedParameterConstraints: { exactTarget: 'telegram_send' },
    })
    expect(leaseAllowsExecution(current, exec('tool_search', { query: 'telegram_send' }))).toBe(true)
    expect(leaseAllowsExecution(current, exec('tool_describe', { name: 'telegram_send' }))).toBe(true)
    expect(leaseAllowsExecution(current, exec('tool_call', { name: 'telegram_send', arguments: { text: 'hi' } }))).toBe(true)
    expect(leaseAllowsExecution(current, exec('tool_call', { name: 'weather' }))).toBe(false)
    expect(leaseAllowsExecution(current, exec('tool_search', { query: 'telegram' }))).toBe(false)
    expect(leaseAllowsExecution(current, exec('tool_describe', {}))).toBe(false)
  })
})

describe('constructor execution boundaries', () => {
  const root = path.join(os.tmpdir(), 'autoevo-managed-source')
  const constructor = new ExecutionGuard({ role: 'constructor', allowedRoot: root })

  it('allows AutoEvo resume and in-root writes, and denies nested subagents and outside writes', () => {
    expect(constructor.guard(exec('capability_workflow_resume'))).toBeUndefined()
    expect(constructor.guard(exec('write', { path: path.join(root, 'src', 'index.ts') }))).toBeUndefined()
    expect(constructor.guard(exec('subagent'))).toMatch(/nested agent\/subagent\/workflow|denies nested/i)
    expect(constructor.guard(exec('write', { path: path.join(os.tmpdir(), 'outside.ts') }))).toMatch(/outside the Host-managed source/i)
    expect(constructor.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(constructor.guard(exec('bash', { command: 'gh pr create' }))).toMatch(/GitHub CLI/i)
    expect(constructor.guard(exec('pwsh', { command: 'gh pr create --fill' }))).toMatch(/GitHub CLI/i)
  })
})

describe('child execution boundaries', () => {
  const child = new ExecutionGuard({ role: 'child' })

  it('denies decisions, mutation, delegation, publication, commits, and unknown direct tools', () => {
    expect(child.guard(exec('capability_workflow'))).toMatch(/AutoEvo decision tools/i)
    expect(child.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('cordis_run'))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('cordis_stop'))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('cordis_undefine'))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('cordis_mount'))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('cordis_unmount'))).toMatch(/Cordis mutation/i)
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
    expect(child.guard(exec('bash', { command: 'pnpm publish' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm version patch' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('bash', { command: 'pnpm run release' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('pwsh', { command: 'dsh deploy' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm install --store-dir .pnpm-store' }))).toMatch(/dependency installation/i)
    expect(child.guard(exec('pwsh', { command: 'C:\\tools\\pnpm.cmd add left-pad' }))).toMatch(/dependency installation/i)
    expect(child.guard(exec('pwsh', { command: 'C:\\tools\\dsh.cmd plugin add unsafe' }))).toMatch(/plugin install\/remove/i)
    expect(child.guard(exec('bash', { command: 'npx vitest run' }))).toMatch(/dependency installation/i)
    expect(child.guard(exec('skill', { name: 'autoevo-plugin-creator' }))).toMatch(/official Creator skills/i)
    expect(child.guard(exec('skill', { name: 'some-other-skill' }))).toMatch(/official Creator skills/i)
    expect(child.guard(exec('external_mutator'))).toMatch(/unrecognized tool/i)
  })

  it('allows only in-repo filesystem work, shell tests, official Creator skills, inspect, and todo', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const call of [
      exec('write'),
      exec('read'),
      exec('pwsh', { command: 'pnpm test' }),
      exec('bash', { command: 'git diff --check' }),
      exec('todo_write'),
      exec('todo_read'),
      exec('skill', { name: 'cordis-plugin-development' }),
      exec('skill', { name: 'editing-cordis-compositions' }),
      exec('cordis_inspect_list'),
      exec('cordis_inspect_query'),
      exec('cordis_inspect_self'),
    ]) {
      await expect(child.preExecute(call, next)).resolves.toEqual({ kind: 'allow' })
    }
    expect(child.guard(exec('run_code'))).toMatch(/unrecognized tool/i)
    expect(child.guard(exec('cordisinspectlist'))).toMatch(/unrecognized tool/i)
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
