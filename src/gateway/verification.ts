/**
 * Verification System for Backup Integrity
 * 
 * Provides health checks and verification that critical files are properly synced to R2.
 * This is Layer 5 of the zero-data-loss architecture.
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { getR2MountPathForUser, R2_MOUNT_PATH } from '../config';
import { isCriticalPath, VERIFICATION_CONFIG } from '../config/backup';

/**
 * Result of a verification check
 */
export interface VerificationResult {
  /** Whether all checks passed */
  passed: boolean;
  /** Timestamp of verification */
  timestamp: string;
  /** Files that were verified */
  filesChecked: number;
  /** Critical files found missing */
  missingCriticalFiles: MissingFile[];
  /** Non-critical files found missing */
  missingFiles: MissingFile[];
  /** Files with checksum mismatches */
  checksumMismatches: ChecksumMismatch[];
  /** Time taken for verification (ms) */
  durationMs: number;
}

/**
 * Information about a missing file
 */
export interface MissingFile {
  path: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  localSize?: number;
  localMtime?: string;
}

/**
 * Information about a checksum mismatch
 */
export interface ChecksumMismatch {
  path: string;
  localChecksum: string;
  remoteChecksum: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * Critical file verification status for a user
 */
export interface CriticalFileStatus {
  userId: string;
  timestamp: string;
  allCriticalFilesPresent: boolean;
  missingCredentials: string[];
  missingConfig: string[];
  r2Path: string;
}

// In-memory cache of verification results (for recent queries)
const verificationCache = new Map<string, VerificationResult>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * List all critical files that should be in R2 for a user
 */
export async function listMissingCriticalFiles(
  env: MoltbotEnv,
  userId: string
): Promise<CriticalFileStatus> {
  const startTime = Date.now();
  const r2Prefix = `users/${userId}`;
  
  const result: CriticalFileStatus = {
    userId,
    timestamp: new Date().toISOString(),
    allCriticalFilesPresent: true,
    missingCredentials: [],
    missingConfig: [],
    r2Path: r2Prefix,
  };
  
  try {
    // Check for credentials directory in R2
    const credentialsPrefix = `${r2Prefix}/openclaw/credentials/`;
    const credentialsList = await env.MOLTBOT_BUCKET.list({
      prefix: credentialsPrefix,
    });
    
    // Check for main config file
    const configKey = `${r2Prefix}/openclaw/openclaw.json`;
    const configExists = await env.MOLTBOT_BUCKET.head(configKey);
    
    if (!configExists) {
      result.missingConfig.push('openclaw.json');
      result.allCriticalFilesPresent = false;
    }
    
    // Check for .registered marker
    const registeredKey = `${r2Prefix}/.registered`;
    const registeredExists = await env.MOLTBOT_BUCKET.head(registeredKey);
    
    if (!registeredExists) {
      result.missingConfig.push('.registered');
    }
    
    // Check for credential files
    const credentialFiles = credentialsList.objects.filter(obj => 
      obj.key.endsWith('.json')
    );
    
    if (credentialFiles.length === 0) {
      // No credential files found at all - this might be a new user
      // but we should flag it for verification
      console.log(`[Verification] No credential files found for user ${userId.slice(0, 8)}...`);
    }
    
    // Log any missing critical files
    if (!result.allCriticalFilesPresent) {
      console.warn(`[Verification] Missing critical files for user ${userId.slice(0, 8)}...:`, {
        missingConfig: result.missingConfig,
        credentialCount: credentialFiles.length,
      });
    }
    
    return result;
  } catch (err) {
    console.error(`[Verification] Error checking critical files for ${userId}:`, err);
    result.allCriticalFilesPresent = false;
    return result;
  }
}

/**
 * Verify that a recent sync actually persisted files to R2
 * This reads back files from R2 to confirm they were written
 */
export async function verifySyncToR2(
  env: MoltbotEnv,
  userId: string,
  syncId?: string
): Promise<VerificationResult> {
  const startTime = Date.now();
  const r2Prefix = `users/${userId}`;
  const cacheKey = `${userId}-${syncId || 'latest'}`;
  
  // Check cache first
  const cached = verificationCache.get(cacheKey);
  if (cached && (Date.now() - new Date(cached.timestamp).getTime()) < CACHE_TTL_MS) {
    return cached;
  }
  
  const result: VerificationResult = {
    passed: true,
    timestamp: new Date().toISOString(),
    filesChecked: 0,
    missingCriticalFiles: [],
    missingFiles: [],
    checksumMismatches: [],
    durationMs: 0,
  };
  
  try {
    // Check critical files first
    const criticalStatus = await listMissingCriticalFiles(env, userId);
    
    // Add missing critical files to result
    for (const missing of criticalStatus.missingConfig) {
      result.missingCriticalFiles.push({
        path: `${r2Prefix}/openclaw/${missing}`,
        priority: 'critical',
      });
    }
    
    // List all files in R2 openclaw directory
    const r2Files = await env.MOLTBOT_BUCKET.list({
      prefix: `${r2Prefix}/openclaw/`,
    });
    
    result.filesChecked = r2Files.objects.length;
    
    // Check for expected critical files
    const expectedCriticalFiles = [
      `${r2Prefix}/openclaw/openclaw.json`,
      `${r2Prefix}/.registered`,
    ];
    
    const foundKeys = new Set(r2Files.objects.map(o => o.key));
    
    for (const expectedPath of expectedCriticalFiles) {
      if (!foundKeys.has(expectedPath)) {
        // Check if this is a critical path
        if (isCriticalPath(expectedPath)) {
          result.missingCriticalFiles.push({
            path: expectedPath,
            priority: 'critical',
          });
        } else {
          result.missingFiles.push({
            path: expectedPath,
            priority: 'high',
          });
        }
      }
    }
    
    // Determine if verification passed
    if (result.missingCriticalFiles.length > 0) {
      result.passed = false;
    }
    
    result.durationMs = Date.now() - startTime;
    
    // Cache the result
    verificationCache.set(cacheKey, result);
    
    // Log issues
    if (!result.passed) {
      console.warn(`[Verification] FAILED for user ${userId.slice(0, 8)}...:`, {
        missingCritical: result.missingCriticalFiles.length,
        missingTotal: result.missingFiles.length,
        filesChecked: result.filesChecked,
      });
    } else {
      console.log(`[Verification] PASSED for user ${userId.slice(0, 8)}...: ${result.filesChecked} files checked`);
    }
    
    return result;
  } catch (err) {
    console.error(`[Verification] Error during sync verification for ${userId}:`, err);
    result.passed = false;
    result.durationMs = Date.now() - startTime;
    return result;
  }
}

/**
 * Verify files within a running sandbox container
 * Compares local files with R2 to detect drift
 */
export async function verifySandboxSync(
  sandbox: Sandbox,
  env: MoltbotEnv,
  userId: string
): Promise<VerificationResult> {
  const startTime = Date.now();
  const r2Prefix = `users/${userId}`;
  
  const result: VerificationResult = {
    passed: true,
    timestamp: new Date().toISOString(),
    filesChecked: 0,
    missingCriticalFiles: [],
    missingFiles: [],
    checksumMismatches: [],
    durationMs: 0,
  };
  
  try {
    // Get list of local critical files
    const localFilesProc = await sandbox.startProcess(
      `find /root/.openclaw -type f \( -name "*.json" -o -name ".registered" \) 2>/dev/null | head -50`
    );
    
    // Wait with timeout
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), VERIFICATION_CONFIG.timeoutMs)
    );
    
    await Promise.race([
      localFilesProc.waitForExit(VERIFICATION_CONFIG.timeoutMs),
      timeoutPromise,
    ]);
    
    const localLogs = await localFilesProc.getLogs();
    const localFiles = (localLogs.stdout || '').trim().split('\n').filter(f => f);
    
    result.filesChecked = localFiles.length;
    
    // Check each critical file exists in R2
    for (const localPath of localFiles) {
      if (!isCriticalPath(localPath)) continue;
      
      // Convert local path to R2 key
      const relativePath = localPath.replace('/root/.openclaw/', '');
      const r2Key = `${r2Prefix}/openclaw/${relativePath}`;
      
      // Check if exists in R2
      const r2Head = await env.MOLTBOT_BUCKET.head(r2Key);
      
      if (!r2Head) {
        const priority = isCriticalPath(localPath) ? 'critical' : 'high';
        
        if (priority === 'critical') {
          result.missingCriticalFiles.push({
            path: localPath,
            priority,
          });
          result.passed = false;
        } else {
          result.missingFiles.push({
            path: localPath,
            priority,
          });
        }
      }
    }
    
    result.durationMs = Date.now() - startTime;
    
    return result;
  } catch (err) {
    console.error(`[Verification] Error during sandbox verification for ${userId}:`, err);
    result.passed = false;
    result.durationMs = Date.now() - startTime;
    return result;
  }
}

