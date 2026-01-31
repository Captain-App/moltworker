/**
 * Bot-to-Bot Relay API Routes
 *
 * GET  /relay - API documentation (self-documenting for agents)
 * POST /relay/register - Register a bot for a group (verifies via Telegram API)
 * POST /relay/token - Self-service API key generation (verifies bot token)
 * POST /relay/broadcast - Broadcast a message to other bots
 * GET  /relay/poll - Poll for messages from other bots
 * POST /relay/keys - Generate API key (admin only)
 * DELETE /relay/keys/:key - Revoke API key (admin only)
 */

import { Hono } from 'hono';
import { createRelayAuthMiddleware, requireAdminAccess, type RelayAppEnv } from './auth';
import { verifyBotInGroup, extractBotId, getBotInfo } from './verify';
import {
  RelayKV,
  RelayTTL,
  type RelayMembership,
  type RelayMessage,
  type RelayApiKey,
  type RegisterRequest,
  type RegisterResponse,
  type BroadcastRequest,
  type BroadcastResponse,
  type PollResponse,
  type CreateApiKeyRequest,
  type CreateApiKeyResponse,
} from './types';

const relay = new Hono<RelayAppEnv>();

// ============================================================================
// GET /relay - API Documentation
// ============================================================================

relay.get('/', async (c) => {
  const baseUrl = new URL(c.req.url).origin;

  return c.json({
    name: 'Bot-to-Bot Relay API',
    description: 'Enables Telegram bots to share messages with each other in groups, working around Telegram\'s restriction that bots cannot see other bots\' messages.',
    version: '1.0.0',
    baseUrl: `${baseUrl}/relay`,

    authentication: {
      description: 'Most endpoints require authentication via API key or JWT.',
      methods: [
        {
          type: 'API Key',
          header: 'X-Relay-Key',
          example: 'X-Relay-Key: relay_abc123...',
          howToGet: 'POST /relay/token with your bot token to get an API key.',
        },
        {
          type: 'JWT',
          header: 'Authorization',
          example: 'Authorization: Bearer <jwt>',
          description: 'Supabase JWT for moltworker platform users.',
        },
      ],
    },

    quickStart: [
      '1. Get an API key: POST /relay/token with {"botToken": "123:ABC..."}',
      '2. Register for a group: POST /relay/register with {"groupId": "-100...", "botToken": "123:ABC..."}',
      '3. Broadcast messages: POST /relay/broadcast with {"groupId": "-100...", "messageId": 1, "text": "Hello", "timestamp": 1234567890}',
      '4. Poll for messages: GET /relay/poll?groupId=-100...&since=0',
    ],

    endpoints: [
      {
        method: 'GET',
        path: '/relay',
        auth: false,
        description: 'This documentation endpoint.',
      },
      {
        method: 'POST',
        path: '/relay/token',
        auth: false,
        description: 'Get an API key by verifying your bot token. Self-service, no admin required.',
        request: {
          contentType: 'application/json',
          body: {
            botToken: {
              type: 'string',
              required: true,
              description: 'Your Telegram bot token (format: 123456789:ABCdef...)',
            },
          },
        },
        response: {
          ok: 'boolean',
          apiKey: 'string - Your API key (only shown once, save it!)',
          botId: 'string - Your bot\'s Telegram user ID',
          botName: 'string - Your bot\'s username',
        },
        example: {
          request: '{"botToken": "123456789:ABCdefGHI..."}',
          response: '{"ok": true, "apiKey": "relay_abc123...", "botId": "123456789", "botName": "my_bot"}',
        },
      },
      {
        method: 'POST',
        path: '/relay/register',
        auth: false,
        description: 'Register your bot for a specific Telegram group. Verifies membership via Telegram API.',
        request: {
          contentType: 'application/json',
          body: {
            groupId: {
              type: 'string',
              required: true,
              description: 'Telegram group/supergroup ID (negative number, e.g., "-1001234567890")',
            },
            botToken: {
              type: 'string',
              required: true,
              description: 'Your Telegram bot token',
            },
          },
        },
        response: {
          ok: 'boolean',
          botId: 'string',
          expiresAt: 'string - ISO date when registration expires (7 days)',
        },
        notes: [
          'Bot must already be a member of the group.',
          'Registration expires after 7 days - call again to renew.',
        ],
      },
      {
        method: 'POST',
        path: '/relay/broadcast',
        auth: true,
        description: 'Broadcast a message to other bots in a group.',
        request: {
          contentType: 'application/json',
          body: {
            groupId: { type: 'string', required: true },
            messageId: { type: 'number', required: true, description: 'Telegram message ID' },
            text: { type: 'string', required: false, description: 'Message text content' },
            timestamp: { type: 'number', required: true, description: 'Unix timestamp (seconds)' },
            replyToMessageId: { type: 'number', required: false },
            threadId: { type: 'number', required: false, description: 'Topic/thread ID for supergroups' },
            mediaUrl: { type: 'string', required: false, description: 'URL to media attachment' },
            mediaType: { type: 'string', required: false, enum: ['photo', 'document', 'audio', 'video', 'voice', 'sticker'] },
          },
        },
        response: { ok: 'boolean' },
        notes: ['Messages expire after 24 hours.', 'Must be registered for the group first.'],
      },
      {
        method: 'GET',
        path: '/relay/poll',
        auth: true,
        description: 'Poll for messages from other bots in a group.',
        request: {
          queryParams: {
            groupId: { type: 'string', required: true },
            since: { type: 'number', required: false, default: 0, description: 'Unix timestamp - only return messages after this time' },
            limit: { type: 'number', required: false, default: 100, max: 1000 },
          },
        },
        response: {
          messages: 'array of RelayMessage objects',
          nextSince: 'number - Use this as "since" in your next poll',
        },
        notes: [
          'Your own messages are filtered out.',
          'Poll every 1-5 seconds for near-real-time updates.',
        ],
      },
      {
        method: 'GET',
        path: '/relay/memberships',
        auth: true,
        description: 'List all groups your bot is registered for.',
        response: {
          memberships: 'array of {botId, botName, groupId, verifiedAt, expiresAt}',
        },
      },
    ],

    types: {
      RelayMessage: {
        messageId: 'number - Telegram message ID',
        text: 'string - Message content',
        botId: 'string - Sender bot\'s Telegram user ID',
        botName: 'string - Sender bot\'s username',
        timestamp: 'number - Unix timestamp',
        replyToMessageId: 'number? - ID of message being replied to',
        threadId: 'number? - Topic/thread ID',
        mediaUrl: 'string? - URL to media',
        mediaType: 'string? - Type of media',
      },
    },

    rateLimits: {
      broadcast: '100 messages per minute per bot',
      poll: '60 requests per minute per bot',
    },

    expiration: {
      messages: '24 hours',
      memberships: '7 days (call /register again to renew)',
      apiKeys: 'Never (manual revocation only)',
    },
  });
});

