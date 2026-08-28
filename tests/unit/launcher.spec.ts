import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testRuntimeConfig } from '../helpers/runtime-config.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { RuntimeConfig } from '../../src/config.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
import type { CommandRequest, CommandRunner } from '../../src/process/runner.js'
import { fixtureDigestFor } from '../../src/host-verification-driver.js'
import { EvolutionError } from '../../src/errors.js'
import { sha256 } from '../../src/state/hashes.js'

const temporary = trackTempDirs()

function config(root: string): RuntimeConfig {
  return testRuntimeConfig(root, {
    dshHome: root,
    forwardedCredentialEnv: ['OPENAI_API_KEY', 'SYNTHETIC_API_KEY'],
    evolutionPreset: true,
  })
}

describe('Host-owned launcher verification', () => {
  it('pins installation to the store that owns the existing profile node_modules tree', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-store-'))
    temporary.push(directory)
    const storeDir = path.join(directory, 'pnpm-store', 'v10')
    const modulesRoot = path.join(directory, 'profiles', 'web', 'node_modules')
    await mkdir(modulesRoot, { recursive: true })
    await writeFile(path.join(modulesRoot, '.modules.yaml'), `storeDir: ${JSON.stringify(storeDir)}\n`, 'utf8')
    let captured: CommandRequest | undefined
    const runner: CommandRunner = {
      async run(request) {
        captured = request
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    await new DshLauncher(runner, config(directory))
      .install(directory, 'web', 'github:acme/tool#commit', process.cwd())

    expect(captured?.argv.at(-1)).toBe(`--config.store-dir=${storeDir}`)
    expect(await new DshLauncher(runner, config(directory)).profileStoreFingerprint(directory, 'web'))
      .toMatch(/^[a-f0-9]{64}$/u)
  })

  it('does not trust a relative store path from profile metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-store-relative-'))
    temporary.push(directory)
    const modulesRoot = path.join(directory, 'profiles', 'web', 'node_modules')
    await mkdir(modulesRoot, { recursive: true })
    await writeFile(path.join(modulesRoot, '.modules.yaml'), 'storeDir: ../unexpected\n', 'utf8')
    let captured: CommandRequest | undefined
    const runner: CommandRunner = {
      async run(request) {
        captured = request
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }

    await new DshLauncher(runner, config(directory))
      .install(directory, 'web', 'github:acme/tool#commit', process.cwd())

    expect(captured?.argv).not.toContain('--store-dir')
    expect(captured?.argv.some((item) => item.startsWith('--config.store-dir='))).toBe(false)
  })

  it('fails closed before invoking DSH when the sealed profile store fingerprint drifted', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-store-drift-'))
    temporary.push(directory)
    const modulesRoot = path.join(directory, 'profiles', 'web', 'node_modules')
    await mkdir(modulesRoot, { recursive: true })
    await writeFile(path.join(modulesRoot, '.modules.yaml'), `storeDir: ${JSON.stringify(path.join(directory, 'store-a'))}\n`, 'utf8')
    const runner = { run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '' })) } as CommandRunner
    const launcher = new DshLauncher(runner, config(directory))
    const sealed = await launcher.profileStoreFingerprint(directory, 'web')
    expect(sealed).toMatch(/^[a-f0-9]{64}$/u)
    if (!sealed) throw new Error('expected a sealed profile store fingerprint')
    await writeFile(path.join(modulesRoot, '.modules.yaml'), `storeDir: ${JSON.stringify(path.join(directory, 'store-b'))}\n`, 'utf8')

    await expect(launcher.install(directory, 'web', 'github:acme/tool#commit', process.cwd(), undefined, {
      expectedProfileStoreFingerprint: sealed,
    })).rejects.toThrow(/store changed/i)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('strips configured credentials from isolated preflight installation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-install-'))
    temporary.push(directory)
    const previousOpenAi = process.env.OPENAI_API_KEY
    const previousXai = process.env.SYNTHETIC_API_KEY
    process.env.OPENAI_API_KEY = 'secret-openai'
    process.env.SYNTHETIC_API_KEY = 'synthetic-secret'
    const requests: CommandRequest[] = []
    try {
      const runner: CommandRunner = {
        async run(request) {
          requests.push(request)
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      }
      const launcher = new DshLauncher(runner, config(directory))
      await launcher.install(directory, 'headless', 'github:acme/tool#commit', process.cwd(), undefined, {
        forwardCredentials: false,
      })
      await launcher.install(directory, 'web', 'github:acme/tool#commit', process.cwd())

      expect(requests[0]?.env?.OPENAI_API_KEY).toBeUndefined()
      expect(requests[0]?.env?.SYNTHETIC_API_KEY).toBeUndefined()
      expect(requests[1]?.env?.OPENAI_API_KEY).toBe('secret-openai')
      expect(requests[1]?.env?.SYNTHETIC_API_KEY).toBe('synthetic-secret')
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAi
      if (previousXai === undefined) delete process.env.SYNTHETIC_API_KEY
      else process.env.SYNTHETIC_API_KEY = previousXai
    }
  })

  it('boots bundle_activation without a task, route, credentials, or Agent prompt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-host-'))
    temporary.push(directory)
    const previousOpenAi = process.env.OPENAI_API_KEY
    const previousXai = process.env.SYNTHETIC_API_KEY
    process.env.OPENAI_API_KEY = 'secret-openai'
    process.env.SYNTHETIC_API_KEY = 'synthetic-secret'
    let captured: CommandRequest | undefined
    try {
      const runner: CommandRunner = {
        async run(request) {
          captured = request
          const patchIndex = request.argv.lastIndexOf('--patch')
          const overlay = JSON.parse(await readFile(request.argv[patchIndex + 1]!, 'utf8')) as Array<{
            id?: string
            disabled?: boolean
            insert?: Array<{ config: { receiptPath: string; layer?: string } }>
          }>
          expect(overlay).not.toEqual(expect.arrayContaining([
            { id: 'headless-startup', disabled: true },
            { id: 'headless-runner', disabled: true },
          ]))
          const observer = overlay.find((entry) => entry.insert)?.insert?.[0]
          const receiptPath = observer!.config.receiptPath
          await writeFile(receiptPath, `${JSON.stringify({
            kind: 'host/complete',
            layer: 'bundle_activation',
            status: 'passed',
            sourceMatched: true,
            expectedTools: [],
            calledTools: [],
            resultTools: [],
            failedTools: [],
            executedCount: 0,
            reason: 'Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn.',
          })}\n`, 'utf8')
          return { exitCode: 0, signal: null, stdout: '', stderr: '' }
        },
      }
      const result = await new DshLauncher(runner, config(directory)).verifyHost({
        dshHome: directory,
        profile: 'headless',
        cwd: process.cwd(),
        layer: 'bundle_activation',
        packageName: 'dsh-tool-calculator',
        expectedTools: [],
        fixtures: [],
        fixtureDigest: fixtureDigestFor([]),
      })
      expect(captured?.argv.includes('calculate 6 * 7')).toBe(false)
      expect(captured?.argv.some((item) => item.includes('test calculator'))).toBe(false)
      expect(JSON.stringify(captured?.argv)).not.toContain('expectedRoute')
      expect(captured?.env?.OPENAI_API_KEY).toBeUndefined()
      expect(captured?.env?.SYNTHETIC_API_KEY).toBeUndefined()
      expect(captured?.env?.DSH_HOME).toBe(directory)
      expect(JSON.stringify(captured?.env)).not.toContain('secret')
      expect(result).toMatchObject({
        attempted: true,
        layer: 'bundle_activation',
        status: 'passed',
        taskResultObserved: false,
        sessionFiles: [],
      })
      expect(result.task).toBeUndefined()
      expect(result.receiptPath).toBeUndefined()
      expect(JSON.stringify(result)).not.toMatch(/secret|expression|arguments|OPENAI/u)
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAi
      if (previousXai === undefined) delete process.env.SYNTHETIC_API_KEY
      else process.env.SYNTHETIC_API_KEY = previousXai
    }
  })

  it('puts installed carrier insert Fibers on the Host overlay when review freeze is absent', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-carrier-'))
    temporary.push(directory)
    const packageRoot = path.join(directory, 'profiles', 'headless', 'node_modules', 'dsh-plugin-beta')
    await mkdir(path.join(packageRoot, 'dsh-plugin'), { recursive: true })
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-beta',
      dsh: { bundle: { patch: './dsh-plugin/cordis.patch.yml' } },
    }), 'utf8')
    await writeFile(path.join(packageRoot, 'dsh-plugin', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: record-sync-tool',
      '      name: \'@deepseek-ai/dsh-mcp-client\'',
    ].join('\n'), 'utf8')
    const runner: CommandRunner = {
      async run(request) {
        const patchIndex = request.argv.lastIndexOf('--patch')
        const overlay = JSON.parse(await readFile(request.argv[patchIndex + 1]!, 'utf8')) as Array<{
          insert?: Array<{ config: { receiptPath: string; activatedFibersJson?: string } }>
        }>
        const observer = overlay.find((entry) => entry.insert)?.insert?.[0]
        expect(JSON.parse(observer!.config.activatedFibersJson ?? '[]')).toEqual([{
          id: 'record-sync-tool',
          name: '@deepseek-ai/dsh-mcp-client',
        }])
        await writeFile(observer!.config.receiptPath, `${JSON.stringify({
          kind: 'host/complete',
          layer: 'bundle_activation',
          status: 'passed',
          sourceMatched: true,
          expectedTools: [],
          calledTools: [],
          resultTools: [],
          failedTools: [],
          executedCount: 0,
          reason: 'Host loaded the reviewed bundle and Loader/Fiber settled without an Agent turn.',
        })}\n`, 'utf8')
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }
    await new DshLauncher(runner, config(directory)).verifyHost({
      dshHome: directory,
      profile: 'headless',
      cwd: process.cwd(),
      layer: 'bundle_activation',
      packageName: 'dsh-plugin-beta',
      expectedTools: [],
      fixtures: [],
      fixtureDigest: fixtureDigestFor([]),
    })
  })

  it('ignores expectedRoute and does not put fixture arguments on the installation evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-host-roundtrip-'))
    temporary.push(directory)
    const runner: CommandRunner = {
      async run(request) {
        const patchIndex = request.argv.lastIndexOf('--patch')
        const overlayPath = request.argv[patchIndex + 1]!
        const overlayText = await readFile(overlayPath, 'utf8')
        expect(overlayText).not.toContain('expectedProvider')
        expect(overlayText).not.toContain('provider-alpha')
        expect(overlayText).not.toContain('verificationTask')
        const overlay = JSON.parse(overlayText) as Array<{ insert?: Array<{ config: { receiptPath: string } }> }>
        const observer = overlay.find((entry) => entry.insert)?.insert?.[0]
        await writeFile(observer!.config.receiptPath, `${JSON.stringify({
          kind: 'host/complete',
          layer: 'tool_roundtrip',
          status: 'passed',
          sourceMatched: true,
          expectedTools: ['calculator'],
          calledTools: ['calculator'],
          resultTools: ['calculator'],
          failedTools: [],
          executedCount: 1,
          reason: 'Host executed 1 expected tool(s) once through ToolRuntime.execute.',
        })}\n`, 'utf8')
        return { exitCode: 0, signal: null, stdout: 'raw tool output must not be copied', stderr: '' }
      },
    }
    const result = await new DshLauncher(runner, config(directory)).verifyHost({
      dshHome: directory,
      profile: 'headless',
      cwd: process.cwd(),
      layer: 'tool_roundtrip',
      packageName: 'dsh-tool-calculator',
      expectedTools: ['calculator'],
      fixtures: [{ tool: 'calculator', arguments: { expression: '1+1' } }],
      fixtureDigest: fixtureDigestFor([{ tool: 'calculator', arguments: { expression: '1+1' } }]),
    })
    expect(result).toMatchObject({
      layer: 'tool_roundtrip',
      status: 'passed',
      calledTools: ['calculator'],
      resultTools: ['calculator'],
    })
    expect(JSON.stringify(result)).not.toContain('1+1')
    expect(JSON.stringify(result)).not.toContain('raw tool output')
    expect(JSON.stringify(result)).not.toContain('expression')
  })

  it('reads exact old/new profile dependency specs for replacement reconciliation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-spec-'))
    temporary.push(directory)
    const profileRoot = path.join(directory, 'profiles', 'web')
    await mkdir(profileRoot, { recursive: true })
    const oldSpec = `github:anonymous-lab/dsh-plugin-alpha#${'a'.repeat(40)}`
    const newSpec = `github:anonymous-lab/dsh-plugin-alpha#${'b'.repeat(40)}`
    await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-plugin-alpha': oldSpec },
      dsh: { profile: { bundles: ['dsh-plugin-alpha'] } },
    }))
    const launcher = new DshLauncher({
      async run() {
        return { exitCode: 0, signal: null, stdout: '', stderr: '' }
      },
    }, config(directory))
    expect(await launcher.profileDependencySpec(directory, 'web', 'dsh-plugin-alpha')).toBe(oldSpec)
    expect(await launcher.profileSourceMatches(directory, 'web', 'dsh-plugin-alpha', oldSpec)).toBe(true)
    expect(await launcher.profileSourceMatches(directory, 'web', 'dsh-plugin-alpha', newSpec)).toBe(false)
    expect(await launcher.profileTargetAbsent(directory, 'web', 'dsh-plugin-alpha')).toBe(false)
    await writeFile(path.join(profileRoot, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-plugin-alpha': newSpec },
      dsh: { profile: { bundles: ['dsh-plugin-alpha'] } },
    }))
    expect(await launcher.profileDependencySpec(directory, 'web', 'dsh-plugin-alpha')).toBe(newSpec)
    expect(await launcher.profileSourceMatches(directory, 'web', 'dsh-plugin-alpha', newSpec)).toBe(true)
  })
})

