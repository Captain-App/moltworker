import { Hono } from 'hono';
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { AppEnv, MoltbotEnv } from '../types';
import { MOLTBOT_PORT, HEALTH_CHECK_CONFIG } from '../config';
import { findExistingMoltbotProcess, checkHealth, getHealthState, getRecentSyncResults } from '../gateway';
import { verifySupabaseJWT } from '../../platform/auth/supabase-jwt';

/**
 * Build sandbox options based on environment configuration.
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
}

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Enhanced health check for gateway status
// Checks the user's sandbox if authenticated, otherwise default sandbox
publicRoutes.get('/api/status', async (c) => {
  let sandbox = c.get('sandbox');
  let userId: string | undefined;

  // Try to get authenticated user's sandbox
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '') ||
                  c.req.raw.headers.get('cookie')?.match(/sb-access-token=([^;]+)/)?.[1];

    if (token && c.env.SUPABASE_JWT_SECRET) {
      const decoded = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET);
      if (decoded) {
        userId = decoded.sub;
        const sandboxName = `openclaw-${userId}`;
        const options = buildSandboxOptions(c.env);
        sandbox = getSandbox(c.env.Sandbox, sandboxName, options);
        console.log(`[API/status] Using authenticated user sandbox: ${sandboxName}`);
      }
    }
  } catch (err) {
    console.log('[API/status] Auth check failed, using default sandbox:', err);
  }

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({
        ok: false,
        status: 'not_running',
        userId: userId?.slice(0, 8),
      });
    }

    // Run full health check if userId is available
    if (userId) {
      const healthResult = await checkHealth(sandbox, userId, HEALTH_CHECK_CONFIG);
      const healthState = getHealthState(userId);
      const recentSyncs = getRecentSyncResults(`users/${userId}`);

      return c.json({
        ok: healthResult.healthy,
        status: healthResult.healthy ? 'healthy' : 'unhealthy',
        processId: process.id,
        processStatus: process.status,
        checks: healthResult.checks,
        consecutiveFailures: healthResult.consecutiveFailures,
        uptimeSeconds: healthResult.uptimeSeconds,
        memoryUsageMb: healthResult.memoryUsageMb,
        lastHealthy: healthState?.lastHealthy,
        lastRestart: healthState?.lastRestart,
        recentSyncs: recentSyncs.slice(0, 3).map(s => ({
          success: s.success,
          lastSync: s.lastSync,
          fileCount: s.fileCount,
          durationMs: s.durationMs,
          error: s.error,
        })),
        userId: userId.slice(0, 8),
      });
    }

    // Basic check for unauthenticated requests
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({
        ok: true,
        status: 'running',
        processId: process.id,
        processStatus: process.status,
      });
    } catch {
      return c.json({
        ok: false,
        status: 'not_responding',
        processId: process.id,
        processStatus: process.status,
      });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// NOTE: /assets/* is NOT handled here - those requests go to the container proxy
// The auth middleware bypasses auth for /assets/* paths so they can be proxied

// GET /api/super/users/:userId/inspect - TEMPORARY: Inspect any user's sandbox (no auth)
// TODO: Remove this endpoint after debugging is complete
publicRoutes.get('/api/super/users/:userId/inspect', async (c) => {
  const userId = c.req.param('userId');
  const sandboxName = `openclaw-${userId}`;

  try {
    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);

    // Get processes
    const processes = await sandbox.listProcesses();
    const processData = await Promise.all(processes.map(async p => {
      const data: Record<string, unknown> = {
        id: p.id,
        command: p.command,
        status: p.status,
        startTime: p.startTime?.toISOString(),
        exitCode: p.exitCode,
      };

      // Get logs for gateway process
      if (p.command.includes('start-moltbot') || p.status === 'failed') {
        try {
          const logs = await p.getLogs();
          data.stdout = (logs.stdout || '').slice(-3000);
          data.stderr = (logs.stderr || '').slice(-3000);
        } catch {
          data.logs_error = 'Failed to get logs';
        }
      }

      return data;
    }));

    // Check R2 backup status
    let r2Status: any = { hasBackup: false };
    try {
      const listed = await c.env.MOLTBOT_BUCKET.list({ prefix: `users/${userId}/` });
      const files = listed.objects.map(o => o.key.replace(`users/${userId}/`, ''));
      r2Status = {
        hasBackup: files.length > 0,
        fileCount: files.length,
        files: files.slice(0, 20),
      };

      // Check last sync
      const syncMarker = await c.env.MOLTBOT_BUCKET.get(`users/${userId}/.last-sync`);
      if (syncMarker) {
        r2Status.lastSync = await syncMarker.text();
      }

      // Check config/personality
      const configFile = await c.env.MOLTBOT_BUCKET.get(`users/${userId}/clawdbot/config.json`);
      if (configFile) {
        try {
          const config = JSON.parse(await configFile.text());
          r2Status.personality = {
            name: config.name,
            personalityPreview: config.personality?.slice(0, 200),
            model: config.model,
          };
        } catch { /* ignore */ }
      }

      // Check secrets
      const secretsFile = await c.env.MOLTBOT_BUCKET.get(`users/${userId}/secrets.json`);
      if (secretsFile) {
        try {
          const secrets = JSON.parse(await secretsFile.text());
          r2Status.configuredSecrets = Object.keys(secrets).filter(k => !!secrets[k]);
        } catch { /* ignore */ }
      }
    } catch (e) {
      r2Status.error = e instanceof Error ? e.message : 'Unknown error';
    }

    return c.json({
      userId,
      sandboxName,
      processCount: processes.length,
      processes: processData,
      r2: r2Status,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
      sandboxName,
    }, 500);
  }
});

