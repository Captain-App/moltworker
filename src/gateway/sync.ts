import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2MountPathForUser } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

/**
 * Result of a sync operation with detailed status
 */
export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
  /** Unique sync ID for verification */
  syncId?: string;
  /** Number of files synced */
  fileCount?: number;
  /** Duration of sync in milliseconds */
  durationMs?: number;
  /** Rsync exit code */
  rsyncExitCode?: number;
}

/**
 * Options for syncing to R2
 */
export interface SyncOptions {
  /** User's R2 prefix for per-user storage (e.g., 'users/{userId}') */
  r2Prefix?: string;
}

/**
 * In-memory storage for recent sync results (for debugging)
 */
const recentSyncResults: Map<string, SyncResult[]> = new Map();
const MAX_RECENT_RESULTS = 10;

/**
 * In-memory lock to prevent concurrent syncs for the same user.
 * Key is r2Prefix, value is timestamp when sync started.
 */
const syncLocks: Map<string, number> = new Map();
const SYNC_LOCK_TIMEOUT_MS = 60_000; // 60 seconds max sync duration

/**
 * Get recent sync results for a user (for debugging)
 */
export function getRecentSyncResults(r2Prefix?: string): SyncResult[] {
  const key = r2Prefix || 'default';
  return recentSyncResults.get(key) || [];
}

/**
 * Get count of consecutive sync failures (from most recent)
 */
export function getConsecutiveSyncFailures(r2Prefix?: string): number {
  const results = getRecentSyncResults(r2Prefix);
  let count = 0;
  for (const result of results) {
    if (!result.success) {
      count++;
    } else {
      break; // Stop at first success
    }
  }
  return count;
}

/**
 * Store a sync result for debugging
 */
function storeSyncResult(r2Prefix: string | undefined, result: SyncResult): void {
  const key = r2Prefix || 'default';
  const results = recentSyncResults.get(key) || [];
  results.unshift(result);
  if (results.length > MAX_RECENT_RESULTS) {
    results.pop();
  }
  recentSyncResults.set(key, results);
}

/**
 * Generate a unique sync ID for verification
 */
function generateSyncId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `sync-${timestamp}-${random}`;
}

