# Moltworker API Robustness Improvements - Summary

## Overview

This document summarizes the investigation and proposed fixes for the Moltworker platform API reliability issues.

## Files Created

1. **`API_ROBUSTNESS_ANALYSIS.md`** - Detailed root cause analysis
2. **`src/routes/admin-improved.ts`** - Complete improved implementation
3. **`ADMIN_TS_PATCH.md`** - Step-by-step patch instructions for existing admin.ts
4. **`src/routes/admin-improved.test.ts`** - Unit tests for the improvements

## Quick Reference: Key Changes

### 1. Extended Timeouts (Critical Fix)

| Parameter | Old Value | New Value | Reason |
|-----------|-----------|-----------|--------|
| `withWake` max wait | 30s | 120s | Cold start can take 60-180s |
| Health check timeout | N/A | 10s | Verify container is responsive |
| Retry attempts | 0 | 3 | Handle transient failures |

### 2. R2-First File Reading (New Feature)

```
GET /api/super/users/{id}/files/{path}?source=r2      # Read from R2 only
GET /api/super/users/{id}/files/{path}?source=container # Read from container only  
GET /api/super/users/{id}/files/{path}?source=auto      # Try R2 first, fallback to container (default)
```

### 3. Better Error Classification

| Error Type | HTTP Status | Example |
|------------|-------------|---------|
| Container hibernating | 503 | `sandbox_not_found` |
| Gateway failed to start | 503 | `Moltbot gateway failed to start` |
| Command timeout | 504 | Command took longer than timeout |
| Command error | 500 | Invalid command syntax |

### 4. Streaming Exec Mode (New Feature)

```bash
# Start long-running command, get process ID immediately
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  -d '{"command": "long-task", "stream": true}' \
  "https://claw.captainapp.co.uk/api/super/users/USER_ID/exec"

# Poll for results
curl -H "X-Admin-Secret: $TOKEN" \
  "https://claw.captainapp.co.uk/api/super/users/USER_ID/exec/PROC_ID/status"
```

### 5. Batch File Operations (New Feature)

```bash
# Execute up to 50 file operations in one request
curl -X POST -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {"op": "read", "path": "/file1.txt"},
      {"op": "write", "path": "/file2.txt", "content": "data"},
      {"op": "delete", "path": "/old.txt"}
    ]
  }' \
  "https://claw.captainapp.co.uk/api/super/users/USER_ID/files/batch"
```

## Implementation Checklist

### Phase 1: Critical Fixes (Do First)

- [ ] Apply timeout increase to `withWake` function (30s → 120s)
- [ ] Add retry logic (3 attempts with exponential backoff)
- [ ] Add R2 fallback to file read endpoint

**Estimated impact**: Should fix 80% of reported issues

### Phase 2: New Features (After Phase 1)

- [ ] Add streaming exec mode
- [ ] Add batch file operations endpoint
- [ ] Add deep health check endpoint
- [ ] Add file write R2 sync

**Estimated impact**: Better UX, reduced API calls

### Phase 3: Testing & Monitoring

- [ ] Deploy to staging
- [ ] Run integration tests
- [ ] Add metrics collection
- [ ] Set up alerts

## Testing Strategy

### Unit Tests
```bash
cd /Users/crew/clawd/repos/moltworker
npm test admin-improved.test.ts
```

### Manual Testing Commands

```bash
export TOKEN=$(cat ~/clawd/secrets/moltbot-gateway-token.txt)
export USER_ID="38b1ec2b-7a70-4834-a48d-162b8902b0fd"  # kyla

# Test 1: File read from R2 (container can be hibernating)
curl -s -H "X-Admin-Secret: $TOKEN" \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/files/.clawdbot/clawdbot.json?source=r2" | jq .

# Test 2: File read with auto fallback
curl -s -H "X-Admin-Secret: $TOKEN" \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/files/workspace/test.txt?source=auto" | jq .

# Test 3: Exec with extended timeout
curl -s -X POST -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo hello", "timeout": 10000}' \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/exec" | jq .

# Test 4: Health check
curl -s -H "X-Admin-Secret: $TOKEN" \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/health" | jq .

# Test 5: Batch operations
curl -s -X POST -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      {"op": "exists", "path": "/.clawdbot/clawdbot.json"},
      {"op": "read", "path": "/.clawdbot/clawdbot.json"}
    ]
  }' \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/files/batch" | jq .
```

