import { access, rm } from 'node:fs/promises'
import path from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { EvolutionError } from './errors.js'
import { isNotFound, isPathInside } from './internal-utils.js'
import type { CommandRunner } from './process/runner.js'

/** Live services the caller has already resolved; the probe does not re-validate their presence. */
export interface LiveSandboxStack {
  sandbox: SandboxProvider
  sandboxPolicy: SandboxPolicyService
  fs: FileSystem
  runner: CommandRunner
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

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

async function exists(
  candidate: string,
  signal?: AbortSignal,
  accessPath: (candidate: string) => Promise<void> = access,
): Promise<boolean> {
  throwIfAborted(signal)
  try {
    await accessPath(candidate)
    throwIfAborted(signal)
    return true
  } catch (error) {
    throwIfAborted(signal)
    if (isNotFound(error)) return false
    throw error
  }
}

async function cleanupProbePaths(
  candidates: readonly string[],
  remove: (candidate: string) => Promise<void> = (candidate) => rm(candidate, { force: true }),
): Promise<void> {
  const results = await Promise.allSettled(candidates.map((candidate) => remove(candidate)))
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}

async function probeFilesystem(
  fs: FileSystem,
  policy: SandboxExecutionPolicy,
  cwd: string,
  insidePath: string,
  outsidePath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  if (fs.sandboxMode === undefined) {
    throw new EvolutionError('invalid_input', 'DSH filesystem provider is not sandbox-enforcing; modify/create cannot proceed', {
      reason: 'unsandboxed_filesystem_provider',
    })
  }
  const resolveOptions = signal ? { signal } : undefined
  throwIfAborted(signal)
  const workspace = await fs.resolve(cwd, resolveOptions)
  throwIfAborted(signal)
  const inside = await fs.resolve(insidePath, resolveOptions)
  throwIfAborted(signal)
  const outside = await fs.resolve(outsidePath, resolveOptions)
  throwIfAborted(signal)
  if (!fs.contains(workspace, inside) || fs.contains(workspace, outside)) {
    throw new EvolutionError('invalid_input', 'DSH filesystem provider reported an invalid managed-source containment boundary', {
      reason: 'filesystem_containment_mismatch',
    })
  }
  throwIfAborted(signal)
  await fs.writeText(inside, 'autoevo sandbox probe\n', undefined, signal, policy)
  throwIfAborted(signal)
  let escaped = false
  try {
    throwIfAborted(signal)
    await fs.writeText(outside, 'autoevo escape probe\n', undefined, signal, policy)
    throwIfAborted(signal)
    escaped = true
  } catch (error) {
    throwIfAborted(signal)
    // Expected: the real sandboxed filesystem rejects a write outside workspaceRoot.
  }
  if (escaped || await exists(outsidePath, signal)) {
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
  throwIfAborted(signal)
  const script = "require('node:fs').writeFileSync(process.argv[1], 'autoevo shell probe\\n')"
  const inside = sandbox.confine([process.execPath, '-e', script, insidePath], {
    mode: 'workspace-write',
    workspaceRoot: policy.workspaceRoot,
    ...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
  })
  throwIfAborted(signal)
  const insideResult = await runner.run({
    argv: inside.argv as [string, ...string[]],
    cwd,
    allowFailure: true,
    ...(signal ? { signal } : {}),
  })
  throwIfAborted(signal)
  if (insideResult.exitCode !== 0 || !(await exists(insidePath, signal))) {
    throw new EvolutionError('invalid_input', 'DSH shell sandbox rejected an in-workspace write required for modify/create', {
      reason: 'shell_incapable',
      enforcement: inside.enforcement,
    })
  }

  throwIfAborted(signal)
  const outside = sandbox.confine([process.execPath, '-e', script, outsidePath], {
    mode: 'workspace-write',
    workspaceRoot: policy.workspaceRoot,
    ...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
  })
  throwIfAborted(signal)
  const outsideResult = await runner.run({
    argv: outside.argv as [string, ...string[]],
    cwd,
    allowFailure: true,
    ...(signal ? { signal } : {}),
  })
  throwIfAborted(signal)
  if (outsideResult.exitCode === 0 || await exists(outsidePath, signal)) {
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
  stack: LiveSandboxStack,
  session: Session,
  expectedCwd: string,
  signal?: AbortSignal,
): Promise<SandboxProbeResult> {
  throwIfAborted(signal)
  const cwd = normalizePath(expectedCwd)
  const policy = stack.sandboxPolicy.resolve({ session })
  throwIfAborted(signal)
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
    if (await exists(candidate, signal)) {
      throw new EvolutionError('invalid_input', 'Sandbox probe path unexpectedly already exists', { path: candidate })
    }
  }

  const probePaths = [insideFs, insideShell, outsideFs, outsideShell]
  let primaryFailed = false
  let result: SandboxProbeResult | undefined
  try {
    await probeFilesystem(stack.fs, policy, cwd, insideFs, outsideFs, signal)
    throwIfAborted(signal)
    const enforcement = await probeShell(stack.sandbox, stack.runner, policy, cwd, insideShell, outsideShell, signal)
    throwIfAborted(signal)
    result = {
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
  } catch (error) {
    primaryFailed = true
    throw error
  } finally {
    try {
      await cleanupProbePaths(probePaths)
    } catch (error) {
      if (!primaryFailed) {
        throwIfAborted(signal)
        throw error
      }
    }
  }
  return result!
}

export const _testing = { isPathInside, normalizePath, cleanupProbePaths, exists }
