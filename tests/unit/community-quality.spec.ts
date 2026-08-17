import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityQualityService } from '../../src/community-quality.js'
import { _testing as configTesting, normalizeConfig, type RuntimeConfig } from '../../src/config.js'
import type { RemotePluginCandidate, ReviewRecord } from '../../src/contracts.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
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
    ...overrides,
  }
}

function candidate(repository: string): RemotePluginCandidate {
  return {
    repository,
    name: repository.split('/')[1]!,
    description: 'calculator plugin',
    stars: 1,
    updatedAt: null,
    topics: ['dsh-plugin'],
  }
}

function review(): ReviewRecord {
  return {
    schemaVersion: 1,
    id: `review_${'a'.repeat(24)}`,
    policyVersion: 'v6-2026-08-17',
    createdAt: '2026-08-17T00:00:00.000Z',
    resolutionId: `resolution_${'b'.repeat(24)}`,
    requirement: 'PRIVATE USER REQUIREMENT',
    sourceSnapshot: {
      kind: 'github', repository: 'acme/repairable', requestedRef: 'main', commit: 'c'.repeat(40), defaultBranch: 'main',
    },
    inspectedFiles: [{ path: 'PRIVATE/PATH', sha256: 'd'.repeat(64), bytes: 10 }],
    manifest: { kind: 'bundle', packageName: 'secret-package', scripts: [], dependencies: [], peerDependencies: {}, expectedTools: ['calculator'] },
    fit: 'partial',
    confidence: 0.9,
    securityRisk: 'low',
    maintained: true,
    license: 'MIT',
    compatibility: { status: 'compatible', reason: 'private detail', runtimeVersion: '0.1.0-rc.6' },
    missingCapabilities: ['private capability detail'],
    findings: [{ code: 'missing_capability', severity: 'warning', source: 'PRIVATE/PATH', detail: 'PRIVATE SOURCE DETAIL' }],
    recommendation: 'modify',
    installSpec: null,
  }
}

