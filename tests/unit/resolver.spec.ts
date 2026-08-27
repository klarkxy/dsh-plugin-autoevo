import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { capabilityAnchors, capabilityQueries, capabilityTerms, marketplaceSearchQueries, isNameDropMention } from '../../src/resolver/keywords.js'
import { resolveLocalCapabilities, _testing } from '../../src/resolver/local.js'

describe('capability query generation', () => {
  it('derives ordered adjacent phrases from arbitrary identifiers', () => {
    const queries = marketplaceSearchQueries('enable quasar ledger replay archive')
    expect(queries).toContain('quasar ledger replay')
    expect(queries).toContain('ledger replay archive')
    expect(queries).not.toContain('enable')
    expect(queries).toHaveLength(5)
  })

  it('keeps an unfamiliar CJK capability property intact', () => {
    const queries = marketplaceSearchQueries('我需要把星历表同步到离线仓库的能力')
    expect(queries).toContain('星历表同步到离线仓库')
    expect(queries.every((query) => query.length >= 2)).toBe(true)
  })

  it('derives terms and anchors without a capability-name catalogue', () => {
    const terms = capabilityTerms('synchronize quasar ledger records')
    expect(terms).toEqual(expect.arrayContaining(['quasar', 'ledger', 'records']))
    expect(capabilityAnchors('synchronize quasar ledger records').map((anchor) => anchor.key))
      .toEqual(expect.arrayContaining(['synchronize', 'quasar', 'ledger', 'records']))
    expect(capabilityQueries('synchronize quasar ledger records with a plugin')).not.toContain('plugin')
  })

  it('retains low-weight platform context without crowding out specific phrases', () => {
    const queries = marketplaceSearchQueries('search DSH plugins for quasar ledger replay')
    expect(queries).toContain('dsh')
    expect(queries).toContain('quasar ledger replay')
    expect(queries.indexOf('quasar ledger replay')).toBeLessThan(queries.indexOf('dsh'))
  })
})

