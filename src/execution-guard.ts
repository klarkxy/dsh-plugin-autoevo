import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { TOOL_NAMES, type ExecutionLease } from './contracts.js'
import { isNewCordisDefinition } from './creation-guard.js'

export type ExecutionRole = 'parent' | 'child'

const AUTOEVO_TOOLS = new Set<string>(TOOL_NAMES)
const FS_WRITE_TOOLS = new Set(['write', 'edit', 'fs_write', 'fs_edit', 'file_write', 'file_edit'])
const FS_READ_TOOLS = new Set([
  'read',
  'fs_read',
  'file_read',
  'search',
  'fs_search',
  'grep',
  'glob',
  'list_dir',
])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'terminal'])
const CORDIS_MUTATION_TOOLS = new Set(['cordis_define', 'cordis_mount', 'cordis_unmount'])
const DELEGATION_TOOLS = new Set([
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'workflow',
  'ralph',
  'agent',
  'task',
])
const PLUGIN_MUTATION_TOOLS = new Set(['plugin_install', 'plugin_remove', 'dsh_plugin_add', 'dsh_plugin_remove'])
const READ_ONLY_DISCOVERY_TOOLS = new Set(['find_dsh_plugin', 'web_search', 'web_fetch', 'skill', 'read_skill'])
const CHILD_SUPPORT_TOOLS = new Set(['todo_write', 'todo_read'])
const CODE_MODE_TRANSPORT_TOOL = 'run_code'
const GIT_COMMAND_RE = /(?:^|[\\/\s;&|("'`])git(?:\.exe|\.cmd)?(?=$|[\s)"'`])/iu
const SAFE_GIT_READ_RE = /(?:^|[\s&])["']?git(?:\.exe)?["']?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+(?:status|diff|show|log|rev-parse)\b/iu
const GH_COMMAND_RE = /(?:^|[\\/\s;&|("'`])gh(?:\.exe|\.cmd)?(?=$|[\s)"'`])/iu
const DSH_PLUGIN_MUTATION_RE = /(?:^|[\s;&|])dsh(?:\.cmd)?\s+plugin\b[\s\S]*\b(add|remove|rm|uninstall)\b/iu
const PACKAGE_PUBLICATION_RE = /(?:^|[\s;&|])(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:publish|pack\s+--publish|version)\b/iu
const PACKAGE_DEPENDENCY_MUTATION_RE = /(?:^|[\s;&|])(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|add|i|ci|update|up|remove|rm|uninstall|dlx|exec)|npx(?:\.cmd)?\b)/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function shellCommandText(args: unknown): string {
  if (!isRecord(args)) return ''
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function toolAliases(name: string): string[] {
  const normalized = name.trim().toLowerCase()
  return [normalized, normalized.replace(/^dsh[_-]/u, ''), normalized.replace(/[_-]/gu, '')]
}

function normalizeEndpointName(name: string): string {
  return name.trim().toLowerCase()
}

const BRIDGE_TARGET_KEYS = ['name', 'tool', 'tool_name', 'toolName', 'query'] as const

/** Exact target from DSH bridge arguments. Multiple distinct values or none fail closed. */
export function bridgeTargetFromArguments(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const found = new Set<string>()
  for (const key of BRIDGE_TARGET_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    found.add(trimmed)
  }
  if (found.size !== 1) return undefined
  return [...found][0]
}

export function leaseAllowsExecution(
  lease: ExecutionLease | undefined,
  exec: Pick<ToolExecution, 'name' | 'arguments'>,
): boolean {
  if (!lease) return false
  const endpoint = lease.endpoint
  const name = normalizeEndpointName(exec.name)
  if (endpoint.kind === 'exact_tool') {
    return name.length > 0 && name === normalizeEndpointName(endpoint.name)
  }
  if (endpoint.kind !== 'bridge') return false
  const allowed = endpoint.tools.map((tool) => normalizeEndpointName(tool))
  if (!allowed.includes(name)) return false
  const target = bridgeTargetFromArguments(exec.arguments)
  if (!target) return false
  if (target !== endpoint.target) return false
  const exactTarget = lease.allowedParameterConstraints.exactTarget
  if (exactTarget !== undefined && target !== exactTarget) return false
  return true
}

function matchesSet(name: string, set: Set<string>): boolean {
  const normalizedSet = new Set([...set].flatMap((entry) => toolAliases(entry)))
  return toolAliases(name).some((alias) => normalizedSet.has(alias))
}

function hasUnsafeGitCommand(command: string): boolean {
  if (!GIT_COMMAND_RE.test(command)) return false
  const segments = command.split(/&&|\|\||[;|]/u)
  for (const segment of segments) {
    if (!GIT_COMMAND_RE.test(segment)) continue
    if (!SAFE_GIT_READ_RE.test(segment)) return true
  }
  return false
}

export interface ExecutionGuardOptions {
  role: ExecutionRole
  /** Host-owned lease lookup. Absent or undefined results stay fail-closed. */
  resolveLease?: (exec: Readonly<ToolExecution>) => ExecutionLease | undefined
}

/**
 * Final execution-layer guard for AutoEvo parent and managed-source child sessions.
 * Prompts are not enforcement; denials here are observable and rejectable.
 */
export class ExecutionGuard {
  constructor(private readonly options: ExecutionGuardOptions) {}

  get role(): ExecutionRole {
    return this.options.role
  }

  denyReason(exec: Readonly<ToolExecution>): string | undefined {
    const name = exec.name
    if (this.options.role === 'parent') return this.parentDenial(name, exec)
    return this.childDenial(name, exec)
  }

  preExecute(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    const reason = this.denyReason(exec)
    if (reason) return Promise.resolve({ kind: 'deny', reason })
    return next()
  }

  guard(exec: Readonly<ToolExecution>): string | undefined {
    return this.denyReason(exec)
  }

  private parentDenial(name: string, exec: Readonly<ToolExecution>): string | undefined {
    if (AUTOEVO_TOOLS.has(name)) return undefined
    if (matchesSet(name, FS_READ_TOOLS)) return undefined
    if (matchesSet(name, READ_ONLY_DISCOVERY_TOOLS)) return undefined
    if (matchesSet(name, FS_WRITE_TOOLS)) {
      return 'AutoEvo parent session denies filesystem write/edit; modify/create runs only in a managed workspace-write child.'
    }
    if (matchesSet(name, SHELL_TOOLS)) {
      const command = shellCommandText(exec.arguments)
      if (DSH_PLUGIN_MUTATION_RE.test(command)) {
        return 'AutoEvo parent session denies direct DSH plugin install/remove; use capability_workflow_resume / plugin_remove.'
      }
      return 'AutoEvo parent session denies shell (pwsh/bash); modify/create runs only in a managed workspace-write child.'
    }
    if (matchesSet(name, CORDIS_MUTATION_TOOLS) || isNewCordisDefinition(exec)) {
      return 'AutoEvo parent session denies Cordis mutation/definition; create-new uses a managed git source child session.'
    }
    if (matchesSet(name, DELEGATION_TOOLS)) {
      return 'AutoEvo parent session denies agent/subagent/workflow delegation; only the Host may launch the managed modify/create child.'
    }
    if (matchesSet(name, PLUGIN_MUTATION_TOOLS)) {
      return 'AutoEvo parent session denies direct plugin install/remove tools; use the capability workflow.'
    }
    const lease = this.options.resolveLease?.(exec)
    if (leaseAllowsExecution(lease, exec)) return undefined
    return `AutoEvo parent session denies unrecognized tool ${JSON.stringify(name)}; only AutoEvo decisions and explicit read-only discovery/review tools are allowed.`
  }

  private childDenial(name: string, exec: Readonly<ToolExecution>): string | undefined {
    // DSH Code Mode reserves run_code as a presentation-only transport. Every
    // SDK sub-dispatch re-enters tools/pre-execute and this guard with its real
    // tool name, so allowing the wrapper grants no endpoint capability.
    if (name === CODE_MODE_TRANSPORT_TOOL) return undefined
    if (AUTOEVO_TOOLS.has(name)) {
      return 'Managed source child session denies AutoEvo decision tools; return to the parent workflow for confirmation.'
    }
    if (matchesSet(name, CORDIS_MUTATION_TOOLS) || isNewCordisDefinition(exec)) {
      return 'Managed source child session denies Cordis mutation/definition.'
    }
    if (matchesSet(name, DELEGATION_TOOLS)) {
      return 'Managed source child session denies nested agent/subagent/workflow delegation.'
    }
    if (matchesSet(name, PLUGIN_MUTATION_TOOLS)) {
      return 'Managed source child session denies direct plugin install/remove.'
    }
    if (matchesSet(name, SHELL_TOOLS)) {
      const command = shellCommandText(exec.arguments)
      if (DSH_PLUGIN_MUTATION_RE.test(command)) {
        return 'Managed source child session denies direct DSH plugin install/remove.'
      }
      if (GH_COMMAND_RE.test(command)) {
        return 'Managed source child session denies every GitHub CLI command; publication and external coordination stay with the parent.'
      }
      if (PACKAGE_PUBLICATION_RE.test(command)) {
        return 'Managed source child session denies package publication and release/version commands.'
      }
      if (PACKAGE_DEPENDENCY_MUTATION_RE.test(command)) {
        return 'Managed source child session denies dependency installation or mutation; use only the reviewed repository inputs already present.'
      }
      if (hasUnsafeGitCommand(command)) {
        return 'Managed source child session permits only read-only git status/diff/show/log/rev-parse; the Host owns commits and publication.'
      }
      return undefined
    }
    if (matchesSet(name, FS_READ_TOOLS) || matchesSet(name, FS_WRITE_TOOLS) || matchesSet(name, CHILD_SUPPORT_TOOLS)) return undefined
    return `Managed source child session denies unrecognized tool ${JSON.stringify(name)}; only in-repo filesystem, shell testing, and read-only support tools are allowed.`
  }
}

export const _testing = {
  FS_WRITE_TOOLS,
  SHELL_TOOLS,
  DELEGATION_TOOLS,
  GIT_COMMAND_RE,
  SAFE_GIT_READ_RE,
  GH_COMMAND_RE,
  hasUnsafeGitCommand,
  DSH_PLUGIN_MUTATION_RE,
  PACKAGE_PUBLICATION_RE,
  PACKAGE_DEPENDENCY_MUTATION_RE,
  matchesSet,
  shellCommandText,
  CODE_MODE_TRANSPORT_TOOL,
  normalizeEndpointName,
  bridgeTargetFromArguments,
  leaseAllowsExecution,
}
