import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { capabilityQueries, capabilityTerms } from '../../src/resolver/keywords.js'
import { resolveLocalCapabilities, _testing } from '../../src/resolver/local.js'

describe('capability query generation', () => {
  it('expands bilingual browser requirements without copying only the user phrase', () => {
    expect(capabilityQueries('让 Agent 操作网页并截图')).toEqual([
      'browser automation',
      'playwright',
      'screenshot',
      'web testing',
    ])
  })

  it('keeps scientific notation as a reviewable capability term', () => {
    expect(capabilityTerms('计算器需要支持科学计数法')).toContain('scientific notation')
  })
})

describe('local matching', () => {
  it('strongly matches a concrete tool and ignores unrelated names', () => {
    expect(_testing.matchConfidence('take a browser screenshot', 'browser_screenshot', 'Capture a page')).toBeGreaterThan(0.62)
    expect(_testing.matchConfidence('run a PowerShell command', 'pwsh', 'Execute a PowerShell command')).toBeGreaterThan(0.62)
    expect(_testing.matchConfidence('take a browser screenshot', 'telegram_send', 'Send a chat message')).toBeLessThan(0.3)
  })

  it('distinguishes scoped tools, tool-search-reachable tools, and model-invocable skills', async () => {
    const schemas = [
      { name: 'tool_search', description: 'Search tools' },
      { name: 'tool_describe', description: 'Describe tools' },
      { name: 'tool_call', description: 'Call tools' },
      { name: 'telegram_send', description: 'Send Telegram messages' },
      { name: 'browser_screenshot', description: 'Capture a browser page' },
    ]
    const ctx = {
      tools: { schemas: () => schemas },
      systemPrompt: { assemble: async () => ({ tools: [{ name: 'browser_screenshot' }] }) },
      skills: {
        list: async () => [{
          name: 'telegram-messaging',
          description: 'Send Telegram messages',
          whenToUse: 'Use for Telegram delivery',
          invocation: { modelInvocable: true },
        }],
      },
    } as unknown as Context
    const result = await resolveLocalCapabilities(
      ctx,
      'Send a Telegram message',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
    )

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool', name: 'telegram_send', availability: 'available_via_tool_search' }),
      expect.objectContaining({ kind: 'skill', name: 'telegram-messaging', availability: 'available' }),
    ]))
    expect(result.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'browser_screenshot' }),
    ]))
    expect(result.githubShouldRun).toBe(false)
  })
})
