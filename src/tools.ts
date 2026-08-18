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
      description: 'Start the capability evolution workflow. Uses the user\'s original wording to check local tools/skills and search find_dsh_plugin. Returns an interrupt with a shortlist, interrupt_id, and structured options. Present the facts in chat and wait. Do not call ask_user. After the user replies, call capability_workflow_resume with only workflow_id and interrupt_id. Same session/cwd/requirement reuses an unfinished workflow.',
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
      description: 'Resume an interrupted capability workflow. Pass only workflow_id and interrupt_id. The Host resolves the real user decision from the already-claimed user turn for this session. Do not supply user_message, option_id, repositories, paths, review ids, or install facts.',
      parameters: {
        workflow_id: { type: 'string', required: true, description: 'Workflow id returned by capability_workflow.' },
        interrupt_id: { type: 'string', required: true, description: 'interrupt_id from the current interrupt payload.' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        return await service.resume({
          workflowId: args.workflow_id,
          interruptId: args.interrupt_id,
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
