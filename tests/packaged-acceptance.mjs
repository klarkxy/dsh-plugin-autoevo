import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const projectRoot = path.resolve(import.meta.dirname, '..')
const dshBin = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const driver = pathToFileURL(path.join(projectRoot, 'tests', 'fixtures', 'packaged-preset-driver.mjs')).href
const blankHome = await mkdtemp(path.join(os.tmpdir(), 'autoevo-packaged-blank-'))
const dshHome = path.join(blankHome, 'dsh')
const stateDir = path.join(blankHome, 'state')
const packDir = path.join(blankHome, 'pack')

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, options.timeoutMs ?? 300_000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} exited ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

async function npmArgv() {
  const adjacent = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (await access(adjacent).then(() => true).catch(() => false)) return [process.execPath, await realpath(adjacent)]
  return ['npm']
}

function surface(overrides = {}) {
  return {
    llmDependency: false,
    llmRegistered: false,
    credentialsDependency: false,
    credentialsRegistered: false,
    networkSignal: false,
    environmentSignal: false,
    processSignal: false,
    skillOnly: false,
    unsafeTools: false,
    expectedTools: [],
    toolFixtures: [],
    kind: 'bundle',
    ...overrides,
  }
}

async function assertPackedPolicyV8(packedRoot) {
  const packedIndex = await readFile(path.join(packedRoot, 'lib', 'index.js'), 'utf8')
  const packedEvolution = [
    await readFile(path.join(packedRoot, 'lib', 'evolution-mode.js'), 'utf8'),
    await readFile(path.join(packedRoot, 'lib', 'evolution-mode2.js'), 'utf8').catch(() => ''),
  ].join('\n')
  const packedDriver = await readFile(
    path.join(packedRoot, 'lib', 'host-verification-driver.js'),
    'utf8',
  ).catch(() => '')
  const packedJs = `${packedIndex}\n${packedEvolution}\n${packedDriver}`
  assert.match(packedEvolution, /runtime Policy V8/u)
  assert.match(packedEvolution, /Mechanical verification is Host-driven/u)
  assert.match(packedEvolution, /do not treat a semantic verifier as the completion gate/u)
  assert.match(packedEvolution, /Cleanup of a completed installation and a sealed failure recovery are distinct Host paths/u)
  assert.doesNotMatch(packedEvolution, /runtime Policy V7/u)
  assert.doesNotMatch(packedJs, /independent semantic verifier/u)

  const {
    POLICY_VERSION,
    VERIFICATION_LAYER_KINDS,
    classifyRuntimeSurface,
    selectInstallVerificationLayer,
  } = await import(pathToFileURL(path.join(projectRoot, 'lib', 'index.js')).href)
  const { AUTOEVO_AUTONOMY_CONTRACT } = await import(
    pathToFileURL(path.join(projectRoot, 'lib', 'evolution-mode.js')).href
  )
  assert.equal(POLICY_VERSION, '8')
  assert.deepEqual([...VERIFICATION_LAYER_KINDS], ['bundle_activation', 'tool_roundtrip', 'manual_runtime'])
  assert.match(AUTOEVO_AUTONOMY_CONTRACT, /runtime Policy V8/u)
  assert.doesNotMatch(AUTOEVO_AUTONOMY_CONTRACT, /runtime Policy V7/u)

  assert.equal(classifyRuntimeSurface(surface()), 'bundle_activation')
  assert.equal(classifyRuntimeSurface(surface({
    expectedTools: ['calculator'],
    toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: true }],
  })), 'tool_roundtrip')
  assert.equal(classifyRuntimeSurface(surface({
    expectedTools: ['calculator'],
    toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
  })), 'manual_runtime')
  assert.equal(classifyRuntimeSurface(surface({
    expectedTools: ['calculator'],
    toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: true }],
    clientPlatform: 'web',
  })), 'manual_runtime')
  assert.equal(selectInstallVerificationLayer({
    review: {
      manifest: { expectedTools: ['calculator'] },
      runtimeSurface: surface({
        expectedTools: ['calculator'],
        toolFixtures: [{ tool: 'calculator', available: true, safe: true, hostValidated: false }],
        verificationLayer: 'manual_runtime',
      }),
    },
    declaredFixtures: { calculator: { safe: true, arguments: { expression: '1+1' } } },
  }).layer, 'manual_runtime')
  assert.match(packedJs, /awaiting_user_test/u)
  assert.match(packedJs, /bundle_activation/u)
  assert.match(packedJs, /tool_roundtrip/u)
  assert.match(packedJs, /manual_runtime cannot be installed as a temporary trial/u)
  assert.match(packedJs, /Completed-install restart is driven by a fresh explicit user request/u)
  assert.match(packedJs, /verification_already_attempted/u)
  assert.match(packedJs, /modify_attempts_exhausted/u)
  assert.match(packedJs, /plugin self-declared safety cannot mint tool_roundtrip/u)

  const readme = await readFile(path.join(packedRoot, 'README.md'), 'utf8')
  assert.match(readme, /Policy V8/u)
  assert.match(readme, /tool_roundtrip/u)
  assert.match(readme, /awaiting_user_test/u)
  assert.match(readme, /capability_workflow_recover/u)
  assert.match(readme, /temporary 会在安装与批准副作用前被拒绝/u)
  assert.doesNotMatch(readme, /开一条新的 V7 发现/u)
  assert.doesNotMatch(readme, /以及独立 semantic verifier/u)

  const skill = await readFile(path.join(packedRoot, 'skills', 'autoevo-plugin-creator', 'SKILL.md'), 'utf8')
  const state = await readFile(
    path.join(packedRoot, 'skills', 'autoevo-plugin-creator', 'references', 'autoevo-state.md'),
    'utf8',
  )
  assert.match(skill, /only a Host tool-roundtrip pass is functionally verified/u)
  assert.match(skill, /Never treat a model judgment or semantic verifier as the success gate/u)
  assert.match(state, /completed `awaiting_user_test`/u)
  assert.match(state, /two legal modes that must not be mixed/u)
  assert.match(state, /Policy V8 discovery/u)

  const preset = await readFile(path.join(packedRoot, 'presets', 'evolution', 'agent.cordis.yml'), 'utf8')
  assert.match(preset, /Policy V8/u)
  assert.match(preset, /awaiting a user test/u)
  assert.doesNotMatch(preset, /independent semantic verifier/u)
}

