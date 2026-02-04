import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncToR2 } from './sync';
import {
  createMockEnv,
  createMockEnvWithR2,
  createMockProcess,
  createMockSandbox,
  suppressConsole
} from '../test-utils';

describe('syncToR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('configuration checks', () => {
    it('returns error when R2 is not configured', async () => {
      const { sandbox } = createMockSandbox();
      const env = createMockEnv();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('R2 storage is not configured');
      expect(result.syncId).toBeDefined(); // Should still have syncId
    });

    it('returns error when mount fails', async () => {
      const { sandbox, startProcessMock, mountBucketMock } = createMockSandbox();
      startProcessMock.mockResolvedValue(createMockProcess(''));
      mountBucketMock.mockRejectedValue(new Error('Mount failed'));

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to mount R2 storage');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('sanity checks', () => {
    it('returns error when config appears empty or invalid', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('s3fs on /data/moltbot type fuse.s3fs\n'))
        .mockResolvedValueOnce(createMockProcess('')); // No "ok" output

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync aborted: config appears empty or invalid');
      expect(result.details).toContain('Local openclaw.json exists');
    });
  });

  describe('sync execution', () => {
    it('returns success when sync completes', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';
      let capturedSyncId = '';

      // Calls: mount check, sanity check, pkill stale rsync, file count before, rsync, verify sync ID, file count after
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('s3fs on /data/openclaw type fuse.s3fs\n'))
        .mockResolvedValueOnce(createMockProcess('ok'))
        .mockResolvedValueOnce(createMockProcess('')) // pkill stale rsync
        .mockResolvedValueOnce(createMockProcess('15')) // file count before
        .mockImplementationOnce((cmd: string) => {
          // Capture the syncId from the rsync command
          const match = cmd.match(/sync-\d+-[a-z0-9]+/);
          capturedSyncId = match?.[0] || 'sync-test-123';
          return Promise.resolve(createMockProcess('', { exitCode: 0 }));
        })
        .mockImplementationOnce((cmd: string) => {
          // Return the captured syncId
          return Promise.resolve(createMockProcess(`${capturedSyncId}|${timestamp}`));
        })
        .mockResolvedValueOnce(createMockProcess('15')); // file count after

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.lastSync).toBe(timestamp);
      expect(result.syncId).toMatch(/^sync-\d+-[a-z0-9]+$/);
      expect(result.rsyncExitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns error when rsync fails with non-zero exit code', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();

      // Calls: mount check, sanity check, pkill stale rsync, file count, rsync (fails), verify (wrong syncId)
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('s3fs on /data/openclaw type fuse.s3fs\n'))
        .mockResolvedValueOnce(createMockProcess('ok'))
        .mockResolvedValueOnce(createMockProcess('')) // pkill stale rsync
        .mockResolvedValueOnce(createMockProcess('15'))
        .mockResolvedValueOnce(createMockProcess('rsync error', { exitCode: 1, stderr: 'rsync error' }))
        .mockResolvedValueOnce(createMockProcess('wrong-sync-id|2026-01-27T12:00:00+00:00'));

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync verification failed');
      expect(result.rsyncExitCode).toBe(1);
    });

    it('returns error when sync ID verification fails', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();

      // Rsync succeeds but sync ID doesn't match (indicates write failed)
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('s3fs on /data/openclaw type fuse.s3fs\n'))
        .mockResolvedValueOnce(createMockProcess('ok'))
        .mockResolvedValueOnce(createMockProcess('')) // pkill stale rsync
        .mockResolvedValueOnce(createMockProcess('15'))
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        .mockResolvedValueOnce(createMockProcess('different-id|2026-01-27T12:00:00+00:00'));

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Sync verification failed');
    });

    it('verifies rsync command is called with correct flags', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';

      startProcessMock
        .mockResolvedValueOnce(createMockProcess('s3fs on /data/openclaw type fuse.s3fs\n'))
        .mockResolvedValueOnce(createMockProcess('ok'))
        .mockResolvedValueOnce(createMockProcess('')) // pkill stale rsync
        .mockResolvedValueOnce(createMockProcess('15'))
        .mockImplementationOnce((cmd: string) => {
          // Return process with the syncId from the command
          return Promise.resolve(createMockProcess('', { exitCode: 0 }));
        })
        .mockImplementationOnce((cmd: string) => {
          // Extract syncId from previous command and return it (call index 4 now due to pkill)
          const syncIdMatch = startProcessMock.mock.calls[4]?.[0]?.match(/sync-\d+-[a-z0-9]+/);
          const syncId = syncIdMatch?.[0] || 'sync-test-123';
          return Promise.resolve(createMockProcess(`${syncId}|${timestamp}`));
        })
        .mockResolvedValueOnce(createMockProcess('15'));

      const env = createMockEnvWithR2();

      await syncToR2(sandbox, env);

      // Fifth call should be rsync (after mount check, sanity check, pkill, file count)
      const rsyncCall = startProcessMock.mock.calls[4][0];
      expect(rsyncCall).toContain('rsync');
      expect(rsyncCall).toContain('--no-times');
      expect(rsyncCall).toContain('--delete');
      expect(rsyncCall).toContain('/root/.openclaw/');
      expect(rsyncCall).toContain('/data/openclaw/');
      // Should include sync ID in the timestamp file
      expect(rsyncCall).toMatch(/echo "sync-\d+-[a-z0-9]+\|/);
    });

    it('includes file count in successful result', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      const timestamp = '2026-01-27T12:00:00+00:00';

      startProcessMock
        .mockResolvedValueOnce(createMockProcess('s3fs on /data/openclaw type fuse.s3fs\n'))
        .mockResolvedValueOnce(createMockProcess('ok'))
        .mockResolvedValueOnce(createMockProcess('')) // pkill stale rsync
        .mockResolvedValueOnce(createMockProcess('25')) // file count before
        .mockImplementationOnce((cmd: string) => {
          return Promise.resolve(createMockProcess('', { exitCode: 0 }));
        })
        .mockImplementationOnce((cmd: string) => {
          // Extract syncId from previous command (call index 4 now due to pkill)
          const syncIdMatch = startProcessMock.mock.calls[4]?.[0]?.match(/sync-\d+-[a-z0-9]+/);
          const syncId = syncIdMatch?.[0] || 'sync-test-123';
          return Promise.resolve(createMockProcess(`${syncId}|${timestamp}`));
        })
        .mockResolvedValueOnce(createMockProcess('25')); // file count after

      const env = createMockEnvWithR2();

      const result = await syncToR2(sandbox, env);

      expect(result.success).toBe(true);
      expect(result.fileCount).toBe(25);
    });
  });
});
