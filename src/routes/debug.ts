import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { findExistingMoltbotProcess, getGatewayMasterToken } from '../gateway';
import { getRecentSyncResults, getConsecutiveSyncFailures } from '../gateway/sync';

/**
 * Debug routes for inspecting container state
 * Note: These routes should be protected by Cloudflare Access middleware
 * when mounted in the main app
 */
const debug = new Hono<AppEnv>();

// GET /debug/admin/ping - Simple ping that doesn't touch sandbox (must be before :userId routes)
debug.get('/admin/ping', async (c) => {
  return c.json({ pong: true, timestamp: new Date().toISOString() });
});

// GET /debug/admin/users/:userId/ps - List processes with commands
debug.get('/admin/users/:userId/ps', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: false });

  try {
    const processes = await sandbox.listProcesses();
    const procs = await Promise.all(processes.map(async (p: any) => {
      let logs = { stdout: '', stderr: '' };
      try {
        logs = await p.getLogs();
      } catch {}
      return {
        id: p.id,
        command: p.command?.substring(0, 100),
        status: p.status,
        stdout: logs.stdout?.substring(0, 500),
        stderr: logs.stderr?.substring(0, 500),
      };
    }));
    return c.json({ userId, processCount: procs.length, processes: procs });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// GET /debug/version - Returns version info from inside the container
debug.get('/version', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Get moltbot version (CLI is still named clawdbot until upstream renames)
    const versionProcess = await sandbox.startProcess('clawdbot --version');
    await new Promise(resolve => setTimeout(resolve, 500));
    const versionLogs = await versionProcess.getLogs();
    const moltbotVersion = (versionLogs.stdout || versionLogs.stderr || '').trim();

    // Get node version
    const nodeProcess = await sandbox.startProcess('node --version');
    await new Promise(resolve => setTimeout(resolve, 500));
    const nodeLogs = await nodeProcess.getLogs();
    const nodeVersion = (nodeLogs.stdout || '').trim();

    return c.json({
      moltbot_version: moltbotVersion,
      node_version: nodeVersion,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', message: `Failed to get version info: ${errorMessage}` }, 500);
  }
});

// GET /debug/processes - List all processes with optional logs
debug.get('/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const includeLogs = c.req.query('logs') === 'true';

    const processData = await Promise.all(processes.map(async p => {
      const data: Record<string, unknown> = {
        id: p.id,
        command: p.command,
        status: p.status,
        startTime: p.startTime?.toISOString(),
        endTime: p.endTime?.toISOString(),
        exitCode: p.exitCode,
      };

      if (includeLogs) {
        try {
          const logs = await p.getLogs();
          data.stdout = logs.stdout || '';
          data.stderr = logs.stderr || '';
        } catch {
          data.logs_error = 'Failed to retrieve logs';
        }
      }

      return data;
    }));

    // Sort by status (running first, then starting, completed, failed)
    // Within each status, sort by startTime descending (newest first)
    const statusOrder: Record<string, number> = {
      'running': 0,
      'starting': 1,
      'completed': 2,
      'failed': 3,
    };
    
    processData.sort((a, b) => {
      const statusA = statusOrder[a.status as string] ?? 99;
      const statusB = statusOrder[b.status as string] ?? 99;
      if (statusA !== statusB) {
        return statusA - statusB;
      }
      // Within same status, sort by startTime descending
      const timeA = a.startTime as string || '';
      const timeB = b.startTime as string || '';
      return timeB.localeCompare(timeA);
    });

    return c.json({ count: processes.length, processes: processData });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/gateway-api - Probe the moltbot gateway HTTP API
debug.get('/gateway-api', async (c) => {
  const sandbox = c.get('sandbox');
  const path = c.req.query('path') || '/';
  const MOLTBOT_PORT = 18789;
  
  try {
    const url = `http://localhost:${MOLTBOT_PORT}${path}`;
    const response = await sandbox.containerFetch(new Request(url), MOLTBOT_PORT);
    const contentType = response.headers.get('content-type') || '';
    
    let body: string | object;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }
    
    return c.json({
      path,
      status: response.status,
      contentType,
      body,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, path }, 500);
  }
});

// GET /debug/cli - Test moltbot CLI commands (CLI is still named clawdbot)
debug.get('/cli', async (c) => {
  const sandbox = c.get('sandbox');
  const cmd = c.req.query('cmd') || 'clawdbot --help';
  
  try {
    const proc = await sandbox.startProcess(cmd);
    
    // Wait longer for command to complete
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 500));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    return c.json({
      command: cmd,
      status: proc.status,
      exitCode: proc.exitCode,
      attempts,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, command: cmd }, 500);
  }
});

