import path from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { TOOL_NAMES, type ExecutionLease } from './contracts.js'
import { isNewCordisDefinition } from './creation-guard.js'
import {
  CORDIS_MUTATION_TOOL_NAMES,
  OFFICIAL_CREATOR_SKILLS,
  REQUIRED_INSPECT_TOOLS,
} from './creator-foundation.js'
import { isPathInside, isRecord, toolAliases } from './internal-utils.js'

export type ExecutionRole = 'parent' | 'child' | 'constructor'

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
const CORDIS_MUTATION_TOOLS = new Set<string>(CORDIS_MUTATION_TOOL_NAMES)
const CORDIS_INSPECT_TOOLS = new Set<string>(REQUIRED_INSPECT_TOOLS)
const PARENT_DENIED_CORDIS_TOOLS = new Set([
  'cordis_define',
  'cordis_run',
  'cordis_undefine',
  'cordis_mount',
  'cordis_unmount',
])
const PARENT_SAFE_CORDIS_TOOLS = new Set(['cordis_stop'])
const SEARCH_BYPASS_TOOLS = new Set(['find_dsh_plugin'])
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
const CHILD_SUPPORT_TOOLS = new Set(['todo_write', 'todo_read', 'todo'])
const SKILL_TOOLS = new Set(['skill'])
const OFFICIAL_CHILD_SKILLS = new Set<string>(OFFICIAL_CREATOR_SKILLS)
const GIT_COMMAND_RE = /(?:^|[\\/\s;&|("'`])git(?:\.exe|\.cmd)?(?=$|[\s)"'`])/iu
const SAFE_GIT_READ_RE = /(?:^|[\s&])["']?git(?:\.exe)?["']?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+(?:status|diff|show|log|rev-parse)\b/iu
const GH_COMMAND_RE = /(?:^|[\\/\s;&|("'`])gh(?:\.exe|\.cmd)?(?=$|[\s)"'`])/iu
const DSH_PLUGIN_MUTATION_RE = /(?:^|[\\/\s;&|("'`])dsh(?:\.cmd)?\s+plugin\b[\s\S]*\b(add|install|remove|rm|uninstall)\b/iu
const PACKAGE_PUBLICATION_RE = /(?:^|[\\/\s;&|("'`])(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:publish|pack\s+--publish|version)\b/iu
const GIT_PUBLICATION_OR_DESTRUCTIVE_RE = /(?:^|[\\/\s;&|("'`])git(?:\.exe|\.cmd)?(?:\s+-[^\s]+(?:\s+[^\s]+)?)*\s+(?:push|tag|reset\s+--hard|clean\s+-[^\s]*f)\b/iu
const GH_PUBLICATION_RE = /(?:^|[\\/\s;&|("'`])gh(?:\.exe|\.cmd)?\s+(?:(?:pr|release|repo|gist)\s+(?:create|delete)|workflow\s+run)\b/iu
const PACKAGE_DEPENDENCY_MUTATION_RE = /(?:^|[\\/\s;&|("'`])(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:install|add|i|ci|update|up|remove|rm|uninstall|dlx|exec)|npx(?:\.cmd)?\b)/iu
const RELEASE_DEPLOY_INSTALL_RE = /(?:^|[\\/\s;&|("'`])(?:(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:release|deploy)\b|dsh(?:\.cmd)?\s+(?:release|deploy|publish|install)\b)/iu
const SHELL_CONTROL_RE = /(?:&&|\|\||[;&|<>`$(){}@^]|\r|\n)/u
const SAFE_PARENT_SHELL_RE = /^\s*(?:(?:pwd|ls|dir|cat|type|rg)(?:\.exe|\.cmd)?\b|(?:get-location|get-childitem|get-content|select-string|resolve-path|test-path)\b|git(?:\.exe|\.cmd)?(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+(?:status|diff|show|log|rev-parse)\b)/iu
const UNSAFE_READ_OPTION_RE = /(?:^|\s)(?:--pre(?:-glob)?|--output|--ext-diff|--textconv)(?:=|\s|$)/iu

function shellCommandText(args: unknown): string {
  if (!isRecord(args)) return ''
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return ''
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

const SKILL_TARGET_KEYS = ['name', 'skill', 'skill_name', 'skillName'] as const

export function skillTargetFromArguments(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const found = new Set<string>()
  for (const key of SKILL_TARGET_KEYS) {
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
  /** Absolute managed-source root. Required for constructor path scoping. */
  allowedRoot?: string
  /** Session cwd used to resolve relative parent write targets. */
  cwd?: string
  /** Host/profile/managed roots that the parent model may never modify. */
  protectedRoots?: readonly string[]
}

function writePathFromArguments(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  for (const key of ['path', 'file', 'file_path', 'filePath', 'filename', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function isPathInsideRoot(target: string, root: string): boolean {
  return isPathInside(root, target)
}

function isSafeShellCommand(command: string, allowed: RegExp): boolean {
  return Boolean(command.trim())
    && !SHELL_CONTROL_RE.test(command)
    && !UNSAFE_READ_OPTION_RE.test(command)
    && allowed.test(command)
}

function isFinishManagedWorkResume(exec: Readonly<ToolExecution>): boolean {
  if (normalizeEndpointName(exec.name) !== 'capability_workflow_resume' || !isRecord(exec.arguments)) return false
  if (exec.arguments.decision !== undefined || !isRecord(exec.arguments.navigation)) return false
  return exec.arguments.navigation.kind === 'finish_managed_work'
}

/**
 * Final execution-layer guard for AutoEvo parent and in-parent managed construction.
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
    if (this.options.role === 'constructor') return this.constructorDenial(name, exec)
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
    if (AUTOEVO_TOOLS.has(name)) {
      if (matchesSet(name, PLUGIN_MUTATION_TOOLS)) {
        return 'AutoEvo parent session denies direct plugin install/remove tools; use the sealed workflow recovery path.'
      }
      return undefined
    }
    const bridgeTarget = bridgeTargetFromArguments(exec.arguments)
    const normalizedBridgeTarget = bridgeTarget ? normalizeEndpointName(bridgeTarget) : undefined
    if (CORDIS_INSPECT_TOOLS.has(normalizeEndpointName(name))
      || (normalizedBridgeTarget && CORDIS_INSPECT_TOOLS.has(normalizedBridgeTarget))) return undefined
    if (matchesSet(name, PARENT_SAFE_CORDIS_TOOLS)
      || (normalizedBridgeTarget && matchesSet(normalizedBridgeTarget, PARENT_SAFE_CORDIS_TOOLS))) return undefined
    if (matchesSet(name, PARENT_DENIED_CORDIS_TOOLS)
      || (normalizedBridgeTarget && matchesSet(normalizedBridgeTarget, PARENT_DENIED_CORDIS_TOOLS))
      || isNewCordisDefinition(exec)) {
      return 'Capability Evolution Policy V11 denies Cordis live mutation in the parent session; use the Search-first workflow.'
    }
    if (matchesSet(name, SEARCH_BYPASS_TOOLS)
      || (normalizedBridgeTarget && matchesSet(normalizedBridgeTarget, SEARCH_BYPASS_TOOLS))) {
      return 'Capability Evolution Policy V11 denies direct or nested find_dsh_plugin; start or resume capability_workflow.'
    }
    if (matchesSet(name, SKILL_TOOLS)) {
      const target = skillTargetFromArguments(exec.arguments)
      if (!target || target === 'cordis-plugin-development') {
        return 'Capability Evolution Policy V11 denies loading cordis-plugin-development in the parent session.'
      }
    }
    if (matchesSet(name, DELEGATION_TOOLS)
      || (normalizedBridgeTarget && matchesSet(normalizedBridgeTarget, DELEGATION_TOOLS))) {
      return 'Capability Evolution Policy V11 denies ordinary model, subagent, agent, and workflow delegation before a managed construction grant.'
    }
    if (matchesSet(name, PLUGIN_MUTATION_TOOLS)
      || (normalizedBridgeTarget && matchesSet(normalizedBridgeTarget, PLUGIN_MUTATION_TOOLS))) {
      return 'AutoEvo parent session denies direct plugin install/remove tools; use capability_workflow_resume / plugin_remove.'
    }
    if (matchesSet(name, FS_WRITE_TOOLS)) {
      const target = writePathFromArguments(exec.arguments)
      if (!target) {
        return 'Capability Evolution denies filesystem writes that do not name an explicit workspace path.'
      }
      const resolved = path.resolve(this.options.cwd ?? process.cwd(), target)
      if ((this.options.protectedRoots ?? []).some((root) => isPathInsideRoot(resolved, root))) {
        return 'Capability Evolution denies parent-session writes into the active profile, AutoEvo state, managed sources, or receipt-owned capability roots.'
      }
      return undefined
    }
    if (matchesSet(name, SHELL_TOOLS)) {
      const command = shellCommandText(exec.arguments)
      if (DSH_PLUGIN_MUTATION_RE.test(command)) {
        return 'AutoEvo parent session denies direct DSH plugin install/remove; use capability_workflow_resume / plugin_remove.'
      }
      if (!isSafeShellCommand(command, SAFE_PARENT_SHELL_RE)) {
        return 'Capability Evolution Policy V11 permits only allowlisted read-only shell inspection commands before managed construction.'
      }
    }
    return undefined
  }

  private constructorDenial(name: string, exec: Readonly<ToolExecution>): string | undefined {
    if (AUTOEVO_TOOLS.has(name)) {
      if (isFinishManagedWorkResume(exec)) return undefined
      return 'Managed construction permits only capability_workflow_resume with finish_managed_work; Host owns every other AutoEvo decision, install, removal, recovery, and rollback action.'
    }
    if (CORDIS_INSPECT_TOOLS.has(normalizeEndpointName(name))) return undefined
    if (matchesSet(name, CORDIS_MUTATION_TOOLS) || isNewCordisDefinition(exec)) {
      return 'Managed construction denies Cordis mutation/definition; edit repository files in the Host-managed source instead.'
    }
    if (matchesSet(name, PLUGIN_MUTATION_TOOLS)) {
      return 'Managed construction denies direct plugin install/remove.'
    }
    if (matchesSet(name, SHELL_TOOLS)) {
      const command = shellCommandText(exec.arguments)
      if (DSH_PLUGIN_MUTATION_RE.test(command)) {
        return 'Managed construction denies direct DSH plugin install/remove.'
      }
      if (PACKAGE_PUBLICATION_RE.test(command) || RELEASE_DEPLOY_INSTALL_RE.test(command)) {
        return 'Managed construction denies package publication, version, release, deploy, and install commands.'
      }
      if (GIT_PUBLICATION_OR_DESTRUCTIVE_RE.test(command) || GH_PUBLICATION_RE.test(command)) {
        return 'Managed construction requires a fresh user decision before publication or destructive repository operations.'
      }
    }
    if (matchesSet(name, FS_WRITE_TOOLS)) {
      const allowedRoot = this.options.allowedRoot
      if (!allowedRoot) {
        return 'Managed construction denies filesystem writes without a Host-bound source root.'
      }
      const target = writePathFromArguments(exec.arguments)
      if (!target) {
        return 'Managed construction denies filesystem writes that do not name a path inside the managed source.'
      }
      const resolved = path.resolve(this.options.cwd ?? allowedRoot, target)
      if (!isPathInsideRoot(resolved, allowedRoot)) {
        return 'Managed construction denies filesystem writes outside the Host-managed source repository.'
      }
      return undefined
    }
    // Once CreationGuard has bound a managed root, DSH remains authoritative for
    // normal tools, workspace sandboxing, approvals, and collaboration. This
    // guard only owns AutoEvo's decision and final-action boundaries above.
    return undefined
  }

  private childDenial(name: string, exec: Readonly<ToolExecution>): string | undefined {
    if (AUTOEVO_TOOLS.has(name)) {
      return 'Managed source child session denies AutoEvo decision tools; return to the parent workflow for confirmation.'
    }
    if (CORDIS_INSPECT_TOOLS.has(normalizeEndpointName(name))) return undefined
    if (matchesSet(name, CORDIS_MUTATION_TOOLS) || isNewCordisDefinition(exec)) {
      return 'Managed source child session denies Cordis mutation/definition.'
    }
    if (matchesSet(name, SKILL_TOOLS)) {
      const target = skillTargetFromArguments(exec.arguments)
      if (target && OFFICIAL_CHILD_SKILLS.has(target)) return undefined
      return 'Managed source child session permits only the official Creator skills cordis-plugin-development and editing-cordis-compositions.'
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
      if (PACKAGE_PUBLICATION_RE.test(command) || RELEASE_DEPLOY_INSTALL_RE.test(command)) {
        return 'Managed source child session denies package publication, version, release, deploy, and install commands.'
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
    return `Managed source child session denies unrecognized tool ${JSON.stringify(name)}; only in-repo filesystem, shell testing, official Creator skill loads, Cordis inspect, and todo tools are allowed.`
  }
}

export const _testing = {
  FS_WRITE_TOOLS,
  SHELL_TOOLS,
  DELEGATION_TOOLS,
  isPathInsideRoot,
  writePathFromArguments,
  CORDIS_MUTATION_TOOLS,
  CORDIS_INSPECT_TOOLS,
  PARENT_DENIED_CORDIS_TOOLS,
  PARENT_SAFE_CORDIS_TOOLS,
  SEARCH_BYPASS_TOOLS,
  SKILL_TOOLS,
  GIT_COMMAND_RE,
  SAFE_GIT_READ_RE,
  GH_COMMAND_RE,
  hasUnsafeGitCommand,
  DSH_PLUGIN_MUTATION_RE,
  PACKAGE_PUBLICATION_RE,
  PACKAGE_DEPENDENCY_MUTATION_RE,
  RELEASE_DEPLOY_INSTALL_RE,
  SAFE_PARENT_SHELL_RE,
  SHELL_CONTROL_RE,
  UNSAFE_READ_OPTION_RE,
  isSafeShellCommand,
  isFinishManagedWorkResume,
  matchesSet,
  shellCommandText,
  normalizeEndpointName,
  bridgeTargetFromArguments,
  skillTargetFromArguments,
  leaseAllowsExecution,
}
