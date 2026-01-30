import { Hono } from 'hono';
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { AppEnv, MoltbotEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';
import { verifySupabaseJWT } from '../../platform/auth/supabase-jwt';

/**
 * Build sandbox options based on environment configuration.
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  return { sleepAfter };
}

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Health check for gateway status
// Checks the user's sandbox if authenticated, otherwise default sandbox
publicRoutes.get('/api/status', async (c) => {
  let sandbox = c.get('sandbox');

  // Try to get authenticated user's sandbox
  try {
    const token = c.req.header('Authorization')?.replace('Bearer ', '') ||
                  c.req.raw.headers.get('cookie')?.match(/sb-access-token=([^;]+)/)?.[1];

    if (token && c.env.SUPABASE_JWT_SECRET) {
      // Don't validate issuer - signature verification with secret is sufficient
      const decoded = await verifySupabaseJWT(token, c.env.SUPABASE_JWT_SECRET);
      if (decoded) {
        const userId = decoded.sub;
        const sandboxName = `openclaw-${userId}`;
        const options = buildSandboxOptions(c.env);
        sandbox = getSandbox(c.env.Sandbox, sandboxName, options);
        console.log(`[API/status] Using authenticated user sandbox: ${sandboxName}`);
      }
    }
  } catch (err) {
    console.log('[API/status] Auth check failed, using default sandbox:', err);
  }

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// NOTE: /assets/* is NOT handled here - those requests go to the container proxy
// The auth middleware bypasses auth for /assets/* paths so they can be proxied

export { publicRoutes };
