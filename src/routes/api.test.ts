import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, AuthenticatedUser, MoltbotEnv } from '../types';
import type { Process, Sandbox } from '@cloudflare/sandbox';
import { createMockEnv, createMockProcess, createMockSandbox, suppressConsole } from '../test-utils';

vi.mock('../gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gateway')>();
  return {
    ...actual,
    ensureMoltbotGateway: vi.fn(async () => undefined),
    findExistingMoltbotProcess: vi.fn(async () => null),
    mountR2Storage: vi.fn(async () => true),
    syncToR2: vi.fn(async () => ({ success: true })),
    waitForProcess: vi.fn(async () => undefined),
    getAllHealthStates: vi.fn(() => new Map()),
    getRecentSyncResults: vi.fn(() => []),
  };
});

vi.mock('../monitoring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../monitoring')>();
  return {
    ...actual,
    getUnresolvedIssues: vi.fn(async () => []),
    getRecentIssues: vi.fn(async () => []),
    getIssue: vi.fn(async () => null),
    resolveIssue: vi.fn(async () => true),
    getIssueCounts: vi.fn(async () => ({})),
    createIssue: vi.fn(async () => 1),
    cleanupOldIssues: vi.fn(async () => 0),
    getRecentEvents: vi.fn(() => []),
  };
});

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

import { api } from './api';
import * as gateway from '../gateway';
import * as monitoring from '../monitoring';
import { getSandbox } from '@cloudflare/sandbox';

function createUser(id: string = 'user-123'): AuthenticatedUser {
  return {
    id,
    sandboxName: `openclaw-${id}`,
    r2Prefix: `users/${id}`,
  };
}

function createExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function createApiTestApp(options: { sandbox?: Sandbox; user?: AuthenticatedUser } = {}) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (options.sandbox) c.set('sandbox', options.sandbox);
    if (options.user) c.set('user', options.user);
    await next();
  });

  app.route('/api', api);
  return app;
}

