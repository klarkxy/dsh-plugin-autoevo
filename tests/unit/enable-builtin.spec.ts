import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { parse } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { ExecutionEndpoint } from '../../src/contracts.js'
import { EvolutionError } from '../../src/errors.js'
import {
  builtinMountPresent,
  builtinReceiptSpec,
  disableBuiltinMount,
  enableBuiltinMount,
  _testing as builtinTesting,
  parseBuiltinReceiptSpec,
} from '../../src/lifecycle/enable-builtin.js'
import type { DshLauncher } from '../../src/lifecycle/launcher.js'
import { sha256 } from '../../src/state/hashes.js'

const temporary = trackTempDirs()

afterEach(() => builtinTesting.resetPatchFileOps())

const ENDPOINT: Extract<ExecutionEndpoint, { kind: 'host_bundled_enable' }> = {
  kind: 'host_bundled_enable',
  packageName: '@deepseek-ai/dsh-time-context',
  version: '0.1.1-rc.2',
  mountId: 'time-context',
  targetProfile: 'web',
}

const TEMPLATE_PATCH = '# Your patch layer for this dsh profile, applied after every bundle layer:\n[]\n'
const ENABLED_DUMP = '- id: time-context\n  name: "@deepseek-ai/dsh-time-context"\n'
const DISABLED_DUMP = '[]\n'

const EXEC = {
  callId: 'call-enable-builtin',
  signal: new AbortController().signal,
  agent: { id: 'session-enable-builtin', session: { header: { id: 'session-enable-builtin' } } },
} as unknown as ToolRunContext

function approvedMutation(
  request: () => Promise<string> = async () => 'allowed-once',
): { ctx: Context; exec: ToolRunContext; requirement: string } {
  return {
    ctx: { get: () => ({ request }) } as unknown as Context,
    exec: EXEC,
    requirement: 'current time',
  }
}

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
  const stdout = dump.stdout === 'time-context'
    ? ENABLED_DUMP
    : dump.stdout === '' || dump.stdout === 'composed profile without opt-in mount' || dump.stdout?.startsWith('profile without')
      ? DISABLED_DUMP
      : dump.stdout ?? ''
  return {
    dumpConfig: async () => ({
      exitCode: dump.exitCode,
      signal: null,
      stdout,
      stderr: dump.stderr ?? '',
    }),
  } as unknown as DshLauncher
}