// GET /debug/admin/users - List all users (admin bypass)
debug.get('/admin/users', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);
  const hasSecret = !!adminSecret;
  const hasExpected = !!expectedSecret;
  const matches = adminSecret === expectedSecret;
  
  if (!adminSecret || adminSecret !== expectedSecret) {
    return c.json({ 
      error: 'Admin access required', 
      hasSecret, 
      hasExpected, 
      matches,
      secretPrefix: adminSecret ? adminSecret.slice(0, 20) : null,
      expectedPrefix: expectedSecret ? expectedSecret.slice(0, 20) : null,
    }, 403);
  }

  try {
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
    return c.json({ users: profiles, count: profiles.length });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/admin/users/search - Search users by email (from auth.users)
debug.get('/admin/users/search', async (c) => {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);
  
  if (!adminSecret || adminSecret !== expectedSecret) {
    return c.json({ error: 'Admin access required' }, 403);
  }

  const email = c.req.query('email');
  if (!email) {
    return c.json({ error: 'Missing ?email= query parameter' }, 400);
  }

  try {
    const supabaseUrl = c.env.SUPABASE_URL || 'https://kjbcjkihxskuwwfdqklt.supabase.co';
    const serviceRoleKey = c.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!serviceRoleKey) {
      return c.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);
    }

    // Query auth.users via admin API (supports email search)
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`, {
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
    });

    if (!response.ok) {
      return c.json({ error: 'Failed to fetch users', status: response.status }, 500);
    }

    const data = await response.json() as { users: Array<{ id: string; email: string; created_at: string; user_metadata?: { full_name?: string } }> };
    
    // Filter by email (case-insensitive partial match)
    const searchTerm = email.toLowerCase();
    const matches = data.users.filter(u => 
      u.email?.toLowerCase().includes(searchTerm)
    ).map(u => ({
      id: u.id,
      email: u.email,
      fullName: u.user_metadata?.full_name || null,
      createdAt: u.created_at,
    }));

    return c.json({ query: email, matches, count: matches.length });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /debug/admin/users/:userId/impersonate - Get a JWT for the user to call gateway API
debug.post('/admin/users/:userId/impersonate', async (c) => {
  const userId = c.req.param('userId');
  const supabaseUrl = c.env.SUPABASE_URL || 'https://kjbcjkihxskuwwfdqklt.supabase.co';
  const serviceRoleKey = c.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    return c.json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' }, 500);
  }

  try {
    // Use Supabase Admin API to generate a token for the user
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return c.json({ error: 'Failed to get user', status: response.status, details: text }, 500);
    }

    const user = await response.json() as any;

    // Generate a token using generate_link endpoint
    const linkResponse = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'magiclink',
        email: user.email,
      }),
    });

    if (!linkResponse.ok) {
      const text = await linkResponse.text();
      return c.json({ error: 'Failed to generate link', status: linkResponse.status, details: text }, 500);
    }

    const linkData = await linkResponse.json() as any;

    return c.json({
      userId,
      email: user.email,
      accessToken: linkData.access_token,
      tokenType: linkData.token_type,
      expiresIn: linkData.expires_in,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/admin/users/:userId - Get user details with restart capability
debug.get('/admin/users/:userId', async (c) => {
  // Temporarily bypass auth for emergency debugging
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  
  try {
    // Check sandbox status
    const sandboxName = `openclaw-${userId}`;
    let sandboxStatus: any = { name: sandboxName, active: false };
    let logs: string[] = [];
    
    try {
      const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: false });
      const processes = await sandbox.listProcesses();
      sandboxStatus = {
        name: sandboxName,
        active: processes.length > 0,
        processCount: processes.length,
        failedStarts: processes.filter((p: any) => p.command?.includes('start-moltbot') && p.status === 'failed').length,
      };
      
      // Get logs from most recent failed start-moltbot process
      const failedStart = processes.find((p: any) => p.command?.includes('start-moltbot') && p.status === 'failed');
      if (failedStart) {
        const proc = processes.find((p: any) => p.id === failedStart.id);
        if (proc) {
          const procLogs = await proc.getLogs();
          logs = [procLogs.stdout || '', procLogs.stderr || ''].filter(Boolean);
        }
      }
    } catch (e) {
      sandboxStatus.error = 'sandbox_not_found';
    }

    return c.json({
      userId,
      sandbox: sandboxStatus,
      recentLogs: logs.slice(0, 2),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /debug/admin/users/:userId/restart - Restart user's container
// EMERGENCY BYPASS: Auth disabled for operational recovery
debug.post('/admin/users/:userId/restart', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const { ensureMoltbotGateway } = await import('../gateway');
  
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: true });

  try {
    // Kill ALL processes including stale gateway
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      try { 
        await proc.kill(); 
        console.log(`[RESTART] Killed process ${proc.id}`);
      } catch (e) { /* ignore */ }
    }

    // Wait for processes to terminate
    await new Promise(r => setTimeout(r, 3000));

    // NOTE: Removed aggressive cleanup startProcess calls - they were accumulating
    // The startup script (start-moltbot.sh) handles its own lock cleanup internally

    // Fix malformed Telegram token in R2 secrets before restart
    try {
      const secretsKey = `users/${userId}/secrets.json`;
      const existing = await c.env.MOLTBOT_BUCKET.get(secretsKey);
      if (existing) {
        const secrets = JSON.parse(await existing.text()) as Record<string, string>;
        if (secrets.TELEGRAM_BOT_TOKEN) {
          const tokenMatch = secrets.TELEGRAM_BOT_TOKEN.match(/(\d+:[A-Za-z0-9_-]+)/);
          if (tokenMatch && tokenMatch[1] !== secrets.TELEGRAM_BOT_TOKEN) {
            secrets.TELEGRAM_BOT_TOKEN = tokenMatch[1];
            await c.env.MOLTBOT_BUCKET.put(secretsKey, JSON.stringify(secrets, null, 2), {
              httpMetadata: { contentType: 'application/json' },
            });
            console.log(`[RESTART] Fixed malformed Telegram token for ${userId}`);
          }
        }
      }
    } catch (e) {
      console.log(`[RESTART] Token fix skipped: ${e}`);
    }

    // Restart gateway
    console.log(`[RESTART] Starting fresh gateway for ${userId}`);
    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch((err) => {
      console.error(`[RESTART] Gateway start failed: ${err}`);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: 'Container restart initiated with full cleanup',
      userId,
      sandboxName,
      killedProcesses: processes.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /debug/admin/users/:userId/kill-zombie - Kill all processes in sandbox
// Uses sandbox API only - no shell commands to avoid process accumulation
debug.post('/admin/users/:userId/kill-zombie', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: true });

  try {
    // Get all processes and kill them via sandbox API
    const processes = await sandbox.listProcesses();
    const killed: string[] = [];
    
    for (const proc of processes) {
      try {
        await proc.kill();
        killed.push(proc.id);
      } catch (e) {
        // Process may already be dead, that's fine
      }
    }

    // NOTE: Removed shell-based cleanup (fuser, pkill, rm) - they were causing process accumulation
    // The startup script handles its own lock cleanup internally

    return c.json({
      success: true,
      userId,
      processesFound: processes.length,
      killed,
      message: 'Processes killed via sandbox API. Gateway will handle lock cleanup on restart.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /debug/admin/users/:userId/destroy - Force destroy a stuck sandbox
// Calls destroy() directly without trying to list processes first
debug.post('/admin/users/:userId/destroy', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;

  try {
    const sandbox = getSandbox(c.env.Sandbox, sandboxName, {
      keepAlive: false,
      containerTimeouts: {
        instanceGetTimeoutMS: 5000,
        portReadyTimeoutMS: 5000,
      },
    });

    // Race destroy against a timeout
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Destroy timed out after 10s')), 10000)
    );

    await Promise.race([sandbox.destroy(), timeoutPromise]);

    return c.json({
      success: true,
      userId,
      sandboxName,
      message: 'Sandbox destroyed. Will recreate on next request.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, note: 'Sandbox may be stuck at infrastructure level' }, 500);
  }
});

// POST /debug/admin/users/:userId/add-group - Add group chat access
// Adds a Telegram group ID to the user's allowed chats
debug.post('/admin/users/:userId/add-group', async (c) => {
  const userId = c.req.param('userId');
  const body = await c.req.json().catch(() => ({}));
  const groupId = body.groupId;
  
  if (!groupId) {
    return c.json({ error: 'groupId required in body' }, 400);
  }

  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: false });

  try {
    // Read current config
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await new Promise(r => setTimeout(r, 1000));
    const logs = await configProc.getLogs();
    const configStr = logs.stdout || '{}';
    let config: any = {};
    try {
      config = JSON.parse(configStr);
    } catch (e) {
      config = {};
    }

    // Add group to telegram allowFrom if not present
    if (!config.channels?.telegram?.allowFrom) {
      config.channels = config.channels || {};
      config.channels.telegram = config.channels.telegram || {};
      config.channels.telegram.allowFrom = config.channels.telegram.allowFrom || [];
    }
    
    if (!config.channels.telegram.allowFrom.includes(groupId)) {
      config.channels.telegram.allowFrom.push(groupId);
    }

    // Write updated config
    const newConfigStr = JSON.stringify(config, null, 2);
    await sandbox.startProcess(`echo '${newConfigStr}' > /root/.clawdbot/clawdbot.json`);

    return c.json({
      success: true,
      userId,
      groupId,
      config: config.channels.telegram,
      message: 'Group added to allowed chats. Restart container to apply changes.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/logs - Returns container logs for debugging
debug.get('/logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processId = c.req.query('id');
    let process = null;

    if (processId) {
      const processes = await sandbox.listProcesses();
      process = processes.find(p => p.id === processId);
      if (!process) {
        return c.json({
          status: 'not_found',
          message: `Process ${processId} not found`,
          stdout: '',
          stderr: '',
        }, 404);
      }
    } else {
      process = await findExistingMoltbotProcess(sandbox);
      if (!process) {
        return c.json({
          status: 'no_process',
          message: 'No Moltbot process is currently running',
          stdout: '',
          stderr: '',
        });
      }
    }

    const logs = await process.getLogs();
    return c.json({
      status: 'ok',
      process_id: process.id,
      process_status: process.status,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      status: 'error',
      message: `Failed to get logs: ${errorMessage}`,
      stdout: '',
      stderr: '',
    }, 500);
  }
});

// GET /debug/ws-test - Interactive WebSocket debug page
debug.get('/ws-test', async (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WebSocket Debug</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; }
    #log { white-space: pre-wrap; background: #000; padding: 10px; height: 400px; overflow-y: auto; border: 1px solid #333; }
    button { margin: 5px; padding: 10px; }
    input { padding: 10px; width: 300px; }
    .error { color: #f00; }
    .sent { color: #0ff; }
    .received { color: #0f0; }
    .info { color: #ff0; }
  </style>
</head>
<body>
  <h1>WebSocket Debug Tool</h1>
  <div>
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
    <button id="clear">Clear Log</button>
  </div>
  <div style="margin: 10px 0;">
    <input id="message" placeholder="JSON message to send..." />
    <button id="send" disabled>Send</button>
  </div>
  <div style="margin: 10px 0;">
    <button id="sendConnect" disabled>Send Connect Frame</button>
  </div>
  <div id="log"></div>
  
  <script>
    const wsUrl = '${wsProtocol}://${host}/';
    let ws = null;
    
    const log = (msg, className = '') => {
      const logEl = document.getElementById('log');
      const time = new Date().toISOString().substr(11, 12);
      logEl.innerHTML += '<span class="' + className + '">[' + time + '] ' + msg + '</span>\\n';
      logEl.scrollTop = logEl.scrollHeight;
    };
    
    document.getElementById('connect').onclick = () => {
      log('Connecting to ' + wsUrl + '...', 'info');
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        log('Connected!', 'info');
        document.getElementById('connect').disabled = true;
        document.getElementById('disconnect').disabled = false;
        document.getElementById('send').disabled = false;
        document.getElementById('sendConnect').disabled = false;
      };
      
      ws.onmessage = (e) => {
        log('RECV: ' + e.data, 'received');
        try {
          const parsed = JSON.parse(e.data);
          log('  Parsed: ' + JSON.stringify(parsed, null, 2), 'received');
        } catch {}
      };
      
      ws.onerror = (e) => {
        log('ERROR: ' + JSON.stringify(e), 'error');
      };
      
      ws.onclose = (e) => {
        log('Closed: code=' + e.code + ' reason=' + e.reason, 'info');
        document.getElementById('connect').disabled = false;
        document.getElementById('disconnect').disabled = true;
        document.getElementById('send').disabled = true;
        document.getElementById('sendConnect').disabled = true;
        ws = null;
      };
    };
    
    document.getElementById('disconnect').onclick = () => {
      if (ws) ws.close();
    };
    
    document.getElementById('clear').onclick = () => {
      document.getElementById('log').innerHTML = '';
    };
    
    document.getElementById('send').onclick = () => {
      const msg = document.getElementById('message').value;
      if (ws && msg) {
        log('SEND: ' + msg, 'sent');
        ws.send(msg);
      }
    };
    
    document.getElementById('sendConnect').onclick = () => {
      if (!ws) return;
      const connectFrame = {
        type: 'req',
        id: 'debug-' + Date.now(),
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: 'debug-tool',
            displayName: 'Debug Tool',
            version: '1.0.0',
            mode: 'webchat',
            platform: 'web'
          },
          role: 'operator',
          scopes: []
        }
      };
      const msg = JSON.stringify(connectFrame);
      log('SEND Connect Frame: ' + msg, 'sent');
      ws.send(msg);
    };
    
    document.getElementById('message').onkeypress = (e) => {
      if (e.key === 'Enter') document.getElementById('send').click();
    };
  </script>
</body>
</html>`;
  
  return c.html(html);
});

