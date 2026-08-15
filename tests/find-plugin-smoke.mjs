import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'

const projectRoot = path.resolve(import.meta.dirname, '..')
const findPluginRoot = process.env.DSH_FIND_PLUGIN_PATH
if (!findPluginRoot) throw new Error('DSH_FIND_PLUGIN_PATH must point to a dsh-find-plugin checkout')
const findPluginEntry = path.join(path.resolve(findPluginRoot), 'lib', 'index.js')
const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'autoevo-find-plugin-smoke-'))
const root = new Context()
root.baseUrl = `${pathToFileURL(projectRoot).href}/`
const originalFetch = globalThis.fetch
const fetchedUrls = []
globalThis.fetch = async (input, init) => {
  const url = String(input)
  fetchedUrls.push(url)
  if (url.startsWith('https://api.github.com/search/repositories?')) {
    return new Response(JSON.stringify({
      items: [{
        name: 'dsh-tool-calculator',
        full_name: 'omdsh-dev/dsh-tool-calculator',
        html_url: 'https://github.com/omdsh-dev/dsh-tool-calculator',
        description: 'A calculator tool for DeepSeek Harness',
        stargazers_count: 12,
        pushed_at: '2026-08-14T00:00:00Z',
        owner: { login: 'omdsh-dev' },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url === 'https://awesome-dsh-plugin.com/plugins.json') {
    return new Response('', { status: 503 })
  }
  return await originalFetch(input, init)
}

try {
  await root.plugin(Loader)
  const entries = [
    ['system-prompt', import.meta.resolve('@deepseek-ai/dsh-system-prompt')],
    ['tools', import.meta.resolve('@deepseek-ai/dsh-tools')],
    ['skills', import.meta.resolve('@deepseek-ai/dsh-skill')],
    ['subprocess', import.meta.resolve('@deepseek-ai/dsh-subprocess')],
    ['find-plugin', pathToFileURL(findPluginEntry).href],
    ['autoevo', pathToFileURL(path.join(projectRoot, 'lib', 'index.js')).href],
  ]
  for (const [id, name] of entries) {
    await root.loader.create({
      id,
      name,
      ...(id === 'autoevo'
        ? { config: {
            dshHome: path.join(stateRoot, 'dsh'),
            stateDir: path.join(stateRoot, 'state'),
            ghCommand: 'autoevo-gh-fallback-must-not-run',
          } }
        : {}),
    })
  }
  await root.loader.await()
  assert.ok(root.tools.get('find_dsh_plugin'))

  const result = await root.tools.execute({
    callId: CallId('autoevo-find-plugin-smoke'),
    name: 'capability_resolve',
    arguments: { requirement: 'scientific notation calculator' },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(result.isError, false, result.isError ? result.error.message : undefined)
  const resolution = result.value
  assert.equal(resolution.remoteCandidateSource, 'dsh-find-plugin', JSON.stringify(resolution))
  assert.ok(resolution.remoteCandidates.length > 0)
  assert.match(resolution.reasons.join(' '), /built-in gh search was skipped/u)
  assert.ok(resolution.remoteCandidates.every((candidate) => /^[^/]+\/[^/]+$/u.test(candidate.repository)))
  assert.ok(fetchedUrls.some((url) => url.startsWith('https://api.github.com/search/repositories?')))

  process.stdout.write(`${JSON.stringify({
    source: resolution.remoteCandidateSource,
    candidates: resolution.remoteCandidates.map((candidate) => candidate.repository),
    ghFallback: 'disabled and skipped',
  })}\n`)
} finally {
  globalThis.fetch = originalFetch
  await root.fiber.dispose()
  await rm(stateRoot, { recursive: true, force: true })
}
