import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testReview } from '../helpers/records.js'
import { trackTempDirs } from '../helpers/temp-dirs.js'
import type { Context } from '@deepseek-ai/cordis'
import { POLICY_VERSION, type ReviewRecord } from '../../src/contracts.js'
import {
  applyHostVerification,
  declaredVerificationFixturesFromPackage,
  extractFixtureArguments,
  fixtureDigestFor,
  hostLayerSuccess,
  hostVerificationOverlay,
  inspectLoadedToolSafety,
  runHostVerification,
  sanitizeHostVerificationEvidence,
  selectInstallVerificationLayer,
  verificationChildEnv,
  _testing as driverTesting,
} from '../../src/host-verification-driver.js'

const temporary = trackTempDirs()

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return testReview({
    createdAt: '2026-08-21T00:00:00.000Z',
    manifest: {
      kind: 'bundle',
      packageName: 'dsh-tool-calculator',
      bundlePatch: './cordis.patch.yml',
      scripts: [],
      dependencies: [],
      peerDependencies: {},
      expectedTools: ['calculator'],
    },
    runtimeSurface: {
      llmDependency: false,
      llmRegistered: false,
      credentialsDependency: false,
      credentialsRegistered: false,
      networkSignal: false,
      environmentSignal: false,
      processSignal: false,
      skillOnly: false,
      unsafeTools: false,
      expectedTools: ['calculator'],
      toolFixtures: [{ tool: 'calculator', available: true, safe: false, hostValidated: false }],
      kind: 'bundle',
      verificationLayer: 'manual_runtime',
    },
    ...overrides,
  })
}

function attestedReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  const current = review(overrides)
  const expectedTools = [...current.manifest.expectedTools]
  return {
    ...current,
    runtimeSurface: overrides.runtimeSurface ?? {
      llmDependency: false,
      llmRegistered: false,
      credentialsDependency: false,
      credentialsRegistered: false,
      networkSignal: false,
      environmentSignal: false,
      processSignal: false,
      skillOnly: false,
      unsafeTools: false,
      expectedTools,
      toolFixtures: expectedTools.map((tool) => ({
        tool, available: true, safe: true, hostValidated: true,
      })),
      kind: 'bundle',
      verificationLayer: expectedTools.length > 0 ? 'tool_roundtrip' : 'bundle_activation',
    },
  }
}

function loadedTool(name = 'calculator', extra: Record<string, unknown> = {}) {
  return {
    name,
    description: 'math',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false,
    },
    ...extra,
  }
}

describe('Host fixture validator', () => {
  it('reads only the namespaced fixtures object and ignores candidate safe:true', async () => {
    const pkg = JSON.parse(await readFile(
      path.join(process.cwd(), 'tests/fixtures/host-verification-calculator.json'),
      'utf8',
    )) as unknown
    const declared = declaredVerificationFixturesFromPackage(pkg)
    expect(declared.calculator).toMatchObject({ arguments: { expression: '1+1' }, safe: true })
    expect(extractFixtureArguments(declared.calculator)).toEqual({ expression: '1+1' })
    expect(extractFixtureArguments({ safe: true })).toBeUndefined()
    expect(extractFixtureArguments(true)).toBeUndefined()
    expect(inspectLoadedToolSafety({ name: 'calculator', risk: 'safe', requiresApproval: false, safe: true }))
      .toMatchObject({ safe: false })
    expect(inspectLoadedToolSafety({ name: 'calculator', safe: true })).toMatchObject({ safe: false })
  })

  it('cannot mint tool_roundtrip from candidate risk:safe, package safe:true, or unattested review facts', () => {
    const current = review()
    const declared = { calculator: { arguments: { expression: '1+1' }, safe: true, risk: 'safe' } }
    expect(selectInstallVerificationLayer({
      review: current,
      declaredFixtures: {},
    }).layer).toBe('manual_runtime')
    expect(selectInstallVerificationLayer({
      review: current,
      declaredFixtures: { calculator: { safe: true } },
    }).layer).toBe('manual_runtime')
    expect(selectInstallVerificationLayer({
      review: current,
      declaredFixtures: declared,
    })).toMatchObject({ layer: 'manual_runtime', fixtures: [] })
    expect(selectInstallVerificationLayer({
      review: review({
        runtimeSurface: {
          ...current.runtimeSurface!,
          expectedRoute: { provider: 'xai-oauth', model: 'grok-4.5' },
          llmRegistered: true,
          verificationLayer: 'manual_runtime',
        },
      }),
      declaredFixtures: { calculator: { arguments: { expression: '1+1' } } },
    }).layer).toBe('manual_runtime')
    expect(selectInstallVerificationLayer({
      review: attestedReview(),
      declaredFixtures: declared,
    })).toMatchObject({
      layer: 'tool_roundtrip',
      fixtures: [{ tool: 'calculator', arguments: { expression: '1+1' } }],
    })
  })

  it('classifies an ordinary no-tool bundle as bundle_activation', () => {
    const none = review({
      manifest: { ...review().manifest, expectedTools: [] },
      runtimeSurface: {
        ...review().runtimeSurface!,
        expectedTools: [],
        toolFixtures: [],
        verificationLayer: 'bundle_activation',
      },
    })
    expect(selectInstallVerificationLayer({ review: none, declaredFixtures: {} }).layer).toBe('bundle_activation')
  })
})