// GET /debug/env - Show environment configuration (sanitized)
debug.get('/env', async (c) => {
  // Log all env keys for debugging
  const envKeys = Object.keys(c.env).sort();
  console.log('[DEBUG] Available env keys:', envKeys);
  console.log('[DEBUG] R2_ACCESS_KEY_ID exists:', 'R2_ACCESS_KEY_ID' in c.env);
  console.log('[DEBUG] R2_SECRET_ACCESS_KEY exists:', 'R2_SECRET_ACCESS_KEY' in c.env);
  
  return c.json({
    has_anthropic_key: !!c.env.ANTHROPIC_API_KEY,
    has_openai_key: !!c.env.OPENAI_API_KEY,
    has_gateway_token: !!getGatewayMasterToken(c.env),
    has_r2_access_key: !!c.env.R2_ACCESS_KEY_ID,
    has_r2_secret_key: !!c.env.R2_SECRET_ACCESS_KEY,
    has_cf_account_id: !!c.env.CF_ACCOUNT_ID,
    dev_mode: c.env.DEV_MODE,
    debug_routes: c.env.DEBUG_ROUTES,
    bind_mode: c.env.CLAWDBOT_BIND_MODE,
    cf_access_team_domain: c.env.CF_ACCESS_TEAM_DOMAIN,
    has_cf_access_aud: !!c.env.CF_ACCESS_AUD,
    // Debug: show first 4 chars of R2 secrets if they exist
    r2_key_preview: c.env.R2_ACCESS_KEY_ID ? c.env.R2_ACCESS_KEY_ID.substring(0, 4) + '...' : null,
    r2_secret_preview: c.env.R2_SECRET_ACCESS_KEY ? c.env.R2_SECRET_ACCESS_KEY.substring(0, 4) + '...' : null,
    // Show all available env keys
    all_env_keys: envKeys,
  });
});

