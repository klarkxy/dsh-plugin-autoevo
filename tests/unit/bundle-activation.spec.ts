import { describe, expect, it } from 'vitest'
import {
  activationTargetsFromPatch,
  flattenLoaderOptions,
  matchActivatedEntries,
  parseActivatedFibersJson,
} from '../../src/lifecycle/bundle-activation.js'

const zhihuPatch = [{
  insert: [{
    id: 'zhihu-search-mcp',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { command: 'uvx' },
  }],
}]

describe('bundle activation identity', () => {
  it('collects carrier insert id and name, not the npm package', () => {
    expect(activationTargetsFromPatch(zhihuPatch)).toEqual([{
      id: 'zhihu-search-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
    }])
  })

  it('collects classic self-insert rows and nested group inserts', () => {
    expect(activationTargetsFromPatch([
      { insert: [{ id: 'calculator', name: 'dsh-tool-calculator' }] },
      {
        insert: [{
          id: 'tools',
          name: 'cordis:group',
          group: true,
          config: [{ id: 'nested', name: 'dsh-nested-tool' }],
        }],
      },
    ])).toEqual([
      { id: 'calculator', name: 'dsh-tool-calculator' },
      { id: 'tools', name: 'cordis:group' },
      { id: 'nested', name: 'dsh-nested-tool' },
    ])
  })

  it('matches a carrier Fiber by insert id and name', () => {
    const entries = [
      { id: 'other-mcp', options: { id: 'other-mcp', name: '@deepseek-ai/dsh-mcp-client' } },
      { id: 'zhihu-search-mcp', options: { id: 'zhihu-search-mcp', name: '@deepseek-ai/dsh-mcp-client' } },
    ]
    const targets = activationTargetsFromPatch(zhihuPatch)
    expect(matchActivatedEntries(entries, {
      packageName: 'dsh-plugin-zhihu-search',
      targets,
    })).toEqual([entries[1]])
  })

  it('does not treat a pre-existing MCP client with another id as this bundle', () => {
    const entries = [
      { id: 'other-mcp', options: { id: 'other-mcp', name: '@deepseek-ai/dsh-mcp-client' } },
    ]
    expect(matchActivatedEntries(entries, {
      packageName: 'dsh-plugin-zhihu-search',
      targets: activationTargetsFromPatch(zhihuPatch),
    })).toEqual([])
  })

  it('falls back to the npm package Fiber when the patch has no inserts', () => {
    const entries = [
      { options: { name: 'dsh-tool-calculator' } },
      { options: { name: '@scope/dsh-tool-calculator' } },
    ]
    expect(matchActivatedEntries(entries, {
      packageName: 'dsh-tool-calculator',
      targets: [],
    })).toEqual(entries)
  })

  it('rejects invalid overlay JSON without throwing', () => {
    expect(parseActivatedFibersJson(undefined)).toEqual([])
    expect(parseActivatedFibersJson('{')).toEqual([])
    expect(parseActivatedFibersJson(JSON.stringify({ id: 'zhihu-search-mcp' }))).toEqual([])
    expect(parseActivatedFibersJson(JSON.stringify([{
      id: 'zhihu-search-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
    }]))).toEqual([{
      id: 'zhihu-search-mcp',
      name: '@deepseek-ai/dsh-mcp-client',
    }])
  })

  it('flattens nested Loader option trees for hot-load matching', () => {
    expect(flattenLoaderOptions([
      { id: 'root', name: 'dsh-plugin-zhihu-search' },
      {
        id: 'group',
        name: 'cordis:group',
        group: true,
        config: [{ id: 'zhihu-search-mcp', name: '@deepseek-ai/dsh-mcp-client' }],
      },
    ]).map((entry) => entry.options)).toEqual([
      { id: 'root', name: 'dsh-plugin-zhihu-search' },
      { id: 'group', name: 'cordis:group' },
      { id: 'zhihu-search-mcp', name: '@deepseek-ai/dsh-mcp-client' },
    ])
  })
})
