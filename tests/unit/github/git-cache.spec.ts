import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { _testing, gitTransportArgs, withCachedGithubRepository } from '../../../src/github/git-cache.js'
import type { CommandRunner } from '../../../src/process/runner.js'
import { trackTempDirs } from '../../helpers/temp-dirs.js'

const temporary = trackTempDirs()

async function staleLock(root: string, name: string, owner: object): Promise<string> {
  const lock = path.join(root, name)
  await mkdir(lock)
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify(owner)}\n`)
  const old = new Date(Date.now() - 10_000)
  await utimes(lock, old, old)
  return lock
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(message)
}

describe('workspace Git cache containment', () => {
  it('keeps operation errors ahead of release failures and surfaces release failure after success', async () => {
    const primary = new Error('cache operation failed')
    const cleanup = new Error('cache lock release failed')
    const releaseAfterFailure = vi.fn(async () => { throw cleanup })

    await expect(_testing.runWithRelease(async () => { throw primary }, releaseAfterFailure))
      .rejects.toBe(primary)
    expect(releaseAfterFailure).toHaveBeenCalledTimes(1)

    const releaseAfterSuccess = vi.fn(async () => { throw cleanup })
    await expect(_testing.runWithRelease(async () => 'ok', releaseAfterSuccess))
      .rejects.toBe(cleanup)
    expect(releaseAfterSuccess).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    const reason = new Error('cache operation cancelled')
    const releaseAfterAbort = vi.fn(async () => { throw cleanup })
    await expect(_testing.runWithRelease(async () => {
      controller.abort(reason)
      throw controller.signal.reason
    }, releaseAfterAbort)).rejects.toBe(reason)
    expect(releaseAfterAbort).toHaveBeenCalledTimes(1)
  })

  it('does not initialize a Git cache directory when its existence probe fails', async () => {
    const eio = Object.assign(new Error('Git cache stat failed'), { code: 'EIO' })
    const initialize = vi.fn(async () => undefined)

    await expect(_testing.ensureGitCacheDirectory(
      'cache.git',
      initialize,
      undefined,
      async () => { throw eio },
    )).rejects.toBe(eio)
    expect(initialize).not.toHaveBeenCalled()
  })

  it('preserves exact cancellation when the Git cache directory probe returns or rejects after abort', async () => {
    for (const mode of ['return', 'reject'] as const) {
      const controller = new AbortController()
      const reason = new Error(`Git cache stat cancelled on ${mode}`)
      const initialize = vi.fn(async () => undefined)

      await expect(_testing.ensureGitCacheDirectory(
        'cache.git',
        initialize,
        controller.signal,
        async () => {
          controller.abort(reason)
          if (mode === 'reject') throw new Error('ordinary stat rejection')
          return { isDirectory: () => false }
        },
      )).rejects.toBe(reason)
      expect(initialize).not.toHaveBeenCalled()
    }
  })

  it('initializes exactly once for ENOENT and skips initialization for an existing directory', async () => {
    const initializeMissing = vi.fn(async () => undefined)
    await expect(_testing.ensureGitCacheDirectory(
      'missing.git',
      initializeMissing,
      undefined,
      async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    )).resolves.toBeUndefined()
    expect(initializeMissing).toHaveBeenCalledTimes(1)

    const initializeExisting = vi.fn(async () => undefined)
    await expect(_testing.ensureGitCacheDirectory(
      'existing.git',
      initializeExisting,
      undefined,
      async () => ({ isDirectory: () => true }),
    )).resolves.toBeUndefined()
    expect(initializeExisting).not.toHaveBeenCalled()
  })

  it('does not initialize over an existing non-directory cache path', async () => {
    const initialize = vi.fn(async () => undefined)

    await expect(_testing.ensureGitCacheDirectory(
      'occupied.git',
      initialize,
      undefined,
      async () => ({ isDirectory: () => false }),
    )).rejects.toMatchObject({ code: 'review_rejected' })
    expect(initialize).not.toHaveBeenCalled()
  })

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

  it('keeps stale recovery critical publication single-owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-lock-'))
    temporary.push(root)
    const lock = await staleLock(root, 'repo.lock', { pid: 123_456, lockToken: 'stale' })
    let token = 0
    let critical = 0
    let recoveryArrivals = 0
    let releaseRecoveryBarrier!: () => void
    const recoveryBarrier = new Promise<void>((resolve) => { releaseRecoveryBarrier = resolve })
    const testing = {
      token: () => `token-${++token}`,
      processAlive: () => false,
      beforeRecoveryMarker: async () => {
        recoveryArrivals += 1
        if (recoveryArrivals === 2) releaseRecoveryBarrier()
        await recoveryBarrier
      },
      afterOwnerWrite: async () => { critical += 1 },
    }
    const [first, second] = await Promise.allSettled([
      _testing.acquireLock(lock, 5, undefined, testing),
      _testing.acquireLock(lock, 5, undefined, testing),
    ])
    expect([first, second].filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(critical).toBe(1)
    const winner = first.status === 'fulfilled' ? first.value : second.status === 'fulfilled' ? second.value : undefined
    await winner?.()
  })

  it('does not let an old release remove a replacement lock token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-release-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    const release = await _testing.acquireLock(lock, 5)
    await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, lockToken: 'replacement' })}\n`)

    await release()
    expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ lockToken: 'replacement' })
  })

  it('checks recovery markers before and after publication and removes a failed owner token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-marker-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    await writeFile(`${lock}.recovery`, JSON.stringify({ recoveryToken: 'other', observedOwner: '{}' }))
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(_testing.acquireLock(lock, 5, controller.signal)).rejects.toThrow('cancelled')

    await rm(`${lock}.recovery`, { force: true })
    await expect(_testing.acquireLock(lock, 5, undefined, {
      afterOwnerWrite: async () => {
        await writeFile(`${lock}.recovery`, JSON.stringify({ recoveryToken: 'other', observedOwner: '{}' }))
      },
    })).rejects.toBeInstanceOf(Error)
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers a stale naked lock directory through marker and quarantine handoff', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-naked-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    await mkdir(lock)
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)
    const release = await _testing.acquireLock(lock, 5, undefined, {
      processAlive: () => false,
    })
    expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid })
    await release()
  })

  it('does not let a slow naked publisher write into a recovered generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-slow-publisher-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    let entered = false
    let resume!: () => void
    const slowBarrier = new Promise<void>((resolve) => { resume = resolve })
    const slow = _testing.acquireLock(lock, 5_000, undefined, {
      token: () => 'slow',
      processAlive: () => false,
      beforeOwnerWrite: async () => {
        entered = true
        await slowBarrier
      },
    })
    await waitFor(() => entered, 'slow publisher did not reach owner barrier')
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)
    let recoveryToken = 0
    const release = await _testing.acquireLock(lock, 5, undefined, {
      token: () => ['recovery', 'quarantine', 'winner'][recoveryToken++]!,
      processAlive: () => false,
    })
    resume()
    await expect(slow).rejects.toBeInstanceOf(Error)
    expect(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'))).toMatchObject({ lockToken: 'winner' })
    await release()
  })

  it('keeps an existing recovery marker busy without creating a lock', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-existing-marker-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    const marker = `${lock}.recovery`
    await writeFile(marker, JSON.stringify({ recoveryToken: 'other', observedOwner: null, observedPublisher: null }))
    await expect(_testing.acquireLock(lock, 0)).rejects.toMatchObject({ details: { retryable: true } })
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lstat(marker)).toBeDefined()
  })

  it('cleans a naked lock when owner publication fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-owner-write-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    await expect(_testing.acquireLock(lock, 5, undefined, {
      beforeOwnerWrite: async () => { throw new Error('owner write failed') },
    })).rejects.toThrow('owner write failed')
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans a token-owned owner file when publication rejects after writing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-owner-reject-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    await expect(_testing.acquireLock(lock, 5, undefined, {
      afterOwnerFileWrite: async () => { throw new Error('owner write rejected after completion') },
    })).rejects.toThrow('owner write rejected after completion')
    await expect(lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' })

    const release = await _testing.acquireLock(lock, 5)
    await release()
  })

  it('fails closed on stale quarantine collision and mismatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-quarantine-'))
    temporary.push(root)
    const collision = await staleLock(root, 'collision.lock', { pid: 123_456, lockToken: 'stale' })
    await mkdir(`${collision}.quarantine.stale`)
    await expect(_testing.acquireLock(collision, 5, undefined, {
      token: () => 'quarantine',
      processAlive: () => false,
    })).rejects.toThrow('quarantine collision')
    expect(await lstat(collision)).toBeDefined()

    const mismatch = await staleLock(root, 'mismatch.lock', { pid: 123_456, lockToken: 'stale' })
    let calls = 0
    await expect(_testing.acquireLock(mismatch, 5, undefined, {
      token: () => calls++ === 0 ? 'recovery' : 'quarantine',
      processAlive: () => false,
      afterQuarantineRename: async (quarantine) => {
        await writeFile(path.join(quarantine, 'owner.json'), JSON.stringify({ pid: 1, lockToken: 'other' }))
      },
    })).rejects.toThrow('quarantine mismatch')
    await expect(lstat(`${mismatch}.quarantine.stale`)).resolves.toBeDefined()
    await expect(lstat(`${mismatch}.recovery`)).resolves.toBeDefined()
  })

  it('waits on a live owner and preserves cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-live-'))
    temporary.push(root)
    const lock = path.join(root, 'repo.lock')
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, lockToken: 'live' }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 1)
    await expect(_testing.acquireLock(lock, 5_000, controller.signal)).rejects.toThrow('cancelled')
    expect(await lstat(lock)).toBeDefined()
  })

  it('treats an unknown owner PID as live and leaves its lock intact on cancellation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'autoevo-cache-unknown-'))
    temporary.push(root)
    const lock = await staleLock(root, 'repo.lock', { pid: 123_456, lockToken: 'unknown' })
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 1)
    await expect(_testing.acquireLock(lock, 5_000, controller.signal, {
      processAlive: () => true,
    })).rejects.toThrow('cancelled')
    expect(await lstat(lock)).toBeDefined()
  })
})
