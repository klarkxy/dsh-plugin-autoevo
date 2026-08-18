import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { capabilityQueries, capabilityTerms, marketplaceSearchQueries, isNameDropMention } from '../../src/resolver/keywords.js'
import { resolveLocalCapabilities, _testing } from '../../src/resolver/local.js'

describe('capability query generation', () => {
  it('expands bilingual browser requirements without copying only the user phrase', () => {
    expect(capabilityQueries('让 Agent 操作网页并截图')).toEqual([
      'screenshot',
      'screen capture',
      'browser automation',
      'playwright',
      'web testing',
    ])
  })

  it('keeps scientific notation as a reviewable capability term', () => {
    expect(capabilityTerms('计算器需要支持科学计数法')).toContain('scientific notation')
  })

  it('sends marketplace phrases in requirement order instead of a single guessed token', () => {
    expect(marketplaceSearchQueries('我需要一个能在dsh里调用codex的能力。')).toEqual(['codex'])
    expect(marketplaceSearchQueries('在 DSH 会话中调用 xAI Grok Build 的能力')).toEqual([
      'xai grok build',
      'xai grok',
      'grok build',
    ])
    expect(marketplaceSearchQueries('通过 xAI API 调用 Grok chat completions，发送消息并返回回复')).toEqual([
      'xai grok',
    ])
  })

  it('keeps screenshot queries when DOM/PNG tokens crowd the marketplace slots', () => {
    // Real requirement from resolution_1ca8f345649e81f66c9a3a46: the ad-hoc
    // English tokens previously evicted "screenshot" and the shortlist
    // degraded to external-browser drivers.
    const requirement = '把当前 DSH 浏览器页面的"对话消息列表 DOM 节点"原样截成单张拼接长图 PNG 并下载到本地;触发方式是 DSH 内一个按钮;不依赖外部浏览器接管,不重排版,保留原 DSH 气泡样式。能力形态最好是动态 Cordis 插件,其次是 DSH 内 npm 包 / Skill。'
    expect(marketplaceSearchQueries(requirement)).toEqual([
      'screenshot',
      'browser automation',
      'dom png cordis npm',
      'dom png',
      'png cordis',
    ])
  })

  it('keeps the conversation subject attached to PNG/JPG screenshot searches', () => {
    // Real requirement from resolution_409cec426df715be5d4d7cfc.
    expect(marketplaceSearchQueries('把当前 DSH 对话记录(用户与助手的多轮消息)截图为图片文件(PNG/JPG),可以保存到本地工作区或下载到浏览器')).toEqual([
      'conversation long png',
      'chat to image',
      'screenshot',
      'conversation export',
      'browser automation',
    ])
  })

  it('uses composite queries instead of a truncated CJK fallback', () => {
    // Real requirement from resolution_19e41a12877ab2e4c9bd35d7, which used
    // to emit the truncated garbage query "我需要一个能把整".
    expect(marketplaceSearchQueries('我需要一个能把整个对话记录做成截图的能力')).toEqual([
      'conversation long png',
      'chat to image',
      'screenshot',
      'conversation export',
      'chat transcript export',
    ])
  })

  it('preserves all facets of a conversation export to long screenshot request', () => {
    expect(marketplaceSearchQueries('我需要一个能把当前 DSH 聊天记录导出成长截图的插件。')).toEqual([
      'conversation export',
      'chat transcript export',
      'conversation long png',
      'chat to image',
      'screenshot',
    ])
  })

  it('keeps product intent focused instead of treating ordinary messages as Telegram', () => {
    const requirement = '通过 xAI API 调用 Grok chat completions，发送消息并返回回复'
    expect(_testing.matchConfidence(
      requirement,
      'THEWOLFWALKER/dsh-notifier',
      'Telegram and messaging notifications for DSH',
    )).toBeLessThan(0.3)
    expect(_testing.matchConfidence(
      requirement,
      'toolazytoname/dsh-plugin-grok',
      'Drive the local Grok Build CLI from DSH',
    )).toBeGreaterThanOrEqual(0.3)
    expect(_testing.matchConfidence(
      requirement,
      'hahaha-taotao/dsh-oauth-api',
      'OAuth plugin for Grok/xAI, Codex, and Claude Code',
    )).toBeGreaterThanOrEqual(0.3)
    expect(_testing.matchConfidence(
      requirement,
      'edison7009/EchoBird',
      'Claude Code, Codex CLI, Grok Build, xAI, DeepSeek Harness, Kimi Code, Qwen Code, Aider, OpenCode',
    )).toBeLessThan(0.3)
  })

  it('accepts screenshot repos for 截成/长图 wording and filters search-only browser tools', () => {
    const requirement = '把当前 DSH 浏览器页面的对话消息列表 DOM 节点原样截成单张拼接长图 PNG 并下载到本地'
    expect(_testing.matchConfidence(
      requirement,
      'paicat1/dsh-screenshot dsh-screenshot',
      'Standalone screen capture for DeepSeek Harness (dsh): browser hotkeys plus an agent-facing capture+read tool.',
    )).toBeGreaterThanOrEqual(0.3)
    expect(_testing.matchConfidence(
      requirement,
      'anweat/dsh-web-search-pro dsh-web-search-pro',
      '增强型、可持久化的网页搜索:多引擎路由、SQLite+LRU 缓存、userscript 风格抽取、Playwright 渲染。',
    )).toBeLessThan(0.3)
  })
})

