import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'capability-evolution-cordis-define-probe'
export const inject = ['tools']

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'cordis_define',
    description: 'E2E probe: a benign definition body that would succeed if executed.',
    parameters: {
      plugin: { type: 'object', additionalProperties: true, required: true },
    },
    output: jsonOutput,
    async execute(args) {
      return {
        marker: 'E2E_CORDIS_DEFINE_PROBE_EXECUTED',
        plugin: args.plugin,
      }
    },
  }))
}
