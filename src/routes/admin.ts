import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getGatewayMasterToken } from '../gateway';

/**
 * Admin API routes for managing user containers
 * These endpoints are protected by super admin authentication
 * and provide container state management and native file operations
 */
const adminRouter = new Hono<AppEnv>();

// Authentication middleware for super admin endpoints
async function requireSuperAuth(c: any, next: () => Promise<void>) {
  const adminSecret = c.req.header('X-Admin-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);
  
  if (!adminSecret || adminSecret !== expectedSecret) {
    return c.json({ 
      error: 'Super admin access required',
      hint: 'Provide X-Admin-Secret header'
    }, 403);
  }
  
  await next();
}

// Helper: Get sandbox for a user with tiered routing support
async function getUserSandbox(env: any, userId: string, keepAlive = false) {
  const { getSandbox } = await import('@cloudflare/sandbox');
  const { getSandboxForUser } = await import('../gateway/tiers');
  const sandboxName = `openclaw-${userId}`;
  
  // Use tiered routing for migrated users, legacy for others
  const sandboxBinding = getSandboxForUser(env, userId);
  
  return getSandbox(sandboxBinding, sandboxName, { 
    keepAlive,
    containerTimeouts: {
      instanceGetTimeoutMS: 30000,
      portReadyTimeoutMS: 60000,
    }
  });
}

// Container states
type ContainerState = 'active' | 'idle' | 'sleeping' | 'stopped' | 'error';

interface ContainerStatus {
  state: ContainerState;
  lastActivity: string | null;
  processCount: number;
  memoryMB: number | null;
  uptimeSeconds: number | null;
  version: string | null;
  error?: string;
}

// Live state check types (v2 synchronous endpoint)
type LiveContainerState = 'stopped' | 'idle' | 'starting' | 'active' | 'error';

interface LiveState {
  state: LiveContainerState;
  userId: string;
  processCount: number;
  gatewayHealthy: boolean | null;
  checkedAt: string;
  latencyMs: number;
  lastSyncAt?: string | null;
  error?: string;
}

/**
 * Performs a synchronous live health check on a user's container
 * 
 * Steps:
 * 1. Get sandbox reference (fast, from DO namespace)
 * 2. List processes to check if any are running
 * 3. If processes exist, ping gateway port 18789
 * 4. Return state based on actual results
 * 
 * Performance Budget: <500ms for single container
 */
async function getLiveState(userId: string, env: AppEnv): Promise<LiveState> {
  const startTime = Date.now();
  
  try {
    // Step 1: Get sandbox reference (fast, from DO namespace)
    const sandbox = await getUserSandbox(env, userId, false);
    
    // Step 2: List processes - lightweight operation (<100ms)
    let processes: any[] = [];
    try {
      processes = await sandbox.listProcesses();
    } catch (processError) {
      // If we can't list processes, sandbox might be hibernating or stopped
      return {
        state: 'stopped',
        userId,
        processCount: 0,
        gatewayHealthy: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
        error: processError instanceof Error ? processError.message : 'Failed to list processes',
      };
    }
    
    // No processes = idle state
    if (processes.length === 0) {
      return {
        state: 'idle',
        userId,
        processCount: 0,
        gatewayHealthy: null,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      };
    }
    
    // Step 3: Check gateway health on port 18789
    const gatewayHealthy = await checkGatewayHealth(sandbox);
    
    // Step 4: Determine state based on gateway health
    return {
      state: gatewayHealthy ? 'active' : 'starting',
      userId,
      processCount: processes.length,
      gatewayHealthy,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
    };
    
  } catch (error) {
    // Can't get sandbox reference = stopped
    return {
      state: 'stopped',
      userId,
      processCount: 0,
      gatewayHealthy: null,
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if the gateway is healthy by attempting to connect via containerFetch
 * Port 18789 serves both WebSocket and HTTP traffic - any response means it's alive
 */
async function checkGatewayHealth(sandbox: any): Promise<boolean> {
  try {
    // Use containerFetch to check if the gateway responds on port 18789
    // This matches how the main app actually communicates with the gateway
    const response = await sandbox.containerFetch(
      new Request('http://localhost:18789/'),
      18789
    );
    
    // Any non-zero status means the server responded (even 404 is OK)
    return response.status > 0;
  } catch {
    // Connection refused or timeout = gateway not healthy
    return false;
  }
}

/**
 * Get all user IDs from the R2 bucket
 * Uses a hardcoded list of known users for reliable dashboard checks
 * This is more efficient than listing from R2 which has pagination/limitations
 */
async function getAllUserIds(env: AppEnv): Promise<string[]> {
  // Hardcoded list of known user IDs from user-lookup.json
  // These are the 9 containers that should be monitored
  return [
    '38b1ec2b-7a70-4834-a48d-162b8902b0fd', // kyla
    '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b', // jack
    '6d575ef4-7ac8-4a17-b732-e0e690986e58', // david geddes
    '0f1195c1-6b57-4254-9871-6ef3b7fa360c', // rhys
    '679f60a6-2e00-403b-86f1-f4696149294f', // james
    'aef3677b-afdf-4a7e-bbeb-c596f0d94d29', // adnan
    '5bb7d208-2baf-4c95-8aec-f28e016acedb', // david lippold
    'e29fd082-6811-4e29-893e-64699c49e1f0', // ben lippold
    'fe56406b-a723-43cf-9f19-ba2ffcb135b0', // miles
  ];
}

// =============================================================================
// Phase 2: State-Aware API
// =============================================================================

// GET /api/super/users/:id/state - Get container state
adminRouter.get('/users/:id/state', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, false);
    const status: ContainerStatus = {
      state: 'stopped',
      lastActivity: null,
      processCount: 0,
      memoryMB: null,
      uptimeSeconds: null,
      version: null,
    };

    try {
      // Try to list processes - if this fails, container is sleeping/stopped
      const processes = await sandbox.listProcesses();
      status.processCount = processes.length;
      
      // Check if gateway is running
      const gatewayProcess = processes.find((p: any) => 
        p.command?.includes('openclaw gateway') && 
        (p.status === 'running' || p.status === 'starting')
      );

      if (gatewayProcess) {
        status.state = 'active';
        status.lastActivity = gatewayProcess.startTime?.toISOString() || null;
        
        // Calculate uptime if we have a start time
        if (gatewayProcess.startTime) {
          const uptime = Math.floor((Date.now() - gatewayProcess.startTime.getTime()) / 1000);
          status.uptimeSeconds = uptime;
        }
      } else if (processes.length > 0) {
        status.state = 'idle';
      }

      // Try to get version from a running process
      if (status.state === 'active') {
        try {
          const versionProc = await sandbox.startProcess('openclaw --version');
          await new Promise(r => setTimeout(r, 500));
          const logs = await versionProc.getLogs();
          const version = (logs.stdout || logs.stderr || '').trim();
          if (version) {
            status.version = version;
          }
        } catch {
          // Ignore version check errors
        }
      }

      // Try to get memory info (this will only work if container is responsive)
      if (status.state === 'active') {
        try {
          const memProc = await sandbox.startProcess("free -m | awk '/^Mem:/{print $3}'");
          await new Promise(r => setTimeout(r, 500));
          const memLogs = await memProc.getLogs();
          const memUsed = parseInt(memLogs.stdout?.trim() || '0', 10);
          if (!isNaN(memUsed)) {
            status.memoryMB = memUsed;
          }
        } catch {
          // Ignore memory check errors
        }
      }

    } catch (sandboxError) {
      // Sandbox exists but is not responsive - likely sleeping
      status.state = 'sleeping';
      status.error = sandboxError instanceof Error ? sandboxError.message : 'Sandbox unresponsive';
    }

    // Check R2 for last sync timestamp
    try {
      const syncKey = `users/${userId}/.last-sync`;
      const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
      if (syncObj) {
        const syncData = await syncObj.text();
        if (syncData) {
          // Use R2 sync time as fallback for lastActivity
          if (!status.lastActivity) {
            status.lastActivity = syncData.split('|')[0] || syncData;
          }
        }
      }
    } catch {
      // Ignore R2 errors
    }

    return c.json({
      userId,
      ...status,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ 
      userId,
      state: 'error',
      error: errorMessage,
      timestamp: new Date().toISOString(),
    }, 500);
  }
});

// GET /api/super/users/:id/state/v2 - Live synchronous state check
adminRouter.get('/users/:id/state/v2', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  const state = await getLiveState(userId, c.env);
  
  // Add last sync info from R2 if available
  try {
    const syncKey = `users/${userId}/.last-sync`;
    const syncObj = await c.env.MOLTBOT_BUCKET.get(syncKey);
    if (syncObj) {
      const syncData = await syncObj.text();
      state.lastSyncAt = syncData.split('|')[0] || syncData;
    }
  } catch {
    // Ignore R2 errors
  }
  
  return c.json(state);
});

