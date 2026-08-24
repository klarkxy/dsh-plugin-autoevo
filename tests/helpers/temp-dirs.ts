import { rm } from 'node:fs/promises'
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
