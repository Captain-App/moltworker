/**
 * OpenClaw - Multi-Tenant Bot Platform
 *
 * This Worker runs personal AI assistant instances in Cloudflare Sandbox containers.
 * Each authenticated user gets their own isolated sandbox and R2 storage.
 *
 * Features:
 * - Per-user sandbox isolation (openclaw-{userId})
 * - Per-user R2 storage (users/{userId}/)
 * - Supabase authentication
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 *
 * Required secrets (set via `wrangler secret put`):
 * - SUPABASE_JWT_SECRET: Supabase JWT secret for auth
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - SUPABASE_URL: Supabase project URL (for issuer validation)
 * - MOLTBOT_GATEWAY_MASTER_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv, AuthenticatedUser } from './types';
import { MOLTBOT_PORT, HEALTH_CHECK_CONFIG } from './config';
import { createSupabaseAuthMiddleware } from '../platform/auth';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
  syncToR2,
  deriveUserGatewayToken,
  getGatewayMasterToken,
  checkHealth,
  shouldRestart,
  recordRestart,
} from './gateway';
import {
  createIssue,
  logSyncEvent,
  logHealthEvent,
  logRestartEvent,
} from './monitoring';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }
  
  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }
  
  return message;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];

  if (!getGatewayMasterToken(env)) {
    missing.push('MOLTBOT_GATEWAY_MASTER_TOKEN (or legacy MOLTBOT_GATEWAY_TOKEN)');
  }

  // Require Supabase JWT secret for authentication
  if (!env.SUPABASE_JWT_SECRET) {
    missing.push('SUPABASE_JWT_SECRET');
  }

  // Check for AI Gateway or direct Anthropic configuration
  if (env.AI_GATEWAY_API_KEY) {
    // AI Gateway requires both API key and base URL
    if (!env.AI_GATEWAY_BASE_URL) {
      missing.push('AI_GATEWAY_BASE_URL (required when using AI_GATEWAY_API_KEY)');
    }
  } else if (!env.ANTHROPIC_API_KEY) {
    // Direct Anthropic access requires API key
    missing.push('ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY');
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 * 
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 * 
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';
  
  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }
  
  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${url.search}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

/**
 * Get the sandbox name for the current request.
 * Uses authenticated user's sandbox name, or falls back to 'moltbot' for public routes.
 */
function getSandboxNameForRequest(c: { get: (key: 'user') => AuthenticatedUser | undefined }): string {
  const user = c.get('user');
  if (user) {
    return user.sandboxName;
  }
  // Fallback for public routes (before auth runs)
  return 'moltbot';
}