describe('git-hosted install lifecycle ownership', () => {
  function pnpmGitPrepareError(...versionedNames: string[]): string {
    const details = versionedNames
      .map((name) => `The git-hosted package "${name}" needs to execute build scripts but is not in the "onlyBuiltDependencies" allowlist.`)
      .join('\n')
    return ` ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  Failed to prepare git-hosted package: ${details}`
  }

  async function seedProfileWorkspace(directory: string, extra = ''): Promise<string> {
    const profileRoot = path.join(directory, 'profiles', 'web')
    await mkdir(profileRoot, { recursive: true })
    const workspacePath = path.join(profileRoot, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n${extra}`)
    return workspacePath
  }

  function scriptedRunner(...outcomes: Array<{ exitCode: number, stdout?: string, stderr?: string }>): {
    runner: CommandRunner
    requests: CommandRequest[]
  } {
    const requests: CommandRequest[] = []
    let index = 0
    return {
      requests,
      runner: {
        async run(request) {
          requests.push(request)
          const outcome = outcomes[Math.min(index, outcomes.length - 1)]
          index += 1
          return { exitCode: outcome?.exitCode ?? 0, signal: null, stdout: outcome?.stdout ?? '', stderr: outcome?.stderr ?? '' }
        },
      },
    }
  }

  it('reports a blocked prepare without mutating the profile workspace or retrying', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-git-prepare-'))
    temporary.push(directory)
    const workspacePath = await seedProfileWorkspace(directory)
    const stderr = pnpmGitPrepareError('acme-tool@0.1.1')
    const stdout = 'ERR_PNPM_PREPARE_PACKAGE failed while preparing acme-tool'
    const { runner, requests } = scriptedRunner({ exitCode: 1, stdout, stderr }, { exitCode: 0 })

    const before = await readFile(workspacePath, 'utf8')
    const failure = await new DshLauncher(runner, config(directory))
      .install(directory, 'web', 'github:acme/tool#commit', process.cwd())
      .then(() => undefined, (error: unknown) => error)

    expect(requests).toHaveLength(1)
    expect(failure).toBeInstanceOf(EvolutionError)
    expect(failure).toMatchObject({
      code: 'command_failed',
      message: 'dsh exited with code 1',
      details: {
        command: 'dsh',
        exitCode: 1,
        diagnosticSummary: expect.stringContaining('ERR_PNPM_PREPARE_PACKAGE'),
        diagnosticHash: sha256(JSON.stringify([stdout, stderr])),
      },
    })
    expect(await readFile(workspacePath, 'utf8')).toBe(before)
  })

  it('does not retry or touch the workspace file for unrelated install failures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-git-unrelated-'))
    temporary.push(directory)
    const workspacePath = await seedProfileWorkspace(directory)
    const before = await readFile(workspacePath, 'utf8')
    const { runner, requests } = scriptedRunner({ exitCode: 1, stderr: 'some other pnpm failure' })

    const failure = await new DshLauncher(runner, config(directory))
      .install(directory, 'web', 'github:acme/tool#commit', process.cwd())
      .then(() => undefined, (error: unknown) => error)

    expect(requests).toHaveLength(1)
    expect(failure).toBeInstanceOf(EvolutionError)
    expect(await readFile(workspacePath, 'utf8')).toBe(before)
  })

  it('passes exact release-age exclusions only on the install command without changing policy files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-release-age-'))
    temporary.push(directory)
    const workspacePath = await seedProfileWorkspace(directory, 'minimumReleaseAge: 1440\n')
    const before = await readFile(workspacePath, 'utf8')
    const { runner, requests } = scriptedRunner({ exitCode: 0 })

    await new DshLauncher(runner, config(directory)).install(
      directory,
      'web',
      'github:acme/tool#commit',
      process.cwd(),
      undefined,
      {
        minimumReleaseAgeExcludes: [
          'ds-harness-remote@0.3.35',
          '@deepseek-ai/dsh-file-viewer@0.2.5',
        ],
      },
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]!.argv).toContain('--config.minimum-release-age-exclude=@deepseek-ai/dsh-file-viewer@0.2.5')
    expect(requests[0]!.argv).toContain('--config.minimum-release-age-exclude=ds-harness-remote@0.3.35')
    expect(await readFile(workspacePath, 'utf8')).toBe(before)
  })

  it('rejects broad or floating release-age exclusions before invoking DSH', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-release-age-invalid-'))
    temporary.push(directory)
    const { runner, requests } = scriptedRunner({ exitCode: 0 })
    await expect(new DshLauncher(runner, config(directory)).install(
      directory,
      'web',
      'github:acme/tool#commit',
      process.cwd(),
      undefined,
      { minimumReleaseAgeExcludes: ['ds-harness-remote@latest'] },
    )).rejects.toMatchObject({ code: 'invalid_input' })
    expect(requests).toHaveLength(0)
  })
})
