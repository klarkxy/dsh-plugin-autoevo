import { describe, expect, it } from 'vitest'
import { assertSafePackageName, isSafePackageName } from '../../src/package-name.js'

describe('DSH package-name boundary', () => {
  it('accepts conservative registry names and rejects shell or option syntax', () => {
    expect(['calculator', '@scope/calculator', 'dsh-tool.safe_1~beta'].every(isSafePackageName)).toBe(true)
    expect([
      '--config',
      '-calculator',
      'calculator&whoami',
      'calculator%PATH%',
      '@scope/-calculator',
      'UpperCase',
      'node_modules',
      'favicon.ico',
    ].some(isSafePackageName)).toBe(false)
  })

  it('fails closed when a recovery receipt contains an unsafe name', () => {
    expect(() => assertSafePackageName('calculator|whoami')).toThrow(/package name is unsafe/u)
  })
})
