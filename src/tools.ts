import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { FORGED_RESUME_HOST_KEYS } from './contracts.js'
import { EvolutionError } from './errors.js'
import type { CapabilityEvolutionService } from './service.js'

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

export function createTools(service: CapabilityEvolutionService): ToolDefinition[] {
  return [
    defineTool({
      name: 'capability_workflow',
      description: 'Start capability discovery with the user\'s original wording. A strict full local match is recommended directly; otherwise remote discovery runs automatically. Returns an interrupt-bound shortlist for one read-only candidate-selection turn.',
      parameters: {
        requirement: { type: 'string', required: true, description: 'Concrete capability required by the current user task.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        return await service.start(args.requirement, exec) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'capability_workflow_resume',
      description: 'Resume an AutoEvo workflow. For read-only search/review/reuse, interpret the user request into navigation over candidate IDs from the current interrupt snapshot. For final install/modify/create/stop confirmation, trust your semantic understanding and provide decision with an allowed action, the current option\'s candidate_id when required, and optional retention. The Host binds that interpretation to the fresh authentic user turn and validates workflow boundaries; it does not re-parse the user\'s wording. Never supply user_message, repository names, paths, review ids, install facts, selection receipts, commitments, leases, or endpoints.',
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
              description: 'Optional for use_this. Interpret the user preference; defaults to temporary.',
            },
          },
        },
      },
      output: jsonOutput,
      async execute(args, exec) {
        rejectForgedResumeArgs(args as Record<string, unknown>)
        return await service.resume({
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
        }, exec) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'plugin_remove',
      description: 'Request one-time approval and remove exactly one installation identified by an owned receipt. Never deletes a managed source repository.',
      parameters: {
        installation_id: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args, exec) {
        return await service.remove({ installationId: args.installation_id }, exec) as unknown as JsonValue
      },
    }),
  ]
}
