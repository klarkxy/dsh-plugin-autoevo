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

  it('uses unique weighted anchors for Zhihu search instead of saturating on generic descriptions', () => {
    const requirement = '在知乎搜索截图相关内容'
    for (const zhihuRequirement of [
      requirement,
      'Zhihu search screenshots',
      '我想要做一个用知乎开放平台搜索的知乎内容的插件',
    ]) {
      expect(_testing.matchConfidence(zhihuRequirement, 'zhihu-search', 'Search Zhihu for posts and answers')).toBeGreaterThan(0.62)
    }
    for (const name of ['mmx-cli', 'pwsh', 'subagent', 'workflow', 'web_search']) {
      expect(_testing.matchConfidence(requirement, name, 'Search content with this plugin tool API platform')).toBeLessThan(0.62)
    }
    expect(_testing.matchConfidence('search plugin tool api content build create platform', 'web_search', 'Search content with this plugin tool API platform')).toBeLessThan(0.3)
  })

  it('resolves the screenshot request to zhihu-search alone above the reuse threshold', async () => {
    const schemas = [
      { name: 'zhihu-search', description: 'Search Zhihu posts, answers, and people' },
      { name: 'mmx-cli', description: 'Create media content with a plugin tool API' },
      { name: 'pwsh', description: 'Execute PowerShell commands and build projects' },
      { name: 'subagent', description: 'Create a subagent workflow' },
      { name: 'workflow', description: 'Build and run a tool workflow' },
      { name: 'web_search', description: 'Search public web content through an API' },
    ]
    const ctx = {
      tools: { schemas: () => schemas },
      systemPrompt: { assemble: async () => ({ tools: schemas.map(({ name }) => ({ name })) }) },
      skills: { list: async () => [] },
    } as unknown as Context

    const result = await resolveLocalCapabilities(
      ctx,
      '我想要做一个用知乎开放平台搜索的知乎内容的插件',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
    )

    expect(result.candidates.filter((candidate) => candidate.confidence >= 0.62)).toEqual([
      expect.objectContaining({ name: 'zhihu-search', availability: 'available' }),
    ])
    expect(result.githubShouldRun).toBe(false)
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
      systemPrompt: { assemble: async () => ({ tools: [
        { name: 'tool_search' },
        { name: 'tool_describe' },
        { name: 'tool_call' },
        { name: 'browser_screenshot' },
      ] }) },
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

  it('does not mistake Creator workflow skills for an existing business capability', async () => {
    const ctx = {
      tools: { schemas: () => [] },
      systemPrompt: { assemble: async () => ({ tools: [] }) },
      skills: { list: async () => [
        {
          name: 'cordis-plugin-development',
          description: 'Create and repair dynamic Cordis Plugins',
          invocation: { modelInvocable: true },
        },
        {
          name: 'autoevo-plugin-creator',
          description: 'AutoEvo workflow for creating dynamic Cordis Plugins',
          invocation: { modelInvocable: true },
        },
      ] },
    } as unknown as Context

    const result = await resolveLocalCapabilities(
      ctx,
      'Create a dynamic Cordis plugin for qzvm-frobulation',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
    )

    expect(result.candidates).toEqual([])
    expect(result.githubShouldRun).toBe(true)
  })

  it('does not claim tool-search reachability when bridge tools are registered but outside the Agent scope', async () => {
    const ctx = {
      tools: { schemas: () => [
        { name: 'tool_search', description: 'Search tools' },
        { name: 'tool_describe', description: 'Describe tools' },
        { name: 'tool_call', description: 'Call tools' },
        { name: 'telegram_send', description: 'Send Telegram messages' },
      ] },
      systemPrompt: { assemble: async () => ({ tools: [] }) },
      skills: { list: async () => [] },
    } as unknown as Context

    const result = await resolveLocalCapabilities(
      ctx,
      'Send a Telegram message',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
    )

    expect(result.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'telegram_send' }),
    ]))
    expect(result.githubShouldRun).toBe(true)
  })
})