// GET /api/super/state/dashboard - Batch status for all users
adminRouter.get('/state/dashboard', requireSuperAuth, async (c) => {
  const startTime = Date.now();
  
  // Get list of all users (from R2)
  const userIds = await getAllUserIds(c.env);
  
  if (userIds.length === 0) {
    return c.json({
      users: [],
      summary: {
        total: 0,
        active: 0,
        idle: 0,
        starting: 0,
        stopped: 0,
        error: 0,
      },
      totalLatencyMs: 0,
      checkedAt: new Date().toISOString(),
    });
  }
  
  // Check all containers in parallel
  const checks = await Promise.all(
    userIds.map(async (userId) => {
      try {
        return await getLiveState(userId, c.env);
      } catch (error) {
        return {
          state: 'error' as const,
          userId,
          processCount: 0,
          gatewayHealthy: null,
          checkedAt: new Date().toISOString(),
          latencyMs: 0,
          error: error instanceof Error ? error.message : 'Failed to check',
        };
      }
    })
  );
  
  const totalLatency = Date.now() - startTime;
  
  return c.json({
    users: checks,
    summary: {
      total: checks.length,
      active: checks.filter(c => c.state === 'active').length,
      idle: checks.filter(c => c.state === 'idle').length,
      starting: checks.filter(c => c.state === 'starting').length,
      stopped: checks.filter(c => c.state === 'stopped').length,
      error: checks.filter(c => c.state === 'error').length,
    },
    totalLatencyMs: totalLatency,
    checkedAt: new Date().toISOString(),
  });
});