/**
 * Sync moltbot config from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config to R2
 * 4. Verifies rsync exit code
 * 5. Writes a timestamp file with unique sync ID for verification
 * 6. Verifies the sync ID was written correctly
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param options - Sync options including user-specific prefix
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const startTime = Date.now();
  const syncId = generateSyncId();
  const lockKey = options.r2Prefix || 'default';

  // Check if another sync is already in progress for this user
  const existingLock = syncLocks.get(lockKey);
  if (existingLock) {
    const lockAge = Date.now() - existingLock;
    if (lockAge < SYNC_LOCK_TIMEOUT_MS) {
      const result: SyncResult = {
        success: false,
        error: 'Sync already in progress',
        details: `Another sync started ${Math.round(lockAge / 1000)}s ago. Skipping to prevent race condition.`,
        syncId,
        durationMs: Date.now() - startTime,
      };
      storeSyncResult(options.r2Prefix, result);
      return result;
    }
    // Lock is stale, clear it
    syncLocks.delete(lockKey);
  }

  // Acquire lock
  syncLocks.set(lockKey, Date.now());

  try {
    return await doSyncToR2(sandbox, env, options, syncId, startTime);
  } finally {
    // Release lock
    syncLocks.delete(lockKey);
  }
}

async function doSyncToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  options: SyncOptions,
  syncId: string,
  startTime: number
): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    const result: SyncResult = { success: false, error: 'R2 storage is not configured', syncId };
    storeSyncResult(options.r2Prefix, result);
    return result;
  }

  // Mount R2 - return early if mount fails
  const mounted = await mountR2Storage(sandbox, env, { r2Prefix: options.r2Prefix });
  if (!mounted) {
    const result: SyncResult = {
      success: false,
      error: 'Failed to mount R2 storage',
      details: `Mount failed for prefix: ${options.r2Prefix || 'default'}. Cannot proceed with sync.`,
      syncId,
      durationMs: Date.now() - startTime,
    };
    storeSyncResult(options.r2Prefix, result);
    return result;
  }

  // Determine mount path based on user prefix
  const mountPath = options.r2Prefix
    ? getR2MountPathForUser(options.r2Prefix)
    : R2_MOUNT_PATH;

  // Sanity check: verify source has valid config before syncing
  // This prevents overwriting good R2 backups with empty/corrupted data
  try {
    // Check file exists and has valid JSON with required fields
    const checkProc = await sandbox.startProcess(
      'test -f /root/.clawdbot/clawdbot.json && ' +
      'node -e "const c=JSON.parse(require(\'fs\').readFileSync(\'/root/.clawdbot/clawdbot.json\')); ' +
      'if(!c.agents && !c.channels && !c.gateway) throw new Error(\'Empty config\'); console.log(\'ok\')"'
    );
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      const result: SyncResult = {
        success: false,
        error: 'Sync aborted: config appears empty or invalid',
        details: `Local clawdbot.json exists but lacks required fields. stderr: ${checkLogs.stderr?.slice(0, 200)}`,
        syncId,
        durationMs: Date.now() - startTime,
      };
      storeSyncResult(options.r2Prefix, result);
      return result;
    }
  } catch (err) {
    const result: SyncResult = {
      success: false,
      error: 'Failed to verify source config',
      details: err instanceof Error ? err.message : 'Unknown error',
      syncId,
      durationMs: Date.now() - startTime,
    };
    storeSyncResult(options.r2Prefix, result);
    return result;
  }

  // Check if a sync is already running to prevent pileup
  // This is critical because the cron runs every minute and rsync can hang on slow s3fs mounts
  try {
    const checkProc = await sandbox.startProcess('pgrep -f "rsync.*/root/.clawdbot" 2>/dev/null | head -1');
    await waitForProcess(checkProc, 3000);
    const checkLogs = await checkProc.getLogs();
    if (checkLogs.stdout?.trim()) {
      console.log(`[sync] Skipping sync - another rsync already running for ${options.r2Prefix || 'default'}`);
      const result: SyncResult = {
        success: false,
        error: 'Sync already in progress',
        details: 'Another rsync process is still running. Skipping to prevent pileup.',
        syncId,
        durationMs: Date.now() - startTime,
      };
      storeSyncResult(options.r2Prefix, result);
      return result;
    }
  } catch {
    // Non-critical, continue with sync
  }

  // Count files before sync for verification
  let fileCountBefore = 0;
  try {
    const countProc = await sandbox.startProcess(`find /root/.clawdbot -type f 2>/dev/null | wc -l`);
    await waitForProcess(countProc, 5000);
    const countLogs = await countProc.getLogs();
    fileCountBefore = parseInt(countLogs.stdout?.trim() || '0', 10);
  } catch {
    // Non-critical, continue with sync
  }

  // Run rsync to backup config and workspace to R2
  // Note: Use --no-times because s3fs doesn't support setting timestamps
  // Use && between commands to ensure they run sequentially and we can check overall success
  // Backup both /root/.clawdbot/ (config) and /root/clawd/ (workspace including scripts, skills, etc.)
  const timestamp = new Date().toISOString();
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${mountPath}/clawdbot/ && rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/clawd/ ${mountPath}/workspace/ 2>/dev/null; rsync_exit=$?; echo "${syncId}|${timestamp}" > ${mountPath}/.last-sync; exit $rsync_exit`;

  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000); // 30 second timeout for sync

    // Get rsync exit code from process
    const rsyncExitCode = proc.exitCode;

    // Verify sync by reading back the sync ID
    const verifyProc = await sandbox.startProcess(`cat ${mountPath}/.last-sync`);
    await waitForProcess(verifyProc, 5000);
    const verifyLogs = await verifyProc.getLogs();
    const syncFileContent = verifyLogs.stdout?.trim() || '';

    // Parse the sync file content (format: syncId|timestamp)
    const [writtenSyncId, writtenTimestamp] = syncFileContent.split('|');

    // Verify the sync ID matches what we wrote
    if (writtenSyncId !== syncId) {
      const logs = await proc.getLogs();
      const result: SyncResult = {
        success: false,
        error: 'Sync verification failed',
        details: `Expected sync ID ${syncId}, got ${writtenSyncId}. Rsync may have failed silently. stdout: ${logs.stdout?.slice(-500)}, stderr: ${logs.stderr?.slice(-500)}`,
        syncId,
        rsyncExitCode: rsyncExitCode ?? undefined,
        durationMs: Date.now() - startTime,
      };
      storeSyncResult(options.r2Prefix, result);
      return result;
    }

    // Check rsync exit code (0 = success, some non-zero codes are acceptable)
    // rsync exit codes: 0=success, 24=vanished files (ok), others=error
    if (rsyncExitCode !== null && rsyncExitCode !== 0 && rsyncExitCode !== 24) {
      const logs = await proc.getLogs();
      const result: SyncResult = {
        success: false,
        error: `Rsync failed with exit code ${rsyncExitCode}`,
        details: `stderr: ${logs.stderr?.slice(-500)}`,
        syncId,
        rsyncExitCode,
        durationMs: Date.now() - startTime,
      };
      storeSyncResult(options.r2Prefix, result);
      return result;
    }

    // Count files after sync
    let fileCountAfter = 0;
    try {
      const countProc = await sandbox.startProcess(`find ${mountPath}/clawdbot -type f 2>/dev/null | wc -l`);
      await waitForProcess(countProc, 5000);
      const countLogs = await countProc.getLogs();
      fileCountAfter = parseInt(countLogs.stdout?.trim() || '0', 10);
    } catch {
      // Non-critical
    }

    const result: SyncResult = {
      success: true,
      lastSync: writtenTimestamp || timestamp,
      syncId,
      fileCount: fileCountAfter,
      rsyncExitCode: rsyncExitCode ?? 0,
      durationMs: Date.now() - startTime,
    };
    storeSyncResult(options.r2Prefix, result);
    return result;

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.error(`[sync] Sync failed for ${options.r2Prefix || 'default'}: ${errorMsg}`, errorStack);
    const result: SyncResult = {
      success: false,
      error: `Sync error: ${errorMsg}`,
      details: errorStack || errorMsg,
      syncId,
      durationMs: Date.now() - startTime,
    };
    storeSyncResult(options.r2Prefix, result);
    return result;
  }
}
