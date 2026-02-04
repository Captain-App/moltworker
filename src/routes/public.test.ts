import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import type { Process, Sandbox } from '@cloudflare/sandbox';
import { createMockEnv, createMockProcess, createMockSandbox, suppressConsole } from '../test-utils';
import { MOLTBOT_PORT } from '../config';

vi.mock('../gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gateway')>();
  return {
    ...actual,
    findExistingMoltbotProcess: vi.fn(async () => null),
    checkHealth: vi.fn(),
    getHealthState: vi.fn(),
    getRecentSyncResults: vi.fn(() => []),
    ensureMoltbotGateway: vi.fn(async () => undefined),
    syncToR2: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));

vi.mock('../../platform/auth/supabase-jwt', () => ({
  verifySupabaseJWT: vi.fn(),
}));

import { publicRoutes } from './public';
import * as gateway from '../gateway';
import { getSandbox } from '@cloudflare/sandbox';
import { verifySupabaseJWT } from '../../platform/auth/supabase-jwt';

function createExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function createPublicTestApp(options: { sandbox?: Sandbox } = {}) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (options.sandbox) c.set('sandbox', options.sandbox);
    await next();
  });

  app.route('/', publicRoutes);
  return app;
}

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createMockR2Bucket(objects: Record<string, string>) {
  const store = new Map(Object.entries(objects));
  return {
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return { text: async () => value };
    }),
    list: vi.fn(async (opts: { prefix?: string }) => {
      const prefix = opts.prefix || '';
      const listed = Array.from(store.keys())
        .filter(k => k.startsWith(prefix))
        .map(k => ({ key: k, size: store.get(k)?.length || 0 }));
      return { objects: listed };
    }),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  suppressConsole();
  vi.clearAllMocks();
});

