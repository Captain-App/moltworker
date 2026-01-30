import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, R2_BUCKET_NAME, getR2MountPathForUser } from '../config';

/**
 * Options for mounting R2 storage
 */
export interface R2MountOptions {
  /** User's R2 prefix for per-user storage (e.g., 'users/{userId}') */
  r2Prefix?: string;
}

/**
 * Check if R2 is already mounted by looking at the mount table
 */
async function isR2Mounted(sandbox: Sandbox, mountPath: string): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(`mount | grep "s3fs on ${mountPath}"`);
    // Wait for the command to complete
    let attempts = 0;
    while (proc.status === 'running' && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    const logs = await proc.getLogs();
    // If stdout has content, the mount exists
    const mounted = !!(logs.stdout && logs.stdout.includes('s3fs'));
    console.log('isR2Mounted check:', mounted, 'path:', mountPath, 'stdout:', logs.stdout?.slice(0, 100));
    return mounted;
  } catch (err) {
    console.log('isR2Mounted error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage
 *
 * R2 is always mounted at the base path (R2_MOUNT_PATH = /data/openclaw).
 * User data is stored in subdirectories (e.g., /data/openclaw/users/{userId}/).
 * The r2Prefix option is ignored for mounting but used by sync functions.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param options - Mount options (r2Prefix is ignored for mounting)
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(
  sandbox: Sandbox,
  env: MoltbotEnv,
  _options: R2MountOptions = {}
): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log('R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)');
    return false;
  }

  // Always mount at base path - user data is in subdirectories
  const mountPath = R2_MOUNT_PATH;

  // Check if already mounted first - this avoids errors and is faster
  if (await isR2Mounted(sandbox, mountPath)) {
    console.log('R2 bucket already mounted at', mountPath);
    return true;
  }

  try {
    console.log('Mounting R2 bucket at', mountPath);
    await sandbox.mountBucket(R2_BUCKET_NAME, mountPath, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Pass credentials explicitly since we use R2_* naming instead of AWS_*
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('R2 bucket mounted successfully at', mountPath);
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.log('R2 mount error:', errorMessage);

    // Check again if it's mounted - the error might be misleading
    if (await isR2Mounted(sandbox, mountPath)) {
      console.log('R2 bucket is mounted despite error');
      return true;
    }

    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}