describe('Host verification driver', () => {
  it('loads a bundle without an Agent turn, model adapter, or default route', async () => {
    const execute = async () => {
      throw new Error('tool execute must not run for bundle_activation')
    }
    const ctx = {
      loader: {
        entries: () => [{
          options: { name: 'dsh-tool-calculator' },
          fiber: { await: async () => undefined, state: 2 },
        }],
      },
      tools: { get: () => undefined, execute },
      get: () => undefined,
      fiber: {},
    } as unknown as Context
    const result = await runHostVerification(ctx, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: [],
      layer: 'bundle_activation',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: fixtureDigestFor([]),
    })
    expect(result).toMatchObject({
      layer: 'bundle_activation',
      status: 'passed',
      sourceMatched: true,
      exitCode: 0,
    })
    expect(result.reason).toMatch(/Loader\/Fiber settled without an Agent turn/i)
  })

  it('awaits only frozen candidate Fibers and never the observer ancestor', async () => {
    let ancestorAwaited = false
    let candidateInitialized = false
    const candidate = {
      id: 'include:calculator',
      options: { id: 'calculator', name: 'dsh-tool-calculator' },
    } as {
      id: string
      options: { id: string; name: string }
      fiber?: { await(): Promise<void>; state: number }
      _initTask?: Promise<void>
    }
    candidate._initTask = Promise.resolve().then(() => {
      candidateInitialized = true
      candidate.fiber = { await: async () => undefined, state: 2 }
    })
    const observer = {
      id: 'autoevo-observer',
      options: { id: 'autoevo-observer', name: 'dsh-plugin-autoevo-verification-observer' },
      fiber: { await: async () => undefined, state: 1 },
      parent: { tree: { entries: () => [candidate] } },
    }
    const ctx = {
      loader: {
        entries: () => [{
          id: 'include',
          options: { id: 'include', name: 'cordis:include' },
          fiber: {
            await: async () => {
              ancestorAwaited = true
              throw new Error('observer ancestor must not be awaited')
            },
            state: 1,
          },
        }],
      },
      tools: { get: () => undefined, execute: async () => ({ isError: true }) },
      get: () => undefined,
      fiber: { entry: observer },
    } as unknown as Context
    const result = await runHostVerification(ctx, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: [],
      layer: 'bundle_activation',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: fixtureDigestFor([]),
      activatedFibersJson: JSON.stringify([{ id: 'calculator', name: 'dsh-tool-calculator' }]),
    })
    expect(ancestorAwaited).toBe(false)
    expect(candidateInitialized).toBe(true)
    expect(result).toMatchObject({ status: 'passed', sourceMatched: true, exitCode: 0 })
  })

  it('does not treat another MCP client Fiber as the reviewed carrier', async () => {
    const ctx = {
      loader: {
        entries: () => [{
          id: 'other-mcp',
          options: { id: 'other-mcp', name: '@deepseek-ai/dsh-mcp-client' },
          fiber: { await: async () => undefined, state: 2 },
        }],
      },
      tools: { get: () => undefined, execute: async () => ({ isError: true }) },
      get: () => undefined,
      fiber: {},
    } as unknown as Context
    const result = await runHostVerification(ctx, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: [],
      layer: 'bundle_activation',
      packageName: 'dsh-plugin-zhihu-search',
      fixtureDigest: fixtureDigestFor([]),
      activatedFibersJson: JSON.stringify([{
        id: 'zhihu-search-mcp',
        name: '@deepseek-ai/dsh-mcp-client',
      }]),
    })
    expect(result).toMatchObject({
      layer: 'bundle_activation',
      status: 'failed',
      sourceMatched: false,
      exitCode: 1,
    })
    expect(result.reason).toMatch(/Fiber was not present/i)
  })

  it('executes a Host-validated fixture once through tools.execute and never retries', async () => {
    const calls: Array<{ name: string; arguments: unknown; agent?: unknown }> = []
    const ctx = {
      loader: {
        entries: () => [{
          options: { name: 'dsh-tool-calculator' },
          fiber: { await: async () => undefined, state: 2 },
        }],
      },
      tools: {
        get: (name: string) => name === 'calculator' ? loadedTool() : undefined,
        execute: async (exec: { name: string; arguments: unknown; agent?: unknown }) => {
          calls.push(exec)
          return { isError: false, value: { ok: true }, content: [] }
        },
      },
      get: () => undefined,
      fiber: {},
    } as unknown as Context
    const fixturesJson = JSON.stringify({ calculator: { expression: '1+1' } })
    const first = await runHostVerification(ctx, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: ['calculator'],
      layer: 'tool_roundtrip',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: fixtureDigestFor([{ tool: 'calculator', arguments: { expression: '1+1' } }]),
      fixturesJson,
    })
    expect(first).toMatchObject({ layer: 'tool_roundtrip', status: 'passed', executedCount: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'calculator', arguments: { expression: '1+1' } })
    expect(calls[0]?.agent).toBeUndefined()
    expect(JSON.stringify(calls[0])).not.toMatch(/run|chat|model/i)

    const once = new driverTesting.OnceMap()
    const digest = 'same-digest'
    expect(once.take(digest)).toBe(true)
    expect(once.take(digest)).toBe(false)
  })

  it('refuses schema-invalid fixtures without executing them and does not trust candidate risk fields', async () => {
    const calls: unknown[] = []
    const ctx = {
      loader: {
        entries: () => [{
          options: { name: 'dsh-tool-calculator' },
          fiber: { await: async () => undefined, state: 2 },
        }],
      },
      tools: {
        get: (name: string) => name === 'calculator' ? loadedTool() : undefined,
        execute: async (exec: unknown) => {
          calls.push(exec)
          return { isError: false, value: {}, content: [] }
        },
      },
      get: () => undefined,
      fiber: {},
    } as unknown as Context
    const schemaMiss = await runHostVerification(ctx, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: ['calculator'],
      layer: 'tool_roundtrip',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: 'a'.repeat(64),
      fixturesJson: JSON.stringify({ calculator: { unexpected: true } }),
    })
    expect(schemaMiss).toMatchObject({ layer: 'tool_roundtrip', status: 'failed', executedCount: 0 })
    expect(calls).toHaveLength(0)

    const declaredRisk = await runHostVerification({
      ...ctx,
      tools: {
        get: () => loadedTool('calculator', { risk: 'write', requiresApproval: true }),
        execute: async (exec: unknown) => {
          calls.push(exec)
          return { isError: false, value: {}, content: [] }
        },
      },
    } as unknown as Context, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: ['calculator'],
      layer: 'tool_roundtrip',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: 'b'.repeat(64),
      fixturesJson: JSON.stringify({ calculator: { expression: '1+1' } }),
    })
    expect(declaredRisk).toMatchObject({ layer: 'tool_roundtrip', status: 'passed', executedCount: 1 })
    expect(calls).toHaveLength(1)
  })

  it('does not spawn a manual_runtime driver loop and sanitizes receipts', async () => {
    const result = await runHostVerification({} as Context, {
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: ['calculator'],
      layer: 'manual_runtime',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: fixtureDigestFor([]),
    })
    expect(result).toMatchObject({
      layer: 'manual_runtime',
      status: 'pending_user_test',
      executedCount: 0,
    })
    const receipt = sanitizeHostVerificationEvidence({
      attempted: true,
      layer: 'tool_roundtrip',
      status: 'passed',
      reason: 'Host executed 1 expected tool(s) once through ToolRuntime.execute.',
      expectedTools: ['calculator'],
      calledTools: ['calculator'],
      resultTools: ['calculator'],
      failedTools: [],
      exitCode: 0,
      sourceMatched: true,
      fixtureDigest: 'a'.repeat(64),
    })
    const serialized = JSON.stringify(receipt)
    expect(serialized).not.toMatch(/expression|1\+1|arguments|OPENAI|D:\\\\|C:\\\\|\/Users\//u)
    expect(receipt.sessionFiles).toEqual([])
    expect(receipt.task).toBeUndefined()
    expect(receipt.receiptPath).toBeUndefined()
    expect(hostLayerSuccess({ sourceMatched: true, layer: 'tool_roundtrip', verification: receipt })).toBe(true)
  })

  it('writes a host overlay without routes, tasks, or credentials and allowlists child env', () => {
    const overlay = hostVerificationOverlay({
      receiptPath: path.resolve('receipt.jsonl'),
      expectedTools: ['calculator'],
      layer: 'tool_roundtrip',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: 'a'.repeat(64),
      fixtures: [{ tool: 'calculator', arguments: { expression: '1+1' } }],
      observerUrl: 'file:///observer.js',
    })
    const text = JSON.stringify(overlay)
    expect(overlay).not.toEqual(expect.arrayContaining([
      { id: 'headless-startup', disabled: true },
      { id: 'headless-runner', disabled: true },
    ]))
    expect(text).toContain('tool_roundtrip')
    expect(text).toContain('activatedFibersJson')
    expect(text).not.toContain('expectedRoute')
    expect(text).not.toContain('expectedProvider')
    expect(text).not.toContain('verificationTask')
    expect(text).not.toContain('agent-default-model')
    const env = verificationChildEnv('/isolated-dsh-home', {
      PATH: '/bin',
      OPENAI_API_KEY: 'secret',
      XAI_API_KEY: 'secret',
      GH_TOKEN: 'secret',
      DSH_HOME: '/parent',
    })
    expect(env.DSH_HOME).toBe('/isolated-dsh-home')
    expect(env.PATH).toBe('/bin')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain('secret')
  })

  it('exits the child after Host verification without hanging on an Agent turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-host-driver-exit-'))
    temporary.push(root)
    const receiptPath = path.join(root, 'host.jsonl')
    const exits: number[] = []
    const ctx = {
      loader: {
        entries: () => [{
          options: { name: 'dsh-tool-calculator' },
          fiber: { await: async () => undefined, state: 2 },
        }],
      },
      tools: { get: () => undefined, execute: async () => ({ isError: true }) },
      get: () => undefined,
      fiber: {},
    } as unknown as Context
    applyHostVerification(ctx, {
      receiptPath,
      expectedTools: [],
      layer: 'bundle_activation',
      packageName: 'dsh-tool-calculator',
      fixtureDigest: fixtureDigestFor([]),
      requestExit: (code) => { exits.push(code) },
    })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([0])
    const body = await readFile(receiptPath, 'utf8')
    expect(body).toContain('"kind":"host/complete"')
    expect(body).toContain('"layer":"bundle_activation"')
    expect(body).not.toContain('expression')
  })

  it('does not reference agent.run, chat, default routes, or credential forwarding in the driver', async () => {
    const source = await readFile(path.join(process.cwd(), 'src/host-verification-driver.ts'), 'utf8')
    expect(source).not.toMatch(/agent\.run|agent\.chat|createUserMessage|forwardedCredentialEnv|agent-default-model/)
  })
})
