import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityQualityService } from '../../src/community-quality.js'
import type { RuntimeConfig } from '../../src/config.js'
import { discoverRemoteCandidates, FIND_PLUGIN_TOOL, _testing } from '../../src/discovery/remote.js'

const config: RuntimeConfig = {
  dshHome: 'C:/dsh',
  stateDir: 'C:/dsh/autoevo',
  ghCommand: 'gh',
  gitCommand: 'git',
  dshCommand: 'dsh',
  dshCommandArgs: [],
  maxCandidates: 5,
  maxFiles: 80,
  maxRepositoryBytes: 1_048_576,
  commandTimeoutMs: 30_000,
  forwardedCredentialEnv: [],
  verificationPatchPaths: [],
  evolutionPreset: true,
  communityQualityFilter: false,
  communityReports: false,
  communityQualityEndpoint: '',
  communityQualityTimeoutMs: 2_000,
}

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const exec = {
  callId: 'call-resolve',
  rootCallId: 'call-resolve',
  token: Symbol('resolve'),
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: 'C:/workspace' } } },
} as unknown as ToolRunContext



describe('remote discovery precedence', () => {
  it('uses a larger bounded pool so quality filtering can refill the shortlist', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-quality-remote-'))
    temporary.push(directory)
    const qualityConfig: RuntimeConfig = {
      ...config,
      stateDir: directory,
      maxCandidates: 2,
      communityQualityFilter: true,
      communityQualityEndpoint: 'https://quality.example',
    }
    const execute = vi.fn(async () => ({
      isError: false as const,
      value: {
        results: [
          { name: 'calculator-broken', url: 'https://github.com/acme/calculator-broken', description: 'calculator', stars: 30 },
          { name: 'calculator-good', url: 'https://github.com/acme/calculator-good', description: 'calculator', stars: 20 },
          { name: 'calculator-unknown', url: 'https://github.com/acme/calculator-unknown', description: 'calculator', stars: 10 },
        ],
      },
      content: [],
    }))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      assessments: [
        { repository: 'acme/calculator-broken', classification: 'broken', reasonCodes: ['verification_failed'] },
        { repository: 'acme/calculator-good', classification: 'good', reasonCodes: ['verified'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const ctx = { tools: { get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })), execute } } as unknown as Context

    const result = await discoverRemoteCandidates({
      ctx,
      config: qualityConfig,
      requirement: 'calculator',
      exec,
      quality: new CommunityQualityService(qualityConfig, fetcher),
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('https://quality.example/v1/quality/assessments', expect.objectContaining({ method: 'GET' }))
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ arguments: expect.objectContaining({ limit: 6 }) }))
    expect(result.candidates.map((item) => item.repository)).toEqual(['acme/calculator-good', 'acme/calculator-unknown'])
    expect(result.qualityScreening).toEqual(expect.objectContaining({
      complete: true,
      filtered: [{ repository: 'acme/calculator-broken', classification: 'broken', reasonCodes: ['verification_failed'] }],
    }))
  })

  it('uses a current-scope find_dsh_plugin result without calling gh', async () => {
    const execute = vi.fn(async (_request: { arguments: { query: string, lang: string } }) => ({
      isError: false as const,
      value: {
        results: [{
          name: 'scientific-calculator',
          url: 'https://github.com/acme/scientific-calculator',
          description: 'Scientific notation support',
          stars: 42,
          install: 'untrusted and intentionally ignored',
        }],
        note: 'untrusted and intentionally ignored',
      },
      content: [],
    }))
    const get = vi.fn(() => ({ name: FIND_PLUGIN_TOOL }))
    const ctx = { tools: { get, execute } } as unknown as Context

    const result = await discoverRemoteCandidates({ ctx, config, requirement: '科学计数法计算器', exec })

    expect(get).toHaveBeenCalledWith(FIND_PLUGIN_TOOL, exec.agent)
    const queries = execute.mock.calls.map((call) => (call[0] as { arguments: { query: string, lang: string } }).arguments)
    expect(queries.length).toBeGreaterThan(1)
    expect(queries.some((item) => item.query === 'scientific notation' || item.query === '科学计数法')).toBe(true)
    expect(queries.every((item) => item.lang === 'zh')).toBe(true)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      name: FIND_PLUGIN_TOOL,
      arguments: expect.objectContaining({ limit: 5 }),
      parent: exec.token,
      rootCallId: exec.rootCallId,
    }))
    expect(result.source).toBe('dsh-find-plugin')
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'acme/scientific-calculator',
      stars: 42,
      updatedAt: null,
    })])
  })

  it('offers the plugin marketplace instead of searching GitHub when find_dsh_plugin is absent', async () => {
    const ctx = { tools: { get: vi.fn(() => undefined) } } as unknown as Context

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      requirement: '我需要一个能在dsh里调用codex的能力。',
      exec,
    })

    expect(result.complete).toBe(true)
    expect(result.source).toBe('marketplace-setup')
    expect(result.candidates).toEqual([])
    expect(result.reasons.join(' ')).toContain('will install the DSH plugin marketplace')
  })

  it('does not fall back to GitHub when the installed marketplace returns nothing relevant', async () => {
    const execute = vi.fn(async (_request: { arguments: { query: string } }) => ({
      isError: false as const,
      value: { results: [{
        name: 'open-design',
        url: 'https://github.com/nexu-io/open-design',
        description: 'Claude Code / Codex / Cursor / OpenCode design plugin',
        stars: 99,
      }] },
      content: [],
    }))
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute,
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      requirement: '我需要一个能在dsh里调用codex的能力。',
      exec,
    })

    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.reasons.join(' ')).toContain('GitHub fallback was not used')
    expect(execute.mock.calls.some((call) => (call[0] as { arguments: { query: string } }).arguments.query.includes('codex'))).toBe(true)
  })

  it('treats an empty marketplace result as no reusable candidate', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => ({ isError: false as const, value: { results: [] }, content: [] })),
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({ ctx, config, requirement: 'calculator', exec })

    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([])
  })

  it('fails closed when the installed marketplace errors', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => ({ isError: true as const, error: { message: 'rate limited' }, content: [] })),
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({ ctx, config, requirement: 'calculator', exec })

    expect(result.complete).toBe(false)
    expect(result.candidates).toEqual([])
  })

  it('rejects malformed finder URLs and ignores install commands', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => ({
          isError: false as const,
          value: { results: [{ name: 'bad', url: 'https://evil.example/acme/plugin', stars: 999, install: 'rm -rf /' }] },
          content: [],
        })),
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({ ctx, config, requirement: 'calculator', exec })

    expect(result.candidates.some((candidate) => candidate.repository === 'acme/plugin')).toBe(false)
  })

  it('drops finder summaries that have no requirement anchor', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => ({
          isError: false as const,
          value: { results: [{
            name: 'open-design',
            url: 'https://github.com/acme/open-design',
            description: 'A general design system repository',
            stars: 99,
          }] },
          content: [],
        })),
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      requirement: 'frobulate-qzvm Q7V9M2X4 R3K8N5P1',
      exec,
    })

    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([])
  })

  it('keeps finder candidates with requirement evidence in topics or package name', () => {
    const candidate = {
      repository: 'acme/plugin-bundle',
      name: 'plugin-bundle',
      description: 'A DSH capability bundle',
      stars: 1,
      updatedAt: null,
      topics: ['dsh-plugin', 'frobulate'],
      packageName: 'dsh-plugin-frobulate',
    }
    expect(_testing.relevantFinderCandidates('frobulate', [candidate])).toEqual([
      expect.objectContaining({
        ...candidate,
        matchedTerms: expect.arrayContaining(['frobulate']),
        matchReason: expect.stringContaining('frobulate'),
      }),
    ])
  })

  it('runs every marketplace phrase and keeps GitHub hits that match the requirement', async () => {
    const execute = vi.fn(async (request: { arguments: { query: string } }) => {
      if (request.arguments.query.includes('grok build')) {
        return {
          isError: false as const,
          value: { results: [{
            name: 'dsh-plugin-grok',
            url: 'https://github.com/toolazytoname/dsh-plugin-grok',
            description: 'Call the local Grok Build CLI from DSH',
            stars: 4,
          }] },
          content: [],
        }
      }
      return {
        isError: false as const,
        value: { results: [{
          name: 'EchoBird',
          url: 'https://github.com/edison7009/EchoBird',
          description: 'Claude Code, Codex CLI, Grok Build, DeepSeek Harness, Kimi Code',
          stars: 3041,
        }] },
        content: [],
      }
    })
    const ctx = {
      tools: { get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })), execute },
    } as unknown as Context

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      requirement: '在 DSH 会话中调用 xAI Grok Build 的能力',
      exec,
    })

    expect(execute.mock.calls.length).toBeGreaterThan(1)
    expect(result.source).toBe('dsh-find-plugin')
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'toolazytoname/dsh-plugin-grok',
    })])
  })

  it('fails closed when the installed marketplace throws', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => { throw new Error('offline') }),
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({ ctx, config, requirement: 'calculator', exec })

    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.reasons.join(' ')).toContain('unavailable')
  })

  it('keeps discovery incomplete when only some marketplace queries succeed', async () => {
    let calls = 0
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => {
          calls += 1
          if (calls === 1) return { isError: false as const, value: { results: [] }, content: [] }
          throw new Error('transient marketplace failure')
        }),
      },
    } as unknown as Context

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      requirement: '在 DSH 会话中调用 xAI Grok Build 的能力',
      exec,
    })

    expect(calls).toBeGreaterThan(1)
    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.reasons.join(' ')).toContain('transient marketplace failure')
  })
})