// POST /api/super/users/:id/wake - Wake up container
adminRouter.post('/users/:id/wake', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const { ensureMoltbotGateway } = await import('../gateway');
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    // Check current state
    let currentState: ContainerState = 'stopped';
    let existingProcess = null;
    
    try {
      const processes = await sandbox.listProcesses();
      existingProcess = processes.find((p: any) => 
        p.command?.includes('openclaw gateway') && 
        (p.status === 'running' || p.status === 'starting')
      );
      
      if (existingProcess) {
        currentState = 'active';
      } else if (processes.length > 0) {
        currentState = 'idle';
      } else {
        currentState = 'sleeping';
      }
    } catch {
      currentState = 'sleeping';
    }

    // If already active or idle, no-op
    if (currentState === 'active' || currentState === 'idle') {
      return c.json({
        userId,
        previousState: currentState,
        currentState: 'active',
        action: 'none',
        message: 'Container is already running',
      });
    }

    // Start the container
    console.log(`[WAKE] Waking up container for user ${userId}...`);
    
    // Kill any stale processes first
    try {
      const processes = await sandbox.listProcesses();
      for (const proc of processes) {
        try {
          await proc.kill();
        } catch {
          // Ignore kill errors
        }
      }
    } catch {
      // Ignore if can't list processes
    }

    // Wait a moment for cleanup
    await new Promise(r => setTimeout(r, 1000));

    // Start gateway
    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch((err: Error) => {
      console.error(`[WAKE] Gateway start failed for ${userId}:`, err);
      throw err;
    });
    c.executionCtx.waitUntil(bootPromise);

    // Poll for health check (max 60 seconds)
    const maxWaitMs = 60000;
    const pollIntervalMs = 2000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      
      try {
        const processes = await sandbox.listProcesses();
        const gatewayProcess = processes.find((p: any) => 
          p.command?.includes('openclaw gateway') && 
          p.status === 'running'
        );
        
        if (gatewayProcess) {
          return c.json({
            userId,
            previousState: currentState,
            currentState: 'active',
            action: 'started',
            message: 'Container is now active',
            waitedMs: Date.now() - startTime,
          });
        }
      } catch {
        // Continue polling
      }
    }

    // Timeout
    return c.json({
      userId,
      previousState: currentState,
      currentState: 'error',
      action: 'timeout',
      message: 'Container failed to become ready within 60 seconds',
      waitedMs: maxWaitMs,
    }, 504);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
      message: 'Failed to wake container',
    }, 500);
  }
});

