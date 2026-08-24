import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { discoverRemoteCandidates, _testing } from '../../src/discovery/remote.js'
import { scopedGithubQuery } from '../../src/github/index.js'

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
}

function searchItem(input: {
  full_name: string
  name?: string
  description?: string
  stars?: number
  updated_at?: string
  topics?: string[]
  archived?: boolean
  fork?: boolean
  disabled?: boolean
}) {
  return {
    full_name: input.full_name,
    name: input.name ?? input.full_name.split('/')[1],
    description: input.description ?? '',
    stargazers_count: input.stars ?? 0,
    updated_at: input.updated_at ?? '2026-08-01T00:00:00Z',
    topics: input.topics ?? ['dsh-plugin'],
    archived: input.archived ?? false,
    fork: input.fork ?? false,
    disabled: input.disabled ?? false,
    default_branch: 'main',
  }
}

function runnerFor(handler: (query: string) => unknown) {
  return {
    run: vi.fn(async (request: { argv: readonly string[] }) => {
      const queryArg = request.argv.find((part) => part.startsWith('q='))
      const query = queryArg?.slice(2) ?? ''
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(handler(query)),
        stderr: '',
      }
    }),
  }
}

describe('scoped GitHub discovery', () => {
  it('forces every query onto topic:dsh-plugin', () => {
    expect(scopedGithubQuery('codex')).toBe('codex topic:dsh-plugin')
    expect(scopedGithubQuery('codex topic:dsh-plugin')).toBe('codex topic:dsh-plugin')
    expect(scopedGithubQuery('')).toBe('topic:dsh-plugin')
  })

  it('searches GitHub with scoped queries and keeps updated metadata', async () => {
    const runner = runnerFor((query) => {
      expect(query).toContain('topic:dsh-plugin')
      if (query.includes('scientific') || query.includes('科学')) {
        return { items: [searchItem({
          full_name: 'acme/scientific-calculator',
          description: 'Scientific notation support',
          stars: 42,
          updated_at: '2026-07-01T00:00:00Z',
          topics: ['dsh-plugin', 'calculator'],
        })] }
      }
      return { items: [] }
    })

    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: '科学计数法计算器',
    })

    expect(runner.run.mock.calls.length).toBeGreaterThan(1)
    expect(runner.run.mock.calls.every((call) => call[0].argv.includes('/search/repositories'))).toBe(true)
    expect(result.source).toBe('github')
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'acme/scientific-calculator',
      stars: 42,
      updatedAt: '2026-07-01T00:00:00Z',
      topics: expect.arrayContaining(['dsh-plugin', 'calculator']),
    })])
  })

  it('does not emit an unscoped dsh fallback query', async () => {
    const runner = runnerFor(() => ({ items: [] }))
    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: '我需要一个能在dsh里调用codex的能力。',
    })
    const queries = runner.run.mock.calls.map((call) => {
      const arg = call[0].argv.find((part) => part.startsWith('q='))
      return arg?.slice(2) ?? ''
    })
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every((query) => query.includes('topic:dsh-plugin'))).toBe(true)
    expect(queries.some((query) => query === 'codex dsh' || query.endsWith(' dsh'))).toBe(false)
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([])
  })

  it('treats an empty scoped search as no reusable candidate', async () => {
    const result = await discoverRemoteCandidates({
      runner: runnerFor(() => ({ items: [] })),
      config,
      cwd: 'C:/workspace',
      requirement: 'calculator',
    })
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.source).toBeUndefined()
  })

  it('fails closed when every GitHub query errors', async () => {
    const result = await discoverRemoteCandidates({
      runner: {
        run: async () => {
          throw new Error('rate limited')
        },
      },
      config,
      cwd: 'C:/workspace',
      requirement: 'calculator',
    })
    expect(result.complete).toBe(false)
    expect(result.candidates).toEqual([])
  })

  it('drops archived, forked, disabled, and finder infrastructure hits', async () => {
    const result = await discoverRemoteCandidates({
      runner: runnerFor(() => ({ items: [
        searchItem({ full_name: 'acme/old', description: 'calculator', archived: true }),
        searchItem({ full_name: 'acme/forked', description: 'calculator', fork: true }),
        searchItem({ full_name: 'awesome-dsh-plugin/dsh-find-plugin', description: 'calculator' }),
        searchItem({ full_name: 'acme/calc', description: 'scientific calculator', stars: 3 }),
      ] })),
      config,
      cwd: 'C:/workspace',
      requirement: 'calculator',
    })
    expect(result.candidates.map((item) => item.repository)).toEqual(['acme/calc'])
  })

  it('keeps candidates with requirement evidence in topics or package name', () => {
    const candidate = {
      repository: 'acme/plugin-bundle',
      name: 'plugin-bundle',
      description: 'A DSH capability bundle',
      stars: 1,
      updatedAt: null,
      topics: ['dsh-plugin', 'frobulate'],
      packageName: 'dsh-plugin-frobulate',
    }
    expect(_testing.relevantRemoteCandidates('frobulate', [candidate])).toEqual([
      expect.objectContaining({
        ...candidate,
        matchedTerms: expect.arrayContaining(['frobulate']),
        matchReason: expect.stringContaining('frobulate'),
      }),
    ])
  })

  it('prefers a low-star exact conversation exporter over popular screenshot OCR', () => {
    const exact = {
      repository: 'acme/dsh-conv-export',
      name: 'dsh-conv-export',
      description: 'Export the current DSH conversation as a long PNG image.',
      stars: 2,
      updatedAt: '2026-08-02T00:00:00Z',
      topics: ['dsh-plugin', 'conversation-export'],
    }
    const popularButWrong = {
      repository: 'acme/dsh-vision-toolkit',
      name: 'dsh-vision-toolkit',
      description: 'Long screenshot OCR and UI restoration toolkit.',
      stars: 680,
      updatedAt: '2026-08-03T00:00:00Z',
      topics: ['screenshot', 'ocr'],
    }

    expect(_testing.relevantRemoteCandidates(
      '我需要一个能把当前 DSH 聊天记录导出成长截图的插件。',
      [popularButWrong, exact],
    )).toEqual([
      expect.objectContaining({ repository: 'acme/dsh-conv-export', stars: 2 }),
    ])
  })

  it('runs every phrase and keeps GitHub hits that match the requirement', async () => {
    const runner = runnerFor((query) => {
      if (query.includes('grok build')) {
        return { items: [searchItem({
          full_name: 'toolazytoname/dsh-plugin-grok',
          description: 'Call the local Grok Build CLI from DSH',
          stars: 4,
        })] }
      }
      return { items: [searchItem({
        full_name: 'edison7009/EchoBird',
        description: 'Claude Code, Codex CLI, Grok Build, DeepSeek Harness, Kimi Code',
        stars: 3041,
      })] }
    })

    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: '在 DSH 会话中调用 xAI Grok Build 的能力',
    })

    expect(runner.run.mock.calls.length).toBeGreaterThan(1)
    expect(result.source).toBe('github')
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'toolazytoname/dsh-plugin-grok',
    })])
  })

  it('keeps discovery incomplete when only some queries succeed', async () => {
    let calls = 0
    const result = await discoverRemoteCandidates({
      runner: {
        run: async () => {
          calls += 1
          if (calls === 1) {
            return { exitCode: 0, signal: null, stdout: JSON.stringify({ items: [] }), stderr: '' }
          }
          throw new Error('transient github failure')
        },
      },
      config,
      cwd: 'C:/workspace',
      requirement: '在 DSH 会话中调用 xAI Grok Build 的能力',
    })

    expect(calls).toBeGreaterThan(1)
    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.reasons.join(' ')).toContain('transient github failure')
  })
})
