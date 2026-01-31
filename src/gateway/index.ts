export { buildEnvVars, deriveUserGatewayToken, getGatewayMasterToken } from './env';
export { mountR2Storage } from './r2';
export { findExistingMoltbotProcess, ensureMoltbotGateway } from './process';
export { syncToR2, getRecentSyncResults } from './sync';
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