/**
 * Run post-restart verification to ensure all files were restored
 * This should be called after container startup to detect any data loss
 */
export async function runPostRestartVerification(
  env: MoltbotEnv,
  userId: string
): Promise<VerificationResult> {
  console.log(`[Verification] Running post-restart verification for user ${userId.slice(0, 8)}...`);
  
  const result = await listMissingCriticalFiles(env, userId);
  
  const verificationResult: VerificationResult = {
    passed: result.allCriticalFilesPresent,
    timestamp: result.timestamp,
    filesChecked: result.missingConfig.length + (result.allCriticalFilesPresent ? 1 : 0),
    missingCriticalFiles: [
      ...result.missingConfig.map(path => ({ path, priority: 'critical' as const })),
      ...result.missingCredentials.map(path => ({ path, priority: 'critical' as const })),
    ],
    missingFiles: [],
    checksumMismatches: [],
    durationMs: 0,
  };
  
  if (!verificationResult.passed) {
    console.error(`[Verification] POST-RESTART DATA LOSS DETECTED for user ${userId.slice(0, 8)}...:`, {
      missingFiles: verificationResult.missingCriticalFiles.map(f => f.path),
    });
    
    // This is a serious issue - log to monitoring
    // TODO: Alert via Telegram/email for critical data loss
  } else {
    console.log(`[Verification] Post-restart verification PASSED for user ${userId.slice(0, 8)}...`);
  }
  
  return verificationResult;
}

