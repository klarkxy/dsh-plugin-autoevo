import path from 'node:path'
import { EvolutionError } from './errors.js'

export type SandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access' | string

export interface SandboxFilesystemProvider {
  mode?: SandboxMode
  cwd?: string
  /**
   * When true, the Host binds cwd to the managed source path at child launch.
   * Mode must still be workspace-write; containment is probed against expectedCwd.
   */
  bindsManagedCwd?: boolean
  /** Optional containment probe used by tests and capable hosts. */
  assertContained?(candidatePath: string): Promise<boolean> | boolean
}

export interface SandboxShellProvider {
  mode?: SandboxMode
  cwd?: string
  bindsManagedCwd?: boolean
  /** Optional write probe; must reject paths outside cwd. */
  canWrite?(candidatePath: string): Promise<boolean> | boolean
}

export interface SandboxStack {
  filesystem?: SandboxFilesystemProvider | null
  shell?: SandboxShellProvider | null
}

export interface SandboxProbeResult {
  ok: true
  mode: 'workspace-write'
  cwd: string
  platform: NodeJS.Platform
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

/**
 * Probe the live DSH filesystem/shell sandbox stack before exposing modify/create.
 * Fail closed on missing providers, wrong mode/cwd binding, or failed containment.
 * Windows enforcement is integrity-oriented partial isolation only.
 */
export async function probeWorkspaceWriteSandbox(
  stack: SandboxStack | undefined,
  expectedCwd: string,
): Promise<SandboxProbeResult> {
  if (!stack) {
    throw new EvolutionError('invalid_input', 'DSH sandbox stack is unavailable; modify/create cannot proceed', {
      reason: 'missing_sandbox_stack',
    })
  }
  if (!stack.filesystem) {
    throw new EvolutionError('invalid_input', 'DSH filesystem sandbox provider is unavailable; modify/create cannot proceed', {
      reason: 'missing_filesystem_provider',
    })
  }
  if (!stack.shell) {
    throw new EvolutionError('invalid_input', 'DSH shell sandbox provider is unavailable; modify/create cannot proceed', {
      reason: 'missing_shell_provider',
    })
  }

  const cwd = normalizePath(expectedCwd)
  const fsMode = stack.filesystem.mode
  const shellMode = stack.shell.mode
  if (fsMode !== 'workspace-write') {
    throw new EvolutionError('invalid_input', 'Filesystem sandbox mode must be workspace-write for modify/create', {
      reason: 'wrong_filesystem_mode',
      mode: fsMode,
    })
  }
  if (shellMode !== 'workspace-write') {
    throw new EvolutionError('invalid_input', 'Shell sandbox mode must be workspace-write for modify/create', {
      reason: 'wrong_shell_mode',
      mode: shellMode,
    })
  }

  const fsCwd = stack.filesystem.cwd ? normalizePath(stack.filesystem.cwd) : undefined
  const shellCwd = stack.shell.cwd ? normalizePath(stack.shell.cwd) : undefined
  if (!stack.filesystem.bindsManagedCwd && (!fsCwd || fsCwd !== cwd)) {
    throw new EvolutionError('invalid_input', 'Filesystem sandbox cwd is not bound to the managed source repository', {
      reason: 'cwd_mismatch',
      expected: cwd,
      actual: fsCwd,
    })
  }
  if (!stack.shell.bindsManagedCwd && (!shellCwd || shellCwd !== cwd)) {
    throw new EvolutionError('invalid_input', 'Shell sandbox cwd is not bound to the managed source repository', {
      reason: 'cwd_mismatch',
      expected: cwd,
      actual: shellCwd,
    })
  }

  const escapeCandidate = path.join(cwd, '..', 'escape-probe')
  if (typeof stack.filesystem.assertContained === 'function') {
    const contained = await stack.filesystem.assertContained(escapeCandidate)
    if (contained) {
      throw new EvolutionError('invalid_input', 'Filesystem sandbox failed containment probe (path escape accepted)', {
        reason: 'containment_probe_failed',
        escapeCandidate,
      })
    }
  } else if (isPathInside(cwd, escapeCandidate)) {
    throw new EvolutionError('invalid_input', 'Filesystem sandbox containment probe is unsupported on this configuration', {
      reason: 'unsupported_configuration',
    })
  }

  if (typeof stack.shell.canWrite === 'function') {
    const outsideWrite = await stack.shell.canWrite(escapeCandidate)
    if (outsideWrite) {
      throw new EvolutionError('invalid_input', 'Shell sandbox failed outside-cwd write probe', {
        reason: 'shell_escape_probe_failed',
        escapeCandidate,
      })
    }
    const insideWrite = await stack.shell.canWrite(path.join(cwd, 'probe.txt'))
    if (!insideWrite) {
      throw new EvolutionError('invalid_input', 'Shell sandbox rejected an in-cwd write required for workspace-write mode', {
        reason: 'shell_incapable',
      })
    }
  }

  return {
    ok: true,
    mode: 'workspace-write',
    cwd,
    platform: process.platform,
    isolation: 'integrity-partial',
    note: process.platform === 'win32'
      ? 'Windows sandbox enforcement is integrity-oriented partial isolation; it does not claim confidentiality or network isolation.'
      : 'workspace-write sandbox probe passed for managed source modify/create.',
  }
}

export const _testing = { isPathInside, normalizePath }
