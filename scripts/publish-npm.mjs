/** Preview by default; --publish is restricted to the matching main release tag in GitHub Actions. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.pack/npm-release')
const registry = 'https://registry.npmjs.org/'
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const publish = process.argv.includes('--publish')
const report = { name: manifest.name, version: manifest.version, mode: publish ? 'publish' : 'preview' }

function run(command, args) {
  let executable = command
  if (command === 'npm' && process.platform === 'win32') {
    executable = process.execPath
    args = [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args]
  }
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NPM_CONFIG_CACHE: resolve(root, '.tmp/npm-cache') },
  })
  if (result.error || result.status !== 0) {
    // npm prints the tarball inventory before the actual error. Keep the tail.
    throw new Error(`${command} ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).slice(-4000)}`)
  }
  return result.stdout.trim()
}

async function registryVersion(name, version, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry)
    url.searchParams.set('release-check', randomUUID())
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache' } })
      if (response.status === 404) return null
      if (response.ok) return await response.json()
      if (response.status !== 429 && response.status < 500) throw new Error(`npm registry returned HTTP ${response.status}`)
    } catch (error) {
      if (attempt === attempts - 1) throw error
    }
    await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)))
  }
  throw new Error('npm registry metadata was unavailable')
}

function saveReport() {
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}

try {
  if (manifest.private || manifest.publishConfig?.access !== 'public' || manifest.publishConfig.registry !== registry) {
    throw new Error('Package is not explicitly configured for public npm publication')
  }
  if (publish) {
    const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF?.replace(/^refs\/tags\//u, '')
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'klarkxy/dsh-plugin-autoevo'
      || tag !== `v${manifest.version}`) {
      throw new Error('Publication requires this repository’s matching version in GitHub Actions')
    }
    run('git', ['fetch', 'origin', 'main'])
    if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) {
      throw new Error('Publication must run from current main')
    }
    if (process.env.GITHUB_REF === `refs/tags/${tag}`) {
      // Normal tag-triggered publication.
    } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === 'refs/heads/main') {
      // Retry the immutable tag after a CI-only correction. Packed files must match.
      run('git', ['merge-base', '--is-ancestor', tag, 'HEAD'])
      const changed = run('git', ['diff', '--name-only', tag, 'HEAD']).split(/\r?\n/u).filter(Boolean)
      if (changed.some((file) => file !== '.github/workflows/npm-publish.yml' && file !== 'scripts/publish-npm.mjs')) {
        throw new Error('Manual publication retry changed package files after the release tag')
      }
    } else {
      throw new Error('Publication requires a matching tag push or a CI-only retry from main')
    }
  }
  mkdirSync(output, { recursive: true })
  const archive = resolve(output, `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`)
  run('npm', ['pack', root, '--pack-destination', output, '--ignore-scripts', '--registry', registry])
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')
  report.archive = basename(archive)
  report.integrity = integrity
  const remote = await registryVersion(manifest.name, manifest.version)
  if (remote) {
    if (remote.dist?.integrity !== integrity) throw new Error('The existing npm version has different bytes')
    report.status = 'already-published'
  } else if (!publish) {
    report.status = 'ready'
  } else {
    const packageExists = await registryVersion(manifest.name, '', 2)
    if (!packageExists && !process.env.NODE_AUTH_TOKEN) {
      throw new Error('First npm publication requires the NPM_TOKEN repository secret; bind the trusted publisher after the package exists')
    }
    let publishError
    try {
      run('npm', ['publish', archive, '--access', 'public', '--provenance', '--ignore-scripts', '--registry', registry])
    } catch (error) {
      publishError = error
    }
    let confirmed = false
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const published = await registryVersion(manifest.name, manifest.version, 2)
      if (published?.dist?.integrity === integrity) { confirmed = true; break }
      if (published) throw new Error('Published npm version has different bytes')
      await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)))
    }
    if (!confirmed) throw publishError ?? new Error('npm publish returned success but the registry did not confirm the archive')
    report.status = publishError ? 'confirmed-after-cli-error' : 'published'
  }
  report.sourceCommit = run('git', ['rev-parse', 'HEAD'])
  saveReport()
  process.stdout.write(`${manifest.name}@${manifest.version}: ${report.status}\n`)
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  saveReport()
  process.stderr.write(`${report.error}\n`)
  process.exitCode = 1
}
