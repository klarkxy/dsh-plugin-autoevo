import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

/**
 * Returns an array that tracks temp directories; every entry is removed
 * recursively after each test. Call once at module scope and push paths.
 */
export function trackTempDirs(): string[] {
  const temporary: string[] = []
  afterEach(async () => {
    await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
  })
  return temporary
}

/**
 * Creates a tracked temp dir in canonical (realpath) form. The Host
 * canonicalizes managed paths, so expectations must compare against the
 * canonical root — Windows temp dirs may be 8.3-aliased or junctioned.
 */
export async function tempRoot(prefix: string, temporary: string[]): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
  temporary.push(root)
  return root
}
