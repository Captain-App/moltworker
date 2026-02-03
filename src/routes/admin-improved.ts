/**
 * Improved Admin API routes with better reliability and robustness
 * 
 * Key improvements:
 * 1. R2-first file operations with container fallback
 * 2. Extended timeout handling for container wake (120s vs 30s)
 * 3. Retry logic with exponential backoff
 * 4. Better error classification (503 for container, 500 for command)
 * 5. Streaming exec mode for long-running commands
 * 6. Batch file operations
 * 7. Deep health checks
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getGatewayMasterToken } from '../gateway';

const adminImprovedRouter = new Hono<AppEnv>();

// Authentication middleware
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

// Helper: Get sandbox for a user
async function getUserSandbox(env: any, userId: string, keepAlive = false) {
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxName = `openclaw-${userId}`;
  return getSandbox(env.Sandbox, sandboxName, { 
    keepAlive,
    containerTimeouts: {
      instanceGetTimeoutMS: 30000,
      portReadyTimeoutMS: 60000,
    }
  });
}

// =============================================================================
// IMPROVED WAKE AND RETRY LOGIC
// =============================================================================

interface WakeOptions {
  maxWakeTimeMs?: number;
  healthCheckTimeoutMs?: number;
  retryAttempts?: number;
}

/**
 * Check if an error is retryable (transient)
 */
function isRetryableError(error: Error): boolean {
  const retryableMessages = [
    'timeout',
    'hibernating',
    'not ready',
    'connection refused',
    'sandbox_not_found',
    'instanceGetTimeout',
    'portReadyTimeout',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'gateway failed to start',
    'process not found',
  ];
  
  const message = error.message.toLowerCase();
  return retryableMessages.some(m => message.includes(m.toLowerCase()));
}

/**
 * Check if container is responsive by running a simple command
 */
async function checkContainerHealth(sandbox: any, timeoutMs: number = 5000): Promise<boolean> {
  try {
    const healthProc = await sandbox.startProcess('echo "health-check"');
    
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Health check timeout')), timeoutMs)
    );
    
    await Promise.race([healthProc.waitForExit(5000), timeoutPromise]);
    const logs = await healthProc.getLogs();
    return logs.stdout?.includes('health-check') ?? false;
  } catch {
    return false;
  }
}

/**
 * Wake a container with extended timeout and health verification
 */
async function wakeContainer(
  env: AppEnv, 
  userId: string, 
  maxWaitMs: number
): Promise<void> {
  const { ensureMoltbotGateway } = await import('../gateway');
  
  console.log(`[WAKE] Waking container for ${userId} (max ${maxWaitMs}ms)...`);
  
  // Kill stale processes
  try {
    const sandbox = await getUserSandbox(env, userId, true);
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      try { 
        await proc.kill(); 
        console.log(`[WAKE] Killed stale process ${proc.id}`);
      } catch {}
    }
  } catch (e) {
    console.log(`[WAKE] No processes to kill or sandbox not ready:`, e);
  }
  
  await new Promise(r => setTimeout(r, 1000));
  
  // Start gateway
  const sandbox = await getUserSandbox(env, userId, true);
  
  // Don't await - let it start in background
  const bootPromise = ensureMoltbotGateway(sandbox, env, userId).catch((err: Error) => {
    console.error(`[WAKE] Gateway start failed for ${userId}:`, err);
    throw err;
  });
  
  // Poll for readiness
  const pollIntervalMs = 2000;
  const startTime = Date.now();
  let lastError: Error | null = null;
  
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    
    try {
      const processes = await sandbox.listProcesses();
      const gatewayRunning = processes.some((p: any) => 
        p.command?.includes('clawdbot gateway') && 
        p.status === 'running'
      );
      
      if (gatewayRunning) {
        // Verify it's actually responsive
        if (await checkContainerHealth(sandbox, 5000)) {
          console.log(`[WAKE] Container for ${userId} is ready (${Date.now() - startTime}ms)`);
          return;
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // Continue polling
    }
  }
  
  throw new Error(
    `Container failed to become ready within ${maxWaitMs}ms. ` +
    `Last error: ${lastError?.message || 'None'}`
  );
}

/**
 * Execute operation with wake and retry logic
 */
