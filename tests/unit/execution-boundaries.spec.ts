import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ExecutionGuard } from '../../src/execution-guard.js'
import type { CommandRunner } from '../../src/process/runner.js'
import { probeWorkspaceWriteSandbox, _testing as sandboxProbeTesting } from '../../src/sandbox-probe.js'

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

  it('enforces the current parent boundaries while preserving read-only inspection and ordinary workspace edits', async () => {
    const next = vi.fn(async () => ({ kind: 'allow' as const }))
    for (const call of [
      exec('capability_workflow'),
      exec('capability_workflow_resume'),
      exec('read'),
      exec('read_image'),
      exec('write', { path: 'notes.txt' }),
      exec('edit', { path: 'notes.txt' }),
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
      exec('cordis_stop'),
      exec('calculator'),
    ]) {
      await expect(parent.preExecute(call, next)).resolves.toEqual({ kind: 'allow' })
    }
    expect(parent.guard(exec('plugin_install'))).toMatch(/plugin install\/remove/i)
    expect(parent.guard(exec('plugin_remove'))).toMatch(/plugin install\/remove/i)
    expect(parent.guard(exec('pwsh', { command: 'dsh plugin add anonymous-capability' }))).toMatch(/plugin install\/remove/i)
    expect(parent.guard(exec('pwsh', { command: 'dsh plugin remove anonymous-capability' }))).toMatch(/plugin install\/remove/i)
    for (const call of [
      exec('cordis_define', { plugin: { kind: 'existing' } }),
      exec('cordis_define', { plugin: { kind: 'new' } }),
      exec('cordis_run'),
      exec('cordis_mount'),
      exec('cordis_undefine'),
      exec('cordis_unmount'),
      exec('find_dsh_plugin'),
      exec('subagent'),
      exec('workflow'),
      exec('ralph'),
      exec('skill', { name: 'cordis-plugin-development' }),
      exec('bash', { command: 'gh pr create' }),
      exec('pwsh', { command: 'gh pr create --title fix --body ready' }),
    ]) expect(parent.guard(call)).toBeTruthy()
    expect(parent.guard(exec('bridge', { tool_name: 'find_dsh_plugin' }))).toMatch(/direct or nested/i)
    expect(parent.guard(exec('pwsh', { command: 'Get-Content (Remove-Item notes.txt -PassThru)' }))).toMatch(/read-only shell/i)
    expect(parent.guard(exec('pwsh', { command: 'Get-Content notes.txt & whoami' }))).toMatch(/read-only shell/i)
    expect(parent.guard(exec('pwsh', { command: 'pnpm test' }))).toMatch(/read-only shell/i)
    expect(parent.guard(exec('pwsh', { command: 'node --version' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'node -v' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'pnpm --version' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'pnpm -v' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'npm --version' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'git --version' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'where node' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'Get-Command pnpm' }))).toBeUndefined()
    expect(parent.guard(exec('pwsh', { command: 'node evil.js' }))).toMatch(/read-only shell/i)
    expect(parent.guard(exec('bash', { command: 'rg --pre dangerous needle .' }))).toMatch(/read-only shell/i)
    expect(parent.guard(exec('pwsh', { command: 'git diff --output=outside.patch' }))).toMatch(/read-only shell/i)
    const protectedParent = new ExecutionGuard({ role: 'parent', cwd: 'C:/workspace', protectedRoots: ['C:/workspace/.autoevo'] })
    expect(protectedParent.guard(exec('write', { path: 'notes.txt' }))).toBeUndefined()
    expect(protectedParent.guard(exec('write', { path: '.autoevo/sources/plugin/index.ts' }))).toMatch(/protected|managed/i)
  })
})

