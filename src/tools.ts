import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CapabilityEvolutionService } from './service.js'

const jsonOutput = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

export function createTools(service: CapabilityEvolutionService): ToolDefinition[] {
  return [
    defineTool({
      name: 'capability_workflow',
      description: 'Start the capability evolution workflow. Uses the user\'s original wording to check local tools/skills and search find_dsh_plugin. Returns an interrupt with a shortlist and structured options. Present the facts in chat and wait. Do not call ask_user. After the user replies, call capability_workflow_resume.',
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
      description: 'Resume an interrupted capability workflow. Pass the user\'s latest chat message verbatim and the option_id from the current interrupt. This is the only way to inspect repositories, allow one new plugin, reuse a local capability, confirm use-this / improve-this, review a local checkout, install, or stop. Do not invent a create-new decision.',
      parameters: {
        workflow_id: { type: 'string', required: true, description: 'Workflow id returned by capability_workflow.' },
        user_message: { type: 'string', required: true, description: 'The user\'s latest chat reply, verbatim.' },
        option_id: {
          type: 'string',
          enum: ['inspect', 'search_more', 'use_local', 'create_new', 'stop', 'use_this', 'modify_this', 'resume_modify'],
          required: true,
          description: 'Option id from the current interrupt payload.',
        },
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exactly one owner/repo when inspecting. Optional when confirming a review.',
        },
        path: { type: 'string', description: 'Local Git worktree root after improve-this work is done.' },
        ref: { type: 'string', description: 'Optional Git ref; resolved to an exact commit before review.' },
        review_id: { type: 'string', description: 'Review id when confirming use-this or improve-this.' },
        target_profile: { type: 'string', description: 'Explicit DSH profile name when option_id is use_this.' },
        retention: { type: 'string', enum: ['temporary', 'persistent'], description: 'Install retention when option_id is use_this.' },
        verification_task: { type: 'string', description: 'Task for a fresh DSH child. Required for temporary trials.' },
        verification_expected_text: { type: 'string', description: 'Optional exact text that must appear in the completed child final answer.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        return await service.resume({
          workflowId: args.workflow_id,
          userMessage: args.user_message,
          optionId: args.option_id,
          ...(args.repositories !== undefined ? { repositories: args.repositories } : {}),
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.ref !== undefined ? { ref: args.ref } : {}),
          ...(args.review_id !== undefined ? { reviewId: args.review_id } : {}),
          ...(args.target_profile !== undefined ? { targetProfile: args.target_profile } : {}),
          ...(args.retention !== undefined ? { retention: args.retention } : {}),
          ...(args.verification_task !== undefined ? { verificationTask: args.verification_task } : {}),
          ...(args.verification_expected_text !== undefined ? { verificationExpectedText: args.verification_expected_text } : {}),
        }, exec) as unknown as JsonValue
      },
    }),
    defineTool({
      name: 'plugin_remove',
      description: 'Request one-time approval and remove exactly one installation identified by an owned receipt.',
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
