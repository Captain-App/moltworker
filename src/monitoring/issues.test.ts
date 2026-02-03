import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cleanupOldIssues,
  createIssue,
  getIssue,
  getIssueCounts,
  getRecentIssues,
  getUnresolvedIssues,
  resolveIssue,
  type D1Database,
  type PlatformIssue,
} from './issues';

function createMockDb(options: {
  onRun?: (query: string, params: unknown[]) => Promise<any>;
  onAll?: (query: string, params: unknown[]) => Promise<any>;
  onFirst?: (query: string, params: unknown[]) => Promise<any>;
} = {}): D1Database & { prepare: any } {
  const prepare = vi.fn((query: string) => {
    let bound: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        bound = values;
        return stmt;
      },
      run: vi.fn(async () => (options.onRun ? options.onRun(query, bound) : ({ success: true, results: [], meta: {} }))),
      all: vi.fn(async () => (options.onAll ? options.onAll(query, bound) : ({ success: true, results: [], meta: {} }))),
      first: vi.fn(async () => (options.onFirst ? options.onFirst(query, bound) : null)),
    };
    return stmt;
  });

  return {
    prepare,
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0 })),
  } as any;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('createIssue', () => {
  it('returns last_row_id on success', async () => {
    const db = createMockDb({
      onRun: async () => ({ success: true, results: [], meta: { last_row_id: 42 } }),
    });

    const id = await createIssue(db, {
      type: 'sync_failure',
      severity: 'high',
      userId: 'user-1',
      message: 'sync failed',
      details: { code: 1 },
    });

    expect(id).toBe(42);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO platform_issues'));
  });

  it('returns null on database error', async () => {
    const db = createMockDb({
      onRun: async () => {
        throw new Error('db down');
      },
    });

    const id = await createIssue(db, { type: 'error', severity: 'low', message: 'x' });
    expect(id).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('getUnresolvedIssues', () => {
  it('builds query with optional filters and parses rows', async () => {
    const rawRow = {
      id: 1,
      type: 'sync_failure',
      severity: 'high',
      user_id: 'user-1',
      message: 'x',
      details: JSON.stringify({ a: 1 }),
      resolved: 0,
      resolved_at: null,
      resolved_by: null,
      created_at: '2026-02-01T00:00:00Z',
    };

    const db = createMockDb({
      onAll: async (query, params) => {
        expect(query).toContain('WHERE resolved = 0');
        expect(query).toContain('user_id = ?');
        expect(query).toContain('type = ?');
        expect(params).toEqual(['user-1', 'sync_failure', 10]);
        return { success: true, results: [rawRow], meta: {} };
      },
    });

    const issues = await getUnresolvedIssues(db, { userId: 'user-1', type: 'sync_failure', limit: 10 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual<PlatformIssue>({
      id: 1,
      type: 'sync_failure',
      severity: 'high',
      userId: 'user-1',
      message: 'x',
      details: { a: 1 },
      resolved: false,
      resolvedAt: undefined,
      resolvedBy: undefined,
      createdAt: '2026-02-01T00:00:00Z',
    });
  });

  it('returns empty array on error', async () => {
    const db = createMockDb({
      onAll: async () => {
        throw new Error('nope');
      },
    });

    const issues = await getUnresolvedIssues(db);
    expect(issues).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('getRecentIssues', () => {
  it('returns rows (resolved and unresolved)', async () => {
    const db = createMockDb({
      onAll: async () => ({
        success: true,
        results: [
          {
            id: 1,
            type: 'error',
            severity: 'low',
            user_id: null,
            message: 'x',
            details: null,
            resolved: 1,
            resolved_at: '2026-02-01T00:10:00Z',
            resolved_by: 'admin',
            created_at: '2026-02-01T00:00:00Z',
          },
        ],
        meta: {},
      }),
    });

    const issues = await getRecentIssues(db, { limit: 5 });
    expect(issues).toHaveLength(1);
    expect(issues[0].resolved).toBe(true);
    expect(issues[0].resolvedBy).toBe('admin');
  });
});

describe('getIssue / resolveIssue', () => {
  it('returns a single issue by id', async () => {
    const db = createMockDb({
      onFirst: async () => ({
        id: 2,
        type: 'restart',
        severity: 'medium',
        user_id: 'user-2',
        message: 'restarted',
        details: null,
        resolved: 0,
        resolved_at: null,
        resolved_by: null,
        created_at: '2026-02-01T00:00:00Z',
      }),
    });

    const issue = await getIssue(db, 2);
    expect(issue?.id).toBe(2);
    expect(issue?.type).toBe('restart');
  });

  it('resolveIssue defaults resolvedBy to "manual"', async () => {
    const db = createMockDb({
      onRun: async (query, params) => {
        expect(query).toContain('UPDATE platform_issues');
        expect(params).toEqual(['manual', 99]);
        return { success: true, results: [], meta: {} };
      },
    });

    const ok = await resolveIssue(db, 99);
    expect(ok).toBe(true);
  });

  it('resolveIssue returns false on error', async () => {
    const db = createMockDb({
      onRun: async () => {
        throw new Error('fail');
      },
    });

    const ok = await resolveIssue(db, 1, 'admin');
    expect(ok).toBe(false);
  });
});

describe('getIssueCounts / cleanupOldIssues', () => {
  it('returns counts keyed by type', async () => {
    const db = createMockDb({
      onAll: async () => ({
        success: true,
        results: [
          { type: 'sync_failure', total: 2, unresolved: 1 },
          { type: 'error', total: 5, unresolved: 0 },
        ],
        meta: {},
      }),
    });

    const counts = await getIssueCounts(db);
    expect(counts.sync_failure).toEqual({ total: 2, unresolved: 1 });
    expect(counts.error).toEqual({ total: 5, unresolved: 0 });
  });

  it('cleanupOldIssues returns deleted count', async () => {
    const db = createMockDb({
      onRun: async (query, params) => {
        expect(query).toContain('DELETE FROM platform_issues');
        expect(params).toEqual([7]);
        return { success: true, results: [], meta: { changes: 3 } };
      },
    });

    const deleted = await cleanupOldIssues(db, 7);
    expect(deleted).toBe(3);
  });
});

