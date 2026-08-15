import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const scenario = process.argv[2] ?? 'full-flow'
const supported = new Set(['resolve-local', 'full-flow', 'partial-flow'])
if (!supported.has(scenario)) throw new Error(`unknown E2E scenario: ${scenario}`)

const projectRoot = path.resolve(import.meta.dirname, '..')
const dshBin = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const scriptedPlugin = pathToFileURL(path.join(projectRoot, 'tests', 'fixtures', 'scripted-llm.mjs')).href
const approvalPlugin = pathToFileURL(path.join(projectRoot, 'tests', 'fixtures', 'approval-allow-once.mjs')).href
const root = await mkdtemp(path.join(os.tmpdir(), `capability-evolution-${scenario}-`))
const dshHome = path.join(root, 'dsh-home')
const stateDir = path.join(dshHome, 'autoevo')
const ownedWorkRoot = path.join(projectRoot, '.e2e-work')
let ownedWorkPath

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
  const localSpec = `link:${projectRoot.replaceAll('\\', '/')}`
  await runDsh(['plugin', '--profile', 'headless', 'add', '--save-exact', localSpec])
  const profile = JSON.parse(await readFile(path.join(dshHome, 'profiles', 'headless', 'package.json'), 'utf8'))
  assert.equal(profile.dependencies['dsh-plugin-autoevo'], localSpec)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-plugin-autoevo'))
}