// Middleware: Initialize sandbox for all requests
// Note: For authenticated routes, the sandbox name is updated after auth middleware runs
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  // Initially use default sandbox; will be updated for authenticated users
  const sandboxName = getSandboxNameForRequest(c);
  const sandbox = getSandbox(c.env.Sandbox, sandboxName, options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// AUTH ROUTES: Login, logout, and OAuth callbacks
// =============================================================================

// Login page - redirect to main app for SSO
app.get('/login', async (c) => {
  // Redirect to the main Captain App for login (shared SSO cookie on .captainapp.co.uk)
  // After auth, it will redirect back with session tokens in the hash
  const returnUrl = encodeURIComponent('https://claw.captainapp.co.uk/auth/callback');
  return c.redirect(`https://captainapp.co.uk/auth?redirect=${returnUrl}`);
});

// Auth callback - handle session tokens from the hash (set by app.captainapp.co.uk)
app.get('/auth/callback', async (c) => {
  // The main app redirects back with tokens in the hash: #access_token=xxx&refresh_token=xxx...
  // We need client-side JS to read the hash and set the cookie
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Signing in...</title>
      <style>
        body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #fff; }
        .loading { text-align: center; }
        .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #f97316; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
    </head>
    <body>
      <div class="loading">
        <div class="spinner"></div>
        <p>Signing in...</p>
      </div>
      <script>
        // Parse tokens from hash
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');

        if (accessToken) {
          // Set cookie for server-side auth (shared across .captainapp.co.uk)
          const domain = '; domain=.captainapp.co.uk';
          document.cookie = 'sb-access-token=' + encodeURIComponent(accessToken) + domain + '; path=/; max-age=3600; SameSite=Lax; Secure';

          // Redirect to main app
          window.location.replace('/');
        } else {
          // No token in hash, check if SSO cookie exists and redirect
          // The cookie might have been set by the main app already
          window.location.replace('/');
        }
      </script>
    </body>
    </html>
  `);
});

// Logout - redirect to main app's logout
app.get('/logout', async (c) => {
  // Clear our cookie and redirect to login
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head><title>Logging out...</title></head>
    <body>
      <p>Logging out...</p>
      <script>
        // Clear cookies on .captainapp.co.uk domain
        document.cookie = 'sb-access-token=; domain=.captainapp.co.uk; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
        document.cookie = 'captainapp-sso-v1=; domain=.captainapp.co.uk; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
        window.location.href = '/login';
      </script>
    </body>
    </html>
  `);
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Debug bypass endpoint (requires secret header, bypasses CF Access)
app.get('/debug-bypass', async (c) => {
  console.log('[DEBUG-BYPASS] Hit debug-bypass endpoint');
  const secret = c.req.header('X-Debug-Secret');
  const expectedSecret = getGatewayMasterToken(c.env);

  console.log('[DEBUG-BYPASS] Secret provided:', !!secret);
  console.log('[DEBUG-BYPASS] Expected secret exists:', !!expectedSecret);

  if (!secret || secret !== expectedSecret) {
    console.log('[DEBUG-BYPASS] Unauthorized - secret mismatch');
    return c.json({ error: 'Unauthorized', hasSecret: !!secret, hasExpected: !!expectedSecret }, 401);
  }

  const sandbox = c.get('sandbox');

  try {
    // Check gateway status
    const processes = await sandbox.listProcesses();
    const gatewayProcess = processes.find(p => p.command.includes('start-moltbot'));

    return c.json({
      gateway: {
        running: !!gatewayProcess,
        processId: gatewayProcess?.id,
        status: gatewayProcess?.status,
      },
      totalProcesses: processes.length,
      env: {
        hasAnthropicKey: !!c.env.ANTHROPIC_API_KEY,
        hasOpenAIKey: !!c.env.OPENAI_API_KEY,
        hasGatewayToken: !!getGatewayMasterToken(c.env),
        devMode: c.env.DEV_MODE,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  
  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }
  
  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }
  
  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));
    
    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }
    
    // Return JSON error for API requests
    return c.json({
      error: 'Configuration error',
      message: 'Required environment variables are not configured',
      missing: missingVars,
      hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
    }, 503);
  }
  
  return next();
});

