import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeConfig } from '../../src/config.js'
import { DshLauncher } from '../../src/lifecycle/launcher.js'
import type { CommandRequest, CommandRunner } from '../../src/process/runner.js'
import { fixtureDigestFor } from '../../src/host-verification-driver.js'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

function config(root: string): RuntimeConfig {
  return {
    dshHome: root,
    stateDir: root,
    ghCommand: 'gh',
    gitCommand: 'git',
    dshCommand: 'dsh',
    dshCommandArgs: [],
    maxCandidates: 5,
    maxFiles: 80,
    maxRepositoryBytes: 1_048_576,
    commandTimeoutMs: 30_000,
    forwardedCredentialEnv: ['OPENAI_API_KEY', 'XAI_API_KEY'],
    verificationPatchPaths: [],
    evolutionPreset: true,
  }
}

describe('Host-owned launcher verification', () => {
  it('strips configured credentials from isolated preflight installation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-install-'))
    temporary.push(directory)
    const previousOpenAi = process.env.OPENAI_API_KEY
    const previousXai = process.env.XAI_API_KEY
    process.env.OPENAI_API_KEY = 'secret-openai'
    process.env.XAI_API_KEY = 'secret-xai'
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
      expect(requests[0]?.env?.XAI_API_KEY).toBeUndefined()
      expect(requests[1]?.env?.OPENAI_API_KEY).toBe('secret-openai')
      expect(requests[1]?.env?.XAI_API_KEY).toBe('secret-xai')
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAi
      if (previousXai === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previousXai
    }
  })

  it('boots bundle_activation without a task, route, credentials, or Agent prompt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'autoevo-launcher-host-'))
    temporary.push(directory)
    const previousOpenAi = process.env.OPENAI_API_KEY
    const previousXai = process.env.XAI_API_KEY
    process.env.OPENAI_API_KEY = 'secret-openai'
    process.env.XAI_API_KEY = 'secret-xai'
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
          expect(overlay).toEqual(expect.arrayContaining([
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
      expect(captured?.env?.XAI_API_KEY).toBeUndefined()
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
      if (previousXai === undefined) delete process.env.XAI_API_KEY
      else process.env.XAI_API_KEY = previousXai
    }
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
        expect(overlayText).not.toContain('xai-oauth')
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
})