// GET /api/super/users/:userId/files - TEMPORARY: Check file system in user's container
// Add ?sync=1 to also run backup
publicRoutes.get('/api/super/users/:userId/files', async (c) => {
  const userId = c.req.param('userId');
  const sandboxName = `openclaw-${userId}`;
  const doSync = c.req.query('sync') === '1';
  const mountPath = `/data/openclaw/users/${userId}`;

  try {
    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);

    // Run ls commands to check file system state
    let commands = [
      'ls -la /root/.clawdbot/ 2>&1 | head -20',
      'cat /root/.clawdbot/clawdbot.json 2>&1 | head -50',
      'mount | grep s3fs',
      'ls -la /data/openclaw/ 2>&1 | head -10',
    ];

    // If sync requested, add sync commands
    if (doSync) {
      commands = commands.concat([
        `mkdir -p ${mountPath}/clawdbot ${mountPath}/skills`,
        `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${mountPath}/clawdbot/ 2>&1`,
        `date -Iseconds > ${mountPath}/.last-sync`,
        `cat ${mountPath}/.last-sync`,
        `ls -la ${mountPath}/ 2>&1`,
      ]);
    }

    const results: Record<string, string> = {};

    for (const cmd of commands) {
      try {
        const proc = await sandbox.startProcess(cmd);
        let attempts = 0;
        while (proc.status === 'running' && attempts < 20) {
          await new Promise(r => setTimeout(r, 200));
          attempts++;
        }
        const logs = await proc.getLogs();
        results[cmd] = logs.stdout || logs.stderr || '(no output)';
      } catch (e) {
        results[cmd] = `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
      }
    }

    return c.json({
      userId,
      sandboxName,
      files: results,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

// GET /api/super/users/:userId/sync - TEMPORARY: Force sync a user's container (no auth)
publicRoutes.get('/api/super/users/:userId/sync', async (c) => {
  const userId = c.req.param('userId');
  const sandboxName = `openclaw-${userId}`;
  const mountPath = `/data/openclaw/users/${userId}`;

  try {
    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);

    // Run sync commands manually with full debug output
    const commands = [
      // Check source exists
      'test -f /root/.clawdbot/clawdbot.json && echo "source_ok" || echo "source_missing"',
      // Create target directory
      `mkdir -p ${mountPath}/clawdbot ${mountPath}/skills`,
      // Run rsync with verbose
      `rsync -rv --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${mountPath}/clawdbot/ 2>&1`,
      // Write timestamp
      `date -Iseconds > ${mountPath}/.last-sync && cat ${mountPath}/.last-sync`,
      // Verify
      `ls -la ${mountPath}/`,
    ];

    const results: Record<string, string> = {};

    for (const cmd of commands) {
      try {
        const proc = await sandbox.startProcess(cmd);
        let attempts = 0;
        while (proc.status === 'running' && attempts < 30) {
          await new Promise(r => setTimeout(r, 500));
          attempts++;
        }
        const logs = await proc.getLogs();
        results[cmd.slice(0, 60)] = (logs.stdout || '') + (logs.stderr || '');
      } catch (e) {
        results[cmd.slice(0, 60)] = `Error: ${e instanceof Error ? e.message : 'Unknown'}`;
      }
    }

    // Check if sync was successful
    const lastSync = results[`date -Iseconds > ${mountPath}/.last-sync && cat ${mountPath}`];
    const success = lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/);

    return c.json({
      success: !!success,
      userId,
      sandboxName,
      lastSync: success ? lastSync.trim() : null,
      debug: results,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

// POST /api/super/users/:userId/exec - Run a command in the user's container
publicRoutes.post('/api/super/users/:userId/exec', async (c) => {
  const userId = c.req.param('userId');
  const sandboxName = `openclaw-${userId}`;

  try {
    const body = await c.req.json();
    const command = body.command;
    if (!command) {
      return c.json({ error: 'Missing command' }, 400);
    }

    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);

    const proc = await sandbox.startProcess(command);
    let attempts = 0;
    while (proc.status === 'running' && attempts < 60) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
    const logs = await proc.getLogs();

    return c.json({
      userId,
      command,
      status: proc.status,
      exitCode: proc.exitCode,
      stdout: logs.stdout,
      stderr: logs.stderr,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

// GET /api/super/users/:userId/restart - Kill gateway and restart
publicRoutes.get('/api/super/users/:userId/restart', async (c) => {
  const userId = c.req.param('userId');
  const sandboxName = `openclaw-${userId}`;

  try {
    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);

    // Kill all processes
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      try { await proc.kill(); } catch (e) { /* ignore */ }
    }

    await new Promise(r => setTimeout(r, 2000));

    // Clear locks
    await sandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null');
    await new Promise(r => setTimeout(r, 500));

    // Run doctor --fix first
    const doctorProc = await sandbox.startProcess('clawdbot doctor --fix --yes 2>&1');
    let attempts = 0;
    while (doctorProc.status === 'running' && attempts < 30) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
    const doctorLogs = await doctorProc.getLogs();

    // Start gateway
    const { ensureMoltbotGateway } = await import('../gateway');
    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch((e) => console.error('Gateway start error:', e));
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      userId,
      sandboxName,
      doctor: doctorLogs.stdout || doctorLogs.stderr,
      message: 'Gateway restarting...',
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

// GET /api/super/users/:userId/fix-config - Fix invalid config keys and restart gateway
publicRoutes.get('/api/super/users/:userId/fix-config', async (c) => {
  const userId = c.req.param('userId');
  const sandboxName = `openclaw-${userId}`;

  try {
    const options = buildSandboxOptions(c.env);
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);

    // Fix the config using sed (more reliable than node in container)
    const sedCommands = [
      // Change groupPolicy from "open" to "allowlist"
      `sed -i 's/"groupPolicy": "open"/"groupPolicy": "allowlist"/g' /root/.clawdbot/clawdbot.json`,
      // Remove dmPolicy line
      `sed -i '/"dmPolicy"/d' /root/.clawdbot/clawdbot.json`,
      // Remove enabled line from telegram section (be careful not to remove from plugins)
      `sed -i '/"telegram":/,/}/{/"enabled": true/d}' /root/.clawdbot/clawdbot.json`,
      // Fix botToken - extract just the token part (format: digits:alphanumeric)
      `sed -i 's/"botToken": "[^"]*\\([0-9]\\+:[A-Za-z0-9_-]\\+\\)"/"botToken": "\\1"/g' /root/.clawdbot/clawdbot.json`,
    ];

    let results: string[] = [];
    for (const cmd of sedCommands) {
      try {
        const proc = await sandbox.startProcess(cmd);
        let attempts = 0;
        while (proc.status === 'running' && attempts < 10) {
          await new Promise(r => setTimeout(r, 200));
          attempts++;
        }
        const logs = await proc.getLogs();
        results.push(logs.stdout || logs.stderr || 'ok');
      } catch (e) {
        results.push('error: ' + (e instanceof Error ? e.message : 'unknown'));
      }
    }

    // Verify the fix
    const verifyProc = await sandbox.startProcess('grep -E "(groupPolicy|botToken)" /root/.clawdbot/clawdbot.json');
    let attempts = 0;
    while (verifyProc.status === 'running' && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    const verifyLogs = await verifyProc.getLogs();

    return c.json({
      userId,
      sandboxName,
      fixed: true,
      sedResults: results,
      verify: verifyLogs.stdout,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      userId,
    }, 500);
  }
});

export { publicRoutes };
