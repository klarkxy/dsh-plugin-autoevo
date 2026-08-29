import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolCallKind, type ToolCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FORGED_RESUME_HOST_KEYS } from './contracts.js'
import { EvolutionError } from './errors.js'
import { parseRequestIntent } from './resolver/intent.js'
import { copyForArgs } from './i18n.js'
import type { CapabilityEvolutionService } from './service.js'
import { compactAgentView } from './workflow/agent-view.js'
import type { WorkflowView } from './workflow/contracts.js'

function rejectForgedResumeArgs(args: Record<string, unknown>): void {
  for (const key of FORGED_RESUME_HOST_KEYS) {
    const snake = key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)
    if (args[key] !== undefined || args[snake] !== undefined) {
      throw new EvolutionError('invalid_input', 'ResumeInput does not accept Host-owned selection, commitment, or lease fields', {
        key,
      })
    }
  }
}

const jsonOutput = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

function recordArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function genericPendingCard(args: unknown, english: string, chinese: string, kind: ToolCallKind): ToolCallView {
  return { card: 'generic', title: copyForArgs(args, english, chinese), kind }
}

function presentResumePendingCard(args: Record<string, unknown>): ToolCallView {
  const decision = recordArgs(args.decision)
  const navigation = recordArgs(args.navigation)
  const action = typeof decision.action === 'string' ? decision.action : ''
  const navKind = typeof navigation.kind === 'string' ? navigation.kind : ''
  if (action === 'modify_this' || navKind === 'finish_managed_work') {
    return genericPendingCard(args, 'Running authorized managed construction', '已授权，正在受管施工会话中修改', 'edit')
  }
  if (action === 'create_new') {
    return genericPendingCard(args, 'Running authorized managed creation', '已授权，正在受管施工会话中创建', 'edit')
  }
  if (action === 'use_this' || action === 'apply_recovery') {
    return genericPendingCard(args, 'Installing and verifying the reviewed plugin; this may take several minutes', '正在安装并验证已审查的插件，可能需要几分钟', 'execute')
  }
  if (action === 'stop' || navKind === 'stop') {
    return genericPendingCard(args, 'Stopping this capability request', '正在停止本次能力请求', 'other')
  }
  if (navKind === 'review_candidates') {
    return genericPendingCard(args, 'Reviewing selected plugin candidates', '正在审查选中的插件候选', 'read')
  }
  if (action === 'enable_builtin') {
    return genericPendingCard(args, 'Enabling the confirmed built-in Host capability', '正在启用已确认的内置能力', 'execute')
  }
  if (navKind === 'clarify_requirement') {
    return genericPendingCard(args, 'Applying the clarification and starting search', '正在应用澄清并开始搜索', 'search')
  }
  if (navKind === 'review_existing') {
    return genericPendingCard(args, 'Reviewing the plugin\'s known source; this is not a modification', '正在审查这份插件的已知来源，这不是修改', 'read')
  }
  if (navKind === 'search_more') {
    return genericPendingCard(args, 'Searching for more plugin candidates', '正在搜索更多插件候选', 'search')
  }
  if (navKind === 'reuse_local') {
    return genericPendingCard(args, 'Using the existing local capability unchanged', '正在原样使用已有本地能力', 'read')
  }
  if (navKind === 'enable_builtin') {
    return genericPendingCard(args, 'Selecting the built-in capability for final confirmation', '正在选择内置能力并进入最终确认', 'read')
  }
  return genericPendingCard(args, 'Continuing the capability workflow', '正在继续能力工作流', 'other')
}

function presentCapabilityToolCall(name: string, args: unknown): ToolCallView {
  if (name === 'capability_workflow') {
    if (typeof recordArgs(args).clarification_question === 'string') {
      return genericPendingCard(args, 'Waiting for one clarification before search', '搜寻前需要一次澄清', 'other')
    }
    return genericPendingCard(args, 'Searching for reusable plugins', '正在搜索可复用插件', 'search')
  }
  if (name === 'capability_workflow_refine') {
    return genericPendingCard(args, 'Refining plugin discovery', '正在补充插件发现', 'search')
  }
  if (name === 'capability_workflow_present') {
    return genericPendingCard(args, 'Preparing the candidate shortlist', '正在准备候选短名单', 'search')
  }
  if (name === 'capability_workflow_diagnose') {
    return genericPendingCard(args, 'Diagnosing the capability workflow', '正在诊断能力工作流', 'other')
  }
  if (name === 'capability_workflow_recover') {
    return genericPendingCard(args, 'Cleaning up and restarting plugin discovery', '正在清理并重新发现插件', 'other')
  }
  if (name === 'plugin_remove') {
    return genericPendingCard(args, 'Removing the selected plugin', '正在移除所选插件', 'delete')
  }
  if (name === 'capability_versions') {
    return genericPendingCard(args, 'Listing installed versions of a capability', '正在列出能力的安装版本', 'read')
  }
  if (name === 'capability_rollback') {
    return genericPendingCard(args, 'Rolling back to a previous installed version', '正在回滚到先前安装的版本', 'execute')
  }
  if (name === 'capability_adopt') {
    return genericPendingCard(args, 'Adopting an unmanaged installed plugin into Host tracking', '正在把未登记的已装插件纳入托管台账', 'read')
  }
  if (name === 'capability_updates') {
    return genericPendingCard(args, 'Checking upstream updates for tracked installations', '正在检查已跟踪安装的上游更新', 'read')
  }
  if (name === 'capability_workflow_resume') return presentResumePendingCard(recordArgs(args))
  return genericPendingCard(args, 'Working on the capability request', '正在处理能力请求', 'other')
}

