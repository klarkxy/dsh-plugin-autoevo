import { describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../../src/config.js'
import { discoverGithubCandidates, validateGithubRepository } from '../../../src/github/discovery.js'
import type { CommandRequest, CommandRunner } from '../../../src/process/runner.js'

const config: RuntimeConfig = {
  dshHome: 'C:/dsh', stateDir: 'C:/dsh/state', ghCommand: 'gh', gitCommand: 'git', dshCommand: 'dsh', dshCommandArgs: [],
  maxCandidates: 2, maxFiles: 10, maxRepositoryBytes: 100_000, commandTimeoutMs: 1_000, forwardedCredentialEnv: [], verificationPatchPaths: [], evolutionPreset: true,
}

describe('GitHub discovery', () => {
  it('accepts only strict owner/repository identifiers', () => {
    expect(validateGithubRepository('owner/repo-name')).toBe('owner/repo-name')
    for (const invalid of ['https://github.com/owner/repo', '../repo', 'owner/repo/extra', 'owner\\repo', 'owner/../repo']) {
      expect(() => validateGithubRepository(invalid)).toThrow('strict owner/repository')
    }
  })

  it('uses argv gh api search, filters forks/archives, merges and caps results', async () => {
    const requests: CommandRequest[] = []
    const responses = [
      { items: [
        { full_name: 'org/alpha', name: 'alpha', description: 'first', stargazers_count: 10, updated_at: '2026-01-01T00:00:00Z', topics: ['dsh'], default_branch: 'main' },
        { full_name: 'org/fork', name: 'fork', stargazers_count: 99, updated_at: '2026-01-01T00:00:00Z', fork: true },
      ] },
      { items: [
        { full_name: 'org/beta', name: 'beta', description: null, stargazers_count: 20, updated_at: '2025-01-01T00:00:00Z', archived: false },
        { full_name: 'org/alpha', name: 'alpha', description: 'repeat', stargazers_count: 10, updated_at: '2026-01-01T00:00:00Z' },
      ] },
    ]
    const runner: CommandRunner = {
      async run(request) {
        requests.push(request)
        return { exitCode: 0, signal: null, stdout: JSON.stringify(responses.shift()), stderr: '' }
      },
    }
    const candidates = await discoverGithubCandidates({ runner, config, cwd: 'C:/workspace', queries: ['dsh plugin', 'calculator'] })
    expect(candidates.map((candidate) => candidate.repository)).toEqual(['org/alpha', 'org/beta'])
    expect(requests).toHaveLength(2)
    expect(requests[0]?.argv).toEqual(['gh', 'api', '--method', 'GET', '/search/repositories', '-f', 'q=dsh plugin', '-f', 'sort=stars', '-f', 'order=desc', '-f', 'per_page=2'])
    expect(requests.every((request) => !request.argv.some((arg) => /[;&|]/.test(arg)))).toBe(true)
  })

  it('parses gh search JSON even when ANSI color codes are present', async () => {
    const colored = '\u001b[1;37m{\u001b[m\u001b[1;34m"items"\u001b[m\u001b[1;37m:\u001b[m[\u001b[1;37m{\u001b[m'
      + '"full_name":"org/calc","name":"calc","description":"c","stargazers_count":1,'
      + '"updated_at":"2026-01-01T00:00:00Z","topics":["dsh-plugin"],"default_branch":"main"'
      + '\u001b[1;37m}\u001b[m]\u001b[1;37m}\u001b[m'
    const runner: CommandRunner = {
      async run() {
        return { exitCode: 0, signal: null, stdout: colored, stderr: '' }
      },
    }
    const candidates = await discoverGithubCandidates({
      runner,
      config,
      cwd: 'C:/workspace',
      queries: ['calculator topic:dsh-plugin'],
    })
    expect(candidates.map((candidate) => candidate.repository)).toEqual(['org/calc'])
  })
})
