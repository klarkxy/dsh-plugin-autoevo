import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { TOOL_NAMES } from './contracts.js'
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
const GIT_PUBLICATION_RE = /\bgit\b[\s\S]*\b(push|tag|release)\b|\bgh\b[\s\S]*\b(pr|release)\b/iu
const DSH_PLUGIN_MUTATION_RE = /(?:^|[\s;&|])dsh(?:\.cmd)?\s+plugin\b[\s\S]*\b(add|remove|rm|uninstall)\b/iu

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

function matchesSet(name: string, set: Set<string>): boolean {
  return toolAliases(name).some((alias) => set.has(alias) || set.has(name))
}

export interface ExecutionGuardOptions {
  role: ExecutionRole
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
    return undefined
  }

  private childDenial(name: string, exec: Readonly<ToolExecution>): string | undefined {
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
      if (GIT_PUBLICATION_RE.test(command)) {
        return 'Managed source child session denies git push/tag/release and gh pr/release publication.'
      }
    }
    return undefined
  }
}

export const _testing = {
  FS_WRITE_TOOLS,
  SHELL_TOOLS,
  DELEGATION_TOOLS,
  GIT_PUBLICATION_RE,
  DSH_PLUGIN_MUTATION_RE,
  matchesSet,
  shellCommandText,
}