async function json<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON response, got: ${text}`);
  }
}

type MockR2Object = { text: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };

function createMockR2Bucket() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      const obj: MockR2Object = {
        text: async () => value,
        arrayBuffer: async () => new TextEncoder().encode(value).buffer,
      };
      return obj;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    list: vi.fn(async (_opts: { prefix?: string }) => ({ objects: [] as Array<{ key: string; size?: number }> })),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

let originalFetch: typeof fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  suppressConsole();
  vi.clearAllMocks();

  originalFetch = globalThis.fetch;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GET /api/admin/users (Supabase profiles)', () => {
  it('returns 403 when requester is not admin', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'false' });
    const app = createApiTestApp({ sandbox });

    const res = await app.request('/api/admin/users', undefined, env, createExecutionCtx());

    expect(res.status).toBe(403);
    const body = await json<{ error: string; hasSecret: boolean; hasUser: boolean }>(res);
    expect(body.error).toContain('Admin access required');
    expect(body.hasSecret).toBe(false);
    expect(body.hasUser).toBe(false);
  });

  it('returns 500 when service role key is not configured', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    const res = await app.request('/api/admin/users', undefined, env, createExecutionCtx());

    expect(res.status).toBe(500);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('returns 500 when Supabase request fails', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 503 }));

    const res = await app.request('/api/admin/users', undefined, env, createExecutionCtx());

    expect(res.status).toBe(500);
    const body = await json<{ error: string; status: number }>(res);
    expect(body.error).toContain('Failed to fetch users');
    expect(body.status).toBe(503);
  });

  it('returns users with sandbox status', async () => {
    const env = createMockEnv({
      DEV_MODE: 'true',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      MOLTBOT_GATEWAY_MASTER_TOKEN: 'master-token',
    });
    const app = createApiTestApp({ sandbox: {} as unknown as Sandbox, user: createUser('admin-1') });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 'u1', username: 'one', full_name: 'User One', created_at: '2026-01-01T00:00:00Z' },
          { id: 'missing', username: 'two', full_name: 'User Two', created_at: '2026-01-02T00:00:00Z' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    vi.mocked(getSandbox).mockImplementation((_ns, name: string) => {
      if (name === 'openclaw-missing') {
        throw new Error('not found');
      }
      return {
        listProcesses: vi.fn(async () => [{ id: 'p1' }]),
      } as unknown as Sandbox;
    });

    const res = await app.request('/api/admin/users', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ users: Array<{ id: string; sandbox: any }>; count: number }>(res);
    expect(body.count).toBe(2);
    expect(body.users[0].id).toBe('u1');
    expect(body.users[0].sandbox.active).toBe(true);
    expect(body.users[0].sandbox.processes).toBe(1);
    expect(body.users[1].id).toBe('missing');
    expect(body.users[1].sandbox.error).toBe('not_found');
  });
});

describe('GET /api/admin/users/search', () => {
  it('returns 403 when requester is not admin', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'false' });
    const app = createApiTestApp({ sandbox });

    const res = await app.request('/api/admin/users/search?q=test', undefined, env, createExecutionCtx());

    expect(res.status).toBe(403);
  });

  it('returns 400 when query parameter is missing', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    const res = await app.request('/api/admin/users/search', undefined, env, createExecutionCtx());

    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain('q required');
  });

  it('returns 500 when service role key is not configured', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    const res = await app.request('/api/admin/users/search?q=test', undefined, env, createExecutionCtx());

    expect(res.status).toBe(500);
  });

  it('returns search results', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'u1', username: 'one' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await app.request('/api/admin/users/search?q=one', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ users: Array<{ id: string }>; count: number }>(res);
    expect(body.count).toBe(1);
    expect(body.users[0].id).toBe('u1');
  });
});

describe('GET /api/admin/users/:userId', () => {
  it('returns 403 when requester is not admin', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'false' });
    const app = createApiTestApp({ sandbox });

    const res = await app.request('/api/admin/users/u1', undefined, env, createExecutionCtx());

    expect(res.status).toBe(403);
  });

  it('returns profile, sandbox status, and a masked gateway token', async () => {
    const env = createMockEnv({
      DEV_MODE: 'true',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      MOLTBOT_GATEWAY_MASTER_TOKEN: 'master-token',
    });
    const app = createApiTestApp({ sandbox: {} as unknown as Sandbox, user: createUser('admin-1') });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'u1', username: 'one' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    vi.mocked(getSandbox).mockReturnValueOnce({
      listProcesses: vi.fn(async () => [
        { id: 'p1', command: 'openclaw gateway', status: 'running', exitCode: undefined },
      ]),
    } as unknown as Sandbox);

    const res = await app.request('/api/admin/users/u1', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ userId: string; user: any; sandbox: any; gatewayToken: string | null }>(res);
    expect(body.userId).toBe('u1');
    expect(body.user?.username).toBe('one');
    expect(body.sandbox.active).toBe(true);
    expect(body.gatewayToken).toMatch(/^[0-9a-f]{8}\.\.\.$/);
  });

  it('reports sandbox_not_found when sandbox access fails', async () => {
    const env = createMockEnv({ DEV_MODE: 'true', SUPABASE_SERVICE_ROLE_KEY: 'service-role' });
    const app = createApiTestApp({ sandbox: {} as unknown as Sandbox, user: createUser('admin-1') });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'u1', username: 'one' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    vi.mocked(getSandbox).mockImplementationOnce(() => {
      throw new Error('missing');
    });

    const res = await app.request('/api/admin/users/u1', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ sandbox: any }>(res);
    expect(body.sandbox.error).toBe('sandbox_not_found');
  });
});

describe('POST /api/admin/users/:userId/restart', () => {
  it('restarts a user sandbox and schedules gateway boot', async () => {
    vi.useFakeTimers();
    const { sandbox, listProcessesMock, startProcessMock } = createMockSandbox();
    const execCtx = createExecutionCtx();

    listProcessesMock.mockResolvedValueOnce([
      { id: 'p1', command: 'openclaw gateway', kill: vi.fn(async () => undefined) },
    ] as unknown as Process[]);
    startProcessMock.mockResolvedValueOnce(createMockProcess('locks cleared'));

    const env = createMockEnv({
      DEV_MODE: 'true',
      MOLTBOT_GATEWAY_MASTER_TOKEN: 'master-token',
    });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    vi.mocked(getSandbox).mockReturnValueOnce(sandbox);
    vi.mocked(gateway.syncToR2).mockResolvedValueOnce({ success: true } as any);

    const reqPromise = app.request('/api/admin/users/u1/restart', { method: 'POST' }, env, execCtx);
    await vi.runAllTimersAsync();
    const res = await reqPromise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; preRestartSync: { success: boolean } }>(res);
    expect(body.success).toBe(true);
    expect(body.preRestartSync.success).toBe(true);
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns success even when pre-restart sync throws', async () => {
    vi.useFakeTimers();
    const { sandbox, listProcessesMock } = createMockSandbox();
    const execCtx = createExecutionCtx();

    listProcessesMock.mockResolvedValueOnce([] as unknown as Process[]);

    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    vi.mocked(getSandbox).mockReturnValueOnce(sandbox);
    vi.mocked(gateway.syncToR2).mockRejectedValueOnce(new Error('sync failed'));

    const reqPromise = app.request('/api/admin/users/u1/restart', { method: 'POST' }, env, execCtx);
    await vi.runAllTimersAsync();
    const res = await reqPromise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; preRestartSync: { success: boolean; error?: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.preRestartSync.success).toBe(false);
    expect(body.preRestartSync.error).toContain('sync failed');
  });
});

describe('GET /api/admin/devices', () => {
  it('returns parsed device JSON when CLI output contains JSON', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(
      createMockProcess('log line\n{"pending":[{"requestId":"r1"}],"paired":[{"id":"d1"}]}\n', {
        exitCode: 0,
      })
    );

    const res = await app.request('/api/admin/devices', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ pending: Array<{ requestId: string }>; paired: Array<{ id: string }> }>(res);
    expect(body.pending[0].requestId).toBe('r1');
    expect(body.paired[0].id).toBe('d1');
    expect(vi.mocked(gateway.ensureMoltbotGateway)).toHaveBeenCalled();
    expect(vi.mocked(gateway.waitForProcess)).toHaveBeenCalled();
  });

  it('returns raw output when no JSON is present', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(createMockProcess('no json here\n', { exitCode: 0 }));

    const res = await app.request('/api/admin/devices', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ pending: unknown[]; paired: unknown[]; raw: string }>(res);
    expect(body.raw).toContain('no json');
  });

  it('returns parseError when JSON parsing fails', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(createMockProcess('{not-json}', { exitCode: 0 }));

    const res = await app.request('/api/admin/devices', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ parseError?: string }>(res);
    expect(body.parseError).toContain('Failed to parse');
  });
});

describe('POST /api/admin/devices/:requestId/approve', () => {
  it('reports success based on stdout containing "Approved"', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(createMockProcess('Approved device\n', { exitCode: 1 }));

    const res = await app.request('/api/admin/devices/r1/approve', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; message: string }>(res);
    expect(body.success).toBe(true);
    expect(body.message).toContain('Device approved');
  });

  it('reports failure when exitCode is non-zero and stdout has no approval', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(createMockProcess('Denied\n', { exitCode: 2 }));

    const res = await app.request('/api/admin/devices/r1/approve', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; message: string }>(res);
    expect(body.success).toBe(false);
    expect(body.message).toContain('may have failed');
  });
});

describe('POST /api/admin/devices/approve-all', () => {
  it('returns 500 when device list JSON parsing fails', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(createMockProcess('{"pending":[}', { exitCode: 0 }));

    const res = await app.request('/api/admin/devices/approve-all', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(500);
    const body = await json<{ error: string }>(res);
    expect(body.error).toContain('Failed to parse device list');
  });

  it('returns early when there are no pending devices', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock.mockResolvedValueOnce(createMockProcess('{"pending":[],"paired":[]}', { exitCode: 0 }));

    const res = await app.request('/api/admin/devices/approve-all', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ approved: string[]; message: string }>(res);
    expect(body.approved).toEqual([]);
    expect(body.message).toContain('No pending devices');
  });

  it('approves all pending devices and reports failures', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    startProcessMock
      .mockResolvedValueOnce(createMockProcess('{"pending":[{"requestId":"r1"},{"requestId":"r2"}]}', { exitCode: 0 }))
      .mockResolvedValueOnce(createMockProcess('Approved\n', { exitCode: 0 }))
      .mockRejectedValueOnce(new Error('boom'));

    const res = await app.request('/api/admin/devices/approve-all', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ approved: string[]; failed: Array<{ requestId: string; error?: string }> }>(res);
    expect(body.approved).toEqual(['r1']);
    expect(body.failed[0].requestId).toBe('r2');
    expect(body.failed[0].error).toContain('boom');
  });
});

describe('GET /api/admin/storage', () => {
  it('returns missing credential list when not configured', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    const res = await app.request('/api/admin/storage', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ configured: boolean; missing?: string[] }>(res);
    expect(body.configured).toBe(false);
    expect(body.missing).toContain('R2_ACCESS_KEY_ID');
    expect(body.missing).toContain('R2_SECRET_ACCESS_KEY');
    expect(body.missing).toContain('CF_ACCOUNT_ID');
  });

  it('returns lastSync and mountPath when configured', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const env = createMockEnv({
      DEV_MODE: 'true',
      R2_ACCESS_KEY_ID: 'key',
      R2_SECRET_ACCESS_KEY: 'secret',
      CF_ACCOUNT_ID: 'acc',
    });
    const user = createUser('user-1');
    const app = createApiTestApp({ sandbox, user });

    startProcessMock
      .mockResolvedValueOnce(createMockProcess('2026-01-31T00:00:00Z\n', { exitCode: 0 }))
      .mockResolvedValueOnce(createMockProcess('file-a\nfile-b\n', { exitCode: 0 }));

    const res = await app.request('/api/admin/storage', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ configured: boolean; lastSync: string | null; mountPath: string; backupFiles: string[] }>(res);
    expect(body.configured).toBe(true);
    expect(body.lastSync).toContain('2026-01-31');
    expect(body.mountPath).toBe(`/data/openclaw/${user.r2Prefix}`);
    expect(body.backupFiles.length).toBeGreaterThan(0);
    expect(vi.mocked(gateway.mountR2Storage)).toHaveBeenCalledWith(sandbox, env, { r2Prefix: user.r2Prefix });
  });
});

describe('POST /api/admin/storage/sync', () => {
  it('returns 200 on successful sync', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    vi.mocked(gateway.syncToR2).mockResolvedValueOnce({ success: true, lastSync: '2026-01-31T00:00:00Z' } as any);

    const res = await app.request('/api/admin/storage/sync', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; lastSync?: string }>(res);
    expect(body.success).toBe(true);
    expect(body.lastSync).toContain('2026-01-31');
  });

  it('returns 400 for not configured errors', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    vi.mocked(gateway.syncToR2).mockResolvedValueOnce({ success: false, error: 'R2 storage is not configured' } as any);

    const res = await app.request('/api/admin/storage/sync', { method: 'POST' }, env, createExecutionCtx());
    expect(res.status).toBe(400);
  });
});

describe('GET/POST /api/admin/gateway/restart', () => {
  it('kills existing process (if any) and schedules gateway restart (GET)', async () => {
    vi.useFakeTimers();
    const { sandbox } = createMockSandbox();
    const execCtx = createExecutionCtx();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    vi.mocked(gateway.findExistingMoltbotProcess).mockResolvedValueOnce({
      id: 'gw-1',
      kill: vi.fn(async () => undefined),
    } as unknown as Process);

    const reqPromise = app.request('/api/admin/gateway/restart', undefined, env, execCtx);
    await vi.runAllTimersAsync();
    const res = await reqPromise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; previousProcessId?: string }>(res);
    expect(body.success).toBe(true);
    expect(body.previousProcessId).toBe('gw-1');
    expect(execCtx.waitUntil).toHaveBeenCalled();
  });

  it('starts a new instance when no existing process is found (POST)', async () => {
    const { sandbox } = createMockSandbox();
    const execCtx = createExecutionCtx();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    vi.mocked(gateway.findExistingMoltbotProcess).mockResolvedValueOnce(null);

    const res = await app.request('/api/admin/gateway/restart', { method: 'POST' }, env, execCtx);
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; message: string }>(res);
    expect(body.success).toBe(true);
    expect(body.message).toContain('No existing process');
    expect(execCtx.waitUntil).toHaveBeenCalled();
  });
});

describe('POST /api/admin/container/reset', () => {
  it('kills all processes and schedules a fresh gateway', async () => {
    vi.useFakeTimers();
    const { sandbox, listProcessesMock, startProcessMock } = createMockSandbox();
    const execCtx = createExecutionCtx();

    listProcessesMock.mockResolvedValueOnce([
      { id: 'p1', command: 'x', kill: vi.fn(async () => undefined) },
      { id: 'p2', command: 'y', kill: vi.fn(async () => undefined) },
    ] as unknown as Process[]);
    startProcessMock.mockResolvedValueOnce(createMockProcess('locks cleared'));

    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    const reqPromise = app.request('/api/admin/container/reset', { method: 'POST' }, env, execCtx);
    await vi.runAllTimersAsync();
    const res = await reqPromise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; killedProcesses: Array<{ id: string }> }>(res);
    expect(body.success).toBe(true);
    expect(body.killedProcesses.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(execCtx.waitUntil).toHaveBeenCalled();
  });
});

describe('User secrets endpoints', () => {
  it('GET /api/admin/secrets returns 401 when not authenticated', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox });

    const res = await app.request('/api/admin/secrets', undefined, env, createExecutionCtx());
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/secrets returns masked secrets and configured list', async () => {
    const { sandbox } = createMockSandbox();
    const bucket = createMockR2Bucket();
    const user = createUser('user-1');
    bucket._store.set(`${user.r2Prefix}/secrets.json`, JSON.stringify({ TELEGRAM_BOT_TOKEN: '1234567890', OPENAI_API_KEY: 'short' }));

    const env = createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: bucket as any });
    const app = createApiTestApp({ sandbox, user });

    const res = await app.request('/api/admin/secrets', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ secrets: Record<string, string | null>; configured: string[] }>(res);
    expect(body.secrets.TELEGRAM_BOT_TOKEN).toBe('1234****7890');
    expect(body.secrets.OPENAI_API_KEY).toBe('****');
    expect(body.configured).toContain('TELEGRAM_BOT_TOKEN');
    expect(body.configured).toContain('OPENAI_API_KEY');
  });

  it('PUT /api/admin/secrets updates and deletes provided keys', async () => {
    const { sandbox } = createMockSandbox();
    const bucket = createMockR2Bucket();
    const user = createUser('user-1');
    bucket._store.set(`${user.r2Prefix}/secrets.json`, JSON.stringify({ TELEGRAM_BOT_TOKEN: 'keepme', DISCORD_BOT_TOKEN: 'deleteme' }));

    const env = createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: bucket as any });
    const app = createApiTestApp({ sandbox, user });

    const res = await app.request(
      '/api/admin/secrets',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ DISCORD_BOT_TOKEN: '', SLACK_BOT_TOKEN: 'newtoken' }),
      },
      env,
      createExecutionCtx()
    );

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; configured: string[] }>(res);
    expect(body.success).toBe(true);
    expect(bucket.put).toHaveBeenCalled();
    expect(body.configured).toContain('TELEGRAM_BOT_TOKEN');
    expect(body.configured).toContain('SLACK_BOT_TOKEN');
    expect(body.configured).not.toContain('DISCORD_BOT_TOKEN');
  });

  it('DELETE /api/admin/secrets/:key rejects invalid key', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', MOLTBOT_BUCKET: createMockR2Bucket() as any });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    const res = await app.request('/api/admin/secrets/NOT_A_KEY', { method: 'DELETE' }, env, createExecutionCtx());
    expect(res.status).toBe(400);
  });
});

describe('Platform dashboard and issues endpoints', () => {
  it('allows admin secret header to authorize (no user)', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ MOLTBOT_GATEWAY_MASTER_TOKEN: 'secret', DEV_MODE: 'false' });
    const app = createApiTestApp({ sandbox });

    const res = await app.request(
      '/api/admin/dashboard',
      { headers: { 'X-Admin-Secret': 'secret' } },
      env,
      createExecutionCtx()
    );

    expect(res.status).toBe(200);
  });

  it('GET /api/admin/dashboard summarizes health and includes recent events', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', PLATFORM_DB: {} as any });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    const now = Date.now();
    const healthStates = new Map<string, any>([
      ['u1', { consecutiveFailures: 0, lastRestart: new Date(now - 10 * 60 * 1000).toISOString(), lastHealthy: new Date(now).toISOString() }],
      ['u2', { consecutiveFailures: 2, lastRestart: new Date(now - 3 * 60 * 60 * 1000).toISOString(), lastHealthy: null }],
    ]);
    vi.mocked(gateway.getAllHealthStates).mockReturnValueOnce(healthStates);

    vi.mocked(monitoring.getIssueCounts).mockResolvedValueOnce({ sync_failure: { total: 2, unresolved: 1 } } as any);
    vi.mocked(monitoring.getUnresolvedIssues).mockResolvedValueOnce([{ id: 1 }] as any);
    vi.mocked(monitoring.getRecentEvents).mockReturnValueOnce([{ type: 'sync', success: true } as any]);

    const res = await app.request('/api/admin/dashboard', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ health: any; issues: any; recentEvents: any[] }>(res);
    expect(body.health.totalTracked).toBe(2);
    expect(body.health.healthy).toBe(1);
    expect(body.health.unhealthy).toBe(1);
    expect(body.health.recentRestarts).toBe(1);
    expect(body.issues.counts.sync_failure.total).toBe(2);
    expect(body.recentEvents.length).toBe(1);
  });

  it('GET /api/admin/issues returns 503 when D1 is missing', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    const res = await app.request('/api/admin/issues', undefined, env, createExecutionCtx());
    expect(res.status).toBe(503);
  });

  it('GET /api/admin/issues calls getUnresolvedIssues when resolved=false', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', PLATFORM_DB: {} as any });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    vi.mocked(monitoring.getUnresolvedIssues).mockResolvedValueOnce([{ id: 1 }] as any);

    const res = await app.request('/api/admin/issues?resolved=false&limit=10&type=sync_failure', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    expect(monitoring.getUnresolvedIssues).toHaveBeenCalledWith(env.PLATFORM_DB, expect.objectContaining({ limit: 10, type: 'sync_failure' }));
  });

  it('GET /api/admin/issues/:id validates numeric id', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', PLATFORM_DB: {} as any });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    const res = await app.request('/api/admin/issues/not-a-number', undefined, env, createExecutionCtx());
    expect(res.status).toBe(400);
  });

  it('POST /api/admin/issues creates an issue', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', PLATFORM_DB: {} as any });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    vi.mocked(monitoring.createIssue).mockResolvedValueOnce(123);

    const res = await app.request(
      '/api/admin/issues',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'error', severity: 'low', message: 'test' }) },
      env,
      createExecutionCtx()
    );

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; issueId: number }>(res);
    expect(body.success).toBe(true);
    expect(body.issueId).toBe(123);
  });
});

describe('GET /api/admin/sync-history/:userId', () => {
  it('returns recent sync results', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('admin-1') });

    vi.mocked(gateway.getRecentSyncResults).mockReturnValueOnce([{ success: true, lastSync: 't' }] as any);

    const res = await app.request('/api/admin/sync-history/u1', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ userId: string; syncResults: any[]; count: number }>(res);
    expect(body.userId).toBe('u1');
    expect(body.count).toBe(1);
  });
});

describe('GET /api/gateway-token', () => {
  it('returns 401 when not authenticated', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox });

    const res = await app.request('/api/gateway-token', undefined, env, createExecutionCtx());
    expect(res.status).toBe(401);
  });

  it('returns 500 when master token is not configured', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true' });
    const app = createApiTestApp({ sandbox, user: createUser('user-1') });

    const res = await app.request('/api/gateway-token', undefined, env, createExecutionCtx());
    expect(res.status).toBe(500);
  });

  it('returns derived gateway token for authenticated user', async () => {
    const { sandbox } = createMockSandbox();
    const env = createMockEnv({ DEV_MODE: 'true', MOLTBOT_GATEWAY_MASTER_TOKEN: 'master-token' });
    const user = createUser('user-1');
    const app = createApiTestApp({ sandbox, user });

    const res = await app.request('/api/gateway-token', undefined, env, createExecutionCtx());
    expect(res.status).toBe(200);
    const body = await json<{ token: string; userId: string }>(res);
    expect(body.userId).toBe(user.id);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Unreachable duplicate admin route handlers', () => {
  function createStubContext(options: {
    env: MoltbotEnv;
    vars?: Record<string, unknown>;
    headers?: Record<string, string>;
    params?: Record<string, string>;
    query?: Record<string, string>;
    jsonBody?: unknown;
  }) {
    const vars: Record<string, unknown> = { ...(options.vars || {}) };
    const headers = new Headers(options.headers || {});
    const url = new URL('http://localhost/test');
    if (options.query) {
      for (const [k, v] of Object.entries(options.query)) {
        url.searchParams.set(k, v);
      }
    }
    const raw = new Request(url.toString(), { headers });

    return {
      env: options.env,
      executionCtx: createExecutionCtx(),
      get: (key: string) => vars[key],
      set: (key: string, value: unknown) => {
        vars[key] = value;
      },
      req: {
        raw,
        header: (name: string) => headers.get(name),
        param: (name: string) => options.params?.[name] ?? '',
        query: (name: string) => options.query?.[name],
        json: async () => options.jsonBody,
      },
      json: (obj: unknown, status: number = 200) =>
        new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }),
    } as any;
  }

  it('executes all GET /api/admin/users handlers via api.routes inspection', async () => {
    const bucket = createMockR2Bucket();
    bucket.list.mockResolvedValueOnce({
      objects: [
        { key: 'users/u1/secrets.json', size: 1 },
        { key: 'users/u2/openclaw/config.json', size: 1 },
      ],
    } as any);

    // Identify all GET handlers for /admin/users registered on the exported api instance.
    const usersGetRoutes = api.routes.filter(r => r.method === 'GET' && r.path === '/admin/users');
    expect(usersGetRoutes.length).toBeGreaterThanOrEqual(1);

    // Run each handler with an admin context.
    for (const route of usersGetRoutes) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
      vi.mocked(getSandbox).mockReturnValue({ listProcesses: vi.fn(async () => []) } as any);

      const ctx = createStubContext({
        env: createMockEnv({
          DEV_MODE: 'true',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role',
          MOLTBOT_BUCKET: bucket as any,
        }),
        vars: { user: createUser('admin-1') },
      });

      const res = await route.handler(ctx, async () => undefined);
      expect(res).toBeInstanceOf(Response);
    }
  });
});