async function preparePartialPlugin() {
  await mkdir(ownedWorkRoot, { recursive: true })
  ownedWorkPath = path.join(ownedWorkRoot, `calculator-${path.basename(root)}`)
  await runProcess('git', [
    'clone', '--filter=blob:none', 'https://github.com/omdsh-dev/dsh-tool-calculator.git', ownedWorkPath,
  ], { timeoutMs: 180_000 })
  const baseCommit = (await runProcess('git', ['-C', ownedWorkPath, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.match(baseCommit, /^[a-f0-9]{40}$/u)
  await runProcess('git', [
    '-C', ownedWorkPath, 'apply', path.join(projectRoot, 'tests', 'fixtures', 'calculator-scientific-notation.patch'),
  ])
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const npmEnvironment = { npm_config_cache: path.join(root, 'npm-cache') }
  await runProcess(process.execPath, [npmCli, 'install'], { cwd: ownedWorkPath, env: npmEnvironment, timeoutMs: 300_000 })
  await runProcess(process.execPath, [npmCli, 'run', 'check'], { cwd: ownedWorkPath, env: npmEnvironment, timeoutMs: 300_000 })
  return { localPath: ownedWorkPath, baseCommit }
}

async function runScenario() {
  await mkdir(dshHome, { recursive: true })
  await installPlugin()
  const partial = scenario === 'partial-flow' ? await preparePartialPlugin() : undefined
  const childPatch = await writePatch('child.cordis.yml', modelPatches({
    scenario: 'calculator-child',
    expression: scenario === 'partial-flow' ? '1e3 + 2' : '6 * 7',
    expectedResult: scenario === 'partial-flow' ? 1002 : 42,
  }))
  const mainPatches = [
    ...modelPatches({ scenario, ...partial }),
    { id: 'autoevo', config: {
      dshHome,
      stateDir,
      dshCommand: process.execPath,
      dshCommandArgs: [dshBin],
      commandTimeoutMs: 120_000,
      verificationPatchPaths: [childPatch],
    } },
    { insert: [{ id: 'capability-evolution-e2e-approval', name: approvalPlugin }] },
  ]
  const mainPatch = await writePatch('main.cordis.yml', mainPatches)
  const task = scenario === 'resolve-local'
    ? 'Resolve a capability that is already local and report the decision.'
    : 'Exercise the approved capability reuse workflow and report only after cleanup.'
  const result = await runDsh(['--profile', 'headless', '--patch', mainPatch, task], 600_000)
  const expectedMarker = scenario === 'resolve-local' ? 'E2E_RESOLVE_LOCAL_OK' : scenario === 'full-flow' ? 'E2E_FULL_FLOW_OK' : 'E2E_PARTIAL_FLOW_OK'
  assert.match(result.stdout, new RegExp(expectedMarker, 'u'))

  if (scenario === 'resolve-local') {
    assert.match(result.stdout, /"decision":"use_local"/u)
    const reviews = await filesBelow(path.join(stateDir, 'reviews'), '.json')
    assert.equal(reviews.length, 0)
    return { scenario, marker: expectedMarker, remoteSearchSkipped: true }
  }

  const installationFiles = await filesBelow(path.join(stateDir, 'installations'), '.json')
  assert.equal(installationFiles.length, 1)
  const installation = JSON.parse(await readFile(installationFiles[0], 'utf8'))
  const reviewFiles = await filesBelow(path.join(stateDir, 'reviews'), '.json')
  const reviews = await Promise.all(reviewFiles.map(async (filename) => JSON.parse(await readFile(filename, 'utf8'))))
  assert.equal(installation.installed, true)
  assert.equal(installation.loaded, true)
  assert.equal(installation.verified, true)
  assert.equal(installation.removed, true)
  assert.equal(installation.verification.taskResultObserved, true)
  assert.equal(installation.verification.taskResultMatchedExpectation, true)
  assert.ok(installation.verification.expectedTools.every((name) => installation.verification.calledTools.includes(name)))
  assert.ok(installation.verification.expectedTools.every((name) => installation.verification.resultTools.includes(name)))
  assert.equal(installation.verification.failedTools.length, 0)
  await stat(installation.verification.receiptPath)
  const trialPath = path.join(stateDir, 'trials', installation.id)
  await assert.rejects(stat(trialPath), (error) => error.code === 'ENOENT')
  const flowEvidence = scenario === 'partial-flow'
    ? (() => {
        const remoteReview = reviews.find((review) => review.sourceSnapshot.kind === 'github')
        const localReview = reviews.find((review) => review.sourceSnapshot.kind === 'local')
        assert.equal(remoteReview?.fit, 'partial')
        assert.equal(remoteReview?.recommendation, 'modify')
        assert.equal(localReview?.fit, 'full')
        assert.equal(localReview?.recommendation, 'use')
        assert.equal(installation.contributionAdvice?.eligible, true)
        assert.match(installation.installSpec, /^file:/u)
        assert.doesNotMatch(installation.installSpec, /^link:/u)
        assert.match(installation.artifactSha256, /^[a-f0-9]{64}$/u)
        assert.ok(installation.ownedArtifactRoot.startsWith(path.join(stateDir, 'trials', installation.id)))
        return {
          remoteFit: 'partial',
          localFit: 'full',
          localArtifact: 'owned immutable tgz',
          contributionAdvice: 'suggest-only; explicit user approval required',
        }
      })()
    : (() => {
        const remoteReview = reviews.find((review) => review.sourceSnapshot.kind === 'github')
        assert.equal(remoteReview?.fit, 'full')
        assert.equal(remoteReview?.recommendation, 'use')
        return { remoteFit: 'full' }
      })()
  return {
    scenario,
    marker: expectedMarker,
    reviewId: installation.reviewId,
    installationId: installation.id,
    expectedTools: installation.verification.expectedTools,
    calledTools: installation.verification.calledTools,
    resultTools: installation.verification.resultTools,
    taskResultSha256: installation.verification.taskResultSha256,
    cleanup: 'owned trial removed',
    ...flowEvidence,
  }
}

try {
  const evidence = await runScenario()
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
} finally {
  if (process.env.KEEP_E2E === '1') {
    process.stderr.write(`kept E2E root: ${root}\n`)
    if (ownedWorkPath) process.stderr.write(`kept modified plugin: ${ownedWorkPath}\n`)
  } else {
    if (ownedWorkPath) await rm(ownedWorkPath, { recursive: true, force: true })
    try {
      await rmdir(ownedWorkRoot)
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
    }
    await rm(root, { recursive: true, force: true })
  }
}
