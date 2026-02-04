# Week 1 Features Enable Guide

## Quick Start

To enable the Week 1 zero-data-loss backup features:

### 1. Edit Configuration

Open `src/config/backup.ts` and change:

```typescript
export const BACKUP_FEATURE_FLAGS = {
  // Phase 1: Critical File Protection (Week 1)
  SHUTDOWN_SYNC: true,           // <-- Change from false to true
  CRITICAL_FILE_PRIORITY: true,  // <-- Change from false to true
  SYNC_VERIFICATION: true,       // <-- Change from false to true
  POST_RESTART_VERIFICATION: true, // <-- Change from false to true
  
  // Phase 2-4: Keep these false for now
  REALTIME_SYNC: false,
  SNAPSHOTS: false,
  WAL: false,
};
```

### 2. Deploy

```bash
npm run deploy
```

### 3. Verify

Check that features are enabled:

```bash
curl "https://claw.captainapp.co.uk/debug/admin/users/YOUR_USER_ID/backup/health" \
  -H "X-Admin-Secret: $MOLTBOT_GATEWAY_MASTER_TOKEN"
```

Response should show:
```json
{
  "features": {
    "shutdownSync": true,
    "criticalFilePriority": true,
    "syncVerification": true
  }
}
```

## Feature Descriptions

### SHUTDOWN_SYNC
Ensures data is synced to R2 before container restart.

**When it runs:**
- Before every container restart (manual or auto-restart)
- On SIGTERM/SIGINT signals in the container

**What it does:**
1. Syncs critical files (credentials, config) first
2. Syncs remaining files
3. Blocks restart until sync completes or timeout (30s)

### CRITICAL_FILE_PRIORITY
Syncs credential files before other data.

**When it runs:**
- Every cron sync (every minute)
- During shutdown sync

**What it does:**
1. Syncs `/root/.clawdbot/credentials/` first
2. Syncs `clawdbot.json` and `.registered`
3. Then syncs workspace files

### SYNC_VERIFICATION
Verifies that files were actually written to R2.

**When it runs:**
- Manual verification via API
- Can be scheduled via cron (future enhancement)

**What it does:**
1. Checks R2 for expected files
2. Compares checksums
3. Reports missing critical files

## Testing

### Test 1: Restart with Credential Survival

```bash
# Create a test credential file
kubectl exec -it moltbot-pod -- bash -c "echo '{\"test\": true}' > /root/.clawdbot/credentials/test.json"

# Restart the container
curl -X POST "https://claw.captainapp.co.uk/debug/admin/users/USER_ID/restart" \
  -H "X-Admin-Secret: $TOKEN"

# Verify the file survived
curl "https://claw.captainapp.co.uk/debug/admin/users/USER_ID/files/root/.clawdbot/credentials/test.json" \
  -H "X-Admin-Secret: $TOKEN"
```

### Test 2: Missing Credential Detection

```bash
# Check for missing files
curl "https://claw.captainapp.co.uk/debug/admin/users/USER_ID/backup/critical" \
  -H "X-Admin-Secret: $TOKEN"
```

### Test 3: Sync Prioritization

```bash
# Watch cron logs
wrangler tail
# Look for:
# [cron] Critical files synced for openclaw-USER_ID in Xms
# [cron] Synced openclaw-USER_ID: N files in Xms
```

## Monitoring

### Key Metrics to Watch

1. **Shutdown sync success rate**
   - Check restart responses for `shutdownSync.success: true`

2. **Missing critical files**
   - Query `/debug/admin/users/:id/backup/critical` periodically
   - Should always show `allCriticalFilesPresent: true`

3. **Sync latency**
   - Critical sync should complete in < 15s
   - Full sync should complete in < 30s

### Alerting

If `alertIfMissingCriticalFiles()` detects missing files:
- Log entry: `[Alert] User XXX has N missing critical files`
- Can be extended to send Telegram/Slack notifications

## Rollback

If issues occur, disable features immediately:

```typescript
// src/config/backup.ts
export const BACKUP_FEATURE_FLAGS = {
  SHUTDOWN_SYNC: false,
  CRITICAL_FILE_PRIORITY: false,
  SYNC_VERIFICATION: false,
  POST_RESTART_VERIFICATION: false,
  // ...
};
```

Deploy the change:
```bash
npm run deploy
```

## Troubleshooting

### Issue: Shutdown sync timing out
**Solution:** Increase timeout in `src/config/backup.ts`:
```typescript
SHUTDOWN_CONFIG.timeoutMs = 45_000; // 45 seconds
```

### Issue: Critical files not being detected
**Solution:** Check path patterns in `src/config/backup.ts`:
```typescript
export const CRITICAL_PATHS = [
  '/root/.clawdbot/credentials/**/*.json',
  '/root/.clawdbot/clawdbot.json',
  // Add more patterns if needed
];
```

### Issue: Verification failing
**Solution:** Check R2 connectivity:
```bash
curl "https://claw.captainapp.co.uk/debug/admin/users/USER_ID/backup/health" \
  -H "X-Admin-Secret: $TOKEN" | jq '.r2Connected'
```

## Support

For issues or questions:
1. Check the Week 1 implementation doc: `/brain/projects/moltworker-week1-implementation.md`
2. Review the design doc: `/brain/projects/moltworker-zero-data-loss-backup-design.md`
3. Check cron logs: `wrangler tail`
