import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars, deriveUserGatewayToken } from './env';
import { mountR2Storage } from './r2';

/**
 * Load user-specific secrets from R2
 * These are stored at users/{userId}/secrets.json
 */
async function loadUserSecrets(env: MoltbotEnv, userId: string): Promise<Record<string, string>> {
  try {
    const secretsKey = `users/${userId}/secrets.json`;
    const object = await env.MOLTBOT_BUCKET.get(secretsKey);

    if (!object) {
      console.log(`[Secrets] No user secrets found for ${userId.slice(0, 8)}...`);
      return {};
    }

    const text = await object.text();
    const secrets = JSON.parse(text) as Record<string, string>;
    const keys = Object.keys(secrets).filter(k => secrets[k]);
    console.log(`[Secrets] Loaded ${keys.length} secrets for user ${userId.slice(0, 8)}...: ${keys.join(', ')}`);
    return secrets;
  } catch (err) {
    console.error(`[Secrets] Failed to load user secrets:`, err);
    return {};
  }
}

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "clawdbot devices list"
      // Note: CLI is still named "clawdbot" until upstream renames it
      const isGatewayProcess = 
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand = 
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param userId - Optional user ID for per-user token derivation (multi-tenant mode)
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv, userId?: string): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);

    // Always use full startup timeout - a process can be "running" but not ready yet
    // (e.g., just started by another concurrent request). Using a shorter timeout
    // causes race conditions where we kill processes that are still initializing.
    try {
      console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
      console.log('Moltbot gateway is reachable');
      return existingProcess;
    } catch (e) {
      // Timeout waiting for port - process is likely dead or stuck, kill and restart
      console.log('Existing process not reachable after full timeout, killing and restarting...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Derive per-user gateway token if userId provided
  let userGatewayToken: string | undefined;
  if (userId && env.MOLTBOT_GATEWAY_TOKEN) {
    userGatewayToken = await deriveUserGatewayToken(env.MOLTBOT_GATEWAY_TOKEN, userId);
    console.log(`[Gateway] Derived per-user token for user ${userId.slice(0, 8)}...`);
  }

  // Load user-specific secrets from R2
  let userSecrets: Record<string, string> = {};
  if (userId) {
    userSecrets = await loadUserSecrets(env, userId);
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');
  const envVars = buildEnvVars(env, userGatewayToken);

  // Merge user secrets into env vars (user secrets override worker secrets)
  // This allows users to configure their own bot tokens
  if (userSecrets.TELEGRAM_BOT_TOKEN) envVars.TELEGRAM_BOT_TOKEN = userSecrets.TELEGRAM_BOT_TOKEN;
  if (userSecrets.DISCORD_BOT_TOKEN) envVars.DISCORD_BOT_TOKEN = userSecrets.DISCORD_BOT_TOKEN;
  if (userSecrets.SLACK_BOT_TOKEN) envVars.SLACK_BOT_TOKEN = userSecrets.SLACK_BOT_TOKEN;
  if (userSecrets.SLACK_APP_TOKEN) envVars.SLACK_APP_TOKEN = userSecrets.SLACK_APP_TOKEN;
  if (userSecrets.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = userSecrets.ANTHROPIC_API_KEY;
  if (userSecrets.OPENAI_API_KEY) envVars.OPENAI_API_KEY = userSecrets.OPENAI_API_KEY;

  const command = '/usr/local/bin/start-moltbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars being passed:', Object.keys(envVars));

  let process: Process;
  try {
    process = await sandbox.startProcess(command, {
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`Moltbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');
  
  return process;
}
