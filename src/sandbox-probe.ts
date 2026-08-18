import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { EvolutionError } from './errors.js'
import type { CommandRunner } from './process/runner.js'

export interface LiveSandboxStack {
  sandbox?: SandboxProvider
  sandboxPolicy?: SandboxPolicyService
  fs?: FileSystem
  runner?: CommandRunner
}

export interface SandboxProbeResult {
  ok: true
  mode: 'workspace-write'
  cwd: string
  platform: NodeJS.Platform
  enforcement: 'full' | 'partial'
  isolation: 'integrity-partial'
  note: string
}

function normalizePath(value: string): string {
  return path.resolve(value)
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizePath(parent), normalizePath(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true).catch(() => false)
}

async function probeFilesystem(
  fs: FileSystem,
  policy: SandboxExecutionPolicy,
  cwd: string,
  insidePath: string,
  outsidePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (fs.sandboxMode === undefined) {
    throw new EvolutionError('invalid_input', 'DSH filesystem provider is not sandbox-enforcing; modify/create cannot proceed', {
      reason: 'unsandboxed_filesystem_provider',
    })
  }
  const resolveOptions = signal ? { signal } : undefined
  const workspace = await fs.resolve(cwd, resolveOptions)
  const inside = await fs.resolve(insidePath, resolveOptions)
  const outside = await fs.resolve(outsidePath, resolveOptions)
  if (!fs.contains(workspace, inside) || fs.contains(workspace, outside)) {
    throw new EvolutionError('invalid_input', 'DSH filesystem provider reported an invalid managed-source containment boundary', {
      reason: 'filesystem_containment_mismatch',
    })
  }
  await fs.writeText(inside, 'autoevo sandbox probe\n', undefined, signal, policy)
  let escaped = false
  try {
    await fs.writeText(outside, 'autoevo escape probe\n', undefined, signal, policy)
    escaped = true
  } catch {
    // Expected: the real sandboxed filesystem rejects a write outside workspaceRoot.
  }
  if (escaped || await exists(outsidePath)) {
    throw new EvolutionError('invalid_input', 'DSH filesystem sandbox accepted an outside-workspace write', {
      reason: 'filesystem_escape_probe_failed',
    })
  }
}

async function probeShell(
  sandbox: SandboxProvider,
  runner: CommandRunner,
  policy: SandboxExecutionPolicy,
  cwd: string,
  insidePath: string,
  outsidePath: string,
  signal?: AbortSignal,
): Promise<'full' | 'partial'> {
  const script = "require('node:fs').writeFileSync(process.argv[1], 'autoevo shell probe\\n')"
  const inside = sandbox.confine([process.execPath, '-e', script, insidePath], {
    mode: 'workspace-write',
    workspaceRoot: policy.workspaceRoot,
    ...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
  })
  const insideResult = await runner.run({
    argv: inside.argv as [string, ...string[]],
    cwd,
    allowFailure: true,
    ...(signal ? { signal } : {}),
  })
  if (insideResult.exitCode !== 0 || !(await exists(insidePath))) {
    throw new EvolutionError('invalid_input', 'DSH shell sandbox rejected an in-workspace write required for modify/create', {
      reason: 'shell_incapable',
      enforcement: inside.enforcement,
    })
  }

  const outside = sandbox.confine([process.execPath, '-e', script, outsidePath], {
    mode: 'workspace-write',
    workspaceRoot: policy.workspaceRoot,
    ...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
  })
  const outsideResult = await runner.run({
    argv: outside.argv as [string, ...string[]],
    cwd,
    allowFailure: true,
    ...(signal ? { signal } : {}),
  })
  if (outsideResult.exitCode === 0 || await exists(outsidePath)) {
    throw new EvolutionError('invalid_input', 'DSH shell sandbox accepted an outside-workspace write', {
      reason: 'shell_escape_probe_failed',
      enforcement: outside.enforcement,
    })
  }
  return inside.enforcement === 'full' && outside.enforcement === 'full' ? 'full' : 'partial'
}

/**
 * Probe the official rc.6 DSH policy, filesystem, and subprocess sandbox seams.
 * The probe runs only after a child session exists and has a durable
 * `workspace-write` override. It owns and removes every probe path.
 */
export async function probeWorkspaceWriteSandbox(
  stack: LiveSandboxStack | undefined,
  session: Session,
  expectedCwd: string,
  signal?: AbortSignal,
): Promise<SandboxProbeResult> {
  if (!stack?.sandbox || !stack.sandboxPolicy || !stack.fs || !stack.runner) {
    throw new EvolutionError('invalid_input', 'The official DSH sandbox, policy, filesystem, and subprocess services are required for modify/create', {
      reason: 'missing_sandbox_service',
    })
  }
  const cwd = normalizePath(expectedCwd)
  const policy = stack.sandboxPolicy.resolve({ session })
  if (policy.mode !== 'workspace-write') {
    throw new EvolutionError('invalid_input', 'Child session sandbox mode must be workspace-write', {
      reason: 'wrong_sandbox_mode',
      actual: policy.mode,
    })
  }
  if (normalizePath(policy.workspaceRoot) !== cwd) {
    throw new EvolutionError('invalid_input', 'Child session sandbox workspaceRoot is not the managed source repository', {
      reason: 'cwd_mismatch',
      expected: cwd,
      actual: policy.workspaceRoot,
    })
  }

  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const insideFs = path.join(cwd, `.autoevo-fs-probe-${nonce}`)
  const insideShell = path.join(cwd, `.autoevo-shell-probe-${nonce}`)
  const outsideRoot = path.dirname(cwd)
  const outsideFs = path.join(outsideRoot, `.autoevo-fs-escape-${nonce}`)
  const outsideShell = path.join(outsideRoot, `.autoevo-shell-escape-${nonce}`)
  if (!isPathInside(cwd, insideFs) || isPathInside(cwd, outsideFs)) {
    throw new EvolutionError('invalid_input', 'Sandbox probe paths did not form the expected containment boundary')
  }
  for (const candidate of [insideFs, insideShell, outsideFs, outsideShell]) {
    if (await exists(candidate)) {
      throw new EvolutionError('invalid_input', 'Sandbox probe path unexpectedly already exists', { path: candidate })
    }
  }

  try {
    await probeFilesystem(stack.fs, policy, cwd, insideFs, outsideFs, signal)
    const enforcement = await probeShell(stack.sandbox, stack.runner, policy, cwd, insideShell, outsideShell, signal)
    return {
      ok: true,
      mode: 'workspace-write',
      cwd,
      platform: process.platform,
      enforcement,
      isolation: 'integrity-partial',
      note: process.platform === 'win32'
        ? 'Windows sandbox enforcement is integrity-oriented partial isolation; it does not claim confidentiality or network isolation.'
        : `workspace-write sandbox probes passed with ${enforcement} shell enforcement.`,
    }
  } finally {
    await Promise.all([insideFs, insideShell, outsideFs, outsideShell].map(async (candidate) => {
      await rm(candidate, { force: true }).catch(() => undefined)
    }))
  }
}

export const _testing = { isPathInside, normalizePath }
