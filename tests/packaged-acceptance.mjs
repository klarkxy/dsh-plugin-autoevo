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

try {
  await mkdir(packDir, { recursive: true })
  const [npm, ...npmPrefix] = await npmArgv()
  await run(npm, [...npmPrefix, 'pack', projectRoot, '--pack-destination', packDir, '--ignore-scripts'], {
    env: { NPM_CONFIG_CACHE: path.join(blankHome, 'npm-cache'), NPM_CONFIG_IGNORE_SCRIPTS: 'true', NO_UPDATE_NOTIFIER: '1' },
  })
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const tarball = await realpath(path.join(packDir, tarballs[0]))
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
  assert.match(result.stdout, /AUTOEVO_PACKAGED_V5_SESSION_OK/u)
  const evidenceLine = result.stdout.split(/\r?\n/u).find((line) => line.includes('AUTOEVO_PACKAGED_V5_SESSION_OK'))
  assert.ok(evidenceLine)
  const evidence = JSON.parse(evidenceLine)
  assert.equal(evidence.preset, 'evolution')
  assert.deepEqual(evidence.tools, ['capability_workflow', 'capability_workflow_resume', 'plugin_remove'])
  assert.ok(evidence.eventTypes.includes('tool/call'))
  assert.ok(evidence.eventTypes.includes('tool/result'))
  assert.ok(evidence.eventTypes.includes('turn/end'))

  const manifest = JSON.parse(await readFile(path.join(dshHome, '.agent-presets', 'evolution', '.autoevo-preset.json'), 'utf8'))
  assert.equal(manifest.templateVersion, '5')
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    installedFrom: path.basename(tarball),
    templateVersion: manifest.templateVersion,
    preset: evidence.preset,
    tools: evidence.tools,
    durableEvents: ['tool/call', 'tool/result', 'turn/end'],
    taskResult: evidence.marker,
  })}\n`)
} finally {
  await rm(blankHome, { recursive: true, force: true })
}
