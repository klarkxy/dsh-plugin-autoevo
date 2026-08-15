import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { discoverRemoteCandidates, FIND_PLUGIN_TOOL } from '../../src/discovery/remote.js'
import type { CommandRunner } from '../../src/process/runner.js'

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
}

const exec = {
  callId: 'call-resolve',
  rootCallId: 'call-resolve',
  token: Symbol('resolve'),
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: 'C:/workspace' } } },
} as unknown as ToolRunContext

function githubRunner(): CommandRunner {
  return {
    run: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: JSON.stringify({ items: [{
        full_name: 'fallback/calculator',
        name: 'calculator',
        description: 'Fallback calculator plugin',
        stargazers_count: 3,
        updated_at: '2026-08-15T00:00:00Z',
        topics: ['dsh-plugin'],
        default_branch: 'main',
      }] }),
    })),
  }
}

describe('remote discovery precedence', () => {
  it('uses a current-scope find_dsh_plugin result without calling gh', async () => {
    const execute = vi.fn(async () => ({
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
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: '科学计数法计算器', exec })

    expect(get).toHaveBeenCalledWith(FIND_PLUGIN_TOOL, exec.agent)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      name: FIND_PLUGIN_TOOL,
      arguments: expect.objectContaining({ query: 'calculator', lang: 'zh', limit: 5 }),
      parent: exec.token,
      rootCallId: exec.rootCallId,
    }))
    expect(runner.run).not.toHaveBeenCalled()
    expect(result.source).toBe('dsh-find-plugin')
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'acme/scientific-calculator',
      stars: 42,
      updatedAt: null,
    })])
  })

  it('falls back to authenticated gh when find_dsh_plugin is absent', async () => {
    const ctx = { tools: { get: vi.fn(() => undefined) } } as unknown as Context
    const runner = githubRunner()

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(runner.run).toHaveBeenCalled()
    expect(result.source).toBe('github')
    expect(result.candidates[0]?.repository).toBe('fallback/calculator')
    expect(result.reasons.join(' ')).toContain('not available in the current Agent scope')
  })

  it.each([
    ['empty', { isError: false as const, value: { results: [] }, content: [] }],
    ['failed', { isError: true as const, error: { message: 'rate limited' }, content: [] }],
  ])('falls back to gh when find_dsh_plugin is %s', async (_label, toolResult) => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => toolResult),
      },
    } as unknown as Context
    const runner = githubRunner()

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(runner.run).toHaveBeenCalled()
    expect(result.source).toBe('github')
    expect(result.candidates[0]?.repository).toBe('fallback/calculator')
    expect(result.reasons.join(' ')).toContain('falling back to built-in gh search')
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
    const runner = githubRunner()

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(result.source).toBe('github')
    expect(result.candidates.some((candidate) => candidate.repository === 'acme/plugin')).toBe(false)
  })
})
