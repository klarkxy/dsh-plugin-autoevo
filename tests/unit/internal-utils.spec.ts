import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAlreadyExists, isNotFound, isProcessAlive } from '../../src/internal-utils.js'

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isProcessAlive', () => {
  it('treats non-positive and non-integer pids as dead without probing', () => {
    const kill = vi.spyOn(process, 'kill')
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('treats only ESRCH as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('ESRCH') })
    expect(isProcessAlive(4242)).toBe(false)
  })

  it('fails closed: EPERM and unknown probe errors mean the holder is alive', () => {
    // Every lock recovery path (source-manager, preset-manager, git-cache) shares
    // this probe; a holder we cannot signal must never be treated as recoverable.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('EPERM') })
    expect(isProcessAlive(4242)).toBe(true)
    kill.mockImplementation(() => { throw errno('EINVAL') })
    expect(isProcessAlive(4242)).toBe(true)
    kill.mockImplementation(() => { throw new Error('no errno at all') })
    expect(isProcessAlive(4242)).toBe(true)
  })
})

describe('errno helpers', () => {
  it('match only their own errno codes', () => {
    expect(isNotFound(errno('ENOENT'))).toBe(true)
    expect(isNotFound(errno('EEXIST'))).toBe(false)
    expect(isNotFound(new Error('plain'))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
    expect(isAlreadyExists(errno('EEXIST'))).toBe(true)
    expect(isAlreadyExists(errno('ENOENT'))).toBe(false)
    expect(isAlreadyExists('EEXIST')).toBe(false)
  })
})
