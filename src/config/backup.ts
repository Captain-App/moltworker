/**
 * Backup and sync configuration
 * 
 * Feature flags for gradual rollout of zero-data-loss backup system.
 * All features default to false for safe deployment.
 */

export const BACKUP_FEATURE_FLAGS = {
  // Phase 1: Critical File Protection (Week 1) - DEPLOYING NOW
  /** Enable shutdown sync hooks */
  SHUTDOWN_SYNC: true,
  /** Enable priority sync for critical files */
  CRITICAL_FILE_PRIORITY: true,
  /** Enable sync verification (read-back check) */
  SYNC_VERIFICATION: true,
  /** Enable post-restart verification */
  POST_RESTART_VERIFICATION: true,
  
  // Phase 2: Real-Time Sync (Week 2)
  REALTIME_SYNC: false,
  
  // Phase 3: Snapshots (Week 3)
  SNAPSHOTS: false,
  
  // Phase 4: WAL (Week 4)
  WAL: false,
};

/**
 * Canary users for phased rollout
 * Add user IDs here to enable Phase 2 features for specific users
 */
export const CANARY_USERS = [
  // Jack and Josh - Phase 2 real-time sync testing
  'jack-lippold',
  'joshua-carey',
];

/**
 * Check if a backup feature is enabled
 * For Phase 2+ features, checks canary list
 */
export function isBackupFeatureEnabled(
  flag: keyof typeof BACKUP_FEATURE_FLAGS,
  userId?: string
): boolean {
  const globallyEnabled = BACKUP_FEATURE_FLAGS[flag];
  
  // Phase 2+ features require canary status until fully rolled out
  if (flag === 'REALTIME_SYNC' && userId) {
    return CANARY_USERS.includes(userId);
  }
  
  return globallyEnabled;
}

/**
 * Critical file patterns that get priority treatment
 * These files are synced first and verified immediately
 */
export const CRITICAL_PATHS = [
  // Credentials (HIGHEST priority)
  '/root/.clawdbot/credentials/**/*.json',
  '/root/.clawdbot/clawdbot.json',
  '/root/.clawdbot/.registered',
  
  // Channel configs (HIGH priority)
  '/root/.clawdbot/channels/**/config.json',
  
  // Memory files (MEDIUM priority)
  '/root/clawd/memory/*.md',
  '/root/clawd/life/**/*.json',
];

/**
 * Path priority levels for sync ordering
 */
export const PATH_PRIORITY: Record<string, number> = {
  'credentials': 100,    // Credentials always first
  'clawdbot.json': 90,   // Main config
  '.registered': 80,     // Registration marker
  'channels': 70,        // Channel configs
  'memory': 50,          // Daily notes
  'life': 40,            // Knowledge graph
  'skills': 30,          // Skills
  'scripts': 20,         // Scripts
  'default': 10,         // Everything else
};

/**
 * Get priority score for a file path (higher = more important)
 */
export function getPathPriority(filePath: string): number {
  const normalizedPath = filePath.toLowerCase();
  
  for (const [pattern, priority] of Object.entries(PATH_PRIORITY)) {
    if (normalizedPath.includes(pattern.toLowerCase())) {
      return priority;
    }
  }
  
  return PATH_PRIORITY.default;
}

/**
 * Check if a file path is considered critical
 */
export function isCriticalPath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  
  // Check exact matches and patterns
  if (normalizedPath.includes('/credentials/')) return true;
  if (normalizedPath.includes('clawdbot.json')) return true;
  if (normalizedPath.includes('.registered')) return true;
  if (normalizedPath.includes('/channels/') && normalizedPath.includes('config.json')) return true;
  
  return false;
}

/**
 * Shutdown sync configuration
 */
export const SHUTDOWN_CONFIG = {
  /** Maximum time to wait for sync before forcing shutdown (ms) */
  timeoutMs: 30_000,
  /** Create emergency snapshot on shutdown */
  emergencySnapshot: true,
  /** Sync critical files first */
  prioritizeCritical: true,
};

/**
 * Verification configuration
 */
export const VERIFICATION_CONFIG = {
  /** Verify every sync by reading back */
  syncTimeVerify: true,
  /** Verify critical files exist in R2 after sync */
  verifyCriticalInR2: true,
  /** Timeout for verification operations (ms) */
  timeoutMs: 10_000,
};