// Auto-wake middleware helper
async function withWake(env: any, userId: string, operation: () => Promise<Response>): Promise<Response> {
  const sandbox = await getUserSandbox(env, userId, true);
  
  // Check if container needs waking
  let needsWake = false;
  try {
    const processes = await sandbox.listProcesses();
    const gatewayRunning = processes.some((p: any) => 
      p.command?.includes('openclaw gateway') && 
      p.status === 'running'
    );
    if (!gatewayRunning && processes.length === 0) {
      needsWake = true;
    }
  } catch {
    needsWake = true;
  }

  // Wake if needed
  if (needsWake) {
    const { ensureMoltbotGateway } = await import('../gateway');
    console.log(`[AUTO-WAKE] Waking container for ${userId} before operation`);
    
    // Kill stale processes
    try {
      const processes = await sandbox.listProcesses();
      for (const proc of processes) {
        try { await proc.kill(); } catch {}
      }
    } catch {}
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Start gateway
    const bootPromise = ensureMoltbotGateway(sandbox, env, userId).catch(() => {});
    env.executionCtx?.waitUntil?.(bootPromise);
    
    // Wait for it to be ready
    const maxWaitMs = 30000;
    const pollIntervalMs = 1000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        const processes = await sandbox.listProcesses();
        if (processes.some((p: any) => p.command?.includes('openclaw gateway') && p.status === 'running')) {
          break;
        }
      } catch {}
    }
  }

  return await operation();
}

// POST /api/super/users/:id/exec - Execute command with auto-wake
adminRouter.post('/users/:id/exec', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { command, timeout = 30000, env: cmdEnv } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Execute the command
      const startTime = Date.now();
      const proc = await sandbox.startProcess(command, {
        env: cmdEnv,
      });

      // Wait for completion or timeout
      const result = await Promise.race([
        proc.waitForExit(timeout),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Command timeout')), timeout)
        ),
      ]);

      const logs = await proc.getLogs();
      const duration = Date.now() - startTime;

      return c.json({
        userId,
        command,
        exitCode: (result as any).exitCode ?? proc.exitCode ?? -1,
        stdout: logs.stdout || '',
        stderr: logs.stderr || '',
        duration,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        command,
        error: errorMessage,
        stdout: '',
        stderr: '',
        timestamp: new Date().toISOString(),
      }, 500);
    }
  });
});

// =============================================================================
// Phase 1: Native File Operations
// =============================================================================