const QUERY_SHAPE_RULE = '1–5 complementary exact GitHub search phrases, 1–2 terms each. GitHub ANDs terms inside a phrase, so never pass prose or pack many concepts into one query.'

export function createTools(service: CapabilityEvolutionService): ToolDefinition[] {
  return [
    defineTool({
      name: 'capability_workflow',
      description: `Start autonomous capability discovery. Host preserves the current top-level user message as the authoritative requirement; requirement is only a non-authoritative summary. Supply ${QUERY_SHAPE_RULE} Host only normalizes, validates, scopes, and executes the phrases; it never rewrites supplied phrases, and derives complementary fallback phrases from the authoritative requirement only when none are supplied. If Host rejects query shape, correct the arguments and retry in the same user turn; rejected queries consume no search quota. If one material clarification is required, omit queries until the fresh answer and provide replacement queries through clarify_requirement.`,
      parameters: {
        requirement: { type: 'string', required: true, description: 'Non-authoritative search summary. Host stores the current top-level user message as the original requirement.' },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: `Agent-planned phrases: ${QUERY_SHAPE_RULE} Omit only when asking one material clarification.`,
        },
        clarification_question: { type: 'string', description: 'Optional single question, at most 300 characters, only when ambiguity materially changes the search surface.' },
        intent: {
          type: 'object',
          required: true,
          additionalProperties: false,
          description: 'Read-only classification of this request. Grants no mutation. evolve_existing reviews/modifies a named installed or previously reviewed plugin and must be used for repair, upgrade, or improve-known-source; reuse_existing uses an existing capability unchanged; discover_or_reuse searches with local reuse allowed. Do not use discover_or_reuse to repair a failed install or improve a source already reviewed in this Host.',
          properties: {
            operation: {
              type: 'string',
              enum: ['discover_or_reuse', 'reuse_existing', 'evolve_existing'],
              required: true,
            },
            required_surface: {
              type: 'string',
              enum: ['any', 'native_dsh_plugin'],
              required: true,
            },
            target_name: {
              type: 'string',
              description: 'Exact local capability or package name when evolving or reusing a specific installed target.',
            },
            evolve_reason: {
              type: 'string',
              enum: ['repair', 'upgrade', 'improve_known_source'],
              description: 'Optional Host-facing reason under evolve_existing. repair is a failed activation/install; upgrade is a live installed plugin; improve_known_source is an already-reviewed GitHub snapshot.',
            },
          },
        },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow', args),
      async execute(args, exec) {
        if (!args.clarification_question && (args.queries?.length ?? 0) === 0) {
          throw new EvolutionError('invalid_input', 'capability_workflow requires one to five Agent-planned exact search phrases unless asking one material clarification')
        }
        return compactAgentView(await service.start(
          args.requirement,
          exec,
          parseRequestIntent(args.intent),
          args.clarification_question,
          args.queries,
        ) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_refine',
      description: `Refine an open discovery pool with Agent-planned complementary exact query phrases or strict owner/repository identities. ${QUERY_SHAPE_RULE} Host validates and executes these parameters unchanged. Correct a rejected query plan in the same user turn; rejection consumes no search quota. This is read-only and cannot seal Gate 1, review, install, modify, or create.`,
      parameters: {
        workflow_id: { type: 'string', required: true },
        queries: { type: 'array', items: { type: 'string' } },
        repositories: { type: 'array', items: { type: 'string' } },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_refine', args),
      async execute(args, exec) {
        return compactAgentView(await service.refine({
          workflowId: args.workflow_id,
          ...(args.queries ? { queries: args.queries } : {}),
          ...(args.repositories ? { repositories: args.repositories } : {}),
        }, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_present',
      description: 'Seal zero to five candidate IDs from the current Host discovery pool into the Gate-1 shortlist. If a collection reports more than five bundle paths, retry with one exact package_selector returned by that error. Use an empty array when search found no relevant candidate.',
      parameters: {
        workflow_id: { type: 'string', required: true },
        candidate_ids: { type: 'array', items: { type: 'string' }, required: true },
        package_selectors: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              candidate_id: { type: 'string', required: true },
              package_path: { type: 'string', required: true },
            },
          },
        },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_present', args),
      async execute(args, exec) {
        return compactAgentView(await service.present({
          workflowId: args.workflow_id,
          candidateIds: args.candidate_ids,
          ...(args.package_selectors ? { packageSelectors: args.package_selectors.map((item) => ({
            candidateId: item.candidate_id,
            packagePath: item.package_path,
          })) } : {}),
        }, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_resume',
      description: 'Interpret a fresh user reply at a sealed Host gate, or continue Host-owned managed construction after an authorized modify/create. Use navigation for candidate review/search/local reuse/Gate-1 built-in selection/managed recovery, or decision for the final use/modify/create/built-in enable/stop choice. For search_more, carry any fresh user-supplied search terms or exact GitHub repository through queries/repositories. Host validates the current interrupt except for managed recovery, which continues the already-authorized workflow.',
      parameters: {
        workflow_id: { type: 'string', required: true, description: 'Workflow id returned by capability_workflow.' },
        interrupt_id: { type: 'string', description: 'interrupt_id from the current interrupt payload. Required at user gates; omit only when continuing an already-authorized managed recovery.' },
        navigation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['clarify_requirement', 'review_candidates', 'review_existing', 'search_more', 'reuse_local', 'enable_builtin', 'stop', 'finish_managed_work'],
              required: true,
            },
            candidate_ids: { type: 'array', items: { type: 'string' } },
            review_mode: { type: 'string', enum: ['fixed', 'adaptive'] },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: `Fresh phrases from the user reply: ${QUERY_SHAPE_RULE} Legal for clarify_requirement or search_more.`,
            },
            repositories: {
              type: 'array',
              items: { type: 'string' },
              description: 'Strict owner/repository identities or exact GitHub repository root URLs from the user. Legal only for search_more.',
            },
            clarified_intent: {
              type: 'object',
              additionalProperties: false,
              description: 'Required only for clarify_requirement. Read-only reclassification after the Host-captured answer.',
              properties: {
                operation: { type: 'string', enum: ['discover_or_reuse', 'reuse_existing', 'evolve_existing'], required: true },
                required_surface: { type: 'string', enum: ['any', 'native_dsh_plugin'], required: true },
                target_name: { type: 'string' },
                evolve_reason: { type: 'string', enum: ['repair', 'upgrade', 'improve_known_source'] },
              },
            },
          },
        },
        decision: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['use_this', 'apply_recovery', 'modify_this', 'create_new', 'enable_builtin', 'stop'],
              required: true,
              description: 'Your semantic interpretation of the user\'s fresh final choice; must be offered by the current interrupt.',
            },
            candidate_id: {
              type: 'string',
              description: 'Required for use_this, apply_recovery, modify_this, or enable_builtin. Copy the id from that action\'s current candidate_ids.',
            },
            recovery_id: {
              type: 'string',
              description: 'Required only for apply_recovery. Copy one id from that action\'s current recovery_ids; do not submit recovery parameters.',
            },
          },
        },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_resume', args),
      async execute(args, exec) {
        rejectForgedResumeArgs(args as Record<string, unknown>)
        if (args.navigation?.kind === 'clarify_requirement' && (args.navigation.queries?.length ?? 0) === 0) {
          throw new EvolutionError('invalid_input', 'clarify_requirement requires one to five fresh Agent-planned exact search phrases')
        }
        if (args.navigation?.kind === 'search_more'
          && (args.navigation.queries?.length ?? 0) === 0
          && (args.navigation.repositories?.length ?? 0) === 0) {
          throw new EvolutionError('invalid_input', 'search_more requires fresh Agent-planned exact search phrases or an exact GitHub repository')
        }
        return compactAgentView(await service.resume({
          workflowId: args.workflow_id,
          ...(args.interrupt_id ? { interruptId: args.interrupt_id } : {}),
          ...(args.navigation ? {
            navigation: {
              kind: args.navigation.kind,
              ...(args.navigation.candidate_ids ? { candidateIds: args.navigation.candidate_ids } : {}),
              ...(args.navigation.review_mode ? { reviewMode: args.navigation.review_mode } : {}),
              ...(args.navigation.queries ? { queries: args.navigation.queries } : {}),
              ...(args.navigation.repositories ? { repositories: args.navigation.repositories } : {}),
              ...(args.navigation.clarified_intent
                ? { clarifiedIntent: parseRequestIntent(args.navigation.clarified_intent) }
                : {}),
            },
          } : {}),
          ...(args.decision ? {
            decision: {
              action: args.decision.action,
              ...(args.decision.candidate_id ? { candidateId: args.decision.candidate_id } : {}),
              ...(args.decision.recovery_id ? { recoveryId: args.decision.recovery_id } : {}),
            },
          } : {}),
        }, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_diagnose',
      description: 'Read bounded, sanitized facts linked to this owner workflow after discovery, review, managed-child, installation, verification, or cleanup failure. Never retries or mutates anything.',
      parameters: {
        workflow_id: { type: 'string', required: true },
        probes: {
          type: 'array',
          items: { type: 'string', enum: ['discovery', 'review', 'installation', 'verification', 'managed_child', 'cleanup'] },
          required: true,
        },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_diagnose', args),
      async execute(args, exec) {
        return compactAgentView(await service.diagnose({
          workflowId: args.workflow_id,
          probes: args.probes,
        }, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_recover',
      description: 'Clean up the exact installation owned by this workflow and start a new discovery from the original requirement. Two legal modes: (1) failure recovery — the workflow is at a sealed recovery interrupt; interrupt_id is required. (2) post-install restart — the workflow already completed as installed, restart_required, activated, or awaiting_user_test, and the user made a new top-level request to clean up and start over; omit interrupt_id. Never accepts an installation id. If this or the previous tool result is waiting or a completed presentation, do not call again in the same top-level user message.',
      parameters: {
        workflow_id: { type: 'string', required: true, description: 'Workflow id returned by capability_workflow.' },
        interrupt_id: {
          type: 'string',
          description: 'Required for sealed failure recovery. Omit for a completed-install restart driven by a fresh explicit user request.',
        },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_recover', args),
      async execute(args, exec) {
        const record = args as Record<string, unknown>
        if (record.installation_id !== undefined || record.installationId !== undefined) {
          throw new EvolutionError('invalid_input', 'capability_workflow_recover never accepts an installation id')
        }
        return compactAgentView(await service.recover({
          workflowId: args.workflow_id,
          ...(args.interrupt_id ? { interruptId: args.interrupt_id } : {}),
        }, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_versions',
      description: 'List the Host-tracked installation version chain for one capability package, newest lineage last, with the live active version and artifact availability. Read-only.',
      parameters: {
        package_name: { type: 'string', description: 'Exact package name. Either package_name or installation_id is required.' },
        installation_id: { type: 'string', description: 'Any installation id of the package; resolves the package name from the receipt.' },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_versions', args),
      async execute(args) {
        return await service.listVersions({
          ...(args.package_name ? { packageName: args.package_name } : {}),
          ...(args.installation_id ? { installationId: args.installation_id } : {}),
        }) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_rollback',
      description: 'Roll back one capability to a previously installed version by reinstalling its linked reviewed source through the standard approved install path. Defaults to the direct predecessor of the given current installation. Never bypasses user approval.',
      parameters: {
        installation_id: { type: 'string', required: true, description: 'The currently active installation id to roll back from.' },
        target_installation_id: { type: 'string', description: 'The version to restore. Omit to use the direct predecessor.' },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_rollback', args),
      async execute(args, exec) {
        return await service.rollback({
          installationId: args.installation_id,
          ...(args.target_installation_id ? { targetInstallationId: args.target_installation_id } : {}),
        }, exec) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_adopt',
      description: 'Without package_name, scan the current profile for installed plugins the Host does not track and list them. With package_name, register one such plugin as an adopted installation receipt so it becomes visible to capability_versions and capability_updates. Adopted receipts have no review and cannot be rolled back to.',
      parameters: {
        package_name: { type: 'string', description: 'Exact package name from the orphan scan. Omit to only list untracked installed plugins.' },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_adopt', args),
      async execute(args) {
        if (!args.package_name) return await service.scanOrphans() as unknown as JsonValue
        return await service.adopt({ packageName: args.package_name }) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_updates',
      description: 'Read-only check comparing every tracked installation pinned to an exact GitHub commit against its upstream default-branch head and latest release. Reports update availability; never installs or upgrades anything.',
      parameters: {},
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_updates', args),
      async execute(_args, exec) {
        return await service.checkUpdates(exec) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'plugin_remove',
      description: 'Request one-time approval and remove exactly one installation identified by an owned receipt. Never deletes a managed source repository.',
      parameters: {
        installation_id: { type: 'string', required: true },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('plugin_remove', args),
      async execute(args, exec) {
        return await service.remove({ installationId: args.installation_id }, exec) as unknown as JsonValue
      },
    }),
  ]
}

export const _testing = {
  presentCapabilityToolCall,
}