describe('Public routes', () => {
  it('GET /sandbox-health returns ok', async () => {
    const app = createPublicTestApp();
    const env = createMockEnv();

    const res = await app.request('/sandbox-health', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ status: string; service: string; gateway_port: number }>(res);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('moltbot-sandbox');
    expect(body.gateway_port).toBe(MOLTBOT_PORT);
  });

  it('GET /logo.png proxies to ASSETS.fetch', async () => {
    const assets = { fetch: vi.fn(async () => new Response('logo', { status: 200 })) } as any;
    const env = createMockEnv({ ASSETS: assets });
    const app = createPublicTestApp();

    const res = await app.request('/logo.png', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('logo');
    expect(assets.fetch).toHaveBeenCalledTimes(1);
  });

  it('GET /_admin/assets/* rewrites to /assets/* for ASSETS binding', async () => {
    const assets = {
      fetch: vi.fn(async (req: Request) => new Response(req.url, { status: 200 })),
    } as any;
    const env = createMockEnv({ ASSETS: assets });
    const app = createPublicTestApp();

    const res = await app.request('http://localhost/_admin/assets/app.js', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const url = await res.text();
    expect(url).toContain('/assets/app.js');
    const [requestArg] = assets.fetch.mock.calls[0] as [Request];
    expect(requestArg.url).toContain('/assets/app.js');
  });
});

describe('GET /api/status', () => {
  it('returns not_running when no process exists', async () => {
    const { sandbox } = createMockSandbox();
    const app = createPublicTestApp({ sandbox });
    const env = createMockEnv();

    vi.mocked(gateway.findExistingMoltbotProcess).mockResolvedValueOnce(null);

    const res = await app.request('/api/status', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; status: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('not_running');
  });

  it('returns running when process exists and port is reachable', async () => {
    const { sandbox } = createMockSandbox();
    const app = createPublicTestApp({ sandbox });
    const env = createMockEnv();

    const proc = {
      id: 'p1',
      status: 'running',
      waitForPort: vi.fn(async () => undefined),
    } as unknown as Process;
    vi.mocked(gateway.findExistingMoltbotProcess).mockResolvedValueOnce(proc);

    const res = await app.request('/api/status', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; status: string; processId: string }>(res);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('running');
    expect(body.processId).toBe('p1');
  });

  it('returns not_responding when process exists but port check fails', async () => {
    const { sandbox } = createMockSandbox();
    const app = createPublicTestApp({ sandbox });
    const env = createMockEnv();

    const proc = {
      id: 'p1',
      status: 'running',
      waitForPort: vi.fn(async () => {
        throw new Error('tcp failed');
      }),
    } as unknown as Process;
    vi.mocked(gateway.findExistingMoltbotProcess).mockResolvedValueOnce(proc);

    const res = await app.request('/api/status', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; status: string }>(res);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('not_responding');
  });

  it('uses authenticated user sandbox when JWT is valid and includes health/sync details', async () => {
    const defaultSandbox = {} as unknown as Sandbox;
    const userSandbox = {} as unknown as Sandbox;
    const app = createPublicTestApp({ sandbox: defaultSandbox });

    const env = createMockEnv({
      SUPABASE_JWT_SECRET: 'jwt-secret',
      SANDBOX_SLEEP_AFTER: '10m',
    });

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce({ sub: 'user-123456789' } as any);
    vi.mocked(getSandbox).mockReturnValueOnce(userSandbox);

    vi.mocked(gateway.findExistingMoltbotProcess).mockResolvedValueOnce({ id: 'gw', status: 'running' } as any);
    vi.mocked(gateway.checkHealth).mockResolvedValueOnce({
      healthy: true,
      checks: { processRunning: true, portReachable: true, gatewayResponds: true },
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
      uptimeSeconds: 123,
      memoryUsageMb: 45,
    } as any);
    vi.mocked(gateway.getHealthState).mockReturnValueOnce({
      consecutiveFailures: 0,
      lastCheck: new Date().toISOString(),
      lastHealthy: '2026-02-01T00:00:00Z',
      lastRestart: '2026-02-01T00:05:00Z',
    } as any);
    vi.mocked(gateway.getRecentSyncResults).mockReturnValueOnce([
      { success: true, lastSync: 't1', fileCount: 1, durationMs: 10 },
      { success: false, lastSync: 't0', fileCount: 0, durationMs: 5, error: 'oops' },
      { success: true, lastSync: 't-ignored', fileCount: 1, durationMs: 1 },
      { success: true, lastSync: 't-ignored2', fileCount: 1, durationMs: 1 },
    ] as any);

    const res = await app.request(
      '/api/status',
      { headers: { Authorization: 'Bearer token123' } },
      env,
      createExecutionCtx()
    );

    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; status: string; userId: string; recentSyncs: unknown[] }>(res);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('healthy');
    expect(body.userId).toBe('user-123'); // sliced to 8 chars
    expect(body.recentSyncs.length).toBe(3);

    expect(getSandbox).toHaveBeenCalledWith(env.Sandbox, 'openclaw-user-123456789', { sleepAfter: '10m' });
  });
});

describe('Super debug endpoints', () => {
  it('GET /api/super/users/:userId/inspect includes process and R2 status', async () => {
    const { sandbox, listProcessesMock } = createMockSandbox();
    const app = createPublicTestApp();

    vi.mocked(getSandbox).mockReturnValueOnce(sandbox);

    listProcessesMock.mockResolvedValueOnce([
      {
        id: 'p1',
        command: '/usr/local/bin/start-moltbot.sh',
        status: 'running',
        startTime: new Date('2026-02-01T00:00:00Z'),
        exitCode: undefined,
        getLogs: vi.fn(async () => ({ stdout: 'boot ok', stderr: '' })),
      },
      {
        id: 'p2',
        command: 'openclaw devices list',
        status: 'completed',
        startTime: new Date('2026-02-01T00:01:00Z'),
        exitCode: 0,
      },
    ] as any);

    const bucket = createMockR2Bucket({
      'users/u1/.last-sync': '2026-02-01T00:10:00Z',
      'users/u1/openclaw/config.json': JSON.stringify({ name: 'Bot', personality: 'hello'.repeat(50), model: 'test' }),
      'users/u1/secrets.json': JSON.stringify({ TELEGRAM_BOT_TOKEN: 'tg', OPENAI_API_KEY: '' }),
      'users/u1/somefile.txt': 'x',
    });

    const env = createMockEnv({
      SANDBOX_SLEEP_AFTER: 'never',
      MOLTBOT_BUCKET: bucket as any,
    });

    const res = await app.request('/api/super/users/u1/inspect', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ userId: string; sandboxName: string; processCount: number; r2: any }>(res);
    expect(body.userId).toBe('u1');
    expect(body.sandboxName).toBe('openclaw-u1');
    expect(body.processCount).toBe(2);
    expect(body.r2.hasBackup).toBe(true);
    expect(body.r2.lastSync).toContain('2026-02-01');
    expect(body.r2.personality.name).toBe('Bot');
    expect(body.r2.configuredSecrets).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('GET /api/super/users/:userId/files?sync=1 runs extra sync commands', async () => {
    const { sandbox, startProcessMock } = createMockSandbox();
    const app = createPublicTestApp();
    vi.mocked(getSandbox).mockReturnValueOnce(sandbox);

    startProcessMock.mockImplementation(async (cmd: string) => createMockProcess(`ok:${cmd}`));

    const env = createMockEnv({ SANDBOX_SLEEP_AFTER: '1h' });
    const res = await app.request('/api/super/users/u1/files?sync=1', undefined, env, createExecutionCtx());

    expect(res.status).toBe(200);
    const body = await json<{ files: Record<string, string> }>(res);
    expect(Object.keys(body.files).some(k => k.includes('rsync -r --no-times'))).toBe(true);
  });

  it('POST /api/super/users/:userId/exec returns 400 when command is missing', async () => {
    const app = createPublicTestApp();
    const env = createMockEnv();

    const res = await app.request(
      '/api/super/users/u1/exec',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      env,
      createExecutionCtx()
    );

    expect(res.status).toBe(400);
  });

  it('GET /api/super/users/:userId/restart kills processes and schedules gateway restart', async () => {
    vi.useFakeTimers();
    const { sandbox, listProcessesMock, startProcessMock } = createMockSandbox();
    const execCtx = createExecutionCtx();
    const app = createPublicTestApp();

    vi.mocked(getSandbox).mockReturnValueOnce(sandbox);
    vi.mocked(gateway.syncToR2).mockResolvedValueOnce({ success: true } as any);

    listProcessesMock.mockResolvedValueOnce([
      { id: 'p1', command: 'openclaw gateway', kill: vi.fn(async () => undefined) },
    ] as any);

    // Clear locks, doctor --fix
    startProcessMock
      .mockResolvedValueOnce(createMockProcess('locks cleared'))
      .mockResolvedValueOnce(createMockProcess('doctor ok', { exitCode: 0 }));

    const env = createMockEnv({ SANDBOX_SLEEP_AFTER: 'never' });

    const reqPromise = app.request('/api/super/users/u1/restart', undefined, env, execCtx);
    await vi.runAllTimersAsync();
    const res = await reqPromise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; message: string; doctor: string }>(res);
    expect(body.success).toBe(true);
    expect(body.message).toContain('Gateway restarting');
    expect(body.doctor).toContain('doctor ok');
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
  });
});