// GET /api/super/users/:id/files/:path{.+} - Read file using native SDK
adminRouter.get('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Use native readFile SDK method
      const result = await sandbox.readFile(path);
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to read file',
          exitCode: result.exitCode,
        }, 500);
      }

      // For binary files or large files, return metadata only
      if (result.isBinary || (result.size && result.size > 1024 * 1024)) {
        return c.json({
          userId,
          path,
          size: result.size,
          encoding: result.encoding,
          isBinary: result.isBinary,
          mimeType: result.mimeType,
          message: 'File is binary or large (>1MB). Use R2 for streaming.',
        }, 200);
      }

      return c.json({
        userId,
        path,
        content: result.content,
        encoding: result.encoding,
        size: result.size,
        mimeType: result.mimeType,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Check if file doesn't exist
      if (errorMessage.includes('not found') || errorMessage.includes('No such file')) {
        return c.json({
          userId,
          path,
          error: 'File not found',
        }, 404);
      }
      
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// HEAD /api/super/users/:id/files/:path{.+}/exists - Check file exists and get metadata
adminRouter.get('/users/:id/files/:path{.+}/exists', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const result = await sandbox.exists(path);
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to check file existence',
        }, 500);
      }

      return c.json({
        userId,
        path,
        exists: result.exists,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// PUT /api/super/users/:id/files/:path{.+} - Write file using native SDK
adminRouter.put('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  // Get content from request body
  let content: string;
  try {
    const body = await c.req.json();
    if (typeof body.content !== 'string') {
      return c.json({ error: 'Request body must have a "content" string field' }, 400);
    }
    content = body.content;
  } catch {
    // Try reading as plain text
    content = await c.req.text();
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Ensure directory exists
      const dirPath = path.substring(0, path.lastIndexOf('/')) || '/';
      if (dirPath !== '/') {
        await sandbox.mkdir(dirPath, { recursive: true });
      }

      // Use native writeFile SDK method
      const result = await sandbox.writeFile(path, content);
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to write file',
          exitCode: result.exitCode,
        }, 500);
      }

      // Also backup to R2
      try {
        const r2Key = `users/${userId}/${path}`;
        await c.env.MOLTBOT_BUCKET.put(r2Key, content, {
          httpMetadata: { contentType: 'application/octet-stream' },
        });
      } catch (r2Error) {
        console.log(`[WRITE] R2 backup failed for ${path}:`, r2Error);
        // Don't fail the request if R2 backup fails
      }

      return c.json({
        userId,
        path,
        success: true,
        bytesWritten: content.length,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// DELETE /api/super/users/:id/files/:path{.+} - Delete file
adminRouter.delete('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const result = await sandbox.deleteFile(path);
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to delete file',
          exitCode: result.exitCode,
        }, 500);
      }

      return c.json({
        userId,
        path,
        success: true,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// GET /api/super/users/:id/files - List files in directory
adminRouter.get('/users/:id/files', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.query('path') || '/';
  const recursive = c.req.query('recursive') === 'true';

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const result = await sandbox.listFiles(path, { recursive });
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'Failed to list files',
          exitCode: result.exitCode,
        }, 500);
      }

      return c.json({
        userId,
        path,
        files: result.files,
        count: result.count,
        timestamp: result.timestamp,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path,
        error: errorMessage,
      }, 500);
    }
  });
});

// =============================================================================
// Phase 3: R2 Dropbox Pattern
// =============================================================================

// POST /api/super/users/:id/config/reload - Trigger container to reload from R2
adminRouter.post('/users/:id/config/reload', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Trigger the container to reload config from R2
      // This uses a signal or special command to tell the gateway to reload
      const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
      await new Promise(r => setTimeout(r, 1000));
      await reloadProc.getLogs();

      return c.json({
        userId,
        success: true,
        message: 'Config reload signal sent to container',
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        error: errorMessage,
        message: 'Failed to send reload signal',
      }, 500);
    }
  });
});

