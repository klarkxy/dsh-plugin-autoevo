import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolCallKind, type ToolCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FORGED_RESUME_HOST_KEYS } from './contracts.js'
import { EvolutionError } from './errors.js'
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
  if (action === 'modify_this') {
    return genericPendingCard(args, 'AutoEvo is improving and checking the plugin; this may take several minutes', 'AutoEvo 正在改进并检查插件，可能需要几分钟', 'edit')
  }
  if (action === 'create_new') {
    return genericPendingCard(args, 'AutoEvo is creating a new plugin; this may take several minutes', 'AutoEvo 正在创建新插件，可能需要几分钟', 'edit')
  }
  if (action === 'use_this') {
    return genericPendingCard(args, 'Installing and verifying the reviewed plugin; this may take several minutes', '正在安装并验证已审查的插件，可能需要几分钟', 'execute')
  }
  if (action === 'stop' || navKind === 'stop') {
    return genericPendingCard(args, 'Stopping this capability request', '正在停止本次能力请求', 'other')
  }
  if (navKind === 'review_candidates') {
    return genericPendingCard(args, 'Reviewing selected plugin candidates', '正在审查选中的插件候选', 'read')
  }
  if (navKind === 'search_more') {
    return genericPendingCard(args, 'Searching for more plugin candidates', '正在搜索更多插件候选', 'search')
  }
  if (navKind === 'reuse_local') {
    return genericPendingCard(args, 'Checking already-installed local capabilities', '正在检查已安装的本地能力', 'read')
  }
  return genericPendingCard(args, 'Continuing the capability workflow', '正在继续能力工作流', 'other')
}

function presentCapabilityToolCall(name: string, args: unknown): ToolCallView {
  if (name === 'capability_workflow') {
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
  if (name === 'capability_workflow_resume') return presentResumePendingCard(recordArgs(args))
  return genericPendingCard(args, 'Working on the capability request', '正在处理能力请求', 'other')
}

export function createTools(service: CapabilityEvolutionService): ToolDefinition[] {
  return [
    defineTool({
      name: 'capability_workflow',
      description: 'Start autonomous capability discovery with the user\'s original requirement. Returns Host-verified facts and a bounded candidate pool. Refine or present the pool using the dedicated tools; this call does not itself authorize review or mutation.',
      parameters: {
        requirement: { type: 'string', required: true, description: 'Concrete capability required by the current user task.' },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow', args),
      async execute(args, exec) {
        return compactAgentView(await service.start(args.requirement, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_refine',
      description: 'Refine an open discovery pool with bounded query hints or strict owner/repository identities. This is read-only and cannot seal Gate 1, review, install, modify, or create.',
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
      description: 'Seal one to five candidate IDs from the current Host discovery pool into the Gate-1 shortlist. Only a later fresh user reply may select candidates for review.',
      parameters: {
        workflow_id: { type: 'string', required: true },
        candidate_ids: { type: 'array', items: { type: 'string' }, required: true },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_present', args),
      async execute(args, exec) {
        return compactAgentView(await service.present({
          workflowId: args.workflow_id,
          candidateIds: args.candidate_ids,
        }, exec) as WorkflowView) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_resume',
      description: 'Interpret a fresh user reply at a sealed Host gate. Use navigation for candidate review/search/local reuse, or decision for the final reviewed use/modify/create/stop choice. Host validates the current interrupt, scoped candidate IDs, review identity, replay, and authentic user turn.',
      parameters: {
        workflow_id: { type: 'string', required: true, description: 'Workflow id returned by capability_workflow.' },
        interrupt_id: { type: 'string', required: true, description: 'interrupt_id from the current interrupt payload.' },
        navigation: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['review_candidates', 'search_more', 'reuse_local', 'stop'],
              required: true,
            },
            candidate_ids: { type: 'array', items: { type: 'string' } },
            review_mode: { type: 'string', enum: ['fixed', 'adaptive'] },
          },
        },
        decision: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['use_this', 'modify_this', 'create_new', 'stop'],
              required: true,
              description: 'Your semantic interpretation of the user\'s fresh final choice; must be offered by the current interrupt.',
            },
            candidate_id: {
              type: 'string',
              description: 'Required for use_this or modify_this. Copy the id from that action\'s current candidate_ids.',
            },
            retention: {
              type: 'string',
              enum: ['temporary', 'persistent'],
              description: 'Optional for use_this. Interpret the user preference; defaults to temporary. A candidate whose review facts show verificationLayer manual_runtime requires persistent.',
            },
          },
        },
      },
      output: jsonOutput,
      presentCall: (args) => presentCapabilityToolCall('capability_workflow_resume', args),
      async execute(args, exec) {
        rejectForgedResumeArgs(args as Record<string, unknown>)
        return compactAgentView(await service.resume({
          workflowId: args.workflow_id,
          interruptId: args.interrupt_id,
          ...(args.navigation ? {
            navigation: {
              kind: args.navigation.kind,
              ...(args.navigation.candidate_ids ? { candidateIds: args.navigation.candidate_ids } : {}),
              ...(args.navigation.review_mode ? { reviewMode: args.navigation.review_mode } : {}),
            },
          } : {}),
          ...(args.decision ? {
            decision: {
              action: args.decision.action,
              ...(args.decision.candidate_id ? { candidateId: args.decision.candidate_id } : {}),
              ...(args.decision.retention ? { retention: args.decision.retention } : {}),
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