// Middleware: Supabase authentication for protected routes
app.use('*', async (c, next) => {
  // Skip auth for public/auth endpoints and static assets
  const url = new URL(c.req.url);
  const publicPaths = ['/login', '/logout', '/auth/callback'];
  const isPublicPath = publicPaths.includes(url.pathname) ||
                       url.pathname.startsWith('/_admin/assets/') ||
                       url.pathname.startsWith('/debug/admin/') ||
                       url.pathname.startsWith('/api/super/'); // TEMP: super admin debug endpoints
  console.log(`[AUTH] Path: ${url.pathname}, isPublic: ${isPublicPath}`);
  if (isPublicPath) {
    return next();
  }

  // Skip auth for admin API routes when X-Admin-Secret header is valid
  if (url.pathname.startsWith('/api/admin/')) {
    const adminSecret = c.req.header('X-Admin-Secret');
    const expectedSecret = getGatewayMasterToken(c.env);
    if (adminSecret && adminSecret === expectedSecret) {
      console.log(`[AUTH] Admin secret auth for ${url.pathname}`);
      return next();
    }
  }

  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createSupabaseAuthMiddleware({
    type: acceptsHtml ? 'html' : 'json',
  });

  // Run auth middleware (sandbox is updated inside middleware before next() is called)
  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// Emergency container reset endpoint (requires auth)
// Uses the authenticated user's sandbox
// Supports both GET and POST for easy mobile access
app.get('/emergency-reset', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('user')?.id;

  console.log(`[RESET] Resetting sandbox for user: ${userId}`);

  try {
    const allProcesses = await sandbox.listProcesses();
    for (const proc of allProcesses) {
      try { await proc.kill(); } catch (e) { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 2000));

    try {
      await sandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null');
    } catch (e) { /* ignore */ }

    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch(() => {});
    c.executionCtx.waitUntil(bootPromise);

    return c.json({ success: true, message: 'Container reset initiated', sandbox: userId ? `openclaw-${userId}` : 'moltbot' });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

app.post('/emergency-reset', async (c) => {
  const sandbox = c.get('sandbox');
  const userId = c.get('user')?.id;

  console.log(`[RESET] Resetting sandbox for user: ${userId}`);

  try {
    const allProcesses = await sandbox.listProcesses();
    for (const proc of allProcesses) {
      try { await proc.kill(); } catch (e) { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 2000));

    try {
      await sandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null');
    } catch (e) { /* ignore */ }

    const bootPromise = ensureMoltbotGateway(sandbox, c.env, userId).catch(() => {});
    c.executionCtx.waitUntil(bootPromise);

    return c.json({ success: true, message: 'Container reset initiated', sandbox: userId ? `openclaw-${userId}` : 'moltbot' });
  } catch (error) {
    return c.json({ error: String(error) }, 500);
  }
});

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const user = c.get('user');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Determine request type
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await) - pass user ID for per-user token
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env, user?.id).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      })
    );

    // Return the loading page immediately, with user info injected
    const userEmail = user?.email || 'User';
    const loadingPage = loadingPageHtml.replace('{{USER_EMAIL}}', userEmail);
    return c.html(loadingPage);
  }

  // Ensure moltbot is running (this will wait for startup) - pass user ID for per-user token
  try {
    await ensureMoltbotGateway(sandbox, c.env, user?.id);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json({
      error: 'Moltbot gateway failed to start',
      details: errorMessage,
      hint,
    }, 503);
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    console.log('[WS] Proxying WebSocket connection to Moltbot');
    console.log('[WS] URL:', request.url);
    console.log('[WS] Search params:', url.search);

    // Inject gateway token for container auth
    // Use per-user derived token if user is authenticated
    let wsUrl = new URL(request.url);
    let gatewayToken: string | undefined;
    const masterToken = getGatewayMasterToken(c.env);
    if (user && masterToken) {
      gatewayToken = await deriveUserGatewayToken(masterToken, user.id);
      console.log(`[WS] Using per-user derived token for user ${user.id.slice(0, 8)}...`);
    } else {
      gatewayToken = masterToken;
    }

    // Add token to URL and as header (container might not see URL params)
    if (gatewayToken) {
      wsUrl.searchParams.set('token', gatewayToken);
      console.log('[WS] Set gateway token in WebSocket URL');
    }

    // Create request with token in header as well
    const wsHeaders = new Headers(request.headers);
    if (gatewayToken) {
      wsHeaders.set('X-Gateway-Token', gatewayToken);
      wsHeaders.set('Authorization', `Bearer ${gatewayToken}`);
    }
    const wsRequest = new Request(wsUrl.toString(), {
      method: request.method,
      headers: wsHeaders,
    });
    
    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);
    
    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }
    
    console.log('[WS] Got container WebSocket, setting up interception');
    
    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());
    
    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();
    
    console.log('[WS] Both WebSockets accepted');
    console.log('[WS] containerWs.readyState:', containerWs.readyState);
    console.log('[WS] serverWs.readyState:', serverWs.readyState);
    
    // Relay messages from client to container, injecting token into connect credentials
    serverWs.addEventListener('message', (event) => {
      console.log('[WS] Client -> Container:', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)');
      let data = event.data;

      // Inject gateway token into connect message auth field
      // Gateway expects: params.auth.token (see gateway/auth.js and message-handler.js)
      // IMPORTANT: Remove device object to skip device signature validation
      // When hasTokenAuth is true AND no device object, gateway allows connection (line 238-275 of message-handler.js)
      if (typeof data === 'string' && gatewayToken) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.method === 'connect' && parsed.params) {
            console.log('[WS] Injecting gateway token into connect auth');
            // Initialize auth object if it doesn't exist, preserving other properties
            parsed.params.auth = parsed.params.auth || {};
            parsed.params.auth.token = gatewayToken;
            // Remove device object - token auth doesn't need device signature validation
            // This prevents "device signature invalid" errors
            delete parsed.params.device;
            // Remove any credentials field that might conflict with schema
            delete parsed.params.credentials;
            // Change client ID from "clawdbot-control-ui" to "webchat" to bypass the HTTPS requirement
            // The gateway has special handling for control-ui that requires secure context,
            // but webchat with token auth works fine over HTTP behind a proxy
            if (parsed.params.client?.id === 'clawdbot-control-ui' || parsed.params.client?.id === 'control-ui') {
              console.log('[WS] Changing client ID from', parsed.params.client.id, 'to webchat for proxy compatibility');
              parsed.params.client.id = 'webchat';
            }
            data = JSON.stringify(parsed);
            console.log('[WS] Modified connect params (device removed):', JSON.stringify(parsed.params).slice(0, 300));
          }
        } catch (e) {
          // Not JSON, pass through as-is
        }
      }

      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(data);
      } else {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });
    
    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      console.log('[WS] Container -> Client (raw):', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)');
      let data = event.data;
      
      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          if (parsed.error?.message) {
            console.log('[WS] Original error.message:', parsed.error.message);
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            console.log('[WS] Transformed error.message:', parsed.error.message);
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          console.log('[WS] Not JSON or parse error:', e);
        }
      }
      
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });
    
    // Handle close events
    serverWs.addEventListener('close', (event) => {
      console.log('[WS] Client closed:', event.code, event.reason);
      containerWs.close(event.code, event.reason);
    });
    
    containerWs.addEventListener('close', (event) => {
      console.log('[WS] Container closed:', event.code, event.reason);
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      console.log('[WS] Transformed close reason:', reason);
      serverWs.close(event.code, reason);
    });
    
    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });
    
    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });
    
    console.log('[WS] Returning intercepted WebSocket response');
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  // For HTML responses, inject gateway token and logout button
  const contentType = httpResponse.headers.get('content-type') || '';
  if (contentType.includes('text/html') && user) {
    const html = await httpResponse.text();

    // Derive the gateway token for this user
    let gatewayToken = '';
    const masterToken = getGatewayMasterToken(c.env);
    if (masterToken) {
      gatewayToken = await deriveUserGatewayToken(masterToken, user.id);
    }

    const injectedScript = `
<script>
// Gateway token for WebSocket authentication - store in localStorage for Control UI
window.__GATEWAY_TOKEN__ = '${gatewayToken}';
if ('${gatewayToken}') {
  // Store token in localStorage where Control UI looks for it
  try {
    localStorage.setItem('clawdbot-gateway-token', '${gatewayToken}');
    localStorage.setItem('gateway-token', '${gatewayToken}');
    // Also try the Control UI's config storage format
    var config = JSON.parse(localStorage.getItem('clawdbot-control-ui-config') || '{}');
    config.gatewayToken = '${gatewayToken}';
    config.token = '${gatewayToken}';
    localStorage.setItem('clawdbot-control-ui-config', JSON.stringify(config));
    console.log('[Injected] Set gateway token in localStorage');
  } catch(e) { console.error('[Injected] localStorage error:', e); }
}

// Logout button
(function() {
  var btn = document.createElement('a');
  btn.href = '/logout';
  btn.innerHTML = 'Logout (${user.email || 'User'})';
  btn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#1a1a2e;color:#f97316;padding:8px 16px;border-radius:6px;text-decoration:none;font-family:system-ui,sans-serif;font-size:13px;border:1px solid #f97316;';
  btn.onmouseover = function() { this.style.background='#f97316'; this.style.color='#fff'; };
  btn.onmouseout = function() { this.style.background='#1a1a2e'; this.style.color='#f97316'; };
  document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(btn); });
  if (document.body) document.body.appendChild(btn);
})();

// Emergency reset button
(function() {
  var btn = document.createElement('button');
  btn.innerHTML = 'Reset';
  btn.title = 'Emergency container reset';
  btn.style.cssText = 'position:fixed;top:10px;right:200px;z-index:99999;background:#1a1a2e;color:#ef4444;padding:8px 16px;border-radius:6px;font-family:system-ui,sans-serif;font-size:13px;border:1px solid #ef4444;cursor:pointer;';
  btn.onmouseover = function() { this.style.background='#ef4444'; this.style.color='#fff'; };
  btn.onmouseout = function() { this.style.background='#1a1a2e'; this.style.color='#ef4444'; };
  btn.onclick = async function() {
    if (!confirm('Reset container? This will restart the gateway.')) return;
    btn.disabled = true;
    btn.innerHTML = 'Resetting...';
    try {
      var res = await fetch('/emergency-reset');
      var data = await res.json();
      if (data.success) {
        btn.innerHTML = 'Done!';
        setTimeout(function() { window.location.reload(); }, 2000);
      } else {
        alert('Reset failed: ' + (data.error || 'Unknown error'));
        btn.disabled = false;
        btn.innerHTML = 'Reset';
      }
    } catch(e) {
      alert('Reset failed: ' + e.message);
      btn.disabled = false;
      btn.innerHTML = 'Reset';
    }
  };
  document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(btn); });
  if (document.body) document.body.appendChild(btn);
})();

// Patch WebSocket to auto-add token to clawdbot gateway connections
(function() {
  var OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    var token = window.__GATEWAY_TOKEN__;
    if (token && url && (url.includes('://') || url.startsWith('/'))) {
      try {
        var wsUrl = new URL(url, window.location.origin);
        // Only add token if not already present and it's a local connection
        if (!wsUrl.searchParams.has('token') && wsUrl.host === window.location.host) {
          wsUrl.searchParams.set('token', token);
          url = wsUrl.toString();
          console.log('[WS-Patch] Added token to WebSocket URL');
        }
      } catch(e) {
        console.error('[WS-Patch] Error:', e);
      }
    }
    return new OriginalWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
})();
</script>`;
    // Inject before </head> or </body> or at end
    let modifiedHtml = html;
    if (html.includes('</head>')) {
      modifiedHtml = html.replace('</head>', injectedScript + '</head>');
    } else if (html.includes('</body>')) {
      modifiedHtml = html.replace('</body>', injectedScript + '</body>');
    } else {
      modifiedHtml = html + injectedScript;
    }
    newHeaders.delete('content-length');
    return new Response(modifiedHtml, {
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      headers: newHeaders,
    });
  }

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

