import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { discoverRemoteCandidates, FIND_PLUGIN_REPOSITORY, FIND_PLUGIN_TOOL, _testing } from '../../src/discovery/remote.js'
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
  evolutionPreset: true,
}

const exec = {
  callId: 'call-resolve',
  rootCallId: 'call-resolve',
  token: Symbol('resolve'),
  signal: new AbortController().signal,
  agent: { session: { header: { cwd: 'C:/workspace' } } },
} as unknown as ToolRunContext



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
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([expect.objectContaining({
      repository: 'acme/scientific-calculator',
      stars: 42,
      updatedAt: null,
    })])
  })

  it('offers the plugin marketplace instead of searching GitHub when find_dsh_plugin is absent', async () => {
    const ctx = { tools: { get: vi.fn(() => undefined) } } as unknown as Context
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      runner,
      cwd: 'C:/workspace',
      requirement: '我需要一个能在dsh里调用codex的能力。',
      exec,
    })

    expect(runner.run).not.toHaveBeenCalled()
    expect(result.complete).toBe(true)
    expect(result.source).toBe('marketplace-setup')
    expect(result.candidates).toEqual([expect.objectContaining({ repository: FIND_PLUGIN_REPOSITORY })])
    expect(result.reasons.join(' ')).toContain('Install the DSH plugin marketplace')
  })

  it('does not fall back to GitHub when the installed marketplace returns nothing relevant', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => ({
          isError: false as const,
          value: { results: [{
            name: 'open-design',
            url: 'https://github.com/nexu-io/open-design',
            description: 'Claude Code / Codex / Cursor / OpenCode design plugin',
            stars: 99,
          }] },
          content: [],
        })),
      },
    } as unknown as Context
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      runner,
      cwd: 'C:/workspace',
      requirement: '我需要一个能在dsh里调用codex的能力。',
      exec,
    })

    expect(runner.run).not.toHaveBeenCalled()
    expect(result.complete).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.reasons.join(' ')).toContain('GitHub fallback was not used')
  })

  it('treats an empty marketplace result as no reusable candidate', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => ({ isError: false as const, value: { results: [] }, content: [] })),
      },
    } as unknown as Context
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(runner.run).not.toHaveBeenCalled()
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
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(runner.run).not.toHaveBeenCalled()
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
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(runner.run).not.toHaveBeenCalled()
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
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({
      ctx,
      config,
      runner,
      cwd: 'C:/workspace',
      requirement: 'frobulate-qzvm Q7V9M2X4 R3K8N5P1',
      exec,
    })

    expect(runner.run).not.toHaveBeenCalled()
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
    expect(_testing.relevantFinderCandidates('frobulate', [candidate])).toEqual([candidate])
  })

  it('fails closed when the installed marketplace throws', async () => {
    const ctx = {
      tools: {
        get: vi.fn(() => ({ name: FIND_PLUGIN_TOOL })),
        execute: vi.fn(async () => { throw new Error('offline') }),
      },
    } as unknown as Context
    const runner = { run: vi.fn(async () => { throw new Error('gh must not run') }) } as CommandRunner

    const result = await discoverRemoteCandidates({ ctx, config, runner, cwd: 'C:/workspace', requirement: 'calculator', exec })

    expect(runner.run).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.reasons.join(' ')).toContain('unavailable')
  })
})
