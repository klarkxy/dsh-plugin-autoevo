const HOST_OWNED_LOCAL_ROOTS = new Set(['.git', 'node_modules', '.pnpm-store'])

/** Host-owned metadata and dependency caches are outside the reviewed package bytes. */
export function isExcludedLocalPackagePath(relative: string): boolean {
  const first = relative.split(/[\\/]/u)[0]
  const comparable = process.platform === 'win32' ? first?.toLowerCase() : first
  return Boolean(comparable && HOST_OWNED_LOCAL_ROOTS.has(comparable))
}
