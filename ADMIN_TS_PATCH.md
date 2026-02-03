# Patch Instructions for admin.ts

This document describes the specific changes needed to apply the robustness improvements to the existing `admin.ts` file.

## Changes to Apply

### 1. Replace the `withWake` function (lines 207-256)

**Replace this:**
```typescript
// Auto-wake middleware helper
async function withWake(env: any, userId: string, operation: () => Promise<Response>): Promise<Response> {
  const sandbox = await getUserSandbox(env, userId, true);
  
  // Check if container needs waking
  let needsWake = false;
  try {
    const processes = await sandbox.listProcesses();
    const gatewayRunning = processes.some((p: any) => 
      p.command?.includes('clawdbot gateway') && 
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
    
    // Wait for it to be ready (max 30s - TOO SHORT!)
    const maxWaitMs = 30000;
    const pollIntervalMs = 1000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        const processes = await sandbox.listProcesses();
        if (processes.some((p: any) => p.command?.includes('clawdbot gateway') && p.status === 'running')) {
          break;
        }
      } catch {}
    }
  }

  return await operation();
}
```

**With this:**
```typescript
// Options for wake and retry
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
    'timeout', 'hibernating', 'not ready', 'connection refused',
    'sandbox_not_found', 'instanceGetTimeout', 'portReadyTimeout',
    'ECONNREFUSED', 'ETIMEDOUT', 'gateway failed to start', 'process not found',
  ];
  const message = error.message.toLowerCase();
  return retryableMessages.some(m => message.includes(m.toLowerCase()));
}

/**
 * Check if container is responsive
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
 * Wake container with extended timeout
 */
async function wakeContainer(env: AppEnv, userId: string, maxWaitMs: number): Promise<void> {
  const { ensureMoltbotGateway } = await import('../gateway');
  console.log(`[WAKE] Waking container for ${userId} (max ${maxWaitMs}ms)...`);
  
  try {
    const sandbox = await getUserSandbox(env, userId, true);
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      try { await proc.kill(); } catch {}
    }
  } catch {}
  
  await new Promise(r => setTimeout(r, 1000));
  
  const sandbox = await getUserSandbox(env, userId, true);
  const bootPromise = ensureMoltbotGateway(sandbox, env, userId).catch((err: Error) => {
    console.error(`[WAKE] Gateway start failed for ${userId}:`, err);
    throw err;
  });
  
  const pollIntervalMs = 2000;
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try {
      const processes = await sandbox.listProcesses();
      const gatewayRunning = processes.some((p: any) => 
        p.command?.includes('clawdbot gateway') && p.status === 'running'
      );
      
      if (gatewayRunning && await checkContainerHealth(sandbox, 5000)) {
        console.log(`[WAKE] Container for ${userId} ready (${Date.now() - startTime}ms)`);
        return;
      }
    } catch {}
  }
  
  throw new Error(`Container failed to become ready within ${maxWaitMs}ms`);
}

/**
 * Improved withWake with retry logic
 */
async function withWake(
  env: AppEnv, 
  userId: string, 
  operation: () => Promise<Response>,
  options: WakeOptions = {}
): Promise<Response> {
  const {
    maxWakeTimeMs = 120_000, // INCREASED from 30s
    healthCheckTimeoutMs = 10_000,
    retryAttempts = 3,
  } = options;

  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      const sandbox = await getUserSandbox(env, userId, true);
      
      let needsWake = false;
      try {
        const processes = await sandbox.listProcesses();
        const gatewayRunning = processes.some((p: any) => 
          p.command?.includes('clawdbot gateway') && p.status === 'running'
        );
        
        if (!gatewayRunning && processes.length === 0) {
          needsWake = true;
        } else if (gatewayRunning) {
          if (!await checkContainerHealth(sandbox, healthCheckTimeoutMs)) {
            needsWake = true;
          }
        } else {
          needsWake = true;
        }
      } catch {
        needsWake = true;
      }

      if (needsWake) {
        await wakeContainer(env, userId, maxWakeTimeMs);
      }

      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableError(lastError)) break;
      
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.log(`[WAKE] Attempt ${attempt + 1}/${retryAttempts} failed, retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return c.json({
    error: 'Container operation failed after retries',
    details: lastError?.message,
    attempts: retryAttempts,
    userId,
  }, 503);
}
```

### 2. Update the file GET endpoint (lines 315-358)

Add R2-first reading before container fallback. Replace the entire endpoint body with:

```typescript
adminRouter.get('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  const source = c.req.query('source') || 'auto'; // 'r2', 'container', 'auto'
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // Try R2 first if auto or r2
  if (source === 'r2' || source === 'auto') {
    try {
      const r2Key = `users/${userId}${normalizedPath}`;
      const r2Obj = await c.env.MOLTBOT_BUCKET.get(r2Key);
      
      if (r2Obj) {
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
    } catch (r2Error) {
      console.log(`[FILES] R2 read failed:`, r2Error);
    }
  }

  // Fallback to container
  if (source === 'container' || source === 'auto') {
    return await withWake(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);
      const result = await sandbox.readFile(normalizedPath);
      
      if (!result.success) {
        return c.json({
          userId,
          path: normalizedPath,
          error: 'File not found',
          source: 'container',
        }, 404);
      }

      return c.json({
        userId,
        path: normalizedPath,
        content: result.content,
        source: 'container',
        size: result.size,
        timestamp: new Date().toISOString(),
      });
    }, { maxWakeTimeMs: 120000 });
  }

  return c.json({ error: 'File not found' }, 404);
});
```

### 3. Update the exec endpoint (lines 262-307)

Add better error classification and timeout handling:

```typescript
adminRouter.post('/users/:id/exec', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { command, timeout = 30000, env: cmdEnv, stream = false } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, 400);
  }

  return await withWake(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const startTime = Date.now();
      const proc = await sandbox.startProcess(command, { env: cmdEnv });

      if (stream) {
        return c.json({
          userId,
          command,
          processId: proc.id,
          status: 'started',
          stream: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Wait with proper timeout
      let result;
      try {
        result = await Promise.race([
          proc.waitForExit(timeout),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Command timeout after ${timeout}ms`)), timeout)
          ),
        ]);
      } catch (timeoutError) {
        try { await proc.kill(); } catch {}
        const logs = await proc.getLogs();
        return c.json({
          userId,
          command,
          error: 'Command timed out',
          errorType: 'timeout',
          exitCode: -1,
          stdout: logs.stdout || '',
          stderr: logs.stderr || '',
          partial: true,
        }, 504);
      }

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
      
      // Better error classification
      const isContainerError = 
        errorMessage.includes('sandbox') || 
        errorMessage.includes('hibernat') ||
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
        command,
        error: errorMessage,
        errorType,
        timestamp: new Date().toISOString(),
      }, statusCode);
    }
  }, { maxWakeTimeMs: 120000, retryAttempts: 3 });
});
```

## Quick Fixes (Minimal Changes)

If you need minimal changes, just make these two edits:

### 1. Change withWake timeout (line 243)
```typescript
// OLD:
const maxWaitMs = 30000;

// NEW:
const maxWakeTimeMs = 120_000; // 120 seconds for cold start
```

### 2. Add R2 fallback to file read (in file GET endpoint, after line 320)
```typescript
// Add this before trying container:
try {
  const r2Key = `users/${userId}/${path}`;
  const r2Obj = await c.env.MOLTBOT_BUCKET.get(r2Key);
  if (r2Obj) {
    const content = await r2Obj.text();
    return c.json({ userId, path, content, source: 'r2' });
  }
} catch {}
```

## Testing the Changes

1. **File read from R2**: Test with hibernating container
   ```bash
   curl -H "X-Admin-Secret: $TOKEN" \
     "https://claw.captainapp.co.uk/api/super/users/USER_ID/files/.clawdbot/clawdbot.json?source=r2"
   ```

2. **Extended timeout exec**: Test with slow command on cold container
   ```bash
   curl -X POST -H "X-Admin-Secret: $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"command": "sleep 5 && echo done", "timeout": 10000}' \
     "https://claw.captainapp.co.uk/api/super/users/USER_ID/exec"
   ```

3. **Retry logic**: Test by killing container mid-operation
   ```bash
   # Start long exec, then kill container via another request
   ```

## Rollback Plan

If issues occur:
1. Revert to original `withWake` function (30s timeout)
2. Remove R2-first logic from file endpoint
3. Keep retry logic as it should be safe

The changes are additive and backward compatible (except for increased timeouts which are actually fixes).
