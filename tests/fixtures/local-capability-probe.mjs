import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'capability-evolution-local-capability-probe'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'nebula_ledger_normalize',
    description: 'Normalize nebula ledger markers.',
    parameters: {
      value: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return args.value.trim()
    },
  }))
}
