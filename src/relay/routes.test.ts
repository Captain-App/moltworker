/**
 * Tests for Relay API Routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { relayRoutes } from './routes';
import type { RelayAppEnv } from './auth';
import type { RelayMembership, RelayMessage, RelayApiKey } from './types';

// Mock the verify module
vi.mock('./verify', () => ({
  verifyBotInGroup: vi.fn(),
  extractBotId: vi.fn((token: string) => {
    const idx = token.indexOf(':');
    return idx > 0 ? token.slice(0, idx) : null;
  }),
}));

// Mock Supabase JWT verification
vi.mock('../../platform/auth/supabase-jwt', () => ({
  verifySupabaseJWT: vi.fn(),
  getUserIdFromPayload: vi.fn((payload: { sub: string }) => payload.sub),
}));

import { verifyBotInGroup } from './verify';
import { verifySupabaseJWT } from '../../platform/auth/supabase-jwt';

// Create a mock KV store
function createMockKV() {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) return null;
      if (type === 'json') return JSON.parse(value);
      return value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options: { prefix?: string; limit?: number }) => {
      const keys: Array<{ name: string }> = [];
      for (const key of store.keys()) {
        if (!options.prefix || key.startsWith(options.prefix)) {
          keys.push({ name: key });
        }
      }
      return { keys: keys.slice(0, options.limit || 1000) };
    }),
    _store: store,
  };
}

// Create a minimal in-memory D1 mock for relay message storage
function createMockD1() {
  type Row = {
    group_id: string;
    bot_id: string;
    bot_name: string;
    message_id: number;
    text: string;
    timestamp: number;
    reply_to_message_id?: number | null;
    thread_id?: string | null;
    media_url?: string | null;
    media_type?: string | null;
  };

  const messages = new Map<string, Row>();

  const db = {
    prepare: vi.fn((query: string) => {
      let bound: unknown[] = [];

      const stmt = {
        bind: (...values: unknown[]) => {
          bound = values;
          return stmt;
        },
        run: vi.fn(async () => {
          if (query.includes('INSERT INTO relay_messages')) {
            const [
              groupId,
              botId,
              botName,
              messageId,
              text,
              timestamp,
              replyToMessageId,
              threadId,
              mediaUrl,
              mediaType,
            ] = bound as unknown as [
              string,
              string,
              string,
              number,
              string,
              number,
              number | null,
              string | null,
              string | null,
              string | null,
            ];

            const key = `${groupId}|${botId}|${messageId}`;
            messages.set(key, {
              group_id: groupId,
              bot_id: botId,
              bot_name: botName,
              message_id: messageId,
              text,
              timestamp,
              reply_to_message_id: replyToMessageId,
              thread_id: threadId,
              media_url: mediaUrl,
              media_type: mediaType,
            });
          }
          return { success: true, results: [], meta: { changes: 1 } };
        }),
        all: vi.fn(async () => {
          if (query.includes('FROM relay_messages')) {
            const groupId = bound[0] as string;
            const since = bound[1] as number;
            const includeSelf = !query.includes('bot_id != ?');
            const excludeBotId = includeSelf ? undefined : (bound[2] as string);
            const limit = includeSelf ? (bound[2] as number) : (bound[3] as number);

            const results = Array.from(messages.values())
              .filter(row => row.group_id === groupId)
              .filter(row => row.timestamp > since)
              .filter(row => (excludeBotId ? row.bot_id !== excludeBotId : true))
              .sort((a, b) => a.timestamp - b.timestamp)
              .slice(0, limit);

            return { success: true, results, meta: {} };
          }
          return { success: true, results: [], meta: {} };
        }),
        first: vi.fn(async () => null),
      };

      return stmt;
    }),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0 })),
    _messages: messages,
  };

  return db;
}

// Create test app with mock bindings
function createTestApp() {
  const mockKV = createMockKV();
  const mockDB = createMockD1();

  const app = new Hono<RelayAppEnv>();

  // Add env bindings middleware
  app.use('*', async (c, next) => {
    (c.env as RelayAppEnv['Bindings']) = {
      RELAY: mockKV as unknown as KVNamespace,
      PLATFORM_DB: mockDB as unknown as any,
      SUPABASE_JWT_SECRET: 'test-secret',
      SUPABASE_URL: 'https://test.supabase.co',
      ADMIN_USER_IDS: 'admin-user-id',
    } as RelayAppEnv['Bindings'];
    await next();
  });

  app.route('/relay', relayRoutes);

  return { app, mockKV, mockDB };
}

// Mock JWT payload that satisfies the type requirements
const mockJwtPayload = (sub: string) =>
  ({
    sub,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: 'https://test.supabase.co/auth/v1',
  }) as Parameters<typeof verifySupabaseJWT> extends [
    string,
    string,
    string | undefined,
  ]
    ? Awaited<ReturnType<typeof verifySupabaseJWT>>
    : never;

describe('POST /relay/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a bot successfully', async () => {
    const { app, mockKV } = createTestApp();

    vi.mocked(verifyBotInGroup).mockResolvedValueOnce({
      ok: true,
      botId: '123456789',
      botName: 'test_bot',
      status: 'member',
    });

    const res = await app.request('/relay/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '-1001234567890',
        botToken: '123456789:token',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; botId: string; expiresAt: string };
    expect(body.ok).toBe(true);
    expect(body.botId).toBe('123456789');
    expect(body.expiresAt).toBeDefined();

    // Verify KV was called
    expect(mockKV.put).toHaveBeenCalled();
  });

  it('returns error for missing fields', async () => {
    const { app } = createTestApp();

    const res = await app.request('/relay/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: '-100123' }), // Missing botToken
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Missing required fields');
  });

  it('returns error when verification fails', async () => {
    const { app } = createTestApp();

    vi.mocked(verifyBotInGroup).mockResolvedValueOnce({
      ok: false,
      error: 'Bot is not a member of this group',
    });

    const res = await app.request('/relay/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '-100123',
        botToken: '123:token',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('not a member');
  });
});

describe('POST /relay/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts a message successfully', async () => {
    const { app, mockKV, mockDB } = createTestApp();

    // Set up mock JWT verification - cast to any to satisfy mock types
    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    // Pre-populate membership
    const membership: RelayMembership = {
      botId: 'user-123',
      botName: 'test_bot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:user-123:-100123', JSON.stringify(membership));

    const res = await app.request('/relay/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-jwt',
      },
      body: JSON.stringify({
        groupId: '-100123',
        messageId: 456,
        text: 'Hello world',
        timestamp: 1706000000,
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Verify message was written to D1
    expect(mockKV.get).toHaveBeenCalled();
    expect(mockDB._messages.size).toBe(1);
  });

  it('returns 401 without authentication', async () => {
    const { app } = createTestApp();

    const res = await app.request('/relay/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: '-100123',
        messageId: 456,
        text: 'Hello',
        timestamp: 1706000000,
      }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 without group membership', async () => {
    const { app } = createTestApp();

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    const res = await app.request('/relay/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid-jwt',
      },
      body: JSON.stringify({
        groupId: '-100123',
        messageId: 456,
        text: 'Hello',
        timestamp: 1706000000,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not registered');
  });
});

describe('GET /relay/poll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns messages from other bots', async () => {
    const { app, mockKV, mockDB } = createTestApp();

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    // Pre-populate membership
    const membership: RelayMembership = {
      botId: 'user-123',
      botName: 'my_bot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:user-123:-100123', JSON.stringify(membership));

    // Pre-populate messages in D1
    mockDB._messages.set('-100123|other-bot-1|1', {
      group_id: '-100123',
      bot_id: 'other-bot-1',
      bot_name: 'BotA',
      message_id: 1,
      text: 'Hello from bot A',
      timestamp: 1706000001,
    });
    mockDB._messages.set('-100123|other-bot-2|2', {
      group_id: '-100123',
      bot_id: 'other-bot-2',
      bot_name: 'BotB',
      message_id: 2,
      text: 'Hello from bot B',
      timestamp: 1706000002,
    });
    mockDB._messages.set('-100123|user-123|3', {
      group_id: '-100123',
      bot_id: 'user-123',
      bot_name: 'my_bot',
      message_id: 3,
      text: 'My own message',
      timestamp: 1706000003,
    });

    const res = await app.request('/relay/poll?groupId=-100123&since=0', {
      headers: { Authorization: 'Bearer valid-jwt' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RelayMessage[]; nextSince: number };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].botId).toBe('other-bot-1');
    expect(body.messages[1].botId).toBe('other-bot-2');
    expect(body.nextSince).toBe(1706000002);
  });

  it('filters messages by since parameter', async () => {
    const { app, mockKV, mockDB } = createTestApp();

    vi.mocked(verifySupabaseJWT).mockResolvedValueOnce(mockJwtPayload('user-123') as any);

    const membership: RelayMembership = {
      botId: 'user-123',
      botName: 'my_bot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:user-123:-100123', JSON.stringify(membership));

    mockDB._messages.set('-100123|other-bot|1', {
      group_id: '-100123',
      bot_id: 'other-bot',
      bot_name: 'Bot',
      message_id: 1,
      text: 'Old message',
      timestamp: 1706000001,
    });
    mockDB._messages.set('-100123|other-bot|2', {
      group_id: '-100123',
      bot_id: 'other-bot',
      bot_name: 'Bot',
      message_id: 2,
      text: 'New message',
      timestamp: 1706000010,
    });

    // Poll with since=1706000001 should only return msg2
    const res = await app.request('/relay/poll?groupId=-100123&since=1706000001', {
      headers: { Authorization: 'Bearer valid-jwt' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: RelayMessage[]; nextSince: number };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].timestamp).toBe(1706000010);
  });
});

describe('API Key authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authenticates with valid API key', async () => {
    const { app, mockKV } = createTestApp();

    // Pre-populate API key
    const apiKeyData: RelayApiKey = {
      botId: 'external-bot-123',
      botName: 'ExternalBot',
      createdAt: new Date().toISOString(),
      createdBy: 'admin',
    };
    mockKV._store.set('relay:apikey:relay_test123', JSON.stringify(apiKeyData));

    // Pre-populate membership
    const membership: RelayMembership = {
      botId: 'external-bot-123',
      botName: 'ExternalBot',
      groupId: '-100123',
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    mockKV._store.set('relay:membership:external-bot-123:-100123', JSON.stringify(membership));

    const res = await app.request('/relay/poll?groupId=-100123&since=0', {
      headers: { 'X-Relay-Key': 'relay_test123' },
    });

    expect(res.status).toBe(200);
  });

  it('rejects invalid API key', async () => {
    const { app } = createTestApp();

    const res = await app.request('/relay/poll?groupId=-100123&since=0', {
      headers: { 'X-Relay-Key': 'invalid_key' },
    });

    expect(res.status).toBe(401);
  });
});
