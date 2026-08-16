import { describe, expect, it, vi } from 'vitest'
import {
  installCordisInspectCompatibility,
  type CordisInspectProviderRegistration,
  type CordisInspectRegistryLike,
} from '../../src/cordis-inspect-compat.js'

function provider(
  id: string,
  description = 'same',
  query: CordisInspectProviderRegistration['query'] = vi.fn(),
): CordisInspectProviderRegistration {
  return {
    manifest: {
      id,
      description,
      methods: [{ name: 'list', inputSchema: {}, outputSchema: {} }],
    },
    query,
  }
}

function queryWithValue(value: string, onCall: () => void): CordisInspectProviderRegistration['query'] {
  return () => {
    onCall()
    return value
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

  it('keeps same-manifest providers with different query implementations fail-closed', () => {
    const registry = registryFixture()
    const uninstall = installCordisInspectCompatibility(registry)
    const release = registry.register(provider('Service', 'same', () => 'creator'))

    expect(() => registry.register(provider('Service', 'same', () => 'evolution'))).toThrow(/already registered/u)
    release()
    uninstall()
  })

  it('forwards shared providers to an equivalent registration that remains active', () => {
    const registry = registryFixture()
    const uninstall = installCordisInspectCompatibility(registry)
    const creatorCalls = vi.fn()
    const evolutionCalls = vi.fn()
    const creatorQuery = queryWithValue('creator', creatorCalls)
    const evolutionQuery = queryWithValue('evolution', evolutionCalls)
    const releaseCreator = registry.register(provider('Service', 'same', creatorQuery))
    const releaseEvolution = registry.register(provider('Service', 'same', evolutionQuery))

    // The factory-generated mock functions have the same stable implementation
    // fingerprint but separate closures, so the proxy must not retain Creator.
    releaseCreator()
    expect(registry.providers.get('Service')?.query()).toBe('evolution')
    expect(creatorCalls).not.toHaveBeenCalled()
    expect(evolutionCalls).toHaveBeenCalledTimes(1)

    releaseEvolution()
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
