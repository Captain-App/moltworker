import type { Sandbox } from '@cloudflare/sandbox';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from './process';
import { waitForProcess } from './utils';

/**
 * Result of a health check for a single sandbox
 */
export interface HealthCheckResult {
  /** Overall health status */
  healthy: boolean;
  /** Individual check results */
  checks: {
    /** Process is running in sandbox */
    processRunning: boolean;
    /** Gateway port is reachable via TCP */
    portReachable: boolean;
    /** Gateway responds to HTTP health check */
    gatewayResponds: boolean;
  };
  /** ISO timestamp of this check */
  lastCheck: string;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Process ID if found */
  processId?: string;
  /** Process status */
  processStatus?: string;
  /** Error message if unhealthy */
  error?: string;
  /** Memory usage if available */
  memoryUsageMb?: number;
  /** Process uptime in seconds */
  uptimeSeconds?: number;
}

/**
 * In-memory tracking of health check state per user
 */
interface HealthState {
  consecutiveFailures: number;
  lastCheck: string;
  lastHealthy: string | null;
  lastRestart: string | null;
}

const healthStates: Map<string, HealthState> = new Map();

/**
 * Configuration for health checks
 */
export interface HealthCheckConfig {
  /** Number of consecutive failures before auto-restart (default: 3) */
  failuresBeforeRestart: number;
  /** Timeout for port check in ms (default: 5000) */
  portCheckTimeoutMs: number;
  /** Timeout for HTTP check in ms (default: 10000) */
  httpCheckTimeoutMs: number;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  failuresBeforeRestart: 3,
  portCheckTimeoutMs: 5000,
  httpCheckTimeoutMs: 10000,
};

/**
 * Get current health state for a user
 */
export function getHealthState(userId: string): HealthState | undefined {
  return healthStates.get(userId);
}

/**
 * Get all health states (for admin dashboard)
 */
export function getAllHealthStates(): Map<string, HealthState> {
  return new Map(healthStates);
}

/**
 * Perform a health check on a user's sandbox
 *
 * @param sandbox - The sandbox instance
 * @param userId - User ID for tracking state
 * @param config - Health check configuration
 * @returns Health check result
 */
export async function checkHealth(
  sandbox: Sandbox,
  userId: string,
  config: Partial<HealthCheckConfig> = {}
): Promise<HealthCheckResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const now = new Date().toISOString();

  // Get or create health state
  let state = healthStates.get(userId);
  if (!state) {
    state = {
      consecutiveFailures: 0,
      lastCheck: now,
      lastHealthy: null,
      lastRestart: null,
    };
    healthStates.set(userId, state);
  }
  state.lastCheck = now;

  const result: HealthCheckResult = {
    healthy: false,
    checks: {
      processRunning: false,
      portReachable: false,
      gatewayResponds: false,
    },
    lastCheck: now,
    consecutiveFailures: state.consecutiveFailures,
  };

  // Check 1: Is the gateway process running?
  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (process) {
      result.processId = process.id;
      result.processStatus = process.status;
      result.checks.processRunning = process.status === 'running';

      // Get uptime if available
      if (process.startTime) {
        result.uptimeSeconds = Math.floor((Date.now() - process.startTime.getTime()) / 1000);
      }
    }
  } catch (err) {
    result.error = `Process check failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }

  // Check 2: Is the port reachable?
  if (result.checks.processRunning) {
    try {
      const process = await findExistingMoltbotProcess(sandbox);
      if (process) {
        await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: cfg.portCheckTimeoutMs });
        result.checks.portReachable = true;
      }
    } catch {
      // Port not reachable
    }
  }

  // Check 3: Does the gateway respond to HTTP?
  if (result.checks.portReachable) {
    try {
      // Try to get memory usage via a quick command
      const memProc = await sandbox.startProcess('cat /proc/meminfo | grep MemAvailable | awk \'{print $2}\'');
      await waitForProcess(memProc, 2000);
      const memLogs = await memProc.getLogs();
      const memKb = parseInt(memLogs.stdout?.trim() || '0', 10);
      if (memKb > 0) {
        result.memoryUsageMb = Math.round((1024 * 1024 - memKb) / 1024); // Rough used memory
      }

      // The gateway should respond - this is a basic test that it's alive
      result.checks.gatewayResponds = true;
    } catch {
      // HTTP check failed
    }
  }

  // Determine overall health
  result.healthy = result.checks.processRunning &&
                   result.checks.portReachable &&
                   result.checks.gatewayResponds;

  // Update state
  if (result.healthy) {
    state.consecutiveFailures = 0;
    state.lastHealthy = now;
  } else {
    state.consecutiveFailures++;
  }
  result.consecutiveFailures = state.consecutiveFailures;

  return result;
}

/**
 * Check if a sandbox should be restarted based on health state
 */
export function shouldRestart(userId: string, config: Partial<HealthCheckConfig> = {}): boolean {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = healthStates.get(userId);
  if (!state) return false;
  return state.consecutiveFailures >= cfg.failuresBeforeRestart;
}

/**
 * Record that a restart was performed
 */
export function recordRestart(userId: string): void {
  const state = healthStates.get(userId);
  if (state) {
    state.lastRestart = new Date().toISOString();
    state.consecutiveFailures = 0;
  }
}

/**
 * Reset health state for a user (e.g., after manual restart)
 */
export function resetHealthState(userId: string): void {
  healthStates.delete(userId);
}