describe('local matching', () => {
  it('recognizes an active client-only plugin from matching Loader metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'autoevo-client-plugin-'))
    try {
      const entryPath = path.join(root, 'lib', 'index.js')
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: '@dsh-external/dsh-quasar-archive',
        description: 'Synchronize quasar ledger records into an archive.',
        keywords: ['quasar', 'ledger', 'archive'],
        dsh: { client: './dist' },
      }))
      const ctx = {
        get: () => ({
          * entries() {
            yield {
              disabled: false,
              fiber: {},
              options: { id: 'quasar-archive', name: pathToFileURL(entryPath).href },
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
        'synchronize quasar ledger records into an archive',
        { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
      )

      expect(result.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'plugin', name: '@dsh-external/dsh-quasar-archive', availability: 'available' }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat a generic archive catalogue as a full specific match', () => {
    expect(_testing.matchConfidence(
      'synchronize quasar ledger records into an archive',
      'generic-archive-catalogue',
      'Archives many unrelated record formats',
    )).toBeLessThan(0.3)
  })

  it('keeps a relevant but incomplete local match partial', () => {
    const requirement = 'synchronize quasar ledger records with checksum'
    const name = 'quasar-ledger-sync'
    const description = 'Synchronize quasar ledger records'
    const confidence = _testing.matchConfidence(requirement, name, description)
    expect(confidence).toBeGreaterThan(_testing.matchConfidence(requirement, 'unrelated-signal', 'Dispatch an event'))
    expect(confidence).toBeGreaterThanOrEqual(0.3)
    expect(_testing.isStrictLocalMatch(requirement, name, description)).toBe(false)
    expect(_testing.localFit(requirement, {
      name,
      description,
      confidence,
    })).toMatchObject({ fit: 'partial', missingFacets: expect.arrayContaining(['checksum']) })
  })

  it('downweights list-shaped mentions without a product catalogue', () => {
    const requirement = 'invoke nebula relay'
    const nameDrop = [
      'nebula relay / comet drive / orbit queue / archive node',
      'multiple unrelated adapters via a registry',
    ].join(' ')
    expect(isNameDropMention(nameDrop, 'nebula relay')).toBe(true)
    expect(_testing.matchConfidence(requirement, 'generic-adapter', nameDrop)).toBeLessThan(0.3)
    expect(_testing.matchConfidence(
      requirement,
      'nebula-relay',
      'Invoke the nebula relay and return its result',
    )).toBeGreaterThanOrEqual(0.3)
  })

  it('requires every generic requirement facet before local reuse', async () => {
    const requirement = 'nebula relay audit'
    const partialTool = { name: 'nebula-relay', description: 'Invoke a nebula relay' }
    const fullTool = { name: 'nebula-relay-audit', description: 'Invoke a nebula relay and audit its result' }
    const exec = { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>
    const contextFor = (schemas: Array<{ name: string, description: string }>) => ({
      tools: { schemas: () => schemas },
      systemPrompt: { assemble: async () => ({ tools: schemas.map(({ name }) => ({ name })) }) },
      skills: { list: async () => [] },
    } as unknown as Context)

    expect(_testing.isStrictLocalMatch(requirement, partialTool.name, partialTool.description)).toBe(false)
    expect((await resolveLocalCapabilities(contextFor([partialTool]), requirement, exec)).shouldDiscoverRemote).toBe(true)
    expect((await resolveLocalCapabilities(contextFor([partialTool, fullTool]), requirement, exec)).shouldDiscoverRemote).toBe(false)
  })

  it('strongly matches a concrete tool and ignores unrelated names', () => {
    expect(_testing.matchConfidence('synchronize quasar ledger', 'quasar_ledger_sync', 'Synchronize quasar ledger')).toBeGreaterThan(0.62)
    expect(_testing.matchConfidence('audit orbit queue', 'orbit_queue_audit', 'Audit an orbit queue')).toBeGreaterThan(0.62)
    expect(_testing.matchConfidence('synchronize quasar ledger', 'signal_dispatch', 'Dispatch an event')).toBeLessThan(0.3)
  })

  it('selects only a synthetic tool matching an unfamiliar identifier', async () => {
    const schemas = [
      { name: 'quasar-ledger', description: 'Synchronize quasar ledger records' },
      { name: 'archive-node', description: 'Archive generic records' },
      { name: 'signal-dispatch', description: 'Dispatch signals' },
    ]
    const ctx = {
      tools: { schemas: () => schemas },
      systemPrompt: { assemble: async () => ({ tools: schemas.map(({ name }) => ({ name })) }) },
      skills: { list: async () => [] },
    } as unknown as Context

    const result = await resolveLocalCapabilities(
      ctx,
      'synchronize quasar ledger records',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
    )

    expect(result.candidates.filter((candidate) => candidate.confidence >= 0.62)).toEqual([
      expect.objectContaining({ name: 'quasar-ledger', availability: 'available' }),
    ])
    expect(result.shouldDiscoverRemote).toBe(false)
  })

  it('recognizes a directly assembled tool when the scoped registry is narrower', async () => {
    const assembledTool = {
      name: 'nebula-ledger-sync',
      description: 'Synchronize nebula ledger records',
    }
    const ctx = {
      tools: { schemas: () => [] },
      systemPrompt: { assemble: async () => ({ tools: [assembledTool] }) },
      skills: { list: async () => [] },
    } as unknown as Context

    const result = await resolveLocalCapabilities(
      ctx,
      'synchronize nebula ledger records',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
    )

    expect(result.candidates).toEqual([
      expect.objectContaining({ name: assembledTool.name, availability: 'available', fit: 'full' }),
    ])
    expect(result.shouldDiscoverRemote).toBe(false)
  })

  it('does not let a same-name skill suppress native plugin discovery', async () => {
    const ctx = {
      tools: { schemas: () => [] },
      systemPrompt: { assemble: async () => ({ tools: [] }) },
      skills: { list: async () => [{
        name: 'quasar-ledger',
        description: 'Synchronize quasar ledger records',
        whenToUse: 'When the user asks to synchronize a ledger',
        invocation: { modelInvocable: true },
      }] },
    } as unknown as Context
    const result = await resolveLocalCapabilities(
      ctx,
      'install the quasar-ledger native plugin',
      { agent: undefined, signal: undefined } as unknown as Pick<ToolRunContext, 'agent' | 'signal'>,
      { intent: { operation: 'discover_or_reuse', requiredSurface: 'native_dsh_plugin' } },
    )
    expect(result.candidates).toEqual([expect.objectContaining({
      kind: 'skill',
      name: 'quasar-ledger',
      surfaceMatch: false,
      reuseEligible: false,
    })])
    expect(result.candidates[0]?.fit).not.toBe('full')
    expect(result.shouldDiscoverRemote).toBe(true)
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
          name: 'editing-cordis-compositions',
          description: 'Edit Cordis compositions',
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
