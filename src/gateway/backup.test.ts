import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDailyBackup, listBackupDates, restoreUserFromBackup } from './backup';
import { createMockEnv } from '../test-utils';

type StoredObject = {
  body: ArrayBuffer;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
};

function textToArrayBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

function createInMemoryR2Bucket(initial: Record<string, { text: string; httpMetadata?: any; customMetadata?: any }> = {}) {
  const store = new Map<string, StoredObject>();
  for (const [key, value] of Object.entries(initial)) {
    store.set(key, {
      body: textToArrayBuffer(value.text),
      httpMetadata: value.httpMetadata,
      customMetadata: value.customMetadata,
    });
  }

  const bucket = {
    get: vi.fn(async (key: string) => {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        arrayBuffer: async () => obj.body,
        text: async () => new TextDecoder().decode(obj.body),
      };
    }),
    put: vi.fn(async (key: string, value: ArrayBuffer | string, options?: any) => {
      const body = typeof value === 'string' ? textToArrayBuffer(value) : value;
      store.set(key, {
        body,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(
      async (opts: { prefix?: string; delimiter?: string; cursor?: string }) => {
        const prefix = opts.prefix || '';
        const keys = Array.from(store.keys()).filter(k => k.startsWith(prefix));

        if (opts.delimiter) {
          const delimitedPrefixes = new Set<string>();
          for (const key of keys) {
            const rest = key.slice(prefix.length);
            const idx = rest.indexOf(opts.delimiter);
            if (idx >= 0) {
              delimitedPrefixes.add(prefix + rest.slice(0, idx + 1));
            }
          }
          return {
            objects: [] as Array<{ key: string; size: number }>,
            delimitedPrefixes: Array.from(delimitedPrefixes),
            truncated: false,
          };
        }

        return {
          objects: keys.map(key => ({ key, size: store.get(key)?.body.byteLength || 0 })),
          truncated: false,
        };
      }
    ),
    _store: store,
  };

  return bucket;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDailyBackup', () => {
  it('returns error when R2 bucket is not configured', async () => {
    const env = createMockEnv({ MOLTBOT_BUCKET: undefined as any });
    const result = await createDailyBackup(env);
    expect(result.success).toBe(false);
    expect(result.error).toContain('R2 bucket not configured');
  });

  it('skips when a backup already ran today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'));

    const bucket = createInMemoryR2Bucket({
      'backups/.last-rolling-backup': { text: '2026-02-01' },
    });

    const env = createMockEnv({ MOLTBOT_BUCKET: bucket as any });
    const result = await createDailyBackup(env);

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('Already backed up today');
  });

  it('copies user data and cleans up backups older than retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'));

    const bucket = createInMemoryR2Bucket({
      // User data
      'users/u1/openclaw/config.json': { text: '{"ok":true}', customMetadata: { a: '1' } },
      'users/u1/secrets.json': { text: '{"TELEGRAM_BOT_TOKEN":"x"}' },
      'users/u2/openclaw/config.json': { text: '{"ok":true}' },
      // Directory marker (size 0), should be skipped
      'users/u2/': { text: '' },

      // Old backups to be cleaned (cutoff for Feb 1 with 7-day retention is 2026-01-25)
      'backups/2026-01-20/users/u1/old.txt': { text: 'old' },
      'backups/2026-01-24/users/u2/old.txt': { text: 'old' },
      // Newer backups should remain
      'backups/2026-01-30/users/u2/keep.txt': { text: 'keep' },
    });

    const env = createMockEnv({ MOLTBOT_BUCKET: bucket as any });
    const result = await createDailyBackup(env);

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-02-01');
    expect(result.usersBackedUp).toBe(2);
    expect(result.filesBackedUp).toBe(3);

    // New backup keys exist
    expect(bucket._store.has('backups/2026-02-01/users/u1/openclaw/config.json')).toBe(true);
    expect(bucket._store.has('backups/2026-02-01/users/u1/secrets.json')).toBe(true);
    expect(bucket._store.has('backups/2026-02-01/users/u2/openclaw/config.json')).toBe(true);

    // Marker updated
    const marker = await bucket.get('backups/.last-rolling-backup');
    expect(await marker?.text()).toBe('2026-02-01');

    // Old backups deleted
    expect(bucket._store.has('backups/2026-01-20/users/u1/old.txt')).toBe(false);
    expect(bucket._store.has('backups/2026-01-24/users/u2/old.txt')).toBe(false);
    // Newer backups kept
    expect(bucket._store.has('backups/2026-01-30/users/u2/keep.txt')).toBe(true);
  });
});

describe('listBackupDates', () => {
  it('returns available backup dates sorted (most recent first)', async () => {
    const bucket = createInMemoryR2Bucket({
      'backups/2026-01-30/users/u1/a.txt': { text: 'a' },
      'backups/2026-02-01/users/u1/a.txt': { text: 'a' },
      'backups/2026-01-31/users/u1/a.txt': { text: 'a' },
    });

    const dates = await listBackupDates(bucket as any);
    expect(dates).toEqual(['2026-02-01', '2026-01-31', '2026-01-30']);
  });
});

describe('restoreUserFromBackup', () => {
  it('restores user files from a backup date', async () => {
    const bucket = createInMemoryR2Bucket({
      'backups/2026-01-31/users/u1/a.txt': { text: 'a' },
      'backups/2026-01-31/users/u1/b.txt': { text: 'b' },
    });

    const result = await restoreUserFromBackup(bucket as any, 'u1', '2026-01-31');

    expect(result.success).toBe(true);
    expect(result.filesRestored).toBe(2);
    expect(bucket._store.has('users/u1/a.txt')).toBe(true);
    expect(bucket._store.has('users/u1/b.txt')).toBe(true);
  });
});

