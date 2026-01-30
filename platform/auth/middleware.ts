import type { Context, Next } from 'hono';
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';
import type { AppEnv, MoltbotEnv, AuthenticatedUser } from '../../src/types';
import { verifySupabaseJWT, getUserIdFromPayload, getUserEmailFromPayload } from './supabase-jwt';

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
 * Options for creating a Supabase auth middleware
 */
export interface SupabaseAuthMiddlewareOptions {
  /** Response type: 'json' for API routes, 'html' for UI routes */
  type: 'json' | 'html';
}

/**
 * Check if running in development mode (skips auth)
 */
export function isDevMode(env: MoltbotEnv): boolean {
  return env.DEV_MODE === 'true';
}

/**
 * Extract JWT from Authorization header
 * Expected format: "Bearer <token>"
 */
export function extractBearerToken(c: Context<AppEnv>): string | null {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7); // Remove "Bearer " prefix
}

/**
 * Extract JWT from cookie
 * Checks both our cookie (sb-access-token) and the shared SSO cookie (captainapp-sso-v1)
 */
export function extractTokenFromCookie(c: Context<AppEnv>): string | null {
  const cookieHeader = c.req.header('Cookie');
  if (!cookieHeader) return null;

  // First try our cookie
  let match = cookieHeader.match(/sb-access-token=([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }

  // Try the shared SSO cookie from Captain App (captainapp-sso-v1)
  // This cookie contains JSON with the session data
  match = cookieHeader.match(/captainapp-sso-v1=([^;]+)/);
  if (match) {
    try {
      const sessionData = JSON.parse(decodeURIComponent(match[1]));
      // The session data structure is { access_token, refresh_token, ... }
      if (sessionData.access_token) {
        return sessionData.access_token;
      }
    } catch (e) {
      console.error('[AUTH] Failed to parse SSO cookie:', e);
    }
  }

  return null;
}

/**
 * Create a Supabase authentication middleware
 *
 * This middleware:
 * 1. Extracts JWT from Authorization header
 * 2. Verifies it using SUPABASE_JWT_SECRET
 * 3. Sets authenticated user info on the context
 *
 * @param options - Middleware options
 * @returns Hono middleware function
 */
export function createSupabaseAuthMiddleware(options: SupabaseAuthMiddlewareOptions) {
  const { type } = options;

  return async (c: Context<AppEnv>, next: Next) => {
    // Skip auth in dev mode
    if (isDevMode(c.env)) {
      c.set('user', {
        id: 'dev-user-id',
        email: 'dev@localhost',
        sandboxName: 'openclaw-dev-user-id',
        r2Prefix: 'users/dev-user-id',
      });
      return next();
    }

    const jwtSecret = c.env.SUPABASE_JWT_SECRET;
    const supabaseUrl = c.env.SUPABASE_URL;

    // Check if Supabase is configured
    if (!jwtSecret) {
      console.error('[AUTH] SUPABASE_JWT_SECRET is not configured');
      if (type === 'json') {
        return c.json({
          error: 'Authentication not configured',
          hint: 'Set SUPABASE_JWT_SECRET environment variable',
        }, 500);
      } else {
        return c.html(`
          <html>
            <body>
              <h1>Authentication Not Configured</h1>
              <p>Set SUPABASE_JWT_SECRET environment variable.</p>
            </body>
          </html>
        `, 500);
      }
    }

    // Get JWT from Authorization header or cookie
    const token = extractBearerToken(c) || extractTokenFromCookie(c);

    if (!token) {
      console.log('[AUTH] No token provided');
      if (type === 'json') {
        return c.json({
          error: 'Unauthorized',
          hint: 'Provide a valid JWT in the Authorization header: Bearer <token>',
        }, 401);
      } else {
        // Redirect to login page for HTML requests
        const returnTo = encodeURIComponent(c.req.url);
        return c.redirect(`/login?return_to=${returnTo}`);
      }
    }

    // Verify JWT
    try {
      // Build expected issuer from SUPABASE_URL if available
      const expectedIssuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : undefined;

      const payload = await verifySupabaseJWT(token, jwtSecret, expectedIssuer);
      const userId = getUserIdFromPayload(payload);
      const email = getUserEmailFromPayload(payload);

      // Set authenticated user info on context
      const user: AuthenticatedUser = {
        id: userId,
        email,
        sandboxName: `openclaw-${userId}`,
        r2Prefix: `users/${userId}`,
      };

      c.set('user', user);
      console.log(`[AUTH] Authenticated user: ${userId} (${email || 'no email'})`);

      // Update sandbox to user-specific sandbox BEFORE calling next()
      const options = buildSandboxOptions(c.env);
      const userSandbox = getSandbox(c.env.Sandbox, user.sandboxName, options);
      c.set('sandbox', userSandbox);
      console.log(`[AUTH] Using sandbox: ${user.sandboxName}`);

      await next();
    } catch (err) {
      console.error('[AUTH] JWT verification failed:', err);

      const errorMessage = err instanceof Error ? err.message : 'JWT verification failed';

      if (type === 'json') {
        return c.json({
          error: 'Unauthorized',
          details: errorMessage,
        }, 401);
      } else {
        // Redirect to login page for HTML requests
        const returnTo = encodeURIComponent(c.req.url);
        return c.redirect(`/login?return_to=${returnTo}`);
      }
    }
  };
}