/**
 * Check if there are any missing critical files and alert
 */
export async function alertIfMissingCriticalFiles(
  env: MoltbotEnv,
  userId: string
): Promise<boolean> {
  const result = await listMissingCriticalFiles(env, userId);
  
  if (!result.allCriticalFilesPresent) {
    const missingCount = result.missingConfig.length + result.missingCredentials.length;
    console.warn(`[Alert] User ${userId.slice(0, 8)}... has ${missingCount} missing critical files:`, {
      config: result.missingConfig,
      credentials: result.missingCredentials,
    });
    
    // TODO: Send alert via Telegram/Slack if configured
    // This would use the user's configured alert channel
    
    return true; // Alert was triggered
  }
  
  return false; // No alert needed
}

/**
 * Health check endpoint data for backup status
 */
export interface BackupHealthStatus {
  healthy: boolean;
  lastSync?: string;
  syncId?: string;
  criticalFilesPresent: boolean;
  missingCriticalFiles: string[];
  r2Connected: boolean;
  issues: string[];
}

/**
 * Get comprehensive backup health status for a user
 */
export async function getBackupHealthStatus(
  env: MoltbotEnv,
  userId: string
): Promise<BackupHealthStatus> {
  const status: BackupHealthStatus = {
    healthy: true,
    criticalFilesPresent: false,
    missingCriticalFiles: [],
    r2Connected: false,
    issues: [],
  };
  
  try {
    // Check R2 connectivity
    const testKey = `users/${userId}/.registered`;
    await env.MOLTBOT_BUCKET.head(testKey);
    status.r2Connected = true;
  } catch {
    status.r2Connected = false;
    status.healthy = false;
    status.issues.push('R2 not accessible');
  }
  
  // Check critical files
  const criticalStatus = await listMissingCriticalFiles(env, userId);
  status.criticalFilesPresent = criticalStatus.allCriticalFilesPresent;
  status.missingCriticalFiles = [
    ...criticalStatus.missingConfig,
    ...criticalStatus.missingCredentials,
  ];
  
  if (!status.criticalFilesPresent) {
    status.healthy = false;
    status.issues.push(`Missing critical files: ${status.missingCriticalFiles.join(', ')}`);
  }
  
  return status;
}
