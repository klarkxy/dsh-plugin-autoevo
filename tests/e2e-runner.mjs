import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { hostDshVersion, resolveHostDsh, skipUnlessHarnessDsh } from './helpers/host-dsh.mjs'

const scenario = process.argv[2] ?? 'resolve-local'
const supported = new Set(['resolve-local', 'adversarial-define', 'marketplace-flow'])
if (!supported.has(scenario)) throw new Error(`unknown E2E scenario: ${scenario}`)

const projectRoot = path.resolve(import.meta.dirname, '..')
const hostDsh = await resolveHostDsh()
if (skipUnlessHarnessDsh(hostDshVersion(hostDsh.bin))) process.exit(0)
const dshBin = hostDsh.bin
const scriptedPlugin = pathToFileURL(path.join(projectRoot, 'tests', 'fixtures', 'scripted-llm.mjs')).href
const approvalPlugin = pathToFileURL(path.join(projectRoot, 'tests', 'fixtures', 'approval-allow-once.mjs')).href
const cordisDefineProbe = pathToFileURL(path.join(projectRoot, 'tests', 'fixtures', 'cordis-define-probe.mjs')).href
const root = await mkdtemp(path.join(os.tmpdir(), `capability-evolution-${scenario}-`))
const dshHome = path.join(root, 'dsh-home')
const stateDir = path.join(dshHome, 'autoevo')

async function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300_000
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`${command} exited ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      else resolve({ stdout, stderr })
    })
  })
}

async function runDsh(args, timeoutMs = 300_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dshBin, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: '1',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`dsh timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`dsh exited ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

function modelPatches(scriptedConfig) {
  return [
    { id: 'agent-default-model', config: { provider: 'capability-evolution-scripted', model: 'scripted' } },
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    {
      insert: [{
        id: `capability-evolution-scripted-${scriptedConfig.scenario}`,
        name: scriptedPlugin,
        config: scriptedConfig,
      }],
    },
  ]
}

async function writePatch(filename, patches) {
  const target = path.join(root, filename)
  await writeFile(target, `${JSON.stringify(patches, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return target
}

async function filesBelow(directory, suffix) {
  const result = []
  const visit = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (!suffix || entry.name.endsWith(suffix)) result.push(target)
    }
  }
  await visit(directory)
  return result
}

async function installPlugin() {
  // DSH rc.6 forwards plugin arguments through a Windows shell. A workspace
  // link whose path contains spaces can be split before pnpm sees it, so the
  // E2E bootstrap uses the same immutable-tarball shape as real owned
  // artifacts instead of depending on shell quoting.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const packed = await runProcess(process.execPath, [
    npmCli,
    'pack',
    projectRoot,
    '--pack-destination',
    root,
    '--ignore-scripts',
  ], { env: { npm_config_cache: path.join(root, 'npm-cache') } })
  const archive = packed.stdout.trim().split(/\r?\n/u).at(-1)
  assert.ok(archive, 'npm pack did not report an archive')
  const localSpec = `file:${path.join(root, archive).replaceAll('\\', '/')}`
  await runDsh(['plugin', '--profile', 'headless', 'add', '--save-exact', localSpec])
  const profile = JSON.parse(await readFile(path.join(dshHome, 'profiles', 'headless', 'package.json'), 'utf8'))
  assert.equal(profile.dependencies['dsh-plugin-autoevo'], localSpec)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-plugin-autoevo'))
}

async function runScenario() {
  await mkdir(dshHome, { recursive: true })
  await installPlugin()
  const mainPatches = [
    ...modelPatches({ scenario }),
    { id: 'autoevo', config: {
      dshHome,
      stateDir,
      dshCommand: process.execPath,
      dshCommandArgs: [dshBin],
      commandTimeoutMs: 120_000,
      verificationPatchPaths: [],
    } },
    ...(scenario === 'adversarial-define'
      ? [{ insert: [{ id: 'capability-evolution-e2e-cordis-define-probe', name: cordisDefineProbe }] }]
      : []),
    { insert: [{ id: 'capability-evolution-e2e-approval', name: approvalPlugin }] },
  ]
  const mainPatch = await writePatch('main.cordis.yml', mainPatches)
  const task = scenario === 'resolve-local' || scenario === 'adversarial-define'
    ? 'Run a PowerShell command using an existing local capability and report the decision.'
    : 'Search GitHub for an existing Grok Build capability.'
  const result = await runDsh(['--profile', 'headless', '--patch', mainPatch, task], 600_000)
  const expectedMarker = scenario === 'resolve-local'
    ? 'E2E_RESOLVE_LOCAL_OK'
    : scenario === 'adversarial-define'
      ? 'E2E_ADVERSARIAL_DEFINE_OK'
      : 'E2E_MARKETPLACE_FLOW_OK'
  assert.match(result.stdout, new RegExp(expectedMarker, 'u'))

  if (scenario === 'adversarial-define') {
    // Headless sessions are outside Capability Evolution mode. Live Creator
    // definitions stay available; AutoEvo still owns persistent discovery.
    assert.match(result.stdout, /E2E_CORDIS_DEFINE_PROBE_EXECUTED/u)
    assert.doesNotMatch(result.stdout, /UNKNOWN_TOOL/u)
    assert.match(result.stdout, /"state":"waiting_candidate_selection"/u)
    assert.match(result.stdout, /"policy_version":"10"/u)
    assert.doesNotMatch(result.stdout, /"policy_version":"9"/u)
    return {
      scenario,
      marker: expectedMarker,
      guard: 'allowed live cordis_define(kind:new) outside Capability Evolution mode',
      workflow: 'autonomous discovery sealed at Gate 1',
      policyVersion: '10',
    }
  }

  if (scenario === 'resolve-local') {
    assert.match(result.stdout, /"state":"waiting_candidate_selection"/u)
    assert.match(result.stdout, /"policy_version":"10"/u)
    assert.doesNotMatch(result.stdout, /"policy_version":"9"/u)
    const reviews = await filesBelow(path.join(stateDir, 'reviews'), '.json')
    assert.equal(reviews.length, 0)
    return { scenario, marker: expectedMarker, remoteSearchSkipped: true, policyVersion: '10' }
  }

  if (scenario === 'marketplace-flow') {
    const profile = JSON.parse(await readFile(path.join(dshHome, 'profiles', 'headless', 'package.json'), 'utf8'))
    assert.equal(profile.dependencies['dsh-find-plugin'], undefined)
    const resolutions = await filesBelow(path.join(stateDir, 'resolutions'), '.json')
    const records = await Promise.all(resolutions.map(async (file) => JSON.parse(await readFile(file, 'utf8'))))
    assert.ok(records.some((record) => record.remoteCandidateSource === 'github'
      && Array.isArray(record.remoteCandidates)
      && record.remoteCandidates.some((item) => /dsh-(?:grok|xai|oauth)/iu.test(item.repository ?? ''))))
    return {
      scenario,
      marker: expectedMarker,
      search: 'scoped GitHub topic search',
      finderDependency: false,
    }
  }

  throw new Error(`unhandled scenario: ${scenario}`)
}

try {
  const evidence = await runScenario()
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} finally {
  if (process.env.KEEP_E2E === '1') {
    process.stderr.write(`kept E2E root: ${root}\n`)
  } else {
    await rm(root, { recursive: true, force: true })
  }
}
