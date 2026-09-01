import type { InstallationRecord, InstallOutcome } from './contracts.js'

function inferredInstallOutcome(record: InstallationRecord): InstallOutcome | undefined {
  if (record.installOutcome) return record.installOutcome
  if (record.verified) return 'verified'
  if (record.installed) return record.loaded ? 'activated' : 'awaiting_user_test'
  if (record.removed || record.installState === 'not_installed') return 'failed_absent'
  return record.installState === 'unknown' ? 'recovery_required' : 'pending'
}

function fillMissingCompletedFields(
  record: InstallationRecord,
  installOutcome: InstallOutcome,
): Pick<InstallationRecord, 'installPhase' | 'installState'> | Record<string, never> {
  switch (installOutcome) {
    case 'failed_absent':
      return {
        ...(record.installPhase === undefined ? { installPhase: 'completed' as const } : {}),
        ...(record.installState === undefined ? { installState: 'not_installed' as const } : {}),
      }
    case 'verified':
    case 'activated':
    case 'awaiting_user_test':
      return {
        ...(record.installPhase === undefined ? { installPhase: 'completed' as const } : {}),
        ...(record.installState === undefined ? { installState: 'installed' as const } : {}),
      }
    default:
      return {}
  }
}

/** Project historical receipts in memory. Disk JSON is not rewritten. */
export function projectInstallation(record: InstallationRecord): InstallationRecord {
  const installOutcome = inferredInstallOutcome(record)
  const projected: InstallationRecord = {
    ...record,
    schemaVersion: 2,
    ...(installOutcome ? { installOutcome } : {}),
    ...(installOutcome ? fillMissingCompletedFields(record, installOutcome) : {}),
  }
  assertInstallationLifecycleTuple(projected)
  return projected
}

/**
 * Validate lifecycle relationships that cannot be proven by field-level schema
 * checks alone. Legacy receipts may omit phase/state/outcome, but whenever a
 * current outcome is present it must agree with the durable physical facts.
 */
export function assertInstallationLifecycleTuple(record: InstallationRecord): void {
  if (record.removed) {
    // Tombstones keep the pre-removal outcome while flipping physical flags
    // (including persistent restartRequired). They remain topology-only until
    // PluginRemover revalidates external absence.
    return
  }

  if (record.installOutcome === 'failed_absent') {
    if (record.installPhase !== 'completed'
      || record.installState !== 'not_installed'
      || record.installed
      || record.loaded
      || record.verified
      || record.restartRequired) {
      throw new Error('failed-absent installation is not proven absent')
    }
    return
  }

  if (record.verified && !record.installed) {
    throw new Error('verified installation is not installed')
  }

  switch (record.installOutcome) {
    case 'verified':
      if (record.installPhase !== 'completed'
        || record.installState !== 'installed'
        || !record.installed
        || !record.verified) {
        throw new Error('verified installation outcome is contradictory')
      }
      return
    case 'activated':
    case 'awaiting_user_test':
      if (record.installPhase !== 'completed'
        || record.installState !== 'installed'
        || !record.installed
        || record.verified) {
        throw new Error('non-verified installation success is contradictory')
      }
      return
    case 'recovery_required':
      if (record.verified) throw new Error('recovery-required installation is marked verified')
      return
    case 'pending':
    case undefined:
      return
  }
}
