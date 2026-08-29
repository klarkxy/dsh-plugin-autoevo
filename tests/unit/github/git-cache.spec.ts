import { mkdir, mkdtemp, readdir, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitTransportArgs, withCachedGithubRepository } from '../../../src/github/git-cache.js'
import type { CommandRunner } from '../../../src/process/runner.js'
import { trackTempDirs } from '../../helpers/temp-dirs.js'

const temporary = trackTempDirs()

describe('workspace Git cache containment', () => {
  it('selects Git for Windows bundled OpenSSL without changing other platforms', () => {
    expect(gitTransportArgs('win32')).toEqual(['-c', 'http.sslBackend=openssl'])
    expect(gitTransportArgs('linux')).toEqual([])
    expect(gitTransportArgs('darwin')).toEqual([])
  })

  it('rejects a junction/symlink redirect before writing repository data outside the workspace', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-workspace-'))
    const outside = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-outside-'))
    temporary.push(workspace, outside)
    const cacheParent = path.join(workspace, '.autoevo', 'cache')
    await mkdir(cacheParent, { recursive: true })
    await symlink(outside, path.join(cacheParent, 'git'), process.platform === 'win32' ? 'junction' : 'dir')
    const runner: CommandRunner = {
      async run() {
        throw new Error('Git must not run for a redirected cache root')
      },
    }

    await expect(withCachedGithubRepository({
      runner,
      config: { gitCommand: 'git', commandTimeoutMs: 1_000 },
      workspaceRoot: workspace,
      cacheRoot: path.join(workspace, '.autoevo', 'cache', 'git'),
      repository: 'acme/package',
      commit: 'a'.repeat(40),
    }, async () => undefined)).rejects.toMatchObject({ code: 'unsafe_path' })
    expect(await readdir(outside)).toEqual([])
  })
})