async function withWakeAndRetry(
  env: AppEnv, 
  userId: string, 
  operation: () => Promise<Response>,
  options: WakeOptions = {}
): Promise<Response> {
  const {
    maxWakeTimeMs = 120_000, // Increased from 30s default
    healthCheckTimeoutMs = 10_000,
    retryAttempts = 3,
  } = options;

  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      const sandbox = await getUserSandbox(env, userId, true);
      
      // Check if container needs waking
      let needsWake = false;
      let isResponsive = false;
      
      try {
        const processes = await sandbox.listProcesses();
        const gatewayRunning = processes.some((p: any) => 
          p.command?.includes('clawdbot gateway') && 
          p.status === 'running'
        );
        
        if (!gatewayRunning && processes.length === 0) {
          console.log(`[WAKE] Container for ${userId} has no processes, needs wake`);
          needsWake = true;
        } else if (gatewayRunning) {
          // Verify responsiveness
          isResponsive = await checkContainerHealth(sandbox, healthCheckTimeoutMs);
          if (!isResponsive) {
            console.log(`[WAKE] Gateway running but not responsive for ${userId}, restarting`);
            needsWake = true;
          }
        } else {
          // Processes exist but no gateway - might be starting or stuck
          const hasStartingGateway = processes.some((p: any) => 
            p.command?.includes('clawdbot gateway') && 
            p.status === 'starting'
          );
          
          if (hasStartingGateway) {
            console.log(`[WAKE] Gateway starting for ${userId}, waiting...`);
            needsWake = true; // Will wait for it in wakeContainer
          } else {
            console.log(`[WAKE] No gateway process for ${userId}, needs wake`);
            needsWake = true;
          }
        }
      } catch (e) {
        console.log(`[WAKE] Error checking container state for ${userId}:`, e);
        needsWake = true;
      }

      // Wake if needed
      if (needsWake) {
        await wakeContainer(env, userId, maxWakeTimeMs);
      }

      // Execute operation
      return await operation();
      
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if error is retryable
      if (!isRetryableError(lastError)) {
        console.log(`[WAKE] Non-retryable error for ${userId}:`, lastError.message);
        break;
      }
      
      // Exponential backoff
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.log(`[WAKE] Attempt ${attempt + 1}/${retryAttempts} failed for ${userId}, retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // All retries exhausted
  return c.json({
    error: 'Container operation failed after retries',
    details: lastError?.message,
    attempts: retryAttempts,
    userId,
  }, 503);
}

// =============================================================================
// IMPROVED FILE OPERATIONS (R2-First)
// =============================================================================

// GET /api/super/users/:id/files/:path{.+} - Read file with R2 fallback
adminImprovedRouter.get('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  const source = c.req.query('source') || 'auto'; // 'r2', 'container', 'auto'
  const maxWakeTime = parseInt(c.req.query('maxWakeTime') || '120000', 10);
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  // Normalize path (ensure it starts with /)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // R2-first: Try R2 backup if requested or auto
  if (source === 'r2' || source === 'auto') {
    try {
      const r2Key = `users/${userId}${normalizedPath}`;
      console.log(`[FILES] Trying R2 first for ${r2Key}`);
      
      const r2Obj = await c.env.MOLTBOT_BUCKET.get(r2Key);
      
      if (r2Obj) {
        // Limit size for text files
        const maxSize = 5 * 1024 * 1024; // 5MB limit
        if (r2Obj.size > maxSize) {
          return c.json({
            userId,
            path: normalizedPath,
            size: r2Obj.size,
            source: 'r2',
            lastModified: r2Obj.uploaded,
            message: 'File too large (>5MB), use range request or container access',
          }, 200);
        }
        
        const content = await r2Obj.text();
        return c.json({
          userId,
          path: normalizedPath,
          content,
          source: 'r2',
          size: content.length,
          lastModified: r2Obj.uploaded,
          timestamp: new Date().toISOString(),
        });
      }
      
      console.log(`[FILES] File not found in R2: ${r2Key}`);
    } catch (r2Error) {
      console.log(`[FILES] R2 read failed for ${normalizedPath}:`, r2Error);
      // Fall through to container
    }
  }

  // Container fallback: Read from active container
  if (source === 'container' || source === 'auto') {
    return await withWakeAndRetry(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);
      
      try {
        const result = await sandbox.readFile(normalizedPath);
        
        if (!result.success) {
          return c.json({
            userId,
            path: normalizedPath,
            error: 'File not found in container',
            exitCode: result.exitCode,
            source: 'container',
          }, 404);
        }

        // For binary or large files, return metadata only
        if (result.isBinary || (result.size && result.size > 1024 * 1024)) {
          return c.json({
            userId,
            path: normalizedPath,
            size: result.size,
            encoding: result.encoding,
            isBinary: result.isBinary,
            mimeType: result.mimeType,
            source: 'container',
            message: 'File is binary or large (>1MB). Use R2 for streaming.',
          }, 200);
        }

        return c.json({
          userId,
          path: normalizedPath,
          content: result.content,
          source: 'container',
          size: result.size,
          encoding: result.encoding,
          mimeType: result.mimeType,
          timestamp: result.timestamp,
        });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        // Classify error
        const isNotFound = 
          errorMessage.includes('not found') || 
          errorMessage.includes('No such file') ||
          errorMessage.includes('ENOENT');
        
        if (isNotFound) {
          return c.json({
            userId,
            path: normalizedPath,
            error: 'File not found',
            source: 'container',
            triedR2: source === 'auto',
          }, 404);
        }
        
        return c.json({
          userId,
          path: normalizedPath,
          error: errorMessage,
          source: 'container',
        }, 500);
      }
    }, { maxWakeTimeMs: maxWakeTime });
  }

  return c.json({ 
    error: 'File not found',
    path: normalizedPath,
    triedSources: source === 'auto' ? ['r2', 'container'] : [source],
  }, 404);
});

// PUT /api/super/users/:id/files/:path{.+} - Write file with R2 sync
adminImprovedRouter.put('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  const skipR2 = c.req.query('skipR2') === 'true';
  const maxWakeTime = parseInt(c.req.query('maxWakeTime') || '120000', 10);
  
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

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return await withWakeAndRetry(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      // Ensure directory exists
      const dirPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) || '/';
      if (dirPath !== '/') {
        await sandbox.mkdir(dirPath, { recursive: true });
      }

      // Write to container
      const result = await sandbox.writeFile(normalizedPath, content);
      
      if (!result.success) {
        return c.json({
          userId,
          path: normalizedPath,
          error: 'Failed to write file to container',
          exitCode: result.exitCode,
        }, 500);
      }

      // Sync to R2 (unless skipped)
      let r2Sync = { success: false, error: null as string | null };
      if (!skipR2) {
        try {
          const r2Key = `users/${userId}${normalizedPath}`;
          await c.env.MOLTBOT_BUCKET.put(r2Key, content, {
            httpMetadata: { 
              contentType: result.mimeType || 'application/octet-stream',
            },
          });
          r2Sync = { success: true, error: null };
          console.log(`[FILES] Synced to R2: ${r2Key}`);
        } catch (r2Error) {
          const r2ErrorMsg = r2Error instanceof Error ? r2Error.message : 'Unknown R2 error';
          r2Sync = { success: false, error: r2ErrorMsg };
          console.log(`[FILES] R2 sync failed: ${r2ErrorMsg}`);
          // Don't fail the request if R2 sync fails
        }
      }

      return c.json({
        userId,
        path: normalizedPath,
        success: true,
        bytesWritten: content.length,
        timestamp: result.timestamp,
        r2Sync,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        userId,
        path: normalizedPath,
        error: errorMessage,
      }, 500);
    }
  }, { maxWakeTimeMs: maxWakeTime });
});

// POST /api/super/users/:id/files/batch - Batch file operations
adminImprovedRouter.post('/users/:id/files/batch', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { operations, parallel = false } = body;
  const maxWakeTime = parseInt(c.req.query('maxWakeTime') || '120000', 10);

  if (!Array.isArray(operations) || operations.length === 0) {
    return c.json({ error: 'operations array is required' }, 400);
  }

  if (operations.length > 50) {
    return c.json({ error: 'Maximum 50 operations per batch' }, 400);
  }

  // Validate operations
  for (const op of operations) {
    if (!op.op || !['read', 'write', 'delete', 'exists'].includes(op.op)) {
      return c.json({ error: `Invalid operation: ${op.op}` }, 400);
    }
    if (!op.path) {
      return c.json({ error: 'Each operation requires a path' }, 400);
    }
    if (op.op === 'write' && typeof op.content !== 'string') {
      return c.json({ error: 'Write operations require content string' }, 400);
    }
  }

  return await withWakeAndRetry(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    const results: any[] = [];
    
    if (parallel) {
      // Execute in parallel (faster but higher load)
      const promises = operations.map(async (op) => {
        try {
          return await executeFileOperation(sandbox, op, c.env, userId);
        } catch (error) {
          return {
            path: op.path,
            op: op.op,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      });
      
      results.push(...await Promise.all(promises));
    } else {
      // Execute sequentially (safer)
      for (const op of operations) {
        try {
          const result = await executeFileOperation(sandbox, op, c.env, userId);
          results.push(result);
        } catch (error) {
          results.push({
            path: op.path,
            op: op.op,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }

    return c.json({
      userId,
      completed: results.length,
      succeeded: results.filter((r: any) => r.success).length,
      failed: results.filter((r: any) => !r.success).length,
      results,
      parallel,
      timestamp: new Date().toISOString(),
    });
  }, { maxWakeTimeMs: maxWakeTime });
});

async function executeFileOperation(sandbox: any, op: any, env: any, userId: string): Promise<any> {
  const normalizedPath = op.path.startsWith('/') ? op.path : `/${op.path}`;
  
  switch (op.op) {
    case 'read': {
      const result = await sandbox.readFile(normalizedPath);
      return {
        path: normalizedPath,
        op: op.op,
        success: result.success,
        content: result.success && !result.isBinary ? result.content : undefined,
        size: result.size,
        isBinary: result.isBinary,
        error: result.success ? undefined : 'File not found',
      };
    }
    
    case 'write': {
      // Ensure directory exists
      const dirPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/')) || '/';
      if (dirPath !== '/') {
        await sandbox.mkdir(dirPath, { recursive: true });
      }
      
      const result = await sandbox.writeFile(normalizedPath, op.content);
      
      // Sync to R2
      try {
        const r2Key = `users/${userId}${normalizedPath}`;
        await env.MOLTBOT_BUCKET.put(r2Key, op.content);
      } catch (e) {
        // Log but don't fail
        console.log(`[BATCH] R2 sync failed for ${normalizedPath}:`, e);
      }
      
      return {
        path: normalizedPath,
        op: op.op,
        success: result.success,
        bytesWritten: op.content.length,
        error: result.success ? undefined : 'Failed to write',
      };
    }
    
    case 'delete': {
      const result = await sandbox.deleteFile(normalizedPath);
      return {
        path: normalizedPath,
        op: op.op,
        success: result.success,
        error: result.success ? undefined : 'Failed to delete',
      };
    }
    
    case 'exists': {
      const result = await sandbox.exists(normalizedPath);
      return {
        path: normalizedPath,
        op: op.op,
        success: result.success,
        exists: result.exists,
        error: result.success ? undefined : 'Failed to check',
      };
    }
    
    default:
      return {
        path: normalizedPath,
        op: op.op,
        success: false,
        error: 'Unknown operation',
      };
  }
}

// =============================================================================
// IMPROVED EXEC OPERATIONS
// =============================================================================

// POST /api/super/users/:id/exec - Execute command with improved reliability
adminImprovedRouter.post('/users/:id/exec', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { 
    command, 
    timeout = 30000, 
    maxWakeTime = 120000,
    env: cmdEnv,
    stream = false,
    workingDir,
  } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, 400);
  }

  // Validate timeout
  const effectiveTimeout = Math.max(1000, Math.min(timeout, 300000)); // 1s to 5min
  
  return await withWakeAndRetry(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const startTime = Date.now();
      
      // Build command with working directory if specified
      const fullCommand = workingDir 
        ? `cd ${workingDir} && ${command}`
        : command;
      
      const proc = await sandbox.startProcess(fullCommand, { env: cmdEnv });

      // For streaming mode, return immediately with process ID
      if (stream) {
        return c.json({
          userId,
          command: fullCommand,
          processId: proc.id,
          status: 'started',
          stream: true,
          timestamp: new Date().toISOString(),
          pollEndpoint: `/api/super/users/${userId}/exec/${proc.id}/status`,
        });
      }

      // Wait for completion with timeout
      let result;
      try {
        result = await Promise.race([
          proc.waitForExit(effectiveTimeout),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Command timeout after ${effectiveTimeout}ms`)), effectiveTimeout)
          ),
        ]);
      } catch (timeoutError) {
        // Try to kill the process
        try { await proc.kill(); } catch {}
        
        // Get partial logs
        const logs = await proc.getLogs();
        const duration = Date.now() - startTime;
        
        return c.json({
          userId,
          command: fullCommand,
          error: 'Command timed out',
          errorType: 'timeout',
          exitCode: -1,
          stdout: logs.stdout || '',
          stderr: logs.stderr || '',
          partial: true,
          duration,
          timestamp: new Date().toISOString(),
        }, 504);
      }

      const logs = await proc.getLogs();
      const duration = Date.now() - startTime;

      return c.json({
        userId,
        command: fullCommand,
        exitCode: (result as any).exitCode ?? proc.exitCode ?? -1,
        stdout: logs.stdout || '',
        stderr: logs.stderr || '',
        duration,
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Classify error for better client handling
      const isContainerError = 
        errorMessage.includes('sandbox') || 
        errorMessage.includes('hibernat') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('container') ||
        errorMessage.includes('failed to start');
      
      const isTimeoutError = errorMessage.includes('timeout');
      
      let errorType = 'command_error';
      let statusCode = 500;
      
      if (isContainerError) {
        errorType = 'container_error';
        statusCode = 503;
      } else if (isTimeoutError) {
        errorType = 'timeout_error';
        statusCode = 504;
      }
      
      return c.json({
        userId,
        command: fullCommand || command,
        error: errorMessage,
        errorType,
        stdout: '',
        stderr: '',
        timestamp: new Date().toISOString(),
      }, statusCode);
    }
  }, { maxWakeTimeMs: maxWakeTime, retryAttempts: 3 });
});