describe('enableBuiltinMount', () => {
  it('accepts only an exact direct YAML dump row for the selected built-in identity', () => {
    expect(builtinTesting.dumpCompositionMatches(ENABLED_DUMP, ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(true)
    expect(builtinTesting.dumpCompositionMatches('- id: time-context\n  name: "@deepseek-ai/dsh-time-context"\n  config: !!js "dshHomePath(\'value\')"\n', ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(true)
    expect(builtinTesting.dumpCompositionMatches('"time-context"\n', ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(false)
    expect(builtinTesting.dumpCompositionMatches('# time-context\n[]\n', ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(false)
    expect(builtinTesting.dumpCompositionMatches('- id: time-context\n  name: "@deepseek-ai/dsh-other"\n', ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(false)
    expect(builtinTesting.dumpCompositionMatches(`${ENABLED_DUMP}${ENABLED_DUMP}`, ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(false)
    expect(builtinTesting.dumpCompositionMatches('- not: an-array-entry\n', ENDPOINT.mountId, ENDPOINT.packageName, true)).toBe(false)
    expect(builtinTesting.dumpCompositionMatches(DISABLED_DUMP, ENDPOINT.mountId, ENDPOINT.packageName, false)).toBe(true)
  })

  it('cleans an owned atomic temp after a landed temp-write rejection and preserves the original error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-atomic-write-'))
    temporary.push(root)
    const patchPath = path.join(root, 'cordis.patch.yml')
    await writeFile(patchPath, TEMPLATE_PATCH)
    const failure = new Error('temp write rejected after landing')
    builtinTesting.setPatchFileOps({
      writeFile: async (target, body, options) => {
        await writeFile(target, body, options)
        throw failure
      },
    })

    await expect(builtinTesting.writePatchAtomically(patchPath, TEMPLATE_PATCH, ENABLED_DUMP)).rejects.toBe(failure)
    await expect(readdir(root)).resolves.not.toContainEqual(expect.stringMatching(/\.tmp$/u))
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(TEMPLATE_PATCH)
  })

  it('accepts a rename that landed the exact postimage before rejecting and cleans its temp', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-atomic-rename-'))
    temporary.push(root)
    const patchPath = path.join(root, 'cordis.patch.yml')
    await writeFile(patchPath, TEMPLATE_PATCH)
    const failure = new Error('rename rejected after landing')
    builtinTesting.setPatchFileOps({
      rename: async (temporaryPath, target) => {
        await rename(temporaryPath, target)
        throw failure
      },
    })

    await expect(builtinTesting.writePatchAtomically(patchPath, TEMPLATE_PATCH, ENABLED_DUMP)).resolves.toBeUndefined()
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(ENABLED_DUMP)
    await expect(readdir(root)).resolves.not.toContainEqual(expect.stringMatching(/\.tmp$/u))
  })

  it('honors abort between temp write and preimage read without renaming the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-atomic-abort-'))
    temporary.push(root)
    const patchPath = path.join(root, 'cordis.patch.yml')
    await writeFile(patchPath, TEMPLATE_PATCH)
    const controller = new AbortController()
    const reason = new Error('abort before patch rename')
    builtinTesting.setPatchFileOps({
      writeFile: async (target, body, options) => {
        await writeFile(target, body, options)
        controller.abort(reason)
      },
    })

    await expect(builtinTesting.writePatchAtomically(patchPath, TEMPLATE_PATCH, ENABLED_DUMP, controller.signal)).rejects.toBe(reason)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(TEMPLATE_PATCH)
    await expect(readdir(root)).resolves.not.toContainEqual(expect.stringMatching(/\.tmp$/u))
  })

  it('does not let best-effort temp cleanup replace the primary atomic write error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-atomic-cleanup-'))
    temporary.push(root)
    const patchPath = path.join(root, 'cordis.patch.yml')
    await writeFile(patchPath, TEMPLATE_PATCH)
    const failure = new Error('primary atomic write error')
    builtinTesting.setPatchFileOps({
      writeFile: async (target, body, options) => {
        await writeFile(target, body, options)
        throw failure
      },
      rm: async () => { throw new Error('cleanup error') },
    })

    await expect(builtinTesting.writePatchAtomically(patchPath, TEMPLATE_PATCH, ENABLED_DUMP)).rejects.toBe(failure)
  })

  it('refuses a stale preimage or replacement target without overwriting either', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-atomic-conflict-'))
    temporary.push(root)
    const patchPath = path.join(root, 'cordis.patch.yml')
    const external = '- id: external\n  name: external-package\n'
    await writeFile(patchPath, TEMPLATE_PATCH)
    builtinTesting.setPatchFileOps({
      writeFile: async (target, body, options) => {
        await writeFile(target, body, options)
        if (String(target).endsWith('.tmp')) await writeFile(patchPath, external)
      },
    })
    await expect(builtinTesting.writePatchAtomically(patchPath, TEMPLATE_PATCH, ENABLED_DUMP)).rejects.toMatchObject({ code: 'review_expired' })
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(external)

    const replacement = '- id: replacement\n  name: replacement-package\n'
    const failure = new Error('rename rejected after replacement')
    await writeFile(patchPath, TEMPLATE_PATCH)
    builtinTesting.setPatchFileOps({
      rename: async (_temporaryPath, target) => {
        await writeFile(target, replacement)
        throw failure
      },
    })
    await expect(builtinTesting.writePatchAtomically(patchPath, TEMPLATE_PATCH, ENABLED_DUMP)).rejects.toBe(failure)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(replacement)
  })

  it('appends an insert row to the profile patch layer and verifies the composition', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-write-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const events: string[] = []
    const result = await enableBuiltinMount({
      ...approvedMutation(async () => {
        expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
        events.push('allowed-once')
        return 'allowed-once'
      }),
      launcher: {
        dumpConfig: async () => {
          expect(await readFile(patchPath, 'utf8')).not.toBe(TEMPLATE_PATCH)
          events.push('profile-write')
          return { exitCode: 0, signal: null, stdout: ENABLED_DUMP, stderr: '' }
        },
      } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      beforeProfileWrite: async () => {
        expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
        events.push('write-ahead-journal')
      },
    })

    expect(result).toMatchObject({ wrote: true, mountId: 'time-context', targetProfile: 'web' })
    expect(events).toEqual(['allowed-once', 'write-ahead-journal', 'profile-write'])
    expect(parse(await readFile(patchPath, 'utf8'))).toEqual([
      { insert: [{ id: 'time-context', name: '@deepseek-ai/dsh-time-context' }] },
    ])
  })

  it('merges with existing patch rows', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-merge-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root, "- id: other-row\n  disabled: true\n")

    await enableBuiltinMount({
      ...approvedMutation(),
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

  it('requires an allowed-once DSH approval before changing the profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-denied-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const dumpConfig = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: ENABLED_DUMP,
      stderr: '',
    }))
    const request = vi.fn(async () => 'denied')
    const beforeProfileWrite = vi.fn(async () => {})

    await expect(enableBuiltinMount({
      ...approvedMutation(request),
      launcher: { dumpConfig } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      beforeProfileWrite,
    })).rejects.toMatchObject({ code: 'approval_required', details: { outcome: 'denied' } })

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'capability_workflow_resume',
      callId: 'call-enable-builtin',
      reason: expect.stringContaining('@deepseek-ai/dsh-time-context@0.1.1-rc.2'),
    }))
    expect(dumpConfig).not.toHaveBeenCalled()
    expect(beforeProfileWrite).not.toHaveBeenCalled()
    expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
  })

  it('preserves the exact abort reason and starts no profile write when approval ignores cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-approval-abort-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const controller = new AbortController()
    const reason = new Error('approval ignored abort')
    const exec = { ...EXEC, signal: controller.signal } as ToolRunContext
    const dumpConfig = vi.fn()

    await expect(enableBuiltinMount({
      ctx: { get: () => ({ request: async () => {
        controller.abort(reason)
        return 'allowed-once'
      } }) } as unknown as Context,
      exec,
      requirement: 'current time',
      launcher: { dumpConfig } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(dumpConfig).not.toHaveBeenCalled()
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(TEMPLATE_PATCH)
  })

  it('rejects conflicting exec and explicit cancellation signals before any profile effect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-signal-conflict-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const exec = { ...EXEC, signal: new AbortController().signal } as ToolRunContext
    const signal = new AbortController().signal

    await expect(enableBuiltinMount({
      ...approvedMutation(),
      exec,
      launcher: { dumpConfig: vi.fn() } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      signal,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(TEMPLATE_PATCH)
  })

  it('leaves the postimage for recovery when cancellation starts after the atomic rename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-postwrite-abort-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const controller = new AbortController()
    const reason = new Error('abort after profile rename')
    const exec = { ...EXEC, signal: controller.signal } as ToolRunContext
    const dumpConfig = vi.fn()
    builtinTesting.setPatchFileOps({
      rename: async (temporaryPath, target) => {
        await rename(temporaryPath, target)
        controller.abort(reason)
      },
    })

    await expect(enableBuiltinMount({
      ...approvedMutation(),
      exec,
      launcher: { dumpConfig } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      signal: controller.signal,
    })).rejects.toBe(reason)
    expect(dumpConfig).not.toHaveBeenCalled()
    await expect(readFile(patchPath, 'utf8')).resolves.toContain('time-context')
  })

  it('leaves the postimage for retry when dump-config throws after the write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-dump-throw-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const first = await enableBuiltinMount({
      ...approvedMutation(),
      launcher: { dumpConfig: async () => { throw new Error('dump threw after evaluating patch') } } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)
    expect(first).toBeInstanceOf(Error)
    await expect(readFile(patchPath, 'utf8')).resolves.toContain('time-context')

    await expect(enableBuiltinMount({
      ...approvedMutation(),
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })).resolves.toMatchObject({ wrote: false })
  })

  it('refuses to overwrite a profile patch changed while approval was pending', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-approval-drift-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const changed = "- id: user-change\n  disabled: true\n"
    const beforeProfileWrite = vi.fn(async () => {})
    const dumpConfig = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: ENABLED_DUMP, stderr: '' }))

    await expect(enableBuiltinMount({
      ...approvedMutation(async () => {
        await writeFile(patchPath, changed, 'utf8')
        return 'allowed-once'
      }),
      launcher: { dumpConfig } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      beforeProfileWrite,
    })).rejects.toMatchObject({ code: 'review_expired' })

    expect(beforeProfileWrite).not.toHaveBeenCalled()
    expect(dumpConfig).not.toHaveBeenCalled()
    expect(await readFile(patchPath, 'utf8')).toBe(changed)
  })

  it('revalidates the exact bundled version after approval before writing the profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-bundle-drift-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const beforeProfileWrite = vi.fn(async () => {})
    const dumpConfig = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: ENABLED_DUMP, stderr: '' }))
    const manifestPath = path.join(
      bundledRoot,
      'node_modules',
      '@deepseek-ai',
      'dsh-time-context',
      'package.json',
    )

    await expect(enableBuiltinMount({
      ...approvedMutation(async () => {
        await writeFile(manifestPath, JSON.stringify({
          name: '@deepseek-ai/dsh-time-context',
          version: '0.1.1-rc.3',
          description: 'Opt-in durable per-step context with the current time and elapsed time',
        }), 'utf8')
        return 'allowed-once'
      }),
      launcher: { dumpConfig } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
      beforeProfileWrite,
    })).rejects.toMatchObject({
      code: 'review_expired',
      details: { expectedVersion: '0.1.1-rc.2', actualVersion: '0.1.1-rc.3' },
    })

    expect(beforeProfileWrite).not.toHaveBeenCalled()
    expect(dumpConfig).not.toHaveBeenCalled()
    expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
  })

  it('is idempotent when the mount row already exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-idem-'))
    temporary.push(root)
    const body = "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n"
    const { bundledRoot, dshHome, patchPath } = await seed(root, body)

    const request = vi.fn(async () => 'allowed-once')
    const result = await enableBuiltinMount({
      ...approvedMutation(request),
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })

    expect(result.wrote).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(await readFile(patchPath, 'utf8')).toBe(body)
  })

  it('rejects a version drift between selection and enablement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-drift-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const failure = await enableBuiltinMount({
      ...approvedMutation(),
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
      ...approvedMutation(),
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
      ...approvedMutation(),
      launcher: launcherWith({ exitCode: 0, stdout: '' }),
      dshHome,
      bundledRoot,
      endpoint: { ...ENDPOINT, mountId: '../escape' },
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'invalid_input' })
  })

  it('leaves the written patch for write-ahead recovery when the composition check fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-rollback-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const failure = await enableBuiltinMount({
      ...approvedMutation(),
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
    expect(await readFile(patchPath, 'utf8')).toContain('time-context')
  })

  it('preserves an external patch edit made during a failed enablement check', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-rollback-race-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const external = "- id: user-change\n  disabled: true\n"

    await expect(enableBuiltinMount({
      ...approvedMutation(),
      launcher: {
        dumpConfig: async () => {
          await writeFile(patchPath, external, 'utf8')
          return { exitCode: 1, signal: null, stdout: '', stderr: 'loader exploded' }
        },
      } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })).rejects.toMatchObject({ code: 'review_expired' })

    expect(await readFile(patchPath, 'utf8')).toBe(external)
  })

  it('rejects an externally removed and reinserted mount row after a successful check', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-postimage-race-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const external = "- id: user-change\n  disabled: true\n- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n"

    await expect(enableBuiltinMount({
      ...approvedMutation(),
      launcher: {
        dumpConfig: async () => {
          await writeFile(patchPath, external, 'utf8')
          return { exitCode: 0, signal: null, stdout: ENABLED_DUMP, stderr: '' }
        },
      } as unknown as DshLauncher,
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })).rejects.toMatchObject({ code: 'review_expired' })

    expect(await readFile(patchPath, 'utf8')).toBe(external)
  })

  it('fails when the dump output does not contain the mounted row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-absent-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)

    const failure = await enableBuiltinMount({
      ...approvedMutation(),
      launcher: launcherWith({ exitCode: 0, stdout: 'composed tree without the row' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'command_failed' })
    expect(await readFile(patchPath, 'utf8')).toContain('time-context')
  })

  it('round-trips a built-in receipt and removes only its exact owned row', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-remove-'))
    temporary.push(root)
    const { bundledRoot, dshHome, patchPath } = await seed(root)
    const enabled = await enableBuiltinMount({
      ...approvedMutation(),
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

  it('preserves an external patch edit made during a failed removal check', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-remove-rollback-race-'))
    temporary.push(root)
    const original = "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n"
    const { dshHome, patchPath } = await seed(root, original)
    const external = "- id: user-change\n  disabled: true\n"

    await expect(disableBuiltinMount({
      launcher: {
        dumpConfig: async () => {
          await writeFile(patchPath, external, 'utf8')
          return { exitCode: 1, signal: null, stdout: '', stderr: 'loader exploded' }
        },
      } as unknown as DshLauncher,
      dshHome,
      targetProfile: ENDPOINT.targetProfile,
      packageName: ENDPOINT.packageName,
      spec: { version: ENDPOINT.version, mountId: ENDPOINT.mountId, wrote: true },
      cwd: root,
    })).rejects.toMatchObject({ code: 'review_expired' })

    expect(await readFile(patchPath, 'utf8')).toBe(external)
  })

  it('rejects an externally reinserted mount row after a successful removal check', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-remove-postimage-race-'))
    temporary.push(root)
    const original = "- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n"
    const { dshHome, patchPath } = await seed(root, original)
    const external = "- id: user-change\n  disabled: true\n- insert:\n    - id: time-context\n      name: '@deepseek-ai/dsh-time-context'\n"

    await expect(disableBuiltinMount({
      launcher: {
        dumpConfig: async () => {
          await writeFile(patchPath, external, 'utf8')
          return { exitCode: 0, signal: null, stdout: DISABLED_DUMP, stderr: '' }
        },
      } as unknown as DshLauncher,
      dshHome,
      targetProfile: ENDPOINT.targetProfile,
      packageName: ENDPOINT.packageName,
      spec: { version: ENDPOINT.version, mountId: ENDPOINT.mountId, wrote: true },
      cwd: root,
    })).rejects.toMatchObject({ code: 'review_expired' })

    expect(await readFile(patchPath, 'utf8')).toBe(external)
  })

  it('treats an absent exact row as a no-op only for recovery journals', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-enable-recovery-absent-'))
    temporary.push(root)
    const { dshHome, patchPath } = await seed(root)
    const dumpConfig = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' }))

    const result = await disableBuiltinMount({
      launcher: { dumpConfig } as unknown as DshLauncher,
      dshHome,
      targetProfile: 'web',
      packageName: ENDPOINT.packageName,
      spec: { version: ENDPOINT.version, mountId: ENDPOINT.mountId, wrote: true },
      cwd: root,
      allowAbsent: true,
    })

    expect(result).toEqual({ wrote: false })
    expect(dumpConfig).not.toHaveBeenCalled()
    expect(await readFile(patchPath, 'utf8')).toBe(TEMPLATE_PATCH)
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
      ...approvedMutation(),
      launcher: launcherWith({ exitCode: 0, stdout: 'time-context' }),
      dshHome,
      bundledRoot,
      endpoint: ENDPOINT,
      cwd: root,
    })
    expect(first.wrote).toBe(true)

    // Simulate restart after the profile write but before the final receipt.
    const recovered = await enableBuiltinMount({
      ...approvedMutation(),
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
      ...approvedMutation(),
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
