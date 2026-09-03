import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { _testing } from '../../src/plugin-runtime.js'
import { tempRoot, trackTempDirs } from '../helpers/temp-dirs.js'

const temporary = trackTempDirs()

function receiptPath(installations: string, hex: string): string {
  return path.join(installations, `installation_${hex}.json`)
}

describe('receipt-owned roots', () => {
  it('returns resolved ownedArtifactRoot values for fresh, changed, and removed receipts', async () => {
    const root = await tempRoot('autoevo-receipt-roots-', temporary)
    const installations = path.join(root, 'installations')
    mkdirSync(installations)

    expect(_testing.receiptOwnedRoots(root)).toEqual([])

    const first = receiptPath(installations, 'a'.repeat(16))
    const artifactA = path.join(root, 'artifact-a')
    writeFileSync(first, JSON.stringify({ ownedArtifactRoot: artifactA }))
    expect(_testing.receiptOwnedRoots(root)).toEqual([path.resolve(artifactA)])
    expect(_testing.receiptOwnedRoots(root)).toEqual([path.resolve(artifactA)])

    const artifactB = path.join(root, 'artifact-b')
    writeFileSync(first, JSON.stringify({ ownedArtifactRoot: artifactB }))
    expect(_testing.receiptOwnedRoots(root)).toEqual([path.resolve(artifactB)])

    rmSync(first)
    expect(_testing.receiptOwnedRoots(root)).toEqual([])
  })

  it('omits unmatched names and empty roots', async () => {
    const root = await tempRoot('autoevo-receipt-roots-skip-', temporary)
    const installations = path.join(root, 'installations')
    mkdirSync(installations)
    const artifact = path.join(root, 'owned')
    writeFileSync(path.join(installations, 'other.json'), JSON.stringify({ ownedArtifactRoot: artifact }))
    writeFileSync(receiptPath(installations, 'b'.repeat(16)), JSON.stringify({ ownedArtifactRoot: '  ' }))
    expect(_testing.receiptOwnedRoots(root)).toEqual([])
  })

  it('treats only a missing installations directory as an empty protection set', async () => {
    const root = await tempRoot('autoevo-receipt-roots-missing-', temporary)
    expect(_testing.receiptOwnedRoots(root)).toEqual([])
  })

  it('fails closed when the installations directory is unreadable', async () => {
    const root = await tempRoot('autoevo-receipt-roots-unreadable-', temporary)
    // A regular file where the directory is expected makes readdir fail with ENOTDIR.
    writeFileSync(path.join(root, 'installations'), 'not a directory')
    expect(() => _testing.receiptOwnedRoots(root)).toThrow()
  })

  it('fails closed on a corrupt receipt instead of shrinking the protected roots', async () => {
    const root = await tempRoot('autoevo-receipt-roots-corrupt-', temporary)
    const installations = path.join(root, 'installations')
    mkdirSync(installations)
    writeFileSync(receiptPath(installations, 'a'.repeat(16)), JSON.stringify({ ownedArtifactRoot: path.join(root, 'owned') }))
    writeFileSync(receiptPath(installations, 'c'.repeat(16)), '{not-json')
    expect(() => _testing.receiptOwnedRoots(root)).toThrow(/installation_c{16}\.json is not valid JSON/u)
  })
})
