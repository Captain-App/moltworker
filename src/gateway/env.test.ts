import { describe, it, expect } from 'vitest';
import { buildEnvVars } from './env';
import { createMockEnv } from '../test-utils';

describe('buildEnvVars', () => {
  it('returns empty object when no env vars set', () => {
    const env = createMockEnv();
    const result = buildEnvVars(env);
    expect(result).toEqual({});
  });

  it('includes ANTHROPIC_API_KEY when set directly', () => {
    const env = createMockEnv({ ANTHROPIC_API_KEY: 'sk-test-key' });
    const result = buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-test-key');
  });

  it('maps AI_GATEWAY_API_KEY to ANTHROPIC_API_KEY for Anthropic gateway', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic',
    });
    const result = buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-gateway-key');
    expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic');
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it('maps AI_GATEWAY_API_KEY to OPENAI_API_KEY for OpenAI gateway', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/openai',
    });
    const result = buildEnvVars(env);
    expect(result.OPENAI_API_KEY).toBe('sk-gateway-key');
    expect(result.OPENAI_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/openai');
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('passes AI_GATEWAY_BASE_URL directly', () => {
    const env = createMockEnv({
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic',
    });
    const result = buildEnvVars(env);
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic');
  });

  it('AI_GATEWAY_* takes precedence over direct provider keys for Anthropic', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.example.com/anthropic',
      ANTHROPIC_API_KEY: 'direct-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    const result = buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('gateway-key');
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.example.com/anthropic');
  });

  it('AI_GATEWAY_* takes precedence over direct provider keys for OpenAI', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.example.com/openai',
      OPENAI_API_KEY: 'direct-key',
    });
    const result = buildEnvVars(env);
    expect(result.OPENAI_API_KEY).toBe('gateway-key');
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.example.com/openai');
    expect(result.OPENAI_BASE_URL).toBe('https://gateway.example.com/openai');
  });

  it('falls back to ANTHROPIC_* when AI_GATEWAY_* not set', () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'direct-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    const result = buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('direct-key');
    expect(result.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('includes OPENAI_API_KEY when set directly (no gateway)', () => {
    const env = createMockEnv({ OPENAI_API_KEY: 'sk-openai-key' });
    const result = buildEnvVars(env);
    expect(result.OPENAI_API_KEY).toBe('sk-openai-key');
  });

  it('maps MOLTBOT_GATEWAY_MASTER_TOKEN to OPENCLAW_GATEWAY_TOKEN for container', () => {
    const env = createMockEnv({ MOLTBOT_GATEWAY_MASTER_TOKEN: 'my-token' });
    const result = buildEnvVars(env);
    expect(result.OPENCLAW_GATEWAY_TOKEN).toBe('my-token');
  });

  it('does not pass channel tokens to container (managed by bot config)', () => {
    // Channel tokens are now managed via the bot's control UI and stored in config,
    // not injected via env vars (prevents config reset on container restart)
    const env = createMockEnv({
      TELEGRAM_BOT_TOKEN: 'tg-token',
      DISCORD_BOT_TOKEN: 'discord-token',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
    });
    const result = buildEnvVars(env);

    expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(result.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_BOT_TOKEN).toBeUndefined();
    expect(result.SLACK_APP_TOKEN).toBeUndefined();
  });

  it('maps DEV_MODE to OPENCLAW_DEV_MODE for container', () => {
    const env = createMockEnv({
      DEV_MODE: 'true',
      CLAWDBOT_BIND_MODE: 'lan',
    });
    const result = buildEnvVars(env);

    expect(result.OPENCLAW_DEV_MODE).toBe('true');
    expect(result.OPENCLAW_BIND_MODE).toBe('lan');
  });

  it('combines all env vars correctly', () => {
    const env = createMockEnv({
      ANTHROPIC_API_KEY: 'sk-key',
      MOLTBOT_GATEWAY_MASTER_TOKEN: 'token',
    });
    const result = buildEnvVars(env);

    expect(result).toEqual({
      ANTHROPIC_API_KEY: 'sk-key',
      OPENCLAW_GATEWAY_TOKEN: 'token',
    });
  });

  it('handles trailing slash in AI_GATEWAY_BASE_URL for OpenAI', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/openai/',
    });
    const result = buildEnvVars(env);
    expect(result.OPENAI_API_KEY).toBe('sk-gateway-key');
    expect(result.OPENAI_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/openai');
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/openai');
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('handles trailing slash in AI_GATEWAY_BASE_URL for Anthropic', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic/',
    });
    const result = buildEnvVars(env);
    expect(result.ANTHROPIC_API_KEY).toBe('sk-gateway-key');
    expect(result.ANTHROPIC_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic');
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/anthropic');
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it('handles multiple trailing slashes in AI_GATEWAY_BASE_URL', () => {
    const env = createMockEnv({
      AI_GATEWAY_API_KEY: 'sk-gateway-key',
      AI_GATEWAY_BASE_URL: 'https://gateway.ai.cloudflare.com/v1/123/my-gw/openai///',
    });
    const result = buildEnvVars(env);
    expect(result.OPENAI_API_KEY).toBe('sk-gateway-key');
    expect(result.OPENAI_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/openai');
    expect(result.AI_GATEWAY_BASE_URL).toBe('https://gateway.ai.cloudflare.com/v1/123/my-gw/openai');
  });
});
