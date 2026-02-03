# Moltworker API Robustness Analysis

## Executive Summary

The Moltworker platform admin APIs have reliability issues due to architectural gaps in how container state transitions are handled. The root causes are:

1. **File API 404s**: No R2 fallback when container filesystem is out of sync
2. **Exec timeouts**: Timeout mismatches between wake time (30s) and startup time (180s)
3. **Intermittent failures**: Lack of retry logic and race conditions in container wake
4. **No progressive degradation**: APIs fail hard instead of degrading gracefully

## Root Cause Analysis

### Issue 1: File Fetch API Returns 404 for Existing Files

**Location**: `/repos/moltworker/src/routes/admin.ts` lines 312-358

```typescript
// GET /api/super/users/:id/files/:path{.+}
const result = await sandbox.readFile(path);
```

**Problem**: The file API only reads from the container filesystem. When:
- Container is hibernating (files not loaded from R2 yet)
- R2 sync failed or is stale
- Container was restarted and files haven't been restored

The API returns 404 even though the file exists in R2 backup.

**Evidence**: The debug endpoints (`debug.ts` lines 801-900) show R2-first pattern works, but admin.ts doesn't use it.

### Issue 2: Exec API Frequent Timeouts

**Location**: `/repos/moltworker/src/routes/admin.ts` lines 262-307

```typescript
const { command, timeout = 30000, env: cmdEnv } = body;
```

**Problem**: 
1. Default timeout (30s) is less than max wake time (30s) + startup time (up to 180s)
2. The `withWake` function polls for max 30s, but startup can take 60-180s
3. When startup exceeds wake poll, exec starts on a non-ready container
4. No timeout extension mechanism for long-running commands

**Evidence**: 
- `STARTUP_TIMEOUT_MS = 180_000` in `config.ts`
- `withWake` max wait is 30s (line 240 in admin.ts)

### Issue 3: Intermittent Failures - Race Conditions

**Location**: `/repos/moltworker/src/routes/admin.ts` lines 207-256

```typescript
async function withWake(env: any, userId: string, operation: () => Promise<Response>) {
  // Check if container needs waking
  let needsWake = false;
  // ... wake logic with 30s timeout
  return await operation();
}
```

**Problems**:
1. `needsWake` check and actual wake are not atomic
2. No retry logic for transient sandbox SDK errors
3. Sandbox instance might be hibernating between check and operation
4. No exponential backoff for SDK failures

**Evidence**: Debug endpoints show "sandbox_not_found" errors intermittently.

### Issue 4: Why State Check Works But File/Exec Don't

**Working endpoint** (`/api/super/users/:id/state/v2`):
```typescript
const sandbox = await getUserSandbox(env, userId, false);
const processes = await sandbox.listProcesses(); // Lightweight, works on hibernating
```

**Failing endpoints** (`/files/:path`, `/exec`):
```typescript
await withWake(c.env, userId, async () => {
  const sandbox = await getUserSandbox(c.env, userId, true); // Requires active container
  const result = await sandbox.readFile(path); // Requires responsive filesystem
});
```

**Key difference**: 
- `listProcesses()` works on hibernating containers (just returns empty array)
- `readFile()` and `startProcess()` require active container with responsive filesystem

## Proposed Fixes

### Fix 1: R2-First File Operations with Container Fallback

**New approach**: Try R2 first, then container if R2 fails.

```typescript
// GET /api/super/users/:id/files/:path{.+}
adminRouter.get('/users/:id/files/:path{.+}', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const path = c.req.param('path') || '';
  const prefer = c.req.query('prefer') || 'auto'; // 'r2', 'container', 'auto'
  
  if (!path) {
    return c.json({ error: 'File path is required' }, 400);
  }

  // R2-first: Try R2 backup first (faster, more reliable)
  if (prefer === 'r2' || prefer === 'auto') {
    try {
      const r2Key = `users/${userId}${path.startsWith('/') ? '' : '/'}${path}`;
      const r2Obj = await c.env.MOLTBOT_BUCKET.get(r2Key);
      
      if (r2Obj) {
        const content = await r2Obj.text();
        return c.json({
          userId,
          path,
          content,
          source: 'r2',
          size: content.length,
          lastModified: r2Obj.uploaded,
        });
      }
    } catch (r2Error) {
      console.log(`[FILES] R2 read failed for ${path}:`, r2Error);
      // Fall through to container
    }
  }

  // Container fallback: Read from active container
  if (prefer === 'container' || prefer === 'auto') {
    return await withWakeAndRetry(c.env, userId, async () => {
      const sandbox = await getUserSandbox(c.env, userId, true);
      const result = await sandbox.readFile(path);
      
      if (!result.success) {
        return c.json({
          userId,
          path,
          error: 'File not found in container or R2',
        }, 404);
      }

      return c.json({
        userId,
        path,
        content: result.content,
        source: 'container',
        size: result.size,
      });
    });
  }

  return c.json({ error: 'File not found in R2 or container' }, 404);
});
```

