import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'capability-evolution-find-plugin-stub'
export const inject = ['tools']

const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'find_dsh_plugin',
    description: 'E2E stub: return the official calculator plugin without calling the live marketplace.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'number' },
      lang: { type: 'string' },
    },
    output: jsonOutput,
    async execute() {
      return {
        results: [{
          name: 'dsh-tool-calculator',
          url: 'https://github.com/omdsh-dev/dsh-tool-calculator',
          description: 'A calculator tool for DeepSeek Harness',
          stars: 12,
        }],
      }
    },
  }))
}