/**
 * Scheduled handler for cron triggers.
 * Runs health checks and syncs all user containers to R2.
 */
async function scheduled(
  _event: ScheduledEvent,
  env: MoltbotEnv,
  _ctx: ExecutionContext
): Promise<void> {
  console.log('[cron] Starting health checks and backup sync...');

  // List all users from R2 bucket
  const userIds = new Set<string>();
  try {
    const listed = await env.MOLTBOT_BUCKET.list({ prefix: 'users/' });
    for (const obj of listed.objects) {
      const match = obj.key.match(/^users\/([^/]+)\//);
      if (match) {
        userIds.add(match[1]);
      }
    }
  } catch (err) {
    console.error('[cron] Failed to list users from R2:', err);
  }

  console.log(`[cron] Found ${userIds.size} users to check`);

  const options = buildSandboxOptions(env);

  // Stats
  let healthyCount = 0;
  let unhealthyCount = 0;
  let restartCount = 0;
  let syncSuccessCount = 0;
  let syncFailCount = 0;
  let skippedCount = 0;
  const issues: Array<{ userId: string; type: string; error: string }> = [];

  // Process each user's sandbox
  for (const userId of userIds) {
    const sandboxName = `openclaw-${userId}`;
    const r2Prefix = `users/${userId}`;

    try {
      const sandbox = getSandbox(env.Sandbox, sandboxName, options);

      // Check if sandbox has any processes (skip if not active)
      const processes = await sandbox.listProcesses();
      if (processes.length === 0) {
        console.log(`[cron] Skipping ${sandboxName} - no active processes`);
        skippedCount++;
        continue;
      }

      // Run health check
      const healthResult = await checkHealth(sandbox, userId, HEALTH_CHECK_CONFIG);

      // Log health event
      logHealthEvent(userId, healthResult.healthy, {
        consecutiveFailures: healthResult.consecutiveFailures,
        processRunning: healthResult.checks.processRunning,
        portReachable: healthResult.checks.portReachable,
        uptimeSeconds: healthResult.uptimeSeconds,
      });

      if (healthResult.healthy) {
        healthyCount++;
        console.log(`[cron] Health OK: ${sandboxName} (uptime: ${healthResult.uptimeSeconds}s)`);
      } else {
        unhealthyCount++;
        console.warn(`[cron] Health FAIL: ${sandboxName} - failures: ${healthResult.consecutiveFailures}, checks: ${JSON.stringify(healthResult.checks)}`);

        // Check if we should auto-restart
        if (shouldRestart(userId, HEALTH_CHECK_CONFIG)) {
          console.log(`[cron] Auto-restarting ${sandboxName} after ${healthResult.consecutiveFailures} consecutive failures`);
          issues.push({ userId, type: 'auto_restart', error: `${healthResult.consecutiveFailures} consecutive health check failures` });

          // Record issue to D1
          if (env.PLATFORM_DB) {
            await createIssue(env.PLATFORM_DB, {
              type: 'health_failure',
              severity: 'high',
              userId,
              message: `Auto-restart triggered after ${healthResult.consecutiveFailures} consecutive health check failures`,
              details: {
                checks: healthResult.checks,
                uptimeSeconds: healthResult.uptimeSeconds,
              },
            });
          }

          try {
            // Kill all processes
            for (const proc of processes) {
              try { await proc.kill(); } catch { /* ignore */ }
            }
            await new Promise(r => setTimeout(r, 2000));

            // Clear locks
            try {
              await sandbox.startProcess('rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock 2>/dev/null');
            } catch { /* ignore */ }

            // Start fresh gateway (don't await - let it run async)
            ensureMoltbotGateway(sandbox, env, userId).catch((err) => {
              console.error(`[cron] Auto-restart failed for ${sandboxName}:`, err);
            });

            recordRestart(userId);
            restartCount++;
            logRestartEvent(userId, true, 'auto_health_failure', { previousFailures: healthResult.consecutiveFailures });
            console.log(`[cron] Auto-restart initiated for ${sandboxName}`);
          } catch (restartErr) {
            console.error(`[cron] Failed to restart ${sandboxName}:`, restartErr);
            issues.push({ userId, type: 'restart_failed', error: restartErr instanceof Error ? restartErr.message : 'Unknown error' });
            logRestartEvent(userId, false, 'auto_health_failure', { previousFailures: healthResult.consecutiveFailures });

            // Record restart failure to D1
            if (env.PLATFORM_DB) {
              await createIssue(env.PLATFORM_DB, {
                type: 'restart',
                severity: 'critical',
                userId,
                message: `Auto-restart failed: ${restartErr instanceof Error ? restartErr.message : 'Unknown error'}`,
                details: { previousFailures: healthResult.consecutiveFailures },
              });
            }
          }
        }
      }

      // Run sync (only if sandbox is active and healthy or just restarted)
      const syncResult = await syncToR2(sandbox, env, { r2Prefix });

      // Log sync event
      logSyncEvent(userId, syncResult.success, syncResult.durationMs || 0, {
        fileCount: syncResult.fileCount,
        error: syncResult.error,
        syncId: syncResult.syncId,
      });

      if (syncResult.success) {
        console.log(`[cron] Synced ${sandboxName}: ${syncResult.fileCount} files in ${syncResult.durationMs}ms`);
        syncSuccessCount++;
      } else {
        console.error(`[cron] Sync failed for ${sandboxName}: ${syncResult.error}`);
        issues.push({ userId, type: 'sync_failed', error: syncResult.error || 'Unknown error' });
        syncFailCount++;

        // Record sync failure to D1 (only if consecutive failures)
        // We don't want to spam issues for every single sync failure
        const recentSyncFailures = issues.filter(i => i.userId === userId && i.type === 'sync_failed').length;
        if (recentSyncFailures >= 3 && env.PLATFORM_DB) {
          await createIssue(env.PLATFORM_DB, {
            type: 'sync_failure',
            severity: 'medium',
            userId,
            message: `Sync failed: ${syncResult.error}`,
            details: {
              rsyncExitCode: syncResult.rsyncExitCode,
              syncId: syncResult.syncId,
              details: syncResult.details,
            },
          });
        }
      }

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[cron] Error processing ${sandboxName}:`, err);
      issues.push({ userId, type: 'cron_error', error: errorMsg });
    }
  }

  // Log summary
  console.log(`[cron] Complete - Health: ${healthyCount} healthy, ${unhealthyCount} unhealthy, ${restartCount} restarted`);
  console.log(`[cron] Complete - Sync: ${syncSuccessCount} succeeded, ${syncFailCount} failed, ${skippedCount} skipped`);
  if (issues.length > 0) {
    console.error(`[cron] Issues:`, JSON.stringify(issues.slice(0, 10)));
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
