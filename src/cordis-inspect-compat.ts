/**
 * Compatibility seam for DSH rc.6's process-global Cordis Inspect registry.
 *
 * `@deepseek-ai/dsh-tool-cordis` is intentionally mounted by both the official
 * Creator preset and AutoEvo's evolution preset. rc.6 registers the same four
 * provider manifests for every standing preset mount, while the Host registry
 * rejects duplicate ids. Share only first-party registrations with equivalent
 * manifest and query implementations, and keep their underlying registration
 * alive until the final preset releases it.
 *
 * TODO: revisit this seam when the DSH dependency moves past rc.6 — if the
 * registry dedupes standing preset mounts itself, delete this module and its
 * install call in index.ts (see tests/unit/cordis-inspect-compat.spec.ts).
 */

const SHAREABLE_PROVIDER_IDS = new Set(['Service', 'Event', 'Builtin', 'Tool'])

export interface CordisInspectProviderRegistration {
  manifest: Record<string, unknown> & { id: string }
  query(...args: unknown[]): unknown
}

export interface CordisInspectRegistryLike {
  register(registration: CordisInspectProviderRegistration): () => void
}

interface SharedRegistration {
  fingerprint: string
  registrations: CordisInspectProviderRegistration[]
  dispose: () => void
}

interface InstalledPatch {
  references: number
  release(): void
}

const installedPatches = new WeakMap<object, InstalledPatch>()

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== 'object') return value
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
    output[key] = stableValue(input[key])
  }
  return output
}

function manifestFingerprint(manifest: Record<string, unknown>): string {
  return JSON.stringify(stableValue(manifest))
}

function queryFingerprint(query: CordisInspectProviderRegistration['query']): string {
  return Function.prototype.toString.call(query)
}

function registrationFingerprint(registration: CordisInspectProviderRegistration): string {
  return JSON.stringify({
    manifest: manifestFingerprint(registration.manifest),
    query: queryFingerprint(registration.query),
  })
}

function idempotent(dispose: () => void): () => void {
  let active = true
  return () => {
    if (!active) return
    active = false
    dispose()
  }
}

/**
 * Install the narrow rc.6 compatibility layer. Unrelated provider ids and
 * conflicting manifests retain the Host registry's strict duplicate error.
 */
export function installCordisInspectCompatibility(
  registry: CordisInspectRegistryLike,
): () => void {
  const registryKey = registry as object
  const installed = installedPatches.get(registryKey)
  if (installed) {
    installed.references += 1
    return idempotent(() => {
      installed.references -= 1
      if (installed.references === 0) installed.release()
    })
  }

  const originalRegister = registry.register
  const shared = new Map<string, SharedRegistration>()

  const patchedRegister = function registerShared(
    this: CordisInspectRegistryLike,
    registration: CordisInspectProviderRegistration,
  ): () => void {
    const id = registration.manifest.id
    if (!SHAREABLE_PROVIDER_IDS.has(id)) {
      return originalRegister.call(registry, registration)
    }

    const fingerprint = registrationFingerprint(registration)
    let entry = shared.get(id)
    if (!entry) {
      entry = {
        fingerprint,
        registrations: [registration],
        dispose: () => {},
      }
      const activeEntry = entry
      entry.dispose = originalRegister.call(registry, {
        manifest: registration.manifest,
        query(...args: unknown[]): unknown {
          const activeRegistration = activeEntry.registrations[0]
          if (!activeRegistration) {
            throw new Error(`Cordis Inspect shared provider "${id}" has no active registration`)
          }
          return activeRegistration.query(...args)
        },
      })
      shared.set(id, entry)
    } else if (entry.fingerprint !== fingerprint) {
      // Delegate to the original strict registry so callers retain the native
      // conflict diagnostic and a changed provider cannot masquerade as shared.
      return originalRegister.call(registry, registration)
    } else {
      entry.registrations.push(registration)
    }

    return idempotent(() => {
      if (!entry) return
      const registrationIndex = entry.registrations.indexOf(registration)
      if (registrationIndex < 0) return
      entry.registrations.splice(registrationIndex, 1)
      if (entry.registrations.length !== 0) return
      shared.delete(id)
      entry.dispose()
    })
  }

  registry.register = patchedRegister
  const patch: InstalledPatch = {
    references: 1,
    release: idempotent(() => {
      if (registry.register === patchedRegister) registry.register = originalRegister
      installedPatches.delete(registryKey)
    }),
  }
  installedPatches.set(registryKey, patch)

  return idempotent(() => {
    patch.references -= 1
    if (patch.references === 0) patch.release()
  })
}