// GET /api/super/users/:id/config - Get config from R2 (R2-first pattern)
adminRouter.get('/users/:id/config', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  try {
    // Read from R2 first (R2-first pattern)
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    const configObj = await c.env.MOLTBOT_BUCKET.get(configKey);

    if (!configObj) {
      return c.json({
        userId,
        error: 'Config not found in R2',
      }, 404);
    }

    const configText = await configObj.text();
    let config: any;
    try {
      config = JSON.parse(configText);
    } catch {
      return c.json({
        userId,
        error: 'Config is not valid JSON',
        raw: configText.substring(0, 1000),
      }, 500);
    }

    return c.json({
      userId,
      source: 'r2',
      config,
      lastModified: configObj.uploaded,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// PUT /api/super/users/:id/config - Update config in R2 (R2-first pattern)
adminRouter.put('/users/:id/config', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');

  let config: any;
  try {
    config = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    // Store old version for rollback capability
    const configKey = `users/${userId}/openclaw/openclaw.json`;
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
    
    // Get existing config for history
    try {
      const existing = await c.env.MOLTBOT_BUCKET.get(configKey);
      if (existing) {
        const existingText = await existing.text();
        const historyEntry = {
          timestamp: new Date().toISOString(),
          config: JSON.parse(existingText),
        };
        
        // Append to history (simple approach - in production, consider limiting history size)
        const existingHistory = await c.env.MOLTBOT_BUCKET.get(historyKey);
        let history: any[] = [];
        if (existingHistory) {
          try {
            history = JSON.parse(await existingHistory.text());
          } catch {}
        }
        history.push(historyEntry);
        
        // Keep only last 10 versions
        if (history.length > 10) {
          history = history.slice(-10);
        }
        
        await c.env.MOLTBOT_BUCKET.put(historyKey, JSON.stringify(history, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
    } catch {
      // Ignore history errors
    }

    // Write new config to R2
    const configText = JSON.stringify(config, null, 2);
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });

    // Trigger container reload
    return await withWake(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);
      
      // Write config to container as well
      try {
        await sandbox.mkdir('/root/.openclaw', { recursive: true });
        await sandbox.writeFile('/root/.openclaw/openclaw.json', configText);
      } catch (writeError) {
        console.log(`[CONFIG] Failed to write to container:`, writeError);
      }

      // Send reload signal
      try {
        const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
        await new Promise(r => setTimeout(r, 500));
        await reloadProc.getLogs();
      } catch {
        // Ignore signal errors
      }

      return c.json({
        userId,
        success: true,
        message: 'Config updated in R2 and container',
        timestamp: new Date().toISOString(),
      });
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// GET /api/super/users/:id/config/history - Get config version history
adminRouter.get('/users/:id/config/history', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  try {
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
    const historyObj = await c.env.MOLTBOT_BUCKET.get(historyKey);

    if (!historyObj) {
      return c.json({
        userId,
        history: [],
        count: 0,
      });
    }

    const historyText = await historyObj.text();
    let history: any[] = [];
    try {
      history = JSON.parse(historyText);
    } catch {
      return c.json({
        userId,
        error: 'History file is corrupted',
      }, 500);
    }

    return c.json({
      userId,
      history: history.map((h, i) => ({
        version: i + 1,
        timestamp: h.timestamp,
      })),
      count: history.length,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// POST /api/super/users/:id/config/rollback - Rollback to previous version
adminRouter.post('/users/:id/config/rollback', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { version } = body;

  if (!version || typeof version !== 'number' || version < 1) {
    return c.json({ error: 'Version number is required (1-indexed)' }, 400);
  }

  try {
    const historyKey = `users/${userId}/openclaw/openclaw.json.history`;
    const historyObj = await c.env.MOLTBOT_BUCKET.get(historyKey);

    if (!historyObj) {
      return c.json({
        userId,
        error: 'No history available for rollback',
      }, 404);
    }

    const historyText = await historyObj.text();
    let history: any[] = [];
    try {
      history = JSON.parse(historyText);
    } catch {
      return c.json({
        userId,
        error: 'History file is corrupted',
      }, 500);
    }

    // Version is 1-indexed from the end (1 = most recent)
    const historyIndex = history.length - version;
    if (historyIndex < 0 || historyIndex >= history.length) {
      return c.json({
        userId,
        error: `Invalid version. Available: 1-${history.length}`,
      }, 400);
    }

    const targetConfig = history[historyIndex].config;
    const configKey = `users/${userId}/openclaw/openclaw.json`;

    // Save current as new history entry
    const currentObj = await c.env.MOLTBOT_BUCKET.get(configKey);
    if (currentObj) {
      const currentText = await currentObj.text();
      history.push({
        timestamp: new Date().toISOString(),
        config: JSON.parse(currentText),
        note: 'Auto-saved before rollback',
      });
    }

    // Write rolled back config
    const configText = JSON.stringify(targetConfig, null, 2);
    await c.env.MOLTBOT_BUCKET.put(configKey, configText, {
      httpMetadata: { contentType: 'application/json' },
    });

    // Update history
    await c.env.MOLTBOT_BUCKET.put(historyKey, JSON.stringify(history, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });

    // Update container
    return await withWake(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);
      
      try {
        await sandbox.writeFile('/root/.openclaw/openclaw.json', configText);
        
        const reloadProc = await sandbox.startProcess('killall -HUP openclaw 2>/dev/null || true');
        await new Promise(r => setTimeout(r, 500));
        await reloadProc.getLogs();
      } catch {
        // Ignore container update errors
      }

      return c.json({
        userId,
        success: true,
        rolledBackTo: {
          version,
          timestamp: history[historyIndex].timestamp,
        },
        message: 'Config rolled back successfully',
      });
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      error: errorMessage,
    }, 500);
  }
});

// =============================================================================
// Cost Tracking Endpoints
// =============================================================================

// GET /api/super/cost - Get total cost summary across all users
adminRouter.get('/cost', requireSuperAuth, async (c) => {
  try {
    const days = parseInt(c.req.query('days') || '30', 10);
    const threshold = c.req.query('threshold') ? parseFloat(c.req.query('threshold')!) : undefined;
    
    const { generateCostSummary } = await import('../lib/cost-tracking');
    const summary = await generateCostSummary(c.env, { days, threshold });
    
    return c.json(summary);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/users/:id - Get cost breakdown for specific user
adminRouter.get('/cost/users/:id', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  
  try {
    const days = parseInt(c.req.query('days') || '30', 10);
    
    const { getUserCostSummary, generateCostSummary } = await import('../lib/cost-tracking');
    const userCost = await getUserCostSummary(c.env, userId, { days });
    
    if (!userCost) {
      return c.json({ error: 'User not found' }, 404);
    }
    
    // Get total for percentage calculation
    const totalSummary = await generateCostSummary(c.env, { days });
    userCost.percentageOfTotal = totalSummary.totalCost > 0 
      ? (userCost.totalCost / totalSummary.totalCost) * 100 
      : 0;
    
    return c.json({
      userId,
      userName: userCost.userName,
      period: totalSummary.period,
      cost: userCost,
      totalPlatformCost: totalSummary.totalCost,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/service/:service - Get cost breakdown by service type
adminRouter.get('/cost/service/:service', requireSuperAuth, async (c) => {
  const service = c.req.param('service') as 'workers' | 'r2' | 'durableObjects' | 'sandbox';
  
  if (!['workers', 'r2', 'durableObjects', 'sandbox'].includes(service)) {
    return c.json({ error: 'Invalid service type' }, 400);
  }
  
  try {
    const days = parseInt(c.req.query('days') || '30', 10);
    
    const { generateCostSummary } = await import('../lib/cost-tracking');
    const summary = await generateCostSummary(c.env, { days });
    
    const serviceBreakdown = summary.serviceBreakdown.find(s => s.service === service);
    
    if (!serviceBreakdown) {
      return c.json({ error: 'Service not found' }, 404);
    }
    
    // Get per-user breakdown for this service
    const userBreakdown = summary.userBreakdown.map(u => ({
      userId: u.userId,
      userName: u.userName,
      cost: service === 'workers' ? u.workers.cost : 
            service === 'r2' ? u.r2.cost :
            service === 'durableObjects' ? u.durableObjects.cost : 0,
      details: service === 'workers' ? { requests: u.workers.requests, gbSeconds: u.workers.gbSeconds } :
               service === 'r2' ? { storageGB: u.r2.storageGB, operations: u.r2.operations } :
               service === 'durableObjects' ? { requests: u.durableObjects.requests, storageGB: u.durableObjects.storageGB } :
               {},
    }));
    
    return c.json({
      service,
      period: summary.period,
      summary: serviceBreakdown,
      users: userBreakdown.sort((a, b) => b.cost - a.cost),
      totalCost: summary.totalCost,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/trend - Get month-over-month cost trending
adminRouter.get('/cost/trend', requireSuperAuth, async (c) => {
  try {
    const { generateCostSummary, getBillingPeriod } = await import('../lib/cost-tracking');
    
    // Current period
    const currentDays = parseInt(c.req.query('days') || '30', 10);
    const currentSummary = await generateCostSummary(c.env, { days: currentDays });
    
    // Previous period for comparison
    const prevPeriod = getBillingPeriod(currentDays);
    const prevStart = new Date(prevPeriod.start);
    prevStart.setDate(prevStart.getDate() - currentDays);
    const prevEnd = new Date(prevPeriod.start);
    
    // Calculate mock previous period costs (would use historical data in production)
    // For now, estimate based on current trend
    const trendFactor = 0.95; // Assume 5% growth month-over-month as default
    
    return c.json({
      current: {
        period: currentSummary.period,
        totalCost: currentSummary.totalCost,
        userCount: currentSummary.userCount,
        serviceBreakdown: currentSummary.serviceBreakdown,
      },
      previous: {
        period: {
          start: prevStart.toISOString(),
          end: prevEnd.toISOString(),
          days: currentDays,
        },
        estimatedTotalCost: currentSummary.totalCost * trendFactor,
        estimatedChange: ((currentSummary.totalCost - (currentSummary.totalCost * trendFactor)) / (currentSummary.totalCost * trendFactor)) * 100,
      },
      trends: currentSummary.trends,
      note: 'Historical data tracking not yet implemented - showing estimates based on current usage',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/check - Check cost against threshold
adminRouter.get('/cost/check', requireSuperAuth, async (c) => {
  try {
    const threshold = parseFloat(c.req.query('threshold') || '50');
    const days = parseInt(c.req.query('days') || '30', 10);
    
    const { checkCostThreshold } = await import('../lib/cost-tracking');
    const result = await checkCostThreshold(c.env, threshold, { days });
    
    return c.json({
      check: {
        threshold,
        days,
        exceeded: result.exceeded,
        current: result.current,
        remaining: Math.max(0, threshold - result.current),
        percentUsed: (result.current / threshold) * 100,
      },
      alerts: result.alerts,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/super/cost/rates - Get current pricing rates
adminRouter.get('/cost/rates', requireSuperAuth, async (c) => {
  const { COST_RATES } = await import('../lib/cost-tracking');
  
  return c.json({
    rates: COST_RATES,
    description: {
      workers: 'Cloudflare Workers - per million requests and GB-seconds',
      r2: 'R2 Object Storage - per GB-month storage and million operations',
      durableObjects: 'Durable Objects - per billion requests and GB-month storage',
    },
    effectiveDate: '2025-01-01',
    source: 'Cloudflare published pricing',
  });
});

// POST /api/super/users/:id/message - Direct message to container (admin bypass)
// Allows admin to impersonate any user and send messages directly to their container
// This bypasses Telegram/Discord pairing requirements
adminRouter.post('/users/:id/message', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { text, asUserId, sessionKey } = body;
  
  if (!text || typeof text !== 'string') {
    return c.json({ error: 'Message text is required' }, 400);
  }
  
  const impersonatedUserId = asUserId || 'admin';
  const messageSessionKey = sessionKey || `admin-${Date.now()}`;
  
  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Create a message payload that mimics normal channel delivery
      const messagePayload = {
        id: `admin-${Date.now()}`,
        sessionKey: messageSessionKey,
        text: text,
        from: {
          id: impersonatedUserId,
          name: 'Admin',
          isAdmin: true,
        },
        timestamp: new Date().toISOString(),
        channel: 'admin-direct',
      };
      
      // Write to container's message inbox
      const inboxPath = `/tmp/admin-messages/${messageSessionKey}.json`;
      const inboxDir = '/tmp/admin-messages';
      
      // Ensure directory exists
      try {
        await sandbox.mkdir(inboxDir, { recursive: true });
      } catch {
        // Directory may already exist
      }
      
      // Write message to inbox
      await sandbox.writeFile(inboxPath, JSON.stringify(messagePayload, null, 2));
      
      // Trigger the gateway to process the message
      // This simulates what happens when a real message arrives
      const triggerProc = await sandbox.startProcess(
        `cd /root/openclaw && echo '${JSON.stringify(messagePayload)}' | openclaw message --stdin --session "${messageSessionKey}" --from "${impersonatedUserId}" 2>&1 || echo "Message queued for processing"`
      );
      
      await new Promise(r => setTimeout(r, 500));
      const logs = await triggerProc.getLogs();
      
      return c.json({
        success: true,
        userId,
        impersonatedAs: impersonatedUserId,
        sessionKey: messageSessionKey,
        message: text,
        gatewayResponse: logs.stdout || 'Message delivered to container',
        timestamp: messagePayload.timestamp,
        note: 'Admin direct message bypasses normal channel authentication'
      });
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        error: 'Failed to deliver admin message',
        details: errorMessage,
        userId,
        impersonatedAs: impersonatedUserId,
      }, 500);
    }
  });
});

export { adminRouter };
