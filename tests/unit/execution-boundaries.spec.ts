import path from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionGuard } from '../../src/execution-guard.js'
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

  it('allows AutoEvo decision tools and read/search helpers', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(parent.preExecute(exec('capability_workflow'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(parent.preExecute(exec('capability_workflow_resume'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(parent.preExecute(exec('plugin_remove'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(parent.preExecute(exec('read'), next)).resolves.toEqual({ kind: 'allow' })
    await expect(parent.preExecute(exec('fs_search'), next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(5)
  })

  it('denies filesystem write/edit aliases and direct calls', async () => {
    for (const name of ['write', 'edit', 'fs_write', 'file_edit']) {
      expect(parent.guard(exec(name))).toMatch(/filesystem write\/edit/i)
    }
  })

  it('denies shell pwsh/bash and direct DSH plugin mutation via shell', async () => {
    expect(parent.guard(exec('pwsh', { command: 'Get-ChildItem' }))).toMatch(/denies shell/i)
    expect(parent.guard(exec('bash', { command: 'ls' }))).toMatch(/denies shell/i)
    expect(parent.guard(exec('pwsh', { command: 'dsh plugin add foo' }))).toMatch(/plugin install\/remove/i)
  })

  it('denies Cordis mutation/definition and nested delegation', async () => {
    expect(parent.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(parent.guard(exec('cordis_mount'))).toMatch(/Cordis mutation/i)
    expect(parent.guard(exec('subagent'))).toMatch(/delegation/i)
    expect(parent.guard(exec('workflow'))).toMatch(/delegation/i)
    expect(parent.guard(exec('ralph'))).toMatch(/delegation/i)
  })
})

describe('child execution boundaries', () => {
  const child = new ExecutionGuard({ role: 'child' })

  it('denies AutoEvo decision tools, Cordis mutation, nested delegation, and publication', () => {
    expect(child.guard(exec('capability_workflow'))).toMatch(/AutoEvo decision tools/i)
    expect(child.guard(exec('capability_workflow_resume'))).toMatch(/AutoEvo decision tools/i)
    expect(child.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(child.guard(exec('subagent_fork'))).toMatch(/nested agent\/subagent\/workflow/i)
    expect(child.guard(exec('plugin_install'))).toMatch(/plugin install\/remove/i)
    expect(child.guard(exec('plugin_remove'))).toMatch(/AutoEvo decision tools|plugin install\/remove/i)

    expect(child.guard(exec('pwsh', { command: 'git push origin HEAD' }))).toMatch(/push\/tag\/release|publication/i)
    expect(child.guard(exec('bash', { command: 'gh pr create' }))).toMatch(/push\/tag\/release|publication/i)
  })

  it('allows ordinary in-repo edit/read tools', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    await expect(child.preExecute(exec('write', { path: 'src/index.ts' }), next)).resolves.toEqual({ kind: 'allow' })
    await expect(child.preExecute(exec('read'), next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(2)
  })
})

describe('workspace-write sandbox probe', () => {
  const cwd = path.resolve('C:/managed/source')

  it('fails closed when providers are missing', async () => {
    await expect(probeWorkspaceWriteSandbox(undefined, cwd)).rejects.toThrow(/sandbox stack is unavailable/i)
    await expect(probeWorkspaceWriteSandbox({ filesystem: { mode: 'workspace-write', cwd } }, cwd))
      .rejects.toThrow(/shell sandbox provider is unavailable/i)
  })

  it('rejects wrong mode and cwd mismatch', async () => {
    await expect(probeWorkspaceWriteSandbox({
      filesystem: { mode: 'read-only', cwd },
      shell: { mode: 'workspace-write', cwd },
    }, cwd)).rejects.toThrow(/Filesystem sandbox mode must be workspace-write/i)

    await expect(probeWorkspaceWriteSandbox({
      filesystem: { mode: 'workspace-write', cwd: path.resolve('C:/other') },
      shell: { mode: 'workspace-write', cwd },
    }, cwd)).rejects.toThrow(/cwd is not bound/i)
  })

  it('rejects path/symlink escape and outside-cwd shell writes', async () => {
    await expect(probeWorkspaceWriteSandbox({
      filesystem: {
        mode: 'workspace-write',
        cwd,
        assertContained: async () => true,
      },
      shell: {
        mode: 'workspace-write',
        cwd,
        canWrite: async (candidate) => !String(candidate).includes('..'),
      },
    }, cwd)).rejects.toThrow(/containment probe/i)

    await expect(probeWorkspaceWriteSandbox({
      filesystem: {
        mode: 'workspace-write',
        cwd,
        assertContained: async () => false,
      },
      shell: {
        mode: 'workspace-write',
        cwd,
        canWrite: async () => true,
      },
    }, cwd)).rejects.toThrow(/outside-cwd write probe/i)
  })

  it('accepts a capable workspace-write stack and records integrity-partial isolation', async () => {
    const result = await probeWorkspaceWriteSandbox({
      filesystem: {
        mode: 'workspace-write',
        cwd,
        assertContained: async (candidate) => !path.relative(cwd, candidate).startsWith('..') && path.relative(cwd, candidate) !== '',
      },
      shell: {
        mode: 'workspace-write',
        cwd,
        canWrite: async (candidate) => {
          const relative = path.relative(cwd, candidate)
          return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
        },
      },
    }, cwd)
    expect(result).toMatchObject({
      ok: true,
      mode: 'workspace-write',
      cwd,
      isolation: 'integrity-partial',
    })
    expect(result.note).toMatch(/partial isolation|workspace-write sandbox probe passed/i)
  })
})