describe('local matching', () => {
  it('recognizes an active client-only conversation exporter from Loader metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'autoevo-client-plugin-'))
    try {
      const entryPath = path.join(root, 'lib', 'index.js')
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: '@dsh-external/dsh-conv-export',
        description: 'Export the current DSH conversation as Markdown, PDF, or a long PNG image.',
        keywords: ['conversation', 'export', 'long-png'],
        dsh: { client: './dist' },
      }))
      const ctx = {
        get: () => ({
          * entries() {
            yield {
              disabled: false,
              fiber: {},
              options: { id: 'conversation-export', name: pathToFileURL(entryPath).href },
              ctx: { baseUrl: pathToFileURL(entryPath).href },
            }
          },
        }),
        tools: { schemas: () => [] },
        systemPrompt: { assemble: async () => ({ tools: [] }) },
        skills: { list: async () => [] },
      } as unknown as Context

      const result = await resolveLocalCapabilities(
        ctx,
        '我需要一个能把当前 DSH 聊天记录导出成长截图的插件。',
        { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
      )

      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'plugin', name: '@dsh-external/dsh-conv-export', availability: 'available' }),
      ]))
      expect(result.shouldDiscoverRemote).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat screenshot OCR as a full conversation export match', () => {
    expect(_testing.matchConfidence(
      '我需要一个能把当前 DSH 聊天记录导出成长截图的插件。',
      'Anionex/dsh-vision-toolkit',
      'Long screenshot OCR and UI restoration toolkit',
    )).toBeLessThan(0.3)
  })

  it('ignores laundry-list Codex name-drops and keeps a focused Codex plugin', () => {
    const requirement = '我需要一个能在dsh里调用codex的能力。'
    const nameDrop = [
      'Best DeepSeek Harness Design Plugin. Claude Code / Codex / Cursor / DeepSeek Harness / OpenCode & 20+ CLIs via BYOK.',
      'claude-code-for-design',
      'codex-design',
      'cursor-design',
      'dsh-plugin',
    ].join(' ')
    expect(isNameDropMention(nameDrop, 'codex')).toBe(true)
    expect(_testing.matchConfidence(requirement, 'open-design', nameDrop)).toBeLessThan(0.3)
    expect(_testing.matchConfidence(
      requirement,
      'acme/dsh-codex-cli dsh-codex-cli',
      'Call Codex CLI from the current DSH session and return the result',
    )).toBeGreaterThanOrEqual(0.3)
  })

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
    expect(result.shouldDiscoverRemote).toBe(false)
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
    expect(result.shouldDiscoverRemote).toBe(false)
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
    expect(result.shouldDiscoverRemote).toBe(true)
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
    expect(result.shouldDiscoverRemote).toBe(true)
  })
})