describe('constructor execution boundaries', () => {
  const root = path.join(os.tmpdir(), 'autoevo-managed-source')
  const constructor = new ExecutionGuard({ role: 'constructor', allowedRoot: root, cwd: root })

  it('keeps the parent read-only while construction runs in the cwd-bound Host child', () => {
    expect(constructor.guard(exec('capability_workflow_resume', {
      workflow_id: `workflow_${'a'.repeat(24)}`,
      navigation: { kind: 'finish_managed_work' },
    }))).toBeUndefined()
    expect(constructor.guard(exec('capability_workflow_resume', {
      workflow_id: `workflow_${'a'.repeat(24)}`,
      navigation: { kind: 'search_more' },
    }))).toMatch(/only capability_workflow_resume with finish_managed_work/i)
    expect(constructor.guard(exec('capability_workflow'))).toMatch(/Host owns every other AutoEvo/i)
    expect(constructor.guard(exec('plugin_remove'))).toMatch(/Host owns every other AutoEvo/i)
    expect(constructor.guard(exec('write', { path: path.join(root, 'src', 'index.ts') }))).toMatch(/cwd-bound Host-owned child|parent-session filesystem/i)
    expect(constructor.guard(exec('write', { path: 'src/index.ts' }))).toMatch(/cwd-bound Host-owned child|parent-session filesystem/i)
    expect(constructor.guard(exec('write', { path: './src/index.ts' }))).toMatch(/cwd-bound Host-owned child|parent-session filesystem/i)
    expect(constructor.guard(exec('write', { path: '../outside.ts' }))).toMatch(/outside the Host-managed source/i)
    expect(constructor.guard(exec('write', { path: path.join(os.tmpdir(), 'outside.ts') }))).toMatch(/outside the Host-managed source/i)
    expect(constructor.guard(exec('cordis_define', { plugin: { kind: 'new' } }))).toMatch(/Cordis mutation/i)
    expect(constructor.guard(exec('pwsh', { command: 'dsh plugin add unreviewed' }))).toMatch(/cwd-bound Host-owned child|parent session/i)
    expect(constructor.guard(exec('pwsh', { command: 'pnpm test' }))).toMatch(/cwd-bound Host-owned child|parent session/i)
    expect(constructor.guard(exec('bash', { command: 'git status' }))).toMatch(/cwd-bound Host-owned child|parent session/i)

    for (const call of [
      exec('read', { path: 'src/index.ts' }),
      exec('grep', { pattern: 'apply' }),
      exec('todo_write'),
    ]) expect(constructor.guard(call)).toBeUndefined()
    expect(constructor.guard(exec('subagent'))).toMatch(/cwd-bound Host-owned child/i)
    expect(constructor.guard(exec('run_code'))).toMatch(/cwd-bound Host-owned child/i)
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
    expect(child.guard(exec('pwsh', { command: 'pwsh -Command "git push origin HEAD"' }))).toMatch(/Host owns commits|read-only git|indirect/i)
    expect(child.guard(exec('pwsh', { command: '& (Get-Command git) push origin HEAD' }))).toMatch(/Host owns commits|read-only git|indirect/i)
    expect(child.guard(exec('pwsh', { command: 'C:\\ProgramData\\Git\\git.exe push origin HEAD' }))).toMatch(/Host owns commits|read-only git/i)
    expect(child.guard(exec('pwsh', { command: 'cmd /c "g^h release create v1.0.0"' }))).toMatch(/indirect|dynamically resolved/i)
    expect(child.guard(exec('pwsh', { command: 'pwsh -Command "& (Get-Command (\'g\'+\'it\')) push origin HEAD"' }))).toMatch(/indirect|dynamically resolved/i)
    expect(child.guard(exec('pwsh', { command: "& ([string]::Concat('g','h')) release create v1.0.0" }))).toMatch(/indirect|dynamically resolved/i)
    expect(child.guard(exec('bash', { command: 'node -e "require(\'child_process\').execSync(\'gh release create v1.0.0\')"' }))).toMatch(/GitHub CLI|indirect|dynamically resolved/i)
    expect(child.guard(exec('bash', { command: 'gh pr create' }))).toMatch(/GitHub CLI/i)
    expect(child.guard(exec('bash', { command: 'pnpm publish' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm version patch' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('bash', { command: 'pnpm run release' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('pwsh', { command: 'dsh deploy' }))).toMatch(/publication|version|release|deploy|install/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm install --store-dir .pnpm-store' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('pwsh', { command: 'C:\\tools\\pnpm.cmd add left-pad' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('pwsh', { command: 'C:\\tools\\dsh.cmd plugin add unsafe' }))).toMatch(/plugin install\/remove/i)
    expect(child.guard(exec('bash', { command: 'npx vitest run' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm install --ignore-scripts' }))).toBeUndefined()
    expect(child.guard(exec('pwsh', { command: 'C:\\tools\\pnpm.cmd install --ignore-scripts --offline' }))).toBeUndefined()
    expect(child.guard(exec('pwsh', { command: 'pnpm i --ignore-scripts --prefer-offline' }))).toBeUndefined()
    expect(child.guard(exec('pwsh', { command: 'pnpm install --ignore-scripts && pnpm test' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm install --ignore-scripts left-pad' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm install' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('pwsh', { command: 'pnpm add x' }))).toMatch(/CLI dependency mutation/i)
    expect(child.guard(exec('bash', { command: 'npx anything' }))).toMatch(/CLI dependency mutation/i)
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
      exec('pwsh', { command: 'pnpm install --ignore-scripts' }),
      exec('pwsh', { command: 'pnpm run build' }),
      exec('bash', { command: 'cargo test' }),
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

function officialStack(cwd: string, options: {
  mode?: string
  root?: string
  fsEscape?: boolean
  shellEscape?: boolean
  abortOutsideFs?: { controller: AbortController; reason: unknown }
  abortInsideRunner?: { controller: AbortController; reason: unknown }
} = {}) {
  const contains = (parent: string, candidate: string) => {
    const relative = path.relative(parent, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }
  const calls = { policy: 0, fsResolve: 0, fsWrite: 0, runner: 0 }
  const policy = {
    mode: options.mode ?? 'workspace-write',
    workspaceRoot: options.root ?? cwd,
    sessionId: 'child-session',
  }
  const fs = {
    sandboxMode: 'read-only',
    async resolve(candidate: string) {
      calls.fsResolve += 1
      return candidate
    },
    contains,
    async writeText(candidate: string, body: string) {
      calls.fsWrite += 1
      const inside = contains(cwd, candidate)
      if (!inside && options.abortOutsideFs) {
        options.abortOutsideFs.controller.abort(options.abortOutsideFs.reason)
        throw options.abortOutsideFs.reason
      }
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
      calls.runner += 1
      const candidate = request.argv.at(-1)!
      const inside = contains(cwd, candidate)
      if (!inside && !options.shellEscape) return { exitCode: 1, signal: null, stdout: '', stderr: 'denied' }
      await writeFile(candidate, 'shell probe\n')
      if (inside && options.abortInsideRunner) {
        options.abortInsideRunner.controller.abort(options.abortInsideRunner.reason)
      }
      return { exitCode: 0, signal: null, stdout: '', stderr: '' }
    },
  }
  return {
    sandbox,
    sandboxPolicy: { resolve: () => {
      calls.policy += 1
      return policy
    } } as unknown as SandboxPolicyService,
    fs,
    runner,
    calls,
  }
}

describe('official DSH workspace-write sandbox probe', () => {
  let cwd: string
  const session = {} as Session
  beforeAll(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), 'autoevo-managed-source-')) })
  afterAll(async () => rm(cwd, { recursive: true, force: true }))

  it('fails closed on wrong mode and wrong root', async () => {
    await expect(probeWorkspaceWriteSandbox(officialStack(cwd, { mode: 'read-only' }), session, cwd)).rejects.toThrow(/workspace-write/i)
    await expect(probeWorkspaceWriteSandbox(officialStack(cwd, { root: path.resolve('C:/tmp/other') }), session, cwd)).rejects.toThrow(/workspaceRoot/i)
  })

  it('propagates a pre-aborted signal before policy, filesystem, or runner probes', async () => {
    const controller = new AbortController()
    const reason = new Error('sandbox probe pre-aborted')
    controller.abort(reason)
    const stack = officialStack(cwd)

    await expect(probeWorkspaceWriteSandbox(stack, session, cwd, controller.signal)).rejects.toBe(reason)
    expect(stack.calls).toEqual({ policy: 0, fsResolve: 0, fsWrite: 0, runner: 0 })
  })

  it('rethrows an outside filesystem abort exactly instead of treating it as a sandbox denial', async () => {
    const controller = new AbortController()
    const reason = new Error('outside filesystem probe cancelled')
    const stack = officialStack(cwd, { abortOutsideFs: { controller, reason } })

    await expect(probeWorkspaceWriteSandbox(stack, session, cwd, controller.signal)).rejects.toBe(reason)
    expect(stack.calls.runner).toBe(0)
  })

  it('does not start the outside shell probe when an ignoring inside runner aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('inside runner cancelled')
    const stack = officialStack(cwd, { abortInsideRunner: { controller, reason } })

    await expect(probeWorkspaceWriteSandbox(stack, session, cwd, controller.signal)).rejects.toBe(reason)
    expect(stack.calls.runner).toBe(1)
  })

  it('reports successful-path cleanup failure after attempting every owned path', async () => {
    const cleanup = new Error('probe cleanup failed')
    const attempted: string[] = []
    await expect(sandboxProbeTesting.cleanupProbePaths(['one', 'two', 'three', 'four'], async (candidate) => {
      attempted.push(candidate)
      if (candidate === 'two') throw cleanup
    })).rejects.toBe(cleanup)
    expect(attempted).toEqual(['one', 'two', 'three', 'four'])
  })

  it('treats only a definite missing probe path as absent', async () => {
    const missing = Object.assign(new Error('probe path missing'), { code: 'ENOENT' })
    const unreadable = Object.assign(new Error('probe path unreadable'), { code: 'EACCES' })

    await expect(sandboxProbeTesting.exists('missing', undefined, async () => { throw missing }))
      .resolves.toBe(false)
    await expect(sandboxProbeTesting.exists('unreadable', undefined, async () => { throw unreadable }))
      .rejects.toBe(unreadable)
  })

  it('preserves exact cancellation when a probe-path access completes after abort', async () => {
    const controller = new AbortController()
    const reason = new Error('probe path access cancelled')

    await expect(sandboxProbeTesting.exists('probe', controller.signal, async () => {
      controller.abort(reason)
    })).rejects.toBe(reason)
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