// GET /api/super/users/:id/exec/:processId/status - Poll streaming exec status
adminImprovedRouter.get('/users/:id/exec/:processId/status', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const processId = c.req.param('processId');
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, false);
    const processes = await sandbox.listProcesses();
    const proc = processes.find((p: any) => p.id === processId);
    
    if (!proc) {
      return c.json({
        userId,
        processId,
        found: false,
        error: 'Process not found (may have completed)',
      }, 404);
    }
    
    const logs = await proc.getLogs();
    
    return c.json({
      userId,
      processId,
      found: true,
      status: proc.status,
      exitCode: proc.exitCode,
      running: proc.status === 'running',
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
      timestamp: new Date().toISOString(),
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      processId,
      error: errorMessage,
    }, 500);
  }
});

// =============================================================================
// DEEP HEALTH CHECK
// =============================================================================

// GET /api/super/users/:id/health - Deep health check
adminImprovedRouter.get('/users/:id/health', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const checks = {
    sandbox: false,
    gateway: false,
    filesystem: false,
    r2: false,
  };
  
  const results: Record<string, any> = {};
  const timings: Record<string, number> = {};
  
  try {
    const startTime = Date.now();
    const sandbox = await getUserSandbox(c.env, userId, false);
    checks.sandbox = true;
    timings.sandbox = Date.now() - startTime;
    
    // Check gateway process
    try {
      const gatewayStart = Date.now();
      const processes = await sandbox.listProcesses();
      const gatewayProcess = processes.find((p: any) => 
        p.command?.includes('clawdbot gateway') && 
        p.status === 'running'
      );
      checks.gateway = !!gatewayProcess;
      timings.gateway = Date.now() - gatewayStart;
      
      results.gatewayProcess = gatewayProcess ? {
        id: gatewayProcess.id,
        status: gatewayProcess.status,
        startTime: gatewayProcess.startTime?.toISOString(),
        command: gatewayProcess.command?.substring(0, 100),
      } : null;
      results.processCount = processes.length;
    } catch (e) {
      results.gatewayError = e instanceof Error ? e.message : 'Unknown';
      timings.gateway = -1;
    }
    
    // Check filesystem responsiveness
    try {
      const fsStart = Date.now();
      const testProc = await sandbox.startProcess('echo "fs-check" && pwd');
      await testProc.waitForExit(5000);
      const logs = await testProc.getLogs();
      checks.filesystem = logs.stdout?.includes('fs-check') ?? false;
      timings.filesystem = Date.now() - fsStart;
      results.workingDir = logs.stdout?.split('\n')[1] || 'unknown';
    } catch (e) {
      results.filesystemError = e instanceof Error ? e.message : 'Unknown';
      timings.filesystem = -1;
    }
    
    // Check R2 connectivity
    try {
      const r2Start = Date.now();
      const syncKey = `users/${userId}/.last-sync`;
      const syncObj = await c.env.MOLTBOT_BUCKET.head(syncKey);
      checks.r2 = !!syncObj;
      timings.r2 = Date.now() - r2Start;
      results.r2LastSync = syncObj?.uploaded;
    } catch (e) {
      results.r2Error = e instanceof Error ? e.message : 'Unknown';
      timings.r2 = -1;
    }
    
    // Check has config
    try {
      const configStart = Date.now();
      const configProc = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "exists"');
      await configProc.waitForExit(2000);
      const logs = await configProc.getLogs();
      results.hasConfig = logs.stdout?.includes('exists') ?? false;
      timings.configCheck = Date.now() - configStart;
    } catch {
      results.hasConfig = false;
      timings.configCheck = -1;
    }
    
    const allHealthy = Object.values(checks).every(Boolean);
    const totalTime = Date.now() - startTime;
    
    return c.json({
      userId,
      healthy: allHealthy,
      checks,
      results,
      timings,
      totalTimeMs: totalTime,
      timestamp: new Date().toISOString(),
    }, allHealthy ? 200 : 503);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      userId,
      healthy: false,
      checks,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    }, 503);
  }
});

export { adminImprovedRouter };