// GET /debug/sync-status - Show R2 sync status for debugging backup/restore issues
debug.get('/sync-status', async (c) => {
  const sandbox = c.get('sandbox');
  const user = c.get('user');
  const userId = user?.id;

  try {
    const r2Prefix = userId ? `users/${userId}` : undefined;

    // Get in-memory sync results (from Worker cron)
    const recentResults = getRecentSyncResults(r2Prefix);
    const consecutiveFailures = getConsecutiveSyncFailures(r2Prefix);

    // Read .last-sync from container (local state)
    let localSyncInfo: { timestamp: string | null; error?: string } = { timestamp: null };
    try {
      const localProc = await sandbox.startProcess('cat /root/.clawdbot/.last-sync 2>/dev/null || echo "NOT_FOUND"');
      await new Promise(r => setTimeout(r, 1000));
      const localLogs = await localProc.getLogs();
      const content = (localLogs.stdout || '').trim();
      if (content && content !== 'NOT_FOUND') {
        localSyncInfo.timestamp = content;
      }
    } catch (err) {
      localSyncInfo.error = err instanceof Error ? err.message : 'Unknown error';
    }

    // Read .last-sync from R2 mount (backup state)
    let r2SyncInfo: { timestamp: string | null; error?: string } = { timestamp: null };
    const r2Path = userId ? `/data/openclaw/users/${userId}/.last-sync` : '/data/openclaw/.last-sync';
    try {
      const r2Proc = await sandbox.startProcess(`cat ${r2Path} 2>/dev/null || echo "NOT_FOUND"`);
      await new Promise(r => setTimeout(r, 1000));
      const r2Logs = await r2Proc.getLogs();
      const content = (r2Logs.stdout || '').trim();
      if (content && content !== 'NOT_FOUND') {
        r2SyncInfo.timestamp = content;
      }
    } catch (err) {
      r2SyncInfo.error = err instanceof Error ? err.message : 'Unknown error';
    }

    // Check if R2 is mounted
    let r2Mounted = false;
    try {
      const mountProc = await sandbox.startProcess('mountpoint -q /data/openclaw && echo "MOUNTED" || echo "NOT_MOUNTED"');
      await new Promise(r => setTimeout(r, 500));
      const mountLogs = await mountProc.getLogs();
      r2Mounted = (mountLogs.stdout || '').includes('MOUNTED');
    } catch {
      // Ignore
    }

    // Check if a sync is currently running
    let syncRunning = false;
    try {
      const syncProc = await sandbox.startProcess('pgrep -f "rsync.*/root/.clawdbot" >/dev/null && echo "RUNNING" || echo "NOT_RUNNING"');
      await new Promise(r => setTimeout(r, 500));
      const syncLogs = await syncProc.getLogs();
      syncRunning = (syncLogs.stdout || '').includes('RUNNING');
    } catch {
      // Ignore
    }

    // Check if clawdbot.json exists locally
    let hasLocalConfig = false;
    try {
      const configProc = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "EXISTS"');
      await new Promise(r => setTimeout(r, 500));
      const configLogs = await configProc.getLogs();
      hasLocalConfig = (configLogs.stdout || '').includes('EXISTS');
    } catch {
      // Ignore
    }

    return c.json({
      userId: userId || 'unknown',
      r2Prefix: r2Prefix || 'default',
      r2Mounted,
      syncCurrentlyRunning: syncRunning,
      hasLocalConfig,
      local: localSyncInfo,
      r2: r2SyncInfo,
      inMemoryResults: {
        consecutiveFailures,
        recentCount: recentResults.length,
        results: recentResults.slice(0, 5), // Last 5 results
      },
      diagnosis: diagnoseIssues(localSyncInfo, r2SyncInfo, r2Mounted, hasLocalConfig, consecutiveFailures),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Helper function to diagnose common sync issues
function diagnoseIssues(
  localSync: { timestamp: string | null; error?: string },
  r2Sync: { timestamp: string | null; error?: string },
  r2Mounted: boolean,
  hasLocalConfig: boolean,
  consecutiveFailures: number
): string[] {
  const issues: string[] = [];

  if (!r2Mounted) {
    issues.push('CRITICAL: R2 storage is not mounted. Backups cannot run.');
  }

  if (!hasLocalConfig) {
    issues.push('WARNING: No local clawdbot.json. Sync will be skipped to prevent wiping R2 backup.');
  }

  if (!r2Sync.timestamp && hasLocalConfig) {
    issues.push('WARNING: No R2 backup exists yet. First backup may not have run.');
  }

  if (consecutiveFailures >= 3) {
    issues.push(`ALERT: ${consecutiveFailures} consecutive sync failures. Check Worker logs.`);
  }

  if (localSync.timestamp && r2Sync.timestamp) {
    // Parse timestamps for comparison
    const localPart = localSync.timestamp.split('|')[1] || localSync.timestamp;
    const r2Part = r2Sync.timestamp.split('|')[1] || r2Sync.timestamp;

    try {
      const localTime = new Date(localPart).getTime();
      const r2Time = new Date(r2Part).getTime();
      const diffMinutes = Math.abs(localTime - r2Time) / 60000;

      if (diffMinutes > 10) {
        if (localTime > r2Time) {
          issues.push(`WARNING: Local is ${Math.round(diffMinutes)}min ahead of R2. Backup may be stale.`);
        } else {
          issues.push(`INFO: R2 is ${Math.round(diffMinutes)}min ahead of local. Restore may be pending.`);
        }
      }
    } catch {
      // Can't parse timestamps
    }
  }

  if (issues.length === 0) {
    issues.push('OK: No obvious issues detected.');
  }

  return issues;
}

// GET /debug/container-config - Read the moltbot config from inside the container
debug.get('/container-config', async (c) => {
  const sandbox = c.get('sandbox');
  
  try {
    const proc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';
    
    let config = null;
    try {
      config = JSON.parse(stdout);
    } catch {
      // Not valid JSON
    }
    
    return c.json({
      status: proc.status,
      exitCode: proc.exitCode,
      config,
      raw: config ? undefined : stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /debug/container-reset - FORCE reset: kill all processes and restart gateway
debug.post('/container-reset', async (c) => {
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
    
    // NOTE: Removed lock-clearing startProcess - startup script handles its own cleanup

    // Import ensureMoltbotGateway dynamically to avoid circular dependency
    const { ensureMoltbotGateway } = await import('../gateway');
    
    // Start fresh gateway
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
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

// POST /debug/admin/users/:userId/fix-telegram - Fix malformed Telegram token in container config
debug.post('/admin/users/:userId/fix-telegram', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: true });

  try {
    // Read current config
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await new Promise(r => setTimeout(r, 1000));
    const logs = await configProc.getLogs();
    const configStr = logs.stdout || '{}';

    let config: any = {};
    try {
      config = JSON.parse(configStr);
    } catch {
      return c.json({ error: 'Failed to parse config', raw: configStr }, 500);
    }

    // Extract clean Telegram token from malformed input
    const oldToken = config.channels?.telegram?.botToken || '';
    const tokenMatch = oldToken.match(/(\d+:[A-Za-z0-9_-]+)/);

    if (!tokenMatch) {
      return c.json({ error: 'No valid token pattern found', oldToken }, 400);
    }

    const cleanToken = tokenMatch[1];
    if (cleanToken === oldToken) {
      return c.json({ message: 'Token already clean', token: cleanToken });
    }

    // Update config with clean token
    config.channels.telegram.botToken = cleanToken;
    const newConfigStr = JSON.stringify(config, null, 2);

    // Write updated config - escape single quotes in JSON
    const escapedConfig = newConfigStr.replace(/'/g, "'\\''");
    await sandbox.startProcess(`echo '${escapedConfig}' > /root/.clawdbot/clawdbot.json`);
    await new Promise(r => setTimeout(r, 500));

    return c.json({
      success: true,
      userId,
      oldToken: oldToken.substring(0, 30) + '...',
      newToken: cleanToken,
      message: 'Telegram token fixed. Restart container to apply.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /debug/admin/users/:userId/fix-secrets - Fix malformed secrets
debug.post('/admin/users/:userId/fix-secrets', async (c) => {
  const userId = c.req.param('userId');
  const body = await c.req.json().catch(() => ({})) as Record<string, string>;

  try {
    const secretsKey = `users/${userId}/secrets.json`;

    // Load existing secrets
    let secrets: Record<string, string> = {};
    const existing = await c.env.MOLTBOT_BUCKET.get(secretsKey);
    if (existing) {
      secrets = JSON.parse(await existing.text());
    }

    // Update with provided values
    for (const [key, value] of Object.entries(body)) {
      if (value) {
        secrets[key] = value;
      }
    }

    // Save to R2
    await c.env.MOLTBOT_BUCKET.put(secretsKey, JSON.stringify(secrets, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    return c.json({
      success: true,
      userId,
      updatedKeys: Object.keys(body),
      message: 'Secrets updated. Restart container to apply.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/admin/users/:userId/r2-backup - Read user's R2 backup directly
debug.get('/admin/users/:userId/r2-backup', async (c) => {
  const userId = c.req.param('userId');

  try {
    // Read config from R2
    const configKey = `users/${userId}/clawdbot/clawdbot.json`;
    const configObj = await c.env.MOLTBOT_BUCKET.get(configKey);

    // Read last-sync marker
    const syncKey = `users/${userId}/.last-sync`;
    const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);

    // List all files for this user
    const listed = await c.env.MOLTBOT_BUCKET.list({ prefix: `users/${userId}/` });
    const files = listed.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }));

    let config = null;
    if (configObj) {
      try {
        config = JSON.parse(await configObj.text());
      } catch (e) {
        config = { error: 'Failed to parse', raw: await configObj.text() };
      }
    }

    return c.json({
      userId,
      hasBackup: !!configObj,
      lastSync: syncObj ? await syncObj.text() : null,
      files,
      config,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/admin/users/:userId/config - Read user's container config
debug.get('/admin/users/:userId/config', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: true });

  try {
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await new Promise(r => setTimeout(r, 1000));
    const logs = await configProc.getLogs();
    const configStr = logs.stdout || '{}';
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(configStr);
    } catch {
      return c.json({ error: 'Failed to parse config', raw: configStr }, 500);
    }

    return c.json({
      userId,
      sandboxName,
      config,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/admin/users/:userId/sync-status - Check sync status for a specific user
debug.get('/admin/users/:userId/sync-status', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;

  try {
    const r2Prefix = `users/${userId}`;

    // Get in-memory sync results
    const recentResults = getRecentSyncResults(r2Prefix);
    const consecutiveFailures = getConsecutiveSyncFailures(r2Prefix);

    // Read .last-sync directly from R2 bucket (doesn't require container)
    let r2SyncFromBucket: { timestamp: string | null; error?: string } = { timestamp: null };
    try {
      const syncKey = `users/${userId}/.last-sync`;
      const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
      if (syncObj) {
        r2SyncFromBucket.timestamp = await syncObj.text();
      }
    } catch (err) {
      r2SyncFromBucket.error = err instanceof Error ? err.message : 'Unknown error';
    }

    // Check if backup exists in R2
    let r2BackupExists = false;
    let r2BackupFiles: string[] = [];
    try {
      const listed = await c.env.MOLTBOT_BUCKET.list({ prefix: `users/${userId}/` });
      r2BackupFiles = listed.objects.map(o => o.key);
      r2BackupExists = r2BackupFiles.some(k => k.includes('clawdbot.json'));
    } catch {
      // Ignore
    }

    // Try to get container status if available
    let containerStatus: Record<string, unknown> = { available: false };
    let localSyncInfo: { timestamp: string | null; error?: string } = { timestamp: null };
    let hasLocalConfig = false;
    let syncRunning = false;
    let r2Mounted = false;

    try {
      const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: false });
      const processes = await sandbox.listProcesses();
      containerStatus = {
        available: true,
        processCount: processes.length,
        gatewayRunning: processes.some((p: any) => p.command?.includes('clawdbot gateway') && p.status === 'running'),
      };

      // Read local .last-sync
      try {
        const localProc = await sandbox.startProcess('cat /root/.clawdbot/.last-sync 2>/dev/null || echo "NOT_FOUND"');
        await new Promise(r => setTimeout(r, 1000));
        const localLogs = await localProc.getLogs();
        const content = (localLogs.stdout || '').trim();
        if (content && content !== 'NOT_FOUND') {
          localSyncInfo.timestamp = content;
        }
      } catch (err) {
        localSyncInfo.error = err instanceof Error ? err.message : 'Unknown error';
      }

      // Check R2 mount
      try {
        const mountProc = await sandbox.startProcess('mountpoint -q /data/openclaw && echo "MOUNTED" || echo "NOT_MOUNTED"');
        await new Promise(r => setTimeout(r, 500));
        const mountLogs = await mountProc.getLogs();
        r2Mounted = (mountLogs.stdout || '').includes('MOUNTED');
      } catch {
        // Ignore
      }

      // Check local config
      try {
        const configProc = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "EXISTS"');
        await new Promise(r => setTimeout(r, 500));
        const configLogs = await configProc.getLogs();
        hasLocalConfig = (configLogs.stdout || '').includes('EXISTS');
      } catch {
        // Ignore
      }

      // Check sync running
      try {
        const syncProc = await sandbox.startProcess('pgrep -f "rsync.*/root/.clawdbot" >/dev/null && echo "RUNNING" || echo "NOT_RUNNING"');
        await new Promise(r => setTimeout(r, 500));
        const syncLogs = await syncProc.getLogs();
        syncRunning = (syncLogs.stdout || '').includes('RUNNING');
      } catch {
        // Ignore
      }

    } catch {
      // Container not available, that's okay
    }

    return c.json({
      userId,
      sandboxName,
      container: {
        ...containerStatus,
        r2Mounted,
        hasLocalConfig,
        syncRunning,
        localSync: localSyncInfo,
      },
      r2Bucket: {
        backupExists: r2BackupExists,
        lastSync: r2SyncFromBucket,
        fileCount: r2BackupFiles.length,
        files: r2BackupFiles,
      },
      inMemoryResults: {
        consecutiveFailures,
        recentCount: recentResults.length,
        results: recentResults.slice(0, 5),
      },
      diagnosis: diagnoseUserIssues(
        r2SyncFromBucket,
        localSyncInfo,
        r2BackupExists,
        r2Mounted,
        hasLocalConfig,
        consecutiveFailures,
        containerStatus.available as boolean
      ),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Helper function to diagnose user-specific sync issues
function diagnoseUserIssues(
  r2Sync: { timestamp: string | null; error?: string },
  localSync: { timestamp: string | null; error?: string },
  r2BackupExists: boolean,
  r2Mounted: boolean,
  hasLocalConfig: boolean,
  consecutiveFailures: number,
  containerAvailable: boolean
): string[] {
  const issues: string[] = [];

  if (!r2BackupExists) {
    issues.push('CRITICAL: No backup in R2 bucket. User data will be lost on container restart!');
  }

  if (!containerAvailable) {
    issues.push('INFO: Container not running. Cannot check live sync status.');
    if (r2BackupExists) {
      issues.push('OK: R2 backup exists, will restore on next container start.');
    }
    return issues;
  }

  if (!r2Mounted) {
    issues.push('CRITICAL: R2 storage not mounted in container. Backups cannot run.');
  }

  if (!hasLocalConfig) {
    issues.push('WARNING: No local clawdbot.json in container. Sync skipped to prevent wiping R2.');
    if (r2BackupExists) {
      issues.push('INFO: R2 backup exists but wasn\'t restored. Check startup logs.');
    }
  }

  if (consecutiveFailures >= 3) {
    issues.push(`ALERT: ${consecutiveFailures} consecutive sync failures.`);
  }

  if (!r2Sync.timestamp && hasLocalConfig) {
    issues.push('WARNING: R2 has no .last-sync file. Backup may never have succeeded.');
  }

  if (localSync.timestamp && r2Sync.timestamp) {
    const localPart = localSync.timestamp.split('|')[1] || localSync.timestamp;
    const r2Part = r2Sync.timestamp.split('|')[1] || r2Sync.timestamp;
    try {
      const localTime = new Date(localPart).getTime();
      const r2Time = new Date(r2Part).getTime();
      const diffMinutes = Math.abs(localTime - r2Time) / 60000;

      if (diffMinutes > 10) {
        if (localTime > r2Time) {
          issues.push(`WARNING: Local ${Math.round(diffMinutes)}min ahead of R2. Recent changes not backed up.`);
        } else {
          issues.push(`INFO: R2 ${Math.round(diffMinutes)}min ahead of local. Container may have old data.`);
        }
      }
    } catch {
      // Can't parse
    }
  }

  if (issues.length === 0) {
    issues.push('OK: Sync appears healthy.');
  }

  return issues;
}

// GET /debug/admin/users/:userId/env - Check container env vars
debug.get('/admin/users/:userId/env', async (c) => {
  const userId = c.req.param('userId');
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, { keepAlive: true });

  try {
    const envProc = await sandbox.startProcess('env | grep -E "OPENCLAW|R2_|CLAWDBOT|TELEGRAM|DISCORD"');
    await new Promise(r => setTimeout(r, 1000));
    const logs = await envProc.getLogs();

    // Also check R2 mount
    const r2Proc = await sandbox.startProcess('ls -la /data/openclaw/users/ 2>&1 | head -10');
    await new Promise(r => setTimeout(r, 1000));
    const r2Logs = await r2Proc.getLogs();

    return c.json({
      userId,
      sandboxName,
      envVars: (logs.stdout || '').split('\n').filter(Boolean),
      r2Status: r2Logs.stdout || r2Logs.stderr || 'no output',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

export { debug };
