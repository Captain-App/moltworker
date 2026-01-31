/**
 * Configuration constants for OpenClaw Sandbox
 */

/** Port that the Moltbot gateway listens on inside the container */
export const MOLTBOT_PORT = 18789;

/** Maximum time to wait for Moltbot to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/** Base mount path for R2 persistent storage inside the container */
export const R2_MOUNT_PATH = '/data/openclaw';

/** R2 bucket name for persistent storage */
export const R2_BUCKET_NAME = 'moltbot-data';

/** Health check configuration */
export const HEALTH_CHECK_CONFIG = {
  /** Number of consecutive failures before auto-restart */
  failuresBeforeRestart: 3,
  /** Timeout for port check in ms */
  portCheckTimeoutMs: 5000,
  /** Timeout for HTTP check in ms */
  httpCheckTimeoutMs: 10000,
};

/**
 * Get the R2 mount path for a specific user.
 * @param r2Prefix - The user's R2 prefix (e.g., 'users/{userId}')
 * @returns The mount path inside the container
 */
export function getR2MountPathForUser(r2Prefix: string): string {
  return `${R2_MOUNT_PATH}/${r2Prefix}`;
}

/**
 * Get the R2 mount path for legacy single-user mode.
 * @deprecated Use getR2MountPathForUser instead
 */
export const R2_LEGACY_MOUNT_PATH = '/data/moltbot';
