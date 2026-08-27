import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { ExecutionEndpoint } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import {
  builtinMountPresent,
  builtinReceiptSpec,
  disableBuiltinMount,
  enableBuiltinMount,
  parseBuiltinReceiptSpec,
} from '../../src/lifecycle/enable-builtin.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { sha256 } from '../../src/state/hashes.js'

const temporary = trackTempDirs()

const ENDPOINT: Extract<ExecutionEndpoint, { kind: 'host_bundled_enable' }> = {
  kind: 'host_bundled_enable',
  packageName: '@deepseek-ai/dsh-time-context',
  version: '0.1.1-rc.2',
  mountId: 'time-context',
  targetProfile: 'web',
}

const TEMPLATE_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'

async function seed(root: string, patchBody = TEMPLATE_PATCH): Promise<{
  bundledRoot: string
  dshHome: string
  patchPath: string
}> {
  const bundledRoot = path.join(root, 'cli')
  const packageDir = path.join(bundledRoot, 'node_modules', '@deepseek-ai', 'dsh-time-context')
  await mkdir(packageDir, { recursive: true })
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-time-context',
    version: '0.1.1-rc.2',
    description: 'Opt-in durable per-step context with the current time and elapsed time',
  }))
  const dshHome = path.join(root, 'dsh-home')
  const profileRoot = path.join(dshHome, 'profiles', 'web')
  await mkdir(profileRoot, { recursive: true })
  const patchPath = path.join(profileRoot, 'cordis.patch.yml')
  await writeFile(patchPath, patchBody)
  return { bundledRoot, dshHome, patchPath }
}

function launcherWith(dump: { exitCode: number | null, stdout?: string, stderr?: string }): DshLauncher {
  return {
    dumpConfig: async () => ({
      exitCode: dump.exitCode,
      signal: null,
      stdout: dump.stdout ?? '',
      stderr: dump.stderr ?? '',
    }),
  } as unknown as DshLauncher
}

describe('enableBuiltinMount', () => {
  it('appends an insert row to the profile patch layer and verifies the composition', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-write-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const result = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: '... time-context ...' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })

    expect(result).toMatchObject({ wrote: true, mountId: 'time-context', targetProfile: 'web' })
    expect(parse(await readFile(patchPath, 'utf8'))).toEqual([
      { insert: [{ id: 'time-context', name: '@deepseek-ai/dsh-time-context' }] },
    ])
  })

  it('merges with existing patch rows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-merge-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root, "- id: other-row\n  disabled: true\n")

    await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })

    expect(parse(await readFile(patchPath, 'utf8'))).toEqual([
      { id: 'other-row', disabled: true },
      { insert: [{ id: 'time-context', name: '@deepseek-ai/dsh-time-context' }] },
    ])
  })

  it('is idempotent when the mount row already exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-idem-'))
    temporary.push(root)
    const body = "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n"
    const { bundledRoot, dshHome, patchPath } = await seed(root, body)

    const result = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })

    expect(result.wrote).toBe(false)
    expect(await readFile(patchPath, 'utf8')).toBe(body)
  })

  it('rejects a version drift between selection and enablement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-drift-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const failure = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: { ...ENDPOINT, version: '0.0.0' },
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(EvolutionError)
    expect(failure).toMatchObject({ code: 'review_expired' })
    expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
  })

  it('rejects a package that is no longer bundled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-missing-'))
    temporary.push(root)
    const { bundledRoot, dshHome } = await seed(root)

    const failure = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: '' }),
      dshHome,
      bundledRoot,
      endpoint: { ...ENDPOINT, packageName: '@deepseek-ai/dsh-not-bundled' },
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'not_found' })
  })

  it('refuses an unsafe mount id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-unsafe-'))
    temporary.push(root)
    const { bundledRoot, dshHome } = await seed(root)

    const failure = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: '' }),
      dshHome,
      bundledRoot,
      endpoint: { ...ENDPOINT, mountId: '../escape' },
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'invalid_input' })
  })

  it('rolls the patch layer back when the composition check fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-rollback-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const failure = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 1, stderr: 'loader exploded' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({
      code: 'command_failed',
      details: { command: 'dsh', exitCode: 1, diagnosticHash: sha256('loader exploded') },
    })
    expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
  })

  it('fails when the dump output does not contain the mounted row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-absent-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const failure = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'composed tree without the row' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'command_failed' })
    expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
  })

  it('round-trips a built-in receipt and removes only its exact owned row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-remove-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const enabled = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })
    const encoded = builtinReceiptSpec({
      version: enabled.version,
      mountId: enabled.mountId,
      wrote: enabled.wrote,
    })
    const spec = parseBuiltinReceiptSpec(encoded)
    expect(spec).toEqual({ version: ENDPOINT.version, mountId: ENDPOINT.mountId, wrote: true })

    await disableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'composed profile without opt-in mount' }),
      dshHome,
      targetProfile: ENDPOINT.targetProfile,
      packageName: ENDPOINT.packageName,
      spec: spec!,
      cwd: root,
    })
    expect(parse(await readFile(patchPath, 'utf8'))).toEqual([])
  })

  it('preserves pre-effect ownership across a crash-style retry and removes the exact row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-reconcile-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const owned = !await builtinMountPresent({
      dshHome,
      targetProfile: ENDPOINT.targetProfile,
      mountId: ENDPOINT.mountId,
      packageName: ENDPOINT.packageName,
    })
    expect(owned).toBe(true)

    const first = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })
    expect(first.wrote).toBe(true)

    // Simulate restart after the profile write but before the final receipt.
    const recovered = await enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })
    expect(recovered.wrote).toBe(false)

    await disableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'profile without the owned row' }),
      dshHome,
      targetProfile: ENDPOINT.targetProfile,
      packageName: ENDPOINT.packageName,
      spec: { version: ENDPOINT.version, mountId: ENDPOINT.mountId, wrote: owned },
      cwd: root,
    })
    expect(parse(await readFile(patchPath, 'utf8'))).toEqual([])
  })

  it('rejects an unrelated row that already uses the selected mount identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-id-collision-'))
    temporary.push(root)
    const original = '- id: time-context\n  disabled: true\n'
    const { bundledRoot, dshHome, patchPath } = await seed(root, original)
    await expect(enableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })).rejects.toMatchObject({ code: 'review_expired' })
    expect(await readFile(patchPath, 'utf8')).toBe(original)
  })

  it('refuses to remove a built-in row after its exact owned shape drifted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-remove-drift-'))
    temporary.push(root)
    const drifted = "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n      config: {}\n"
    const { dshHome, patchPath } = await seed(root, drifted)

    await expect(disableBuiltinMount({
      launcher: launcherWith({ exitCode: 0, stdout: '' }),
      dshHome,
      targetProfile: ENDPOINT.targetProfile,
      packageName: ENDPOINT.packageName,
      spec: { version: ENDPOINT.version, mountId: ENDPOINT.mountId, wrote: true },
      cwd: root,
    })).rejects.toMatchObject({ code: 'review_expired' })
    expect(await readFile(patchPath, 'utf8')).toBe(drifted)
  })
})