describe('community quality filtering', () => {
  it('defaults both network features off and validates the service URL', () => {
    expect(normalizeConfig({})).toEqual(expect.objectContaining({
      communityQualityFilter: false,
      communityReports: false,
      communityQualityEndpoint: '',
      communityQualityTimeoutMs: 2_000,
    }))
    expect(configTesting.normalizeCommunityQualityEndpoint('https://quality.example/api/')).toBe('https://quality.example/api')
    expect(configTesting.normalizeCommunityQualityEndpoint('http://localhost:3000/api')).toBe('http://localhost:3000/api')
    expect(configTesting.normalizeCommunityQualityEndpoint('http://[::1]:3000/api')).toBe('http://[::1]:3000/api')
    expect(() => configTesting.normalizeCommunityQualityEndpoint('http://quality.example')).toThrow(/HTTPS/u)
    expect(() => configTesting.normalizeCommunityQualityEndpoint('https://user:secret@quality.example')).toThrow(/credentials/u)
  })

  it('is opt-in and performs no network request by default', async () => {
    const fetcher = vi.fn(async () => { throw new Error('must not run') }) as unknown as typeof fetch
    const service = new CommunityQualityService(config(), fetcher)
    const candidates = [candidate('acme/one')]

    const result = await service.screen(candidates)

    expect(fetcher).not.toHaveBeenCalled()
    expect(result).toEqual({ candidates })
  })

  it('filters broken and junk while retaining good, repairable, and unknown candidates', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { schemaVersion: number, repositories: string[] }
      expect(request).toEqual({
        schemaVersion: 1,
        repositories: ['acme/good', 'acme/repairable', 'acme/broken', 'acme/junk', 'acme/unknown'],
      })
      return new Response(JSON.stringify({
        assessments: [
          { repository: 'acme/good', classification: 'good', repairability: 1, evolutionValue: 0.4, confidence: 0.9, observationCount: 8, reasonCodes: ['verified'], updatedAt: '2026-08-17T00:00:00.000Z' },
          { repository: 'acme/repairable', classification: 'repairable', repairability: 0.8, evolutionValue: 0.95, confidence: 0.8, observationCount: 4, reasonCodes: ['missing-tool'] },
          { repository: 'acme/broken', classification: 'broken', reasonCodes: ['verification-failed'] },
          { repository: 'acme/junk', classification: 'junk', reasonCodes: ['spam'] },
          { repository: 'evil/not-requested', classification: 'junk', reasonCodes: ['untrusted'] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const service = new CommunityQualityService(config({
      communityQualityFilter: true,
      communityQualityEndpoint: 'https://quality.example/api',
    }), fetcher)
    const candidates = ['good', 'repairable', 'broken', 'junk', 'unknown'].map((name) => candidate(`acme/${name}`))

    const result = await service.screen(candidates)

    expect(result.candidates.map((item) => item.repository)).toEqual(['acme/good', 'acme/repairable', 'acme/unknown'])
    expect(result.candidates[1]?.communityQuality).toEqual(expect.objectContaining({
      classification: 'repairable',
      repairability: 0.8,
      evolutionValue: 0.95,
    }))
    expect(result.screening).toEqual(expect.objectContaining({
      complete: true,
      assessedCandidates: 4,
      filtered: [
        { repository: 'acme/broken', classification: 'broken', reasonCodes: ['verification-failed'] },
        { repository: 'acme/junk', classification: 'junk', reasonCodes: ['spam'] },
      ],
    }))
  })

  it('keeps candidates when the quality service is unavailable', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const service = new CommunityQualityService(config({
      communityQualityFilter: true,
      communityQualityEndpoint: 'https://quality.example',
    }), fetcher)
    const candidates = [candidate('acme/one')]

    const result = await service.screen(candidates)

    expect(result.candidates).toEqual(candidates)
    expect(result.screening).toEqual(expect.objectContaining({ complete: false, filtered: [] }))
  })
})

describe('anonymous community observations', () => {
  it('uploads only the allowlisted structured review fields and keeps a local delivery receipt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-quality-'))
    temporary.push(directory)
    const uploaded: unknown[] = []
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      uploaded.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const service = new CommunityQualityService(config({
      stateDir: directory,
      communityReports: true,
      communityQualityEndpoint: 'https://quality.example',
    }), fetcher)

    await service.recordReview({ repository: 'acme/repairable', commit: 'c'.repeat(40), localModification: false }, review())

    expect(uploaded).toHaveLength(1)
    const serialized = JSON.stringify(uploaded[0])
    expect(serialized).toContain('acme/repairable')
    expect(serialized).toContain('missing_capability')
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain('secret-package')
    expect(uploaded[0]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      repository: 'acme/repairable',
      commit: 'c'.repeat(40),
      autoevoVersion: '0.5.0',
      dshVersion: '0.1.0-rc.6',
      stage: 'review',
      outcome: 'repairable',
      repairability: 'repairable',
      evolutionValue: 'high',
      securityRisk: 'low',
    }))
    expect(uploaded[0]).not.toHaveProperty('delivery')

    const root = path.join(directory, 'community-quality', 'observations')
    const entries = await readdir(root)
    expect(entries).toHaveLength(1)
    const stored = JSON.parse(await readFile(path.join(root, entries[0]!), 'utf8')) as { delivery: { status: string } }
    expect(stored.delivery.status).toBe('sent')
  })

  it('does not persist or upload observations without report opt-in', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-quality-off-'))
    temporary.push(directory)
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const service = new CommunityQualityService(config({
      stateDir: directory,
      communityQualityEndpoint: 'https://quality.example',
    }), fetcher)

    await service.recordReview({ repository: 'acme/repairable', commit: 'c'.repeat(40), localModification: false }, review())

    expect(fetcher).not.toHaveBeenCalled()
    await expect(readdir(path.join(directory, 'community-quality', 'observations'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
