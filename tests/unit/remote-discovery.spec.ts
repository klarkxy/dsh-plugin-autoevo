import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { discoverRemoteCandidates, _testing } from '../../src/discovery/remote.js'
import { scopedGithubQuery, searchGithubRepositories } from '../../src/github/index.js'

const config: RuntimeConfig = {
  dshHome: 'C:/dsh',
  stateDir: 'C:/dsh/autoevo',
  ghCommand: 'gh',
  gitCommand: 'git',
  dshCommand: 'dsh',
  dshCommandArgs: [],
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
    expect(scopedGithubQuery('quasar relay')).toBe('quasar relay topic:dsh-plugin')
    expect(scopedGithubQuery('quasar relay topic:dsh-plugin')).toBe('quasar relay topic:dsh-plugin')
    expect(scopedGithubQuery('')).toBe('topic:dsh-plugin')
  })

  it('does not search GitHub for a clarification protocol label', () => {
    const phrases = _testing.githubSearchPhrases(
      '我需要一个能autoreview的能力，类似于codex的「替我审批」\n\nClarification:\n1',
    )
    expect(phrases.join(' ')).not.toMatch(/clarification/i)
    expect(phrases).toEqual(expect.arrayContaining(['autoreview', 'codex', '替我审批']))
  })

  it('does not invoke a runner when its search signal is already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('pre-aborted')
    controller.abort(reason)
    const runner = { run: vi.fn() }

    await expect(searchGithubRepositories({
      runner,
      config,
      cwd: 'C:/workspace',
      query: 'calculator',
      limit: 20,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('rejects an ignoring runner result when the signal aborts during search', async () => {
    const controller = new AbortController()
    const reason = new Error('abort after run')
    const runner = {
      run: vi.fn(async () => {
        controller.abort(reason)
        return { exitCode: 0, signal: null, stdout: JSON.stringify({ items: [] }), stderr: '' }
      }),
    }

    await expect(searchGithubRepositories({
      runner,
      config,
      cwd: 'C:/workspace',
      query: 'calculator',
      limit: 20,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid GitHub search response schemas but accepts an empty items array', async () => {
    for (const invalid of [{}, { items: null }, { items: 'nope' }, { items: {} }, []]) {
      await expect(searchGithubRepositories({
        runner: { run: async () => ({ exitCode: 0, signal: null, stdout: JSON.stringify(invalid), stderr: '' }) },
        config,
        cwd: 'C:/workspace',
        query: 'calculator',
        limit: 20,
      })).rejects.toMatchObject({ code: 'github_unavailable' })
    }
    await expect(searchGithubRepositories({
      runner: { run: async () => ({ exitCode: 0, signal: null, stdout: JSON.stringify({ items: [] }), stderr: '' }) },
      config,
      cwd: 'C:/workspace',
      query: 'calculator',
      limit: 20,
    })).resolves.toEqual([])
  })

  it('propagates an aborted first query without scheduling a later query', async () => {
    const controller = new AbortController()
    const reason = new Error('abort first query')
    const runner = {
      run: vi.fn(async () => {
        controller.abort(reason)
        return { exitCode: 0, signal: null, stdout: JSON.stringify({ items: [] }), stderr: '' }
      }),
    }

    await expect(discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: 'calculator',
      queries: ['first', 'second'],
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('searches GitHub with scoped queries and keeps updated metadata', async () => {
    const runner = runnerFor((query) => {
      expect(query).toContain('topic:dsh-plugin')
      if (query.includes('quasar ledger')) {
        return { items: [searchItem({
          full_name: 'example-org/dsh-quasar-ledger',
          description: 'Quasar ledger replay archive',
          stars: 42,
          updated_at: '2026-07-01T00:00:00Z',
          topics: ['dsh-plugin', 'quasar-ledger'],
        })] }
      }
      return { items: [] }
    })

    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: 'quasar ledger replay archive',
    })

    expect(runner.run.mock.calls.length).toBeGreaterThan(1)
    expect(runner.run.mock.calls.every((call) => call[0].argv.includes('/search/repositories'))).toBe(true)
    expect(result.source).toBe('github')
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'example-org/dsh-quasar-ledger',
      stars: 42,
      updatedAt: '2026-07-01T00:00:00Z',
      topics: expect.arrayContaining(['dsh-plugin', 'quasar-ledger']),
    })])
  })

  it('executes model-planned baseline queries and records only actual attempts', async () => {
    const runner = runnerFor((query) => ({ items: query.includes('auto review')
      ? [searchItem({
          full_name: 'PerryLink/dsh-auto-review',
          description: 'Automatic approval review for DSH',
          topics: ['dsh-plugin', 'auto-review'],
        })]
      : [] }))
    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: 'generic capability request',
      queries: ['auto review'],
    })

    expect(result.queries).toEqual(['auto review'])
    expect(result.candidates).toEqual([
      expect.objectContaining({ repository: 'PerryLink/dsh-auto-review' }),
    ])
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('executes Agent-planned queries exactly without Host synthesis', async () => {
    const planned = [
      'auto approve',
      'approval automation',
      'sandbox approval',
      'permission approval',
      'codex approval',
    ]
    const phrases = _testing.githubSearchPhrases('我需要一个类似于codex的「替我审批」', planned)

    expect(phrases).toEqual(planned)

    const runner = runnerFor((query) => ({ items: query === 'auto approve topic:dsh-plugin'
      ? [searchItem({
          full_name: 'Jiao-XXX/dsh-auto-approve',
          description: 'Automatically approve DSH permission requests',
          stars: 11,
          topics: ['dsh-plugin', 'auto-approve'],
        })]
      : [] }))
    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: '我需要一个类似于codex的「替我审批」',
      queries: planned,
    })

    expect(runner.run).toHaveBeenCalledTimes(5)
    expect(result.source).toBe('github')
    expect(result.candidates).toEqual([
      expect.objectContaining({ repository: 'Jiao-XXX/dsh-auto-approve', stars: 11 }),
    ])
  })

  it('does not emit an unscoped dsh fallback query', async () => {
    const runner = runnerFor(() => ({ items: [] }))
    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: '在 DSH 会话中调用 quasar relay',
    })
    const queries = runner.run.mock.calls.map((call) => {
      const arg = call[0].argv.find((part) => part.startsWith('q='))
      return arg?.slice(2) ?? ''
    })
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every((query) => query.includes('topic:dsh-plugin'))).toBe(true)
    expect(queries.some((query) => query === 'quasar relay dsh' || query.endsWith(' dsh'))).toBe(false)
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

  it('drops archived, forked, and disabled hits without repository-name exceptions', async () => {
    const result = await discoverRemoteCandidates({
      runner: runnerFor(() => ({ items: [
        searchItem({ full_name: 'acme/old', description: 'calculator', archived: true }),
        searchItem({ full_name: 'acme/forked', description: 'calculator', fork: true }),
        searchItem({ full_name: 'acme/search-helper', description: 'calculator search helper', stars: 2 }),
        searchItem({ full_name: 'acme/calc', description: 'scientific calculator', stars: 3 }),
      ] })),
      config,
      cwd: 'C:/workspace',
      requirement: 'calculator',
    })
    expect(result.candidates.map((item) => item.repository)).toEqual(['acme/calc', 'acme/search-helper'])
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

  it('uses model-planned discovery queries as temporary relevance evidence', () => {
    const candidate = {
      repository: 'acme/dsh-quasar-relay',
      name: 'dsh-quasar-relay',
      description: 'Call the quasar relay from DSH',
      stars: 1,
      updatedAt: null,
      topics: ['dsh-plugin'],
    }
    expect(_testing.relevantRemoteCandidates('generic capability', [candidate], ['quasar relay']))
      .toEqual([expect.objectContaining({ repository: candidate.repository })])
  })

  it('uses bilingual operation evidence for a remote shortlist without naming exceptions', () => {
    const candidates = [
      {
        repository: 'acme/extension-index',
        name: 'extension-index',
        description: 'Search and browse extensions from a session',
        stars: 2,
        updatedAt: null,
        topics: ['dsh-plugin'],
      },
      {
        repository: 'acme/theme-pack',
        name: 'theme-pack',
        description: 'A visual theme for a session',
        stars: 4,
        updatedAt: null,
        topics: ['dsh-plugin'],
      },
    ]
    expect(_testing.relevantRemoteCandidates('在 DSH 会话里搜索扩展', candidates).map((item) => item.repository))
      .toEqual(['acme/extension-index', 'acme/theme-pack'])
  })

  it('prefers a low-star specific match over a popular generic catalogue', () => {
    const exact = {
      repository: 'example-org/dsh-quasar-ledger',
      name: 'dsh-quasar-ledger',
      description: 'Synchronize quasar ledger records and verify checksums.',
      stars: 2,
      updatedAt: '2026-08-02T00:00:00Z',
      topics: ['dsh-plugin', 'quasar-ledger'],
    }
    const popularButWrong = {
      repository: 'example-org/dsh-adapter-catalogue',
      name: 'dsh-adapter-catalogue',
      description: 'A large catalogue of unrelated record adapters.',
      stars: 680,
      updatedAt: '2026-08-03T00:00:00Z',
      topics: ['dsh-plugin', 'catalogue'],
    }

    expect(_testing.relevantRemoteCandidates(
      'synchronize quasar ledger records and verify checksums',
      [popularButWrong, exact],
    )).toEqual([
      expect.objectContaining({ repository: 'example-org/dsh-quasar-ledger', stars: 2 }),
      expect.objectContaining({ repository: 'example-org/dsh-adapter-catalogue', stars: 680 }),
    ])
  })

  it('runs every phrase and keeps an anonymous exact-match hit over a generic catalogue entry', async () => {
    const runner = runnerFor((query) => {
      if (query.includes('quasar relay')) {
        return { items: [searchItem({
          full_name: 'example-org/dsh-quasar-relay',
          description: 'Call the quasar relay from DSH',
          stars: 4,
        })] }
      }
      return { items: [searchItem({
        full_name: 'example-org/adapter-catalogue',
        description: 'Comet drive, orbit queue, quasar relay, and many unrelated adapters',
        stars: 3041,
      })] }
    })

    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: '在 DSH 会话中调用 quasar relay',
    })

    expect(runner.run.mock.calls.length).toBeGreaterThan(1)
    expect(result.source).toBe('github')
    expect(result.candidates.map((item) => item.repository)).toEqual([
      'example-org/dsh-quasar-relay',
      'example-org/adapter-catalogue',
    ])
  })

  it('keeps the complete bounded union from five result pages for Agent curation', async () => {
    const planned = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const runner = runnerFor((query) => {
      const prefix = query.split(' ')[0]!
      return { items: Array.from({ length: 20 }, (_, index) => searchItem({
        full_name: `${prefix}-org/plugin-${index}`,
        description: index === 19 ? 'No semantic overlap with the request' : `${prefix} capability`,
      })) }
    })
    const result = await discoverRemoteCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      requirement: 'specific capability',
      queries: planned,
    })

    expect(result.candidates).toHaveLength(100)
    expect(new Set(result.candidates.map((item) => item.repository)).size).toBe(100)
    expect(result.candidates.every((item) => item.matchedQueries?.length === 1)).toBe(true)
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
      requirement: '在 DSH 会话中调用 quasar relay',
    })

    expect(calls).toBeGreaterThan(1)
    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.reasons.join(' ')).toContain('transient github failure')
  })
})
