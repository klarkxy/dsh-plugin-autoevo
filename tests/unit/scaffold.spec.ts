import { describe, expect, it } from 'vitest'

import * as plugin from '../../src/index.js'

describe('DSH bundle scaffold', () => {
  it('exports the native named plugin shape without a default export', () => {
    expect(plugin.name).toBe('autoevo')
    expect(plugin.inject).toEqual(['tools', 'skills', 'subprocess', 'systemPrompt'])
    expect(plugin.Config).toBeDefined()
    expect(plugin.apply).toBeTypeOf('function')
    expect('default' in plugin).toBe(false)
    expect(plugin.POLICY_VERSION).toBe('14')
    expect('ExecutionLease' in plugin).toBe(false)
    expect('_testing' in plugin).toBe(false)
  })
})