### Fix 2: Improved withWake with Extended Timeout and Health Check

```typescript
interface WakeOptions {
  maxWakeTimeMs?: number;
  healthCheckTimeoutMs?: number;
  retryAttempts?: number;
}

async function withWakeAndRetry(
  env: AppEnv, 
  userId: string, 
  operation: () => Promise<Response>,
  options: WakeOptions = {}
): Promise<Response> {
  const {
    maxWakeTimeMs = 120_000, // Increased from 30s to 120s
    healthCheckTimeoutMs = 30_000,
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
        // Quick health check - list processes (lightweight)
        const processes = await sandbox.listProcesses();
        const gatewayRunning = processes.some((p: any) => 
          p.command?.includes('clawdbot gateway') && 
          p.status === 'running'
        );
        
        if (!gatewayRunning && processes.length === 0) {
          needsWake = true;
        } else {
          // Gateway appears running, verify it's responsive
          isResponsive = await checkContainerHealth(sandbox, healthCheckTimeoutMs);
          if (!isResponsive) {
            needsWake = true; // Gateway stuck, needs restart
          }
        }
      } catch {
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
        break; // Don't retry on permanent errors
      }
      
      // Exponential backoff before retry
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.log(`[WAKE] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // All retries exhausted
  return new Response(
    JSON.stringify({
      error: 'Container operation failed after retries',
      details: lastError?.message,
      attempts: retryAttempts,
    }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

async function checkContainerHealth(sandbox: any, timeoutMs: number): Promise<boolean> {
  try {
    // Test with a simple command that should always work
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

function isRetryableError(error: Error): boolean {
  const retryableMessages = [
    'timeout',
    'hibernating',
    'not ready',
    'connection refused',
    'sandbox_not_found',
    'instanceGetTimeout',
    'portReadyTimeout',
  ];
  
  const message = error.message.toLowerCase();
  return retryableMessages.some(m => message.includes(m));
}

async function wakeContainer(env: AppEnv, userId: string, maxWaitMs: number): Promise<void> {
  const { ensureMoltbotGateway } = await import('../gateway');
  
  console.log(`[WAKE] Waking container for ${userId}...`);
  
  // Kill stale processes
  try {
    const sandbox = await getUserSandbox(env, userId, true);
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      try { await proc.kill(); } catch {}
    }
  } catch {}
  
  await new Promise(r => setTimeout(r, 1000));
  
  // Start gateway
  const sandbox = await getUserSandbox(env, userId, true);
  const bootPromise = ensureMoltbotGateway(sandbox, env, userId);
  
  // Wait for gateway to be ready
  const pollIntervalMs = 2000;
  const startTime = Date.now();
  
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
          console.log(`[WAKE] Container for ${userId} is ready`);
          return;
        }
      }
    } catch {
      // Continue polling
    }
  }
  
  throw new Error(`Container failed to become ready within ${maxWaitMs}ms`);
}
```

### Fix 3: Exec API with Adaptive Timeout and Streaming

```typescript
// POST /api/super/users/:id/exec - Execute command with auto-wake
adminRouter.post('/users/:id/exec', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { 
    command, 
    timeout = 30000, 
    maxWakeTime = 120000,
    env: cmdEnv,
    stream = false,
  } = body;

  if (!command || typeof command !== 'string') {
    return c.json({ error: 'Command is required' }, 400);
  }

  // Adaptive timeout: allow longer timeouts for waking containers
  const effectiveTimeout = Math.max(timeout, maxWakeTime + 10000);

  return await withWakeAndRetry(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    
    try {
      const startTime = Date.now();
      const proc = await sandbox.startProcess(command, { env: cmdEnv });

      // For streaming responses, return early with process ID
      if (stream) {
        return c.json({
          userId,
          command,
          processId: proc.id,
          status: 'started',
          timestamp: new Date().toISOString(),
        });
      }

      // Wait for completion with timeout
      const result = await Promise.race([
        proc.waitForExit(timeout),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Command timeout after ${timeout}ms`)), timeout)
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
      
      // Distinguish between container errors and command errors
      const isContainerError = errorMessage.includes('sandbox') || 
                               errorMessage.includes('hibernat') ||
                               errorMessage.includes('not found');
      
      const statusCode = isContainerError ? 503 : 500;
      
      return c.json({
        userId,
        command,
        error: errorMessage,
        errorType: isContainerError ? 'container_error' : 'command_error',
        stdout: '',
        stderr: '',
        timestamp: new Date().toISOString(),
      }, statusCode);
    }
  }, { maxWakeTimeMs: maxWakeTime, retryAttempts: 3 });
});
```

### Fix 4: Batch Operations for Better Performance

```typescript
// POST /api/super/users/:id/files/batch - Batch file operations
adminRouter.post('/users/:id/files/batch', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { operations } = body; // Array of { op: 'read'|'write'|'delete', path, content? }

  if (!Array.isArray(operations) || operations.length === 0) {
    return c.json({ error: 'operations array is required' }, 400);
  }

  if (operations.length > 50) {
    return c.json({ error: 'Maximum 50 operations per batch' }, 400);
  }

  return await withWakeAndRetry(c.env, userId, async () => {
    const sandbox = await getUserSandbox(c.env, userId, true);
    const results = [];
    
    // Execute operations sequentially to avoid overwhelming container
    for (const op of operations) {
      try {
        let result;
        switch (op.op) {
          case 'read':
            result = await sandbox.readFile(op.path);
            break;
          case 'write':
            result = await sandbox.writeFile(op.path, op.content);
            break;
          case 'delete':
            result = await sandbox.deleteFile(op.path);
            break;
          default:
            result = { success: false, error: 'Unknown operation' };
        }
        results.push({ path: op.path, op: op.op, ...result });
      } catch (error) {
        results.push({
          path: op.path,
          op: op.op,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return c.json({
      userId,
      completed: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    });
  });
});
```

### Fix 5: Health Check Endpoint Improvements

```typescript
// GET /api/super/users/:id/health - Deep health check
adminRouter.get('/users/:id/health', requireSuperAuth, async (c) => {
  const userId = c.req.param('id');
  const checks = {
    sandbox: false,
    gateway: false,
    filesystem: false,
    r2: false,
  };
  
  const results: Record<string, any> = {};
  
  try {
    const sandbox = await getUserSandbox(c.env, userId, false);
    checks.sandbox = true;
    
    // Check gateway process
    try {
      const processes = await sandbox.listProcesses();
      const gatewayProcess = processes.find((p: any) => 
        p.command?.includes('clawdbot gateway') && 
        p.status === 'running'
      );
      checks.gateway = !!gatewayProcess;
      results.gatewayProcess = gatewayProcess ? {
        id: gatewayProcess.id,
        startTime: gatewayProcess.startTime?.toISOString(),
      } : null;
    } catch (e) {
      results.gatewayError = e instanceof Error ? e.message : 'Unknown';
    }
    
    // Check filesystem responsiveness
    try {
      const testProc = await sandbox.startProcess('echo "fs-check"');
      await testProc.waitForExit(5000);
      const logs = await testProc.getLogs();
      checks.filesystem = logs.stdout?.includes('fs-check') ?? false;
    } catch (e) {
      results.filesystemError = e instanceof Error ? e.message : 'Unknown';
    }
    
    // Check R2 connectivity
    try {
      const syncKey = `users/${userId}/.last-sync`;
      const syncObj = await c.env.MOLTBOT_BUCKET.head(syncKey);
      checks.r2 = !!syncObj;
      results.r2LastSync = syncObj?.uploaded;
    } catch (e) {
      results.r2Error = e instanceof Error ? e.message : 'Unknown';
    }
    
    const allHealthy = Object.values(checks).every(Boolean);
    
    return c.json({
      userId,
      healthy: allHealthy,
      checks,
      results,
      timestamp: new Date().toISOString(),
    }, allHealthy ? 200 : 503);
    
  } catch (error) {
    return c.json({
      userId,
      healthy: false,
      checks,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    }, 503);
  }
});
```

## Test Plan

### Unit Tests

1. **File API Tests**:
```typescript
describe('File API', () => {
  it('should read file from R2 when container is hibernating', async () => {
    // Mock container hibernating, R2 has file
    // Expect: 200 with file content from R2
  });
  
  it('should fallback to container when R2 file not found', async () => {
    // Mock R2 missing, container has file
    // Expect: 200 with file content from container
  });
  
  it('should return 404 when file not in R2 or container', async () => {
    // Both missing
    // Expect: 404
  });
});
```

2. **Exec API Tests**:
```typescript
describe('Exec API', () => {
  it('should handle container wake within extended timeout', async () => {
    // Container needs 60s to wake
    // Expect: 200 with command result
  });
  
  it('should return 503 for container errors vs 500 for command errors', async () => {
    // Test error classification
  });
  
  it('should support streaming mode', async () => {
    // Long-running command
    // Expect: immediate 200 with processId
  });
});
```

3. **Retry Logic Tests**:
```typescript
describe('Retry Logic', () => {
  it('should retry on transient sandbox errors', async () => {
    // First 2 calls fail, 3rd succeeds
    // Expect: eventual success
  });
  
  it('should not retry on permanent errors', async () => {
    // Invalid command
    // Expect: immediate failure
  });
});
```

### Integration Tests

1. **End-to-End Container Lifecycle**:
   - Stop container
   - Call file API (should wake and return file)
   - Call exec API (should work immediately)
   - Let container hibernate
   - Call file API again (should wake again)

2. **Load Testing**:
   - 10 concurrent file reads
   - 10 concurrent exec commands
   - Measure wake time, success rate, latency

3. **Failure Injection**:
   - Block R2 access (should still work via container)
   - Kill gateway mid-operation (should retry)
   - Timeout scenarios

### Manual Testing Checklist

- [ ] File read returns content from hibernating container via R2
- [ ] File write syncs to both container and R2
- [ ] Exec works on freshly restarted container
- [ ] Exec streaming mode returns process ID immediately
- [ ] Batch operations complete all 50 ops successfully
- [ ] Health check shows accurate status for each component
- [ ] Retry logic handles 3 consecutive failures gracefully
- [ ] Timeout errors are distinguishable from command errors

## Migration Plan

### Phase 1: Non-Breaking Improvements (Immediate)
1. Add R2-first file reading (new query param `?source=r2`)
2. Increase `withWake` timeout to 120s
3. Add retry logic (3 attempts with backoff)
4. Improve error messages and status codes

### Phase 2: New Features (Week 2)
1. Add streaming exec mode
2. Add batch file operations
3. Add deep health check endpoint

### Phase 3: Breaking Changes (If Needed)
1. Change default file source to R2-first
2. Increase default exec timeout
3. Remove deprecated endpoints

## Configuration Changes

Add to `wrangler.toml`:

```toml
[vars]
# Container wake timeout (was 30s, now 120s)
SANDBOX_WAKE_TIMEOUT_MS = 120000

# Default exec timeout (was 30s, now 60s for short ops)
DEFAULT_EXEC_TIMEOUT_MS = 60000

# Max exec timeout for long operations
MAX_EXEC_TIMEOUT_MS = 300000

# Retry configuration
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY_MS = 1000
```

## Monitoring Recommendations

1. **Metrics to Track**:
   - Container wake time (p50, p95, p99)
   - File API source distribution (R2 vs container)
   - Exec timeout rate
   - Retry success rate
   - Sandbox SDK error types

2. **Alerts**:
   - Wake time > 90s (p99)
   - File API 404 rate > 5%
   - Exec timeout rate > 10%
   - Retry exhaustion rate > 1%

## Conclusion

The API reliability issues stem from a fundamental architectural assumption: that containers are always ready. The fixes introduce:

1. **Graceful degradation**: R2 fallback when container is unavailable
2. **Extended timeouts**: 120s wake time to handle cold starts
3. **Resilience**: Retry logic with exponential backoff
4. **Observability**: Better error classification and health checks

These changes will make the admin APIs reliable for container management while maintaining backward compatibility.
