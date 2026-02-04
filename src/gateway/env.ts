import type { MoltbotEnv } from '../types';

/**
 * Get the gateway master token from env, supporting both old and new names.
 * Prefers MOLTBOT_GATEWAY_MASTER_TOKEN, falls back to MOLTBOT_GATEWAY_TOKEN.
 */
export function getGatewayMasterToken(env: MoltbotEnv): string | undefined {
  return env.MOLTBOT_GATEWAY_MASTER_TOKEN || env.MOLTBOT_GATEWAY_TOKEN;
}

/**
 * Derive a per-user gateway token using HMAC-SHA256.
 * This ensures each user's container has a unique token derived from the master secret.
 *
 * @param masterSecret - The MOLTBOT_GATEWAY_MASTER_TOKEN worker secret
 * @param userId - The authenticated user's ID
 * @returns A unique token for this user (hex encoded)
 */
export async function deriveUserGatewayToken(masterSecret: string, userId: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(masterSecret);
  const message = encoder.encode(`gateway-token:${userId}`);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, message);
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build environment variables to pass to the Moltbot container process
 *
 * @param env - Worker environment bindings
 * @param userGatewayToken - Optional per-user gateway token (derived from master secret + user ID)
 * @param userId - Optional user ID for per-user R2 storage paths
 * @returns Environment variables record
 */
export function buildEnvVars(env: MoltbotEnv, userGatewayToken?: string, userId?: string): Record<string, string> {
  const envVars: Record<string, string> = {};

  // Normalize the base URL by removing trailing slashes
  const normalizedBaseUrl = env.AI_GATEWAY_BASE_URL?.replace(/\/+$/, '');
  const isOpenAIGateway = normalizedBaseUrl?.endsWith('/openai');

  // AI Gateway vars take precedence
  // Map to the appropriate provider env var based on the gateway endpoint
  if (env.AI_GATEWAY_API_KEY) {
    if (isOpenAIGateway) {
      envVars.OPENAI_API_KEY = env.AI_GATEWAY_API_KEY;
    } else {
      envVars.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY;
    }
  }

  // Fall back to direct provider keys
  if (!envVars.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY) {
    envVars.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  }
  if (!envVars.OPENAI_API_KEY && env.OPENAI_API_KEY) {
    envVars.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }

  // Pass base URL (used by start-moltbot.sh to determine provider)
  if (normalizedBaseUrl) {
    envVars.AI_GATEWAY_BASE_URL = normalizedBaseUrl;
    // Also set the provider-specific base URL env var
    if (isOpenAIGateway) {
      envVars.OPENAI_BASE_URL = normalizedBaseUrl;
    } else {
      envVars.ANTHROPIC_BASE_URL = normalizedBaseUrl;
    }
  } else if (env.ANTHROPIC_BASE_URL) {
    envVars.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  }
  // Map gateway token to OPENCLAW_GATEWAY_TOKEN (container expects this name)
  // Use per-user derived token if provided, otherwise fall back to master token
  const masterToken = getGatewayMasterToken(env);
  if (userGatewayToken) {
    envVars.OPENCLAW_GATEWAY_TOKEN = userGatewayToken;
  } else if (masterToken) {
    envVars.OPENCLAW_GATEWAY_TOKEN = masterToken;
  }
  if (env.DEV_MODE) envVars.OPENCLAW_DEV_MODE = env.DEV_MODE;
  if (env.CLAWDBOT_BIND_MODE) envVars.OPENCLAW_BIND_MODE = env.CLAWDBOT_BIND_MODE;
  // Channel tokens (Telegram, Discord, Slack) are managed via the bot's control UI,
  // stored in config, and persisted to R2. Not injected via env vars.
  if (env.CDP_SECRET) envVars.CDP_SECRET = env.CDP_SECRET;
  if (env.WORKER_URL) envVars.WORKER_URL = env.WORKER_URL;
  
  // R2 storage credentials
  if (env.R2_ACCESS_KEY_ID) envVars.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET_ACCESS_KEY) envVars.R2_SECRET_ACCESS_KEY = env.R2_SECRET_ACCESS_KEY;
  if (env.CF_ACCOUNT_ID) envVars.CF_ACCOUNT_ID = env.CF_ACCOUNT_ID;

  // User ID for per-user R2 storage paths
  if (userId) envVars.OPENCLAW_USER_ID = userId;

  return envVars;
}
