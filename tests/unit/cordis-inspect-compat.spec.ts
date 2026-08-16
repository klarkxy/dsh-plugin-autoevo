import { describe, expect, it, vi } from 'vitest'
import {
  installCordisInspectCompatibility,
  type CordisInspectProviderRegistration,
  type CordisInspectRegistryLike,
} from '../../src/cordis-inspect-compat.js'

function provider(id: string, description = 'same'): CordisInspectProviderRegistration {
  return {
    manifest: {
      id,
      description,
      methods: [{ name: 'list', inputSchema: {}, outputSchema: {} }],
    },
    query: vi.fn(),
  }
}

function registryFixture(): CordisInspectRegistryLike & { providers: Map<string, CordisInspectProviderRegistration> } {
  const providers = new Map<string, CordisInspectProviderRegistration>()
  return {
    providers,
    register(registration) {
      const id = registration.manifest.id
      if (providers.has(id)) throw new Error(`Host Cordis inspect provider "${id}" is already registered`)
      providers.set(id, registration)
      return () => {
        if (providers.get(id) === registration) providers.delete(id)
      }
    },
  }
}

describe('Cordis Inspect rc.6 compatibility', () => {
  it('reference-counts identical first-party provider manifests', () => {
    const registry = registryFixture()
    const uninstall = installCordisInspectCompatibility(registry)
    const releaseCreator = registry.register(provider('Service'))
    const releaseEvolution = registry.register(provider('Service'))

    expect(registry.providers.size).toBe(1)
    releaseCreator()
    expect(registry.providers.has('Service')).toBe(true)
    releaseEvolution()
    expect(registry.providers.has('Service')).toBe(false)
    uninstall()
  })

  it('keeps conflicting first-party manifests fail-closed', () => {
    const registry = registryFixture()
    const uninstall = installCordisInspectCompatibility(registry)
    const release = registry.register(provider('Tool', 'official'))

    expect(() => registry.register(provider('Tool', 'changed'))).toThrow(/already registered/u)
    release()
    uninstall()
  })

  it('does not weaken duplicate handling for unrelated providers', () => {
    const registry = registryFixture()
    const uninstall = installCordisInspectCompatibility(registry)
    const release = registry.register(provider('Community'))

    expect(() => registry.register(provider('Community'))).toThrow(/already registered/u)
    release()
    uninstall()
  })

  it('installs once and restores the original register method after the final owner', () => {
    const registry = registryFixture()
    const original = registry.register
    const releaseOne = installCordisInspectCompatibility(registry)
    const patched = registry.register
    const releaseTwo = installCordisInspectCompatibility(registry)

    expect(patched).not.toBe(original)
    expect(registry.register).toBe(patched)
    releaseOne()
    expect(registry.register).toBe(patched)
    releaseTwo()
    expect(registry.register).toBe(original)
  })
})
