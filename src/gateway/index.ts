export { buildEnvVars, deriveUserGatewayToken, getGatewayMasterToken } from './env';
export { mountR2Storage } from './r2';
export { findExistingMoltbotProcess, ensureMoltbotGateway, restartContainer } from './process';
export { createDailyBackup, createRollingBackup, listBackupDates, restoreUserFromBackup } from './backup';
export { syncToR2, getRecentSyncResults, getConsecutiveSyncFailures, syncCriticalFilesToR2, syncBeforeShutdown } from './sync';
export type { SyncResult } from './sync';
export { waitForProcess } from './utils';
export {
  checkHealth,
  shouldRestart,
  recordRestart,
  resetHealthState,
  getHealthState,
  getAllHealthStates,
} from './health';
export type { HealthCheckResult, HealthCheckConfig } from './health';
export { getSandboxForUser, getInstanceTypeName, setUserTier, getAllTierAssignments } from './tiers';

// Zero-data-loss backup system (Week 1)
export {
  listMissingCriticalFiles,
  verifySyncToR2,
  verifySandboxSync,
  runPostRestartVerification,
  alertIfMissingCriticalFiles,
  getBackupHealthStatus,
} from './verification';
export type {
  VerificationResult,
  MissingFile,
  ChecksumMismatch,
  CriticalFileStatus,
  BackupHealthStatus,
} from './verification';

// Backup feature flags and configuration
export { isBackupFeatureEnabled } from '../config/backup';