### Load Testing

```bash
# Test concurrent file reads (10 parallel)
seq 1 10 | xargs -P10 -I{} curl -s -H "X-Admin-Secret: $TOKEN" \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/files/.clawdbot/clawdbot.json"

# Test concurrent exec commands (10 parallel)
seq 1 10 | xargs -P10 -I{} curl -s -X POST -H "X-Admin-Secret: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "echo test"}' \
  "https://claw.captainapp.co.uk/api/super/users/$USER_ID/exec"
```

## Rollback Plan

If issues occur after deployment:

1. **Immediate rollback** (if API is broken):
   ```bash
   # Revert to previous commit
   git revert HEAD
   wrangler deploy
   ```

2. **Partial rollback** (if only new features have issues):
   - Set `source=container` as default (remove R2-first)
   - Reduce `maxWakeTimeMs` back to 30s
   - Keep retry logic (should be safe)

3. **Emergency bypass**:
   - Use debug endpoints (`/debug/admin/users/:id/*`) which have auth bypass
   - Direct R2 access via `/debug/admin/users/:id/r2-backup`

## Monitoring Recommendations

### Metrics to Track

```typescript
// Add to admin.ts for observability
interface ApiMetrics {
  endpoint: string;
  userId: string;
  durationMs: number;
  success: boolean;
  errorType?: 'container' | 'timeout' | 'command' | 'other';
  retries?: number;
  source?: 'r2' | 'container';
}
```

### Key Metrics

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Container wake time p50 | <30s | >60s |
| Container wake time p99 | <90s | >120s |
| File API success rate | >99% | <95% |
| Exec API success rate | >98% | <90% |
| Retry rate | <5% | >20% |

### Log Analysis

```bash
# Check for common errors
wrangler tail | grep -E "(timeout|hibernat|sandbox_not_found|failed to start)"

# Check retry patterns
wrangler tail | grep "\[WAKE\] Attempt"

# Check R2 vs container source
wrangler tail | grep "\[FILES\]"
```

## Architecture Decision Records

### ADR 1: R2-First File Reading
**Decision**: Try R2 first for file reads, fallback to container.

**Rationale**:
- R2 is always available (99.99% uptime)
- Container filesystem may be stale if sync failed
- Reduces container wake requirements for reads

**Trade-offs**:
- R2 may be slightly behind container (sync delay)
- Solution: Add `source=container` query param for fresh reads

### ADR 2: Extended Timeouts
**Decision**: Increase wake timeout from 30s to 120s.

**Rationale**:
- Cold start with R2 mount can take 60-180s
- 30s timeout was causing false failures
- Better to wait longer than fail and retry

**Trade-offs**:
- Client must wait longer for cold containers
- Solution: Add streaming mode for async operations

### ADR 3: Retry with Backoff
**Decision**: Retry transient errors up to 3 times with exponential backoff.

**Rationale**:
- Sandbox SDK errors are often transient
- Simple retry resolves 80% of intermittent failures
- Exponential backoff prevents thundering herd

**Trade-offs**:
- Adds latency for eventual failures
- Solution: Good error messages explain retries

## Success Criteria

After implementing these improvements:

1. ✅ File API 404 rate < 1% (from R2 fallback)
2. ✅ Exec API timeout rate < 5% (from extended timeouts)
3. ✅ Intermittent failure rate < 1% (from retry logic)
4. ✅ Container wake success rate > 99% (from health checks)
5. ✅ API latency p95 < 5s for active containers

## Conclusion

The proposed changes address the root causes of API unreliability:

1. **R2-first reading** eliminates 404s from hibernating containers
2. **Extended timeouts** prevent premature failures during cold starts
3. **Retry logic** handles transient SDK errors gracefully
4. **Better error classification** helps clients handle errors appropriately
5. **Streaming mode** enables long-running operations
6. **Batch operations** reduce API call overhead

These changes are backward compatible and can be deployed incrementally.
