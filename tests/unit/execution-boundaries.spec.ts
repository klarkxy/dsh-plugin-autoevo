import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    expect(child.guard(exec('external_mutator'))).toMatch(/unrecognized tool/i)
  })

  it('allows in-repo filesystem work, shell tests, and read-only git inspection', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const call of [exec('write'), exec('read'), exec('pwsh', { command: 'pnpm test' }), exec('bash', { command: 'git diff --check' })]) {
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
  const cwd = path.resolve('C:/tmp/autoevo-managed-source')
  const session = {} as Session
  beforeAll(async () => mkdir(cwd, { recursive: true }))
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
