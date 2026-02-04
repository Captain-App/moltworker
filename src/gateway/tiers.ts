/**
 * Per-user instance type configuration
 * Maps user IDs to sandbox tier (standard-1, standard-2, standard-3)
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

// Feature flag - controlled via env.TIERED_ROUTING_ENABLED
// When false (default), all users use legacy 'Sandbox' binding
// When true, migrated users use tiered bindings based on USER_TIER_MAP
const TIERED_ROUTING_ENABLED = true; // Tiered routing enabled - 2026-02-04

/**
 * User ID to instance tier mapping
 * standard-1: 1 vCPU, 1 GiB RAM (~$3/mo) - default
 * standard-2: 2 vCPU, 2 GiB RAM (~$6/mo) - power users
 * standard-3: 4 vCPU, 4 GiB RAM (~$12/mo) - heavy users
 */
const USER_TIER_MAP: Record<string, 1 | 2 | 3> = {
  // Jack - heavy usage, founder (standard-3)
  '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b': 3,
  
  // Josh - active user (standard-2)
  '81bf6a68-28fe-48ef-b257-f9ad013e6298': 2,
  
  // Miles - power user, AI learning workspace (standard-2)
  'fe56406b-a723-43cf-9f19-ba2ffcb135b0': 2,
  
  // Default: all other users get standard-1
};

// Track which users have been migrated to tiered namespaces
// Migration requires: R2 sync → stop old → start new → verify
const MIGRATED_USERS = new Set<string>([
  // Tiered routing rollout - 2026-02-04
  '32c7100e-c6ce-4cf8-8b64-edf4ac3b760b', // Jack - standard-3
  '81bf6a68-28fe-48ef-b257-f9ad013e6298', // Josh - standard-2
  'fe56406b-a723-43cf-9f19-ba2ffcb135b0', // Miles - standard-2
]);

/**
 * Check if tiered routing is enabled (feature flag)
 */
function isTieredRoutingEnabled(env: MoltbotEnv): boolean {
  // Check env var first, fallback to compile-time default
  if (env.TIERED_ROUTING_ENABLED !== undefined) {
    return env.TIERED_ROUTING_ENABLED === 'true' || env.TIERED_ROUTING_ENABLED === true;
  }
  return TIERED_ROUTING_ENABLED;
}

/**
 * Get the appropriate sandbox binding for a user based on their tier
 * 
 * SAFETY: Returns legacy 'Sandbox' binding for:
 * - Non-migrated users (even if feature flag is on)
 * - All users when feature flag is off
 * - Any user where tiered binding is undefined
 */
export function getSandboxForUser(env: MoltbotEnv, userId: string): MoltbotEnv['SandboxStandard1'] {
  // Phase 2: Only use tiered routing if explicitly enabled AND user is migrated
  const tieredEnabled = isTieredRoutingEnabled(env);
  const isMigrated = MIGRATED_USERS.has(userId);
  
  if (!tieredEnabled || !isMigrated) {
    // Use legacy binding for safety
    return env.Sandbox;
  }
  
  // User is migrated and tiered routing is enabled
  const tier = USER_TIER_MAP[userId] || 1;
  
  console.log(`[TIERS] Using tiered binding for ${userId}: standard-${tier}`);
  
  switch (tier) {
    case 3:
      return env.SandboxStandard3 || env.SandboxStandard2 || env.SandboxStandard1 || env.Sandbox;
    case 2:
      return env.SandboxStandard2 || env.SandboxStandard1 || env.Sandbox;
    case 1:
    default:
      return env.SandboxStandard1 || env.Sandbox;
  }
}

/**
 * Get instance type name for logging/metrics
 */
export function getInstanceTypeName(userId: string): string {
  const tier = USER_TIER_MAP[userId] || 1;
  return `standard-${tier}`;
}

/**
 * Add or update a user's tier assignment
 */
export function setUserTier(userId: string, tier: 1 | 2 | 3): void {
  USER_TIER_MAP[userId] = tier;
  console.log(`[TIERS] User ${userId} assigned to standard-${tier}`);
}

/**
 * Get all tier assignments (for admin/debug)
 */
export function getAllTierAssignments(): Record<string, number> {
  return { ...USER_TIER_MAP };
}