try {
  await mkdir(packDir, { recursive: true })
  const [npm, ...npmPrefix] = await npmArgv()
  await run(npm, [...npmPrefix, 'pack', projectRoot, '--pack-destination', packDir, '--ignore-scripts'], {
    env: { NPM_CONFIG_CACHE: path.join(blankHome, 'npm-cache'), NPM_CONFIG_IGNORE_SCRIPTS: 'true', NO_UPDATE_NOTIFIER: '1' },
  })
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const tarball = await realpath(path.join(packDir, tarballs[0]))
  const extractDir = path.join(blankHome, 'extracted')
  await mkdir(extractDir, { recursive: true })
  try {
    await run('tar', ['-xzf', tarball, '-C', extractDir])
  } catch {
    await run('tar', ['-xf', tarball, '-C', extractDir])
  }
  const packedRoot = path.join(extractDir, 'package')
  await assertPackedPolicyV8(packedRoot)
  const localSpec = `file:${tarball.replaceAll('\\', '/')}`

  const dshEnv = { DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', DSH_TOOLS_MODE: 'code' }
  await run(process.execPath, [dshBin, 'plugin', '--profile', 'headless', 'add', '--save-exact', localSpec], {
    env: dshEnv,
    timeoutMs: 300_000,
  })
  const profile = JSON.parse(await readFile(path.join(dshHome, 'profiles', 'headless', 'package.json'), 'utf8'))
  assert.equal(profile.dependencies['dsh-plugin-autoevo'], localSpec)
  assert.ok(profile.dsh.profile.bundles.includes('dsh-plugin-autoevo'))

  const patchFile = path.join(blankHome, 'packaged-acceptance.cordis.yml')
  await writeFile(patchFile, `${JSON.stringify([
    { id: 'headless-runner', disabled: true },
    { id: 'autoevo', config: { dshHome, stateDir, sourceDir: path.join(stateDir, 'sources'), evolutionPreset: true } },
    { insert: [
      { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
      {
        id: 'agent-presets',
        name: '@deepseek-ai/dsh-agent-presets',
        config: {
          default: 'standard',
          roots: [{ path: path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets'), trust: 'system' }],
          includeUserRoot: true,
        },
      },
      { id: 'autoevo-packaged-driver', name: driver, config: { dshHome, cwd: blankHome } },
    ] },
  ], null, 2)}\n`)

  const result = await run(process.execPath, [dshBin, '--profile', 'headless', '--patch', patchFile, 'packaged acceptance'], {
    cwd: blankHome,
    env: dshEnv,
    timeoutMs: 300_000,
  })
  assert.match(result.stdout, /AUTOEVO_PACKAGED_V13_SESSION_OK/u)
  const evidenceLine = result.stdout.split(/\r?\n/u).find((line) => line.includes('AUTOEVO_PACKAGED_V13_SESSION_OK'))
  assert.ok(evidenceLine)
  const evidence = JSON.parse(evidenceLine)
  assert.equal(evidence.preset, 'evolution')
  assert.deepEqual(evidence.tools, [
    'capability_workflow',
    'capability_workflow_diagnose',
    'capability_workflow_present',
    'capability_workflow_recover',
    'capability_workflow_refine',
    'capability_workflow_resume',
    'plugin_remove',
  ])
  assert.ok(evidence.eventTypes.includes('tool/call'))
  assert.ok(evidence.eventTypes.includes('tool/result'))
  assert.ok(evidence.eventTypes.includes('turn/end'))
  assert.equal(evidence.policyVersion, '8')
  assert.equal(evidence.recoverInterruptOptional, true)

  const manifest = JSON.parse(await readFile(path.join(dshHome, '.agent-presets', 'evolution', '.autoevo-preset.json'), 'utf8'))
  assert.equal(manifest.templateVersion, '13')
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    installedFrom: path.basename(tarball),
    templateVersion: manifest.templateVersion,
    policyVersion: evidence.policyVersion,
    preset: evidence.preset,
    tools: evidence.tools,
    durableEvents: ['tool/call', 'tool/result', 'turn/end'],
    nonFailureOutcomes: ['verified', 'activated', 'awaiting_user_test'],
    recoverInterruptOptional: evidence.recoverInterruptOptional,
    taskResult: evidence.marker,
  })}\n`)
} finally {
  await rm(blankHome, { recursive: true, force: true })
}
