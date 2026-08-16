import { describe, expect, it, vi } from 'vitest'
import { _testing } from '../../src/index.js'
import type { CordisInspectRegistryLike } from '../../src/cordis-inspect-compat.js'

function registryFixture(): CordisInspectRegistryLike {
  const providers = new Map<string, unknown>()
  return {
    register(registration) {
      const id = registration.manifest.id
      if (providers.has(id)) throw new Error(`Host Cordis inspect provider "${id}" is already registered`)
      providers.set(id, registration)
      return () => providers.delete(id)
    },
  }
}

describe('Cordis Inspect late-service compatibility', () => {
  it('installs only when cordisInspect later becomes available', () => {
    let callback: ((child: { get(name: string): unknown }) => unknown) | undefined
    const inject = vi.fn((_dependencies: string[], registered: typeof callback) => {
      callback = registered
    })
    const ctx = { inject } as never

    _testing.installCordisInspectCompatibilityWhenAvailable(ctx)

    expect(inject).toHaveBeenCalledWith(['cordisInspect'], expect.any(Function))
    expect(callback).toBeDefined()
    const registry = registryFixture()
    const releasePatch = callback!({ get: (name) => name === 'cordisInspect' ? registry : undefined }) as () => void
    const releaseOne = registry.register({ manifest: { id: 'Service' }, query: () => 'shared' })
    const releaseTwo = registry.register({ manifest: { id: 'Service' }, query: () => 'shared' })

    expect(typeof releaseTwo).toBe('function')
    releaseOne()
    releaseTwo()
    releasePatch()
  })
})
