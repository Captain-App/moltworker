import { Hono } from 'hono';
import type { AppEnv } from '../types';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
  mountR2Storage,
  syncToR2,
  waitForProcess,
  deriveUserGatewayToken,
  getGatewayMasterToken,
  getAllHealthStates,
  getRecentSyncResults,
} from '../gateway';
import { R2_MOUNT_PATH, getR2MountPathForUser } from '../config';
import {
  getUnresolvedIssues,
  getRecentIssues,
  getIssue,
  resolveIssue,
  getIssueCounts,
  createIssue,
  cleanupOldIssues,
  getRecentEvents,
} from '../monitoring';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Supabase auth via main middleware)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - protected by Supabase auth (applied in main index.ts middleware)
 */
const adminApi = new Hono<AppEnv>();

// Helper: Check if requester is admin
function isAdminRequest(c: any): boolean {
  const user = c.get('user');
  const devMode = c.env.DEV_MODE === 'true';
  const adminIds = c.env.ADMIN_USER_IDS?.split(',') || [];
  
  // Also allow access via admin secret header (for service role operations)
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);
  const secretAuth = !!adminSecret && adminSecret === expectedSecret;
  
  return devMode || secretAuth || (user?.id && adminIds.includes(user.id));
}

// GET /api/admin/users - List all users from Supabase auth
adminApi.get('/users', async (c) => {
  // Direct secret check at endpoint level (bypasses middleware auth)
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);
  const user = c.get('user');
  const devMode = c.env.DEV_MODE === 'true';
  const adminIds = c.env.ADMIN_USER_IDS?.split(',') || [];
  const isAdmin = devMode || (adminSecret && adminSecret === expectedSecret) || (user?.id && adminIds.includes(user.id));
  
  if (!isAdmin) {
    return c.json({ error: 'Admin access required', hasSecret: !!adminSecret, hasUser: !!user }, 403);
  }

  try {
    // Query Supabase auth.users via REST
    const supabaseUrl = c.env.SUPABASE_URL || 'https://kjbcjkihxskuwwfdqklt.supabase.co';
    const serviceRoleKey = c.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!serviceRoleKey) {
      return c.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id,username,full_name,created_at&order=created_at.desc&limit=100`, {
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return c.json({ error: 'Failed to fetch users', status: response.status }, 500);
    }

    const profiles = await response.json();
    
    // Check which users have sandboxes
    const usersWithSandboxes = await Promise.all(
      profiles.map(async (profile: any) => {
        const sandboxName = `openclaw-${profile.id}`;
        try {
          const { getSandbox } = await import('@cloudflare/sandbox');
          const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: false });
          // Try to list processes to see if sandbox exists
          const processes = await sandbox.listProcesses();
          return {
            ...profile,
            sandbox: {
              name: sandboxName,
              active: processes.length > 0,
              processes: processes.length,
            },
          };
        } catch (e) {
          return {
            ...profile,
            sandbox: { name: sandboxName, active: false, error: 'not_found' },
          };
        }
      })
    );

    return c.json({
      users: usersWithSandboxes,
      count: usersWithSandboxes.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/users/search - Search users by email/name
adminApi.get('/users/search', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const query = c.req.query('q');
  if (!query) {
    return c.json({ error: 'Query parameter q required' }, 400);
  }

  try {
    const supabaseUrl = c.env.SUPABASE_URL || 'https://kjbcjkihxskuwwfdqklt.supabase.co';
    const serviceRoleKey = c.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!serviceRoleKey) {
      return c.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);
    }

    // Search profiles by username or full_name
    const response = await fetch(
      `${supabaseUrl}/rest/v1/profiles?select=id,username,full_name,created_at&or=(username.ilike.*${query}*,full_name.ilike.*${query}*)&limit=20`,
      {
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      return c.json({ error: 'Search failed', status: response.status }, 500);
    }

    const profiles = await response.json();
    return c.json({ users: profiles, count: profiles.length });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/users/:userId - Get user details with sandbox status
adminApi.get('/users/:userId', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const userId = c.req.param('userId');
  
  try {
    const supabaseUrl = c.env.SUPABASE_URL || 'https://kjbcjkihxskuwwfdqklt.supabase.co';
    const serviceRoleKey = c.env.SUPABASE_SERVICE_ROLE_KEY;
    
    // Get profile
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?select=*&id=eq.${userId}&limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': serviceRoleKey,
          'Content-Type': 'application/json',
        },
      }
    );
    
    const profiles = await profileRes.json();
    const profile = profiles[0] || null;

    // Get sandbox status
    const sandboxName = `openclaw-${userId}`;
    let sandboxStatus: any = { name: sandboxName, active: false };
    
    try {
      const { getSandbox } = await import('@cloudflare/sandbox');
      const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: false });
      const processes = await sandbox.listProcesses();
      sandboxStatus = {
        name: sandboxName,
        active: processes.length > 0,
        processes: processes.map((p: any) => ({
          id: p.id,
          command: p.command,
          status: p.status,
          exitCode: p.exitCode,
        })),
      };
    } catch (e) {
      sandboxStatus.error = 'sandbox_not_found';
    }

    // Derive gateway token for this user
    let gatewayToken: string | null = null;
    const masterToken = getGatewayMasterToken(c.env);
    if (masterToken) {
      gatewayToken = await deriveUserGatewayToken(masterToken, userId);
    }

    return c.json({
      user: profile,
      userId,
      sandbox: sandboxStatus,
      gatewayToken: gatewayToken ? `${gatewayToken.slice(0, 8)}...` : null,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/users/:userId/restart - Restart user's container
adminApi.post('/users/:userId/restart', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: true });

  try {
    // Kill all processes
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      try { await proc.kill(); } catch (e) { /* ignore */ }
    }

    await new Promise(r => setTimeout(r, 2000));

    // Clear locks
    try {
      await sandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null');
    } catch (e) { /* ignore */ }

    // Restart gateway
    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch(() => {});
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: 'Container restart initiated',
      userId,
      sandboxName,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to list devices (CLI is still named clawdbot until upstream renames)
    // Must specify --url to connect to the gateway running in the same container
    const proc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to approve the device (CLI is still named clawdbot)
    const proc = await sandbox.startProcess(`clawdbot devices approve ${requestId} --url ws://localhost:18789`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices (CLI is still named clawdbot)
    const listProc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        const approveProc = await sandbox.startProcess(`clawdbot devices approve ${device.requestId} --url ws://localhost:18789`);
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        const approveLogs = await approveProc.getLogs();
        const success = approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter(r => r.success).length;
    return c.json({
      approved: results.filter(r => r.success).map(r => r.requestId),
      failed: results.filter(r => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const user = c.get('user');

  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;
  let backupFiles: string[] = [];

  // Determine the user-specific mount path
  const userMountPath = user?.r2Prefix
    ? getR2MountPathForUser(user.r2Prefix)
    : R2_MOUNT_PATH;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted (with user prefix)
      await mountR2Storage(sandbox, c.env, { r2Prefix: user?.r2Prefix });

      // Check for sync marker file
      const proc = await sandbox.startProcess(`cat ${userMountPath}/.last-sync 2>/dev/null || echo ""`);
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      const timestamp = logs.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }

      // List what's in the backup directory
      const listProc = await sandbox.startProcess(`ls -la ${userMountPath}/ 2>/dev/null | head -20`);
      await waitForProcess(listProc, 5000);
      const listLogs = await listProc.getLogs();
      if (listLogs.stdout) {
        backupFiles = listLogs.stdout.split('\n').filter(l => l.trim());
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    mountPath: userMountPath,
    backupFiles,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');
  const user = c.get('user');

  // Pass user's R2 prefix for per-user backup
  const result = await syncToR2(sandbox, c.env, { r2Prefix: user?.r2Prefix });
  
  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json({
      success: false,
      error: result.error,
      details: result.details,
    }, status);
  }
});

// GET/POST /api/admin/gateway/restart - Kill the current gateway and start a new one
// GET is supported for easy browser access on mobile
adminApi.get('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');
  const user = c.get('user');

  try {
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const bootPromise = ensureMoltbotGateway(sandbox, c.env, user?.id).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
      sandbox: user?.sandboxName,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');
  const user = c.get('user');

  try {
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const bootPromise = ensureMoltbotGateway(sandbox, c.env, user?.id).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
      sandbox: user?.sandboxName,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/container/reset - FORCE reset: kill all processes and restart gateway
adminApi.post('/container/reset', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Get ALL processes and kill them
    const allProcesses = await sandbox.listProcesses();
    console.log(`[RESET] Found ${allProcesses.length} processes to kill`);
    
    for (const proc of allProcesses) {
      console.log(`[RESET] Killing process ${proc.id}: ${proc.command}`);
      try {
        await proc.kill();
      } catch (killErr) {
        console.error(`[RESET] Error killing process ${proc.id}:`, killErr);
      }
    }
    
    // Wait for processes to die
    await new Promise(r => setTimeout(r, 3000));
    
    // Clear any lock files
    try {
      const clearLocks = await sandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null; echo "locks cleared"');
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.log('[RESET] Lock clear warning:', e);
    }

    // Start fresh gateway
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('[RESET] Gateway start failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: `Killed ${allProcesses.length} processes. Fresh gateway starting...`,
      killedProcesses: allProcesses.map(p => ({ id: p.id, command: p.command })),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// =============================================================================
// User Secrets Management
// Stored in R2 at users/{userId}/secrets.json
// =============================================================================

interface UserSecrets {
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

const SECRET_KEYS: (keyof UserSecrets)[] = [
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

// GET /api/admin/secrets - Get current secrets (masked for display)
adminApi.get('/secrets', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  try {
    const secretsKey = `${user.r2Prefix}/secrets.json`;
    const object = await c.env.MOLTBOT_BUCKET.get(secretsKey);

    let secrets: UserSecrets = {};
    if (object) {
      const text = await object.text();
      secrets = JSON.parse(text);
    }

    // Return masked values and which secrets are configured
    const masked: Record<string, string | null> = {};
    const configured: string[] = [];

    for (const key of SECRET_KEYS) {
      masked[key] = maskSecret(secrets[key]);
      if (secrets[key]) {
        configured.push(key);
      }
    }

    return c.json({
      secrets: masked,
      configured,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// PUT /api/admin/secrets - Update secrets
adminApi.put('/secrets', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  try {
    const body = await c.req.json() as Partial<UserSecrets>;
    const secretsKey = `${user.r2Prefix}/secrets.json`;

    // Load existing secrets
    let secrets: UserSecrets = {};
    const existing = await c.env.MOLTBOT_BUCKET.get(secretsKey);
    if (existing) {
      secrets = JSON.parse(await existing.text());
    }

    // Update only provided values (empty string = delete)
    for (const key of SECRET_KEYS) {
      if (key in body) {
        const value = body[key];
        if (value === '' || value === null) {
          delete secrets[key];
        } else if (value) {
          secrets[key] = value;
        }
      }
    }

    // Save to R2
    await c.env.MOLTBOT_BUCKET.put(secretsKey, JSON.stringify(secrets, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    // Return updated masked values
    const masked: Record<string, string | null> = {};
    const configured: string[] = [];

    for (const key of SECRET_KEYS) {
      masked[key] = maskSecret(secrets[key]);
      if (secrets[key]) {
        configured.push(key);
      }
    }

    return c.json({
      success: true,
      secrets: masked,
      configured,
      message: 'Secrets updated. Restart the gateway to apply changes.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// DELETE /api/admin/secrets/:key - Delete a specific secret
adminApi.delete('/secrets/:key', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const key = c.req.param('key') as keyof UserSecrets;
  if (!SECRET_KEYS.includes(key)) {
    return c.json({ error: 'Invalid secret key' }, 400);
  }

  try {
    const secretsKey = `${user.r2Prefix}/secrets.json`;

    // Load existing secrets
    let secrets: UserSecrets = {};
    const existing = await c.env.MOLTBOT_BUCKET.get(secretsKey);
    if (existing) {
      secrets = JSON.parse(await existing.text());
    }

    // Delete the specific key
    delete secrets[key];

    // Save to R2
    await c.env.MOLTBOT_BUCKET.put(secretsKey, JSON.stringify(secrets, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    return c.json({
      success: true,
      message: `${key} deleted. Restart the gateway to apply changes.`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// =============================================================================
// Super Admin: Debug other users (requires ADMIN_USER_IDS env var)
// =============================================================================

function isAdmin(userId: string, env: { ADMIN_USER_IDS?: string }): boolean {
  const adminIds = env.ADMIN_USER_IDS?.split(',').map(id => id.trim()) || [];
  return adminIds.includes(userId);
}

// GET /api/admin/users - List all users from R2
adminApi.get('/users', async (c) => {
  const user = c.get('user');
  if (!user || !isAdmin(user.id, c.env)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  try {
    // List all objects under users/ prefix
    const listed = await c.env.MOLTBOT_BUCKET.list({ prefix: 'users/' });

    // Extract unique user IDs from paths like users/{userId}/secrets.json
    const userIds = new Set<string>();
    for (const obj of listed.objects) {
      const match = obj.key.match(/^users\/([^/]+)\//);
      if (match) {
        userIds.add(match[1]);
      }
    }

    return c.json({
      count: userIds.size,
      users: Array.from(userIds).map(id => ({
        id,
        sandboxName: `openclaw-${id}`,
      })),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/users/:userId/debug - Debug another user's sandbox
adminApi.get('/users/:userId/debug', async (c) => {
  const user = c.get('user');
  if (!user || !isAdmin(user.id, c.env)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const targetUserId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');

  // Get target user's sandbox
  const targetSandbox = getSandbox(c.env.Sandbox, `openclaw-${targetUserId}`, { keepAlive: true });

  try {
    const processes = await targetSandbox.listProcesses();

    const processData = await Promise.all(processes.map(async p => {
      const data: Record<string, unknown> = {
        id: p.id,
        command: p.command,
        status: p.status,
        startTime: p.startTime?.toISOString(),
        exitCode: p.exitCode,
      };

      // Get logs for failed/completed processes
      if (p.status === 'failed' || p.status === 'completed' || p.command.includes('start-moltbot')) {
        try {
          const logs = await p.getLogs();
          data.stdout = (logs.stdout || '').slice(-2000); // Last 2000 chars
          data.stderr = (logs.stderr || '').slice(-2000);
        } catch {
          data.logs_error = 'Failed to retrieve logs';
        }
      }

      return data;
    }));

    // Sort: running first, then by start time
    processData.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return 0;
    });

    return c.json({
      targetUser: targetUserId,
      sandboxName: `openclaw-${targetUserId}`,
      processCount: processes.length,
      processes: processData,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/users/:userId/reset - Reset another user's container
adminApi.post('/users/:userId/reset', async (c) => {
  const user = c.get('user');
  if (!user || !isAdmin(user.id, c.env)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const targetUserId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const { ensureMoltbotGateway } = await import('../gateway');

  const targetSandbox = getSandbox(c.env.Sandbox, `openclaw-${targetUserId}`, { keepAlive: true });

  try {
    // Kill all processes
    const processes = await targetSandbox.listProcesses();
    for (const proc of processes) {
      try { await proc.kill(); } catch (e) { /* ignore */ }
    }

    await new Promise(r => setTimeout(r, 2000));

    // Clear locks
    try {
      await targetSandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null');
    } catch (e) { /* ignore */ }

    // Restart gateway
    const bootPromise = ensureMoltbotGateway(targetSandbox, c.env, targetUserId).catch(() => {});
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: 'Container reset initiated',
      targetUser: targetUserId,
      sandboxName: `openclaw-${targetUserId}`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/users - List all users with active sandboxes (admin only, or dev mode)
adminApi.get('/users', async (c) => {
  // Allow in DEV_MODE or with admin access
  const isDevMode = c.env.DEV_MODE === 'true';
  const isAdmin = c.get('user')?.id && c.env.ADMIN_USER_IDS?.split(',').includes(c.get('user')!.id);
  if (!isDevMode && !isAdmin) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  // List R2 storage for user data
  try {
    const bucket = c.env.MOLTBOT_BUCKET;
    const users: Array<{ id: string; username?: string; full_name?: string; created_at?: string }> = [];
    
    // Try to list objects with users/ prefix
    const listResult = await bucket.list({ prefix: 'users/' });
    const userIds = new Set<string>();
    
    for (const obj of listResult.objects || []) {
      const match = obj.key.match(/^users\/([^/]+)/);
      if (match) {
        userIds.add(match[1]);
      }
    }
    
    return c.json({
      users: Array.from(userIds).map(id => ({ id })),
      count: userIds.size,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// =============================================================================
// Platform Dashboard & Issues (Admin only)
// =============================================================================

// GET /api/admin/dashboard - Platform health dashboard
adminApi.get('/dashboard', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  try {
    // Get health states
    const healthStates = getAllHealthStates();
    const healthSummary = {
      totalTracked: healthStates.size,
      healthy: 0,
      unhealthy: 0,
      recentRestarts: 0,
    };

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    for (const [_userId, state] of healthStates) {
      if (state.consecutiveFailures === 0) {
        healthSummary.healthy++;
      } else {
        healthSummary.unhealthy++;
      }
      if (state.lastRestart && new Date(state.lastRestart).getTime() > oneHourAgo) {
        healthSummary.recentRestarts++;
      }
    }

    // Get issue counts from D1 (if available)
    let issueCounts: Record<string, { total: number; unresolved: number }> = {};
    let unresolvedIssues: Array<unknown> = [];
    if (c.env.PLATFORM_DB) {
      issueCounts = await getIssueCounts(c.env.PLATFORM_DB);
      unresolvedIssues = await getUnresolvedIssues(c.env.PLATFORM_DB, { limit: 10 });
    }

    // Get recent events
    const recentEvents = getRecentEvents(20);

    return c.json({
      health: healthSummary,
      issues: {
        counts: issueCounts,
        recentUnresolved: unresolvedIssues,
      },
      recentEvents,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/issues - List platform issues
adminApi.get('/issues', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  if (!c.env.PLATFORM_DB) {
    return c.json({ error: 'D1 database not configured' }, 503);
  }

  const resolved = c.req.query('resolved');
  const userId = c.req.query('user_id');
  const type = c.req.query('type');
  const limit = parseInt(c.req.query('limit') || '50', 10);

  try {
    let issues;
    if (resolved === 'false') {
      issues = await getUnresolvedIssues(c.env.PLATFORM_DB, {
        limit,
        userId: userId || undefined,
        type: type as any,
      });
    } else {
      issues = await getRecentIssues(c.env.PLATFORM_DB, {
        limit,
        userId: userId || undefined,
      });
    }

    return c.json({ issues, count: issues.length });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/issues/:id - Get a specific issue
adminApi.get('/issues/:id', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  if (!c.env.PLATFORM_DB) {
    return c.json({ error: 'D1 database not configured' }, 503);
  }

  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Invalid issue ID' }, 400);
  }

  try {
    const issue = await getIssue(c.env.PLATFORM_DB, id);
    if (!issue) {
      return c.json({ error: 'Issue not found' }, 404);
    }
    return c.json({ issue });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/issues/:id/resolve - Resolve an issue
adminApi.post('/issues/:id/resolve', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  if (!c.env.PLATFORM_DB) {
    return c.json({ error: 'D1 database not configured' }, 503);
  }

  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Invalid issue ID' }, 400);
  }

  const user = c.get('user');
  const resolvedBy = user?.id || 'admin';

  try {
    const success = await resolveIssue(c.env.PLATFORM_DB, id, resolvedBy);
    if (!success) {
      return c.json({ error: 'Failed to resolve issue' }, 500);
    }
    return c.json({ success: true, issueId: id, resolvedBy });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/issues - Create a new issue (for testing/manual logging)
adminApi.post('/issues', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  if (!c.env.PLATFORM_DB) {
    return c.json({ error: 'D1 database not configured' }, 503);
  }

  try {
    const body = await c.req.json();
    const { type, severity, userId, message, details } = body;

    if (!type || !severity || !message) {
      return c.json({ error: 'Missing required fields: type, severity, message' }, 400);
    }

    const issueId = await createIssue(c.env.PLATFORM_DB, {
      type,
      severity,
      userId,
      message,
      details,
    });

    if (!issueId) {
      return c.json({ error: 'Failed to create issue' }, 500);
    }

    return c.json({ success: true, issueId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/issues/cleanup - Clean up old resolved issues
adminApi.post('/issues/cleanup', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  if (!c.env.PLATFORM_DB) {
    return c.json({ error: 'D1 database not configured' }, 503);
  }

  const days = parseInt(c.req.query('days') || '30', 10);

  try {
    const deleted = await cleanupOldIssues(c.env.PLATFORM_DB, days);
    return c.json({ success: true, deleted, olderThanDays: days });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/sync-history/:userId - Get sync history for a user
adminApi.get('/sync-history/:userId', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const userId = c.req.param('userId');
  const r2Prefix = `users/${userId}`;
  const results = getRecentSyncResults(r2Prefix);

  return c.json({
    userId,
    syncResults: results,
    count: results.length,
  });
});

// GET /api/gateway-token - Exchange JWT for gateway token (authenticated users only)
// The frontend calls this to get the token needed to connect to their gateway
api.get('/gateway-token', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const masterToken = getGatewayMasterToken(c.env);
  if (!masterToken) {
    return c.json({ error: 'Gateway token not configured' }, 500);
  }

  // Derive the per-user gateway token
  const gatewayToken = await deriveUserGatewayToken(masterToken, user.id);

  return c.json({
    token: gatewayToken,
    userId: user.id,
  });
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