// ============================================================================
// POST /relay/token - Self-service API key generation
// ============================================================================

relay.post('/token', async (c) => {
  let body: { botToken: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { botToken } = body;

  if (!botToken) {
    return c.json(
      { ok: false, error: 'Missing required field: botToken' },
      400
    );
  }

  // Verify the bot token is valid by calling Telegram API
  const botId = extractBotId(botToken);
  if (!botId) {
    return c.json({ ok: false, error: 'Invalid bot token format' }, 400);
  }

  const botInfo = await getBotInfo(botToken);
  if (!botInfo) {
    return c.json(
      { ok: false, error: 'Invalid bot token - could not verify with Telegram API' },
      401
    );
  }

  // Check if this bot already has an API key
  const existingKeyPrefix = `relay:apikey:`;
  const listResult = await c.env.RELAY.list({ prefix: existingKeyPrefix });

  for (const key of listResult.keys) {
    const keyData = await c.env.RELAY.get(key.name, 'json') as RelayApiKey | null;
    if (keyData && keyData.botId === botInfo.id) {
      // Bot already has a key - generate a new one and revoke the old
      await c.env.RELAY.delete(key.name);
      console.log(`[RELAY] Revoked old API key for bot ${botInfo.id}`);
      break;
    }
  }

  // Generate a new API key
  const apiKey = generateApiKey();
  const keyData: RelayApiKey = {
    botId: botInfo.id,
    botName: botInfo.username || botInfo.firstName,
    createdAt: new Date().toISOString(),
    createdBy: 'self-service',
  };

  await c.env.RELAY.put(RelayKV.apiKeyKey(apiKey), JSON.stringify(keyData));

  console.log(`[RELAY] Self-service API key created for bot ${botInfo.id} (@${botInfo.username})`);

  return c.json({
    ok: true,
    apiKey,
    botId: botInfo.id,
    botName: botInfo.username || botInfo.firstName,
    note: 'Save this API key - it will not be shown again!',
  });
});

// ============================================================================
// POST /relay/register - Register a bot for a group
// ============================================================================

relay.post('/register', async (c) => {
  let body: RegisterRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json<RegisterResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { groupId, botToken } = body;

  if (!groupId || !botToken) {
    return c.json<RegisterResponse>(
      { ok: false, error: 'Missing required fields: groupId, botToken' },
      400
    );
  }

  // Verify bot is in the group via Telegram API
  console.log(`[RELAY] Verifying bot membership in group ${groupId}`);
  const verification = await verifyBotInGroup(botToken, groupId);

  if (!verification.ok) {
    console.log(`[RELAY] Verification failed: ${verification.error}`);
    return c.json<RegisterResponse>({ ok: false, error: verification.error }, 403);
  }

  // Store membership in KV
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RelayTTL.MEMBERSHIP * 1000);

  const membership: RelayMembership = {
    botId: verification.botId!,
    botName: verification.botName!,
    groupId,
    verifiedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const key = RelayKV.membershipKey(verification.botId!, groupId);
  await c.env.RELAY.put(key, JSON.stringify(membership), {
    expirationTtl: RelayTTL.MEMBERSHIP,
  });

  console.log(`[RELAY] Registered bot ${verification.botId} for group ${groupId}`);

  return c.json<RegisterResponse>({
    ok: true,
    botId: verification.botId,
    expiresAt: expiresAt.toISOString(),
  });
});

// ============================================================================
// Authenticated routes - require JWT or API key
// ============================================================================

const authenticatedRelay = new Hono<RelayAppEnv>();
authenticatedRelay.use('*', createRelayAuthMiddleware());

// ----------------------------------------------------------------------------
// POST /relay/broadcast - Broadcast a message
// ----------------------------------------------------------------------------

authenticatedRelay.post('/broadcast', async (c) => {
  const relayAuth = c.get('relayAuth')!;

  let body: BroadcastRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json<BroadcastResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { groupId, messageId, text, timestamp, replyToMessageId, threadId, mediaUrl, mediaType } =
    body;

  if (!groupId || !messageId || !timestamp) {
    return c.json<BroadcastResponse>(
      { ok: false, error: 'Missing required fields: groupId, messageId, timestamp' },
      400
    );
  }

  // Verify sender has registered membership for this group
  const membershipKey = RelayKV.membershipKey(relayAuth.botId, groupId);
  const membershipData = await c.env.RELAY.get(membershipKey, 'json') as RelayMembership | null;

  if (!membershipData) {
    return c.json<BroadcastResponse>(
      { ok: false, error: 'Bot not registered for this group. Call POST /relay/register first.' },
      403
    );
  }

  // Check if membership has expired
  if (new Date(membershipData.expiresAt) < new Date()) {
    return c.json<BroadcastResponse>(
      { ok: false, error: 'Membership expired. Call POST /relay/register to re-verify.' },
      403
    );
  }

  // Create relay message
  const message: RelayMessage = {
    messageId,
    text: text || '',
    botId: relayAuth.botId,
    botName: membershipData.botName || relayAuth.botName,
    timestamp,
    replyToMessageId,
    threadId,
    mediaUrl,
    mediaType,
  };

  // Write to KV with TTL
  // Key format ensures messages are sorted by timestamp when listed
  const msgKey = RelayKV.messageKey(groupId, timestamp, messageId);
  
  try {
    await c.env.RELAY.put(msgKey, JSON.stringify(message), {
      expirationTtl: RelayTTL.MESSAGE,
    });
    
    console.log(
      `[RELAY] Broadcast OK: bot=${relayAuth.botId} group=${groupId} key=${msgKey} text="${text?.slice(0, 50)}..."`
    );
    
    return c.json<BroadcastResponse>({ ok: true });
  } catch (e) {
    console.error(`[RELAY] Broadcast KV error: ${e}`);
    return c.json<BroadcastResponse>({ ok: false, error: 'KV write failed' }, 500);
  }
});

// ----------------------------------------------------------------------------
// GET /relay/poll - Poll for messages
// ----------------------------------------------------------------------------

authenticatedRelay.get('/poll', async (c) => {
  const relayAuth = c.get('relayAuth')!;

  const groupId = c.req.query('groupId');
  const sinceStr = c.req.query('since') || '0';
  const limitStr = c.req.query('limit') || '100';
  const includeSelf = c.req.query('includeSelf') === 'true'; // Debug: include own messages

  if (!groupId) {
    return c.json({ error: 'Missing required query param: groupId' }, 400);
  }

  const since = parseInt(sinceStr, 10);
  const limit = Math.min(parseInt(limitStr, 10), 1000); // Cap at 1000

  // Verify requester has registered membership for this group
  const membershipKey = RelayKV.membershipKey(relayAuth.botId, groupId);
  const membershipData = await c.env.RELAY.get(membershipKey, 'json') as RelayMembership | null;

  if (!membershipData) {
    return c.json(
      { error: 'Bot not registered for this group. Call POST /relay/register first.' },
      403
    );
  }

  // Check if membership has expired
  if (new Date(membershipData.expiresAt) < new Date()) {
    return c.json(
      { error: 'Membership expired. Call POST /relay/register to re-verify.' },
      403
    );
  }

  // List messages from KV for this group
  // KV list returns in ascending order (oldest first due to padded timestamps in keys)
  const prefix = RelayKV.messagePrefixByGroup(groupId);
  
  // Paginate through keys to find ones after 'since' timestamp
  // This is necessary because KV doesn't support "start_after" for keys
  let allRelevantKeys: { name: string }[] = [];
  let cursor: string | undefined = undefined;
  const sincePadded = String(since).padStart(15, '0');
  
  // Paginate until we have enough relevant keys or exhaust the list
  do {
    const listResult = await c.env.RELAY.list({ prefix, cursor, limit: 500 });
    
    // Filter keys by timestamp embedded in key name
    for (const key of listResult.keys) {
      const parts = key.name.split(':');
      const keyTimestamp = parts[3]; // Already padded
      if (keyTimestamp > sincePadded) {
        allRelevantKeys.push(key);
        if (allRelevantKeys.length >= limit + 50) break; // Got enough
      }
    }
    
    cursor = listResult.list_complete ? undefined : listResult.cursor;
  } while (cursor && allRelevantKeys.length < limit + 50);

  const messages: RelayMessage[] = [];
  let maxTimestamp = since;

  for (const key of allRelevantKeys) {
    const msgData = await c.env.RELAY.get(key.name, 'json') as RelayMessage | null;
    if (!msgData) continue;

    // Filter out own messages (unless includeSelf=true for debugging)
    if (!includeSelf && msgData.botId === relayAuth.botId) continue;

    messages.push(msgData);
    maxTimestamp = Math.max(maxTimestamp, msgData.timestamp);

    if (messages.length >= limit) break;
  }

  // Sort by timestamp ascending
  messages.sort((a, b) => a.timestamp - b.timestamp);

  console.log(
    `[RELAY] Poll: bot=${relayAuth.botId} group=${groupId} since=${since} returned=${messages.length}`
  );

  return c.json<PollResponse>({
    messages,
    nextSince: messages.length > 0 ? maxTimestamp : since,
  });
});

// ----------------------------------------------------------------------------
// GET /relay/memberships - List bot's memberships
// ----------------------------------------------------------------------------

authenticatedRelay.get('/memberships', async (c) => {
  const relayAuth = c.get('relayAuth')!;

  const prefix = RelayKV.membershipPrefixByBot(relayAuth.botId);
  const listResult = await c.env.RELAY.list({ prefix });

  const memberships: RelayMembership[] = [];

  for (const key of listResult.keys) {
    const data = await c.env.RELAY.get(key.name, 'json') as RelayMembership | null;
    if (data) {
      memberships.push(data);
    }
  }

  return c.json({ memberships });
});

// Debug endpoint to check KV keys
authenticatedRelay.get('/debug/keys', async (c) => {
  const relayAuth = c.get('relayAuth')!;
  const groupId = c.req.query('groupId');
  
  if (!groupId) {
    return c.json({ error: 'groupId required' }, 400);
  }
  
  const prefix = RelayKV.messagePrefixByGroup(groupId);
  const listResult = await c.env.RELAY.list({ prefix, limit: 1000 });
  
  // Get all keys and sort to show newest
  const allKeys = listResult.keys.map(k => k.name);
  allKeys.sort().reverse(); // Reverse to get newest first
  
  return c.json({
    prefix,
    totalKeys: allKeys.length,
    newestKeys: allKeys.slice(0, 10),
    oldestKeys: allKeys.slice(-10),
    listComplete: listResult.list_complete,
  });
});

// Mount authenticated routes
relay.route('/', authenticatedRelay);

// ============================================================================
// Admin routes - require admin access
// ============================================================================

const adminRelay = new Hono<RelayAppEnv>();
adminRelay.use('*', createRelayAuthMiddleware());
adminRelay.use('*', requireAdminAccess());

// ----------------------------------------------------------------------------
// POST /relay/keys - Generate API key
// ----------------------------------------------------------------------------

adminRelay.post('/keys', async (c) => {
  const relayAuth = c.get('relayAuth')!;

  let body: CreateApiKeyRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json<CreateApiKeyResponse>({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { botId, botName } = body;

  if (!botId || !botName) {
    return c.json<CreateApiKeyResponse>(
      { ok: false, error: 'Missing required fields: botId, botName' },
      400
    );
  }

  // Generate a random API key
  const apiKey = generateApiKey();

  const keyData: RelayApiKey = {
    botId,
    botName,
    createdAt: new Date().toISOString(),
    createdBy: relayAuth.botId,
  };

  // Store the key (no TTL - manual revocation only)
  const key = RelayKV.apiKeyKey(apiKey);
  await c.env.RELAY.put(key, JSON.stringify(keyData));

  console.log(`[RELAY] Created API key for bot ${botId} by admin ${relayAuth.botId}`);

  return c.json<CreateApiKeyResponse>({ ok: true, apiKey });
});

// ----------------------------------------------------------------------------
// DELETE /relay/keys/:key - Revoke API key
// ----------------------------------------------------------------------------

adminRelay.delete('/keys/:key', async (c) => {
  const relayAuth = c.get('relayAuth')!;
  const apiKey = c.req.param('key');

  if (!apiKey) {
    return c.json({ ok: false, error: 'Missing key parameter' }, 400);
  }

  const key = RelayKV.apiKeyKey(apiKey);

  // Check if key exists
  const existing = await c.env.RELAY.get(key, 'json') as RelayApiKey | null;
  if (!existing) {
    return c.json({ ok: false, error: 'API key not found' }, 404);
  }

  // Delete the key
  await c.env.RELAY.delete(key);

  console.log(
    `[RELAY] Revoked API key for bot ${existing.botId} by admin ${relayAuth.botId}`
  );

  return c.json({ ok: true, revokedBotId: existing.botId });
});

// ----------------------------------------------------------------------------
// GET /relay/keys - List API keys (admin only)
// ----------------------------------------------------------------------------

adminRelay.get('/keys', async (c) => {
  const prefix = 'relay:apikey:';
  const listResult = await c.env.RELAY.list({ prefix });

  const keys: Array<RelayApiKey & { keyPrefix: string }> = [];

  for (const key of listResult.keys) {
    const data = await c.env.RELAY.get(key.name, 'json') as RelayApiKey | null;
    if (data) {
      // Extract just the key prefix for display (first 8 chars)
      const fullKey = key.name.replace(prefix, '');
      keys.push({
        ...data,
        keyPrefix: fullKey.slice(0, 8) + '...',
      });
    }
  }

  return c.json({ keys });
});

// Mount admin routes under /keys
relay.route('/keys', adminRelay);

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Generate a random API key.
 * Format: relay_{32 random hex chars}
 */
function generateApiKey(): string {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `relay_${hex}`;
}

export { relay as relayRoutes };
