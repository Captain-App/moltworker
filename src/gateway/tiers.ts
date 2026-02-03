/**
 * Per-user instance type configuration
 * Maps user IDs to sandbox tier (standard-1, standard-2, standard-3)
 */

import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

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
  
  // Default: all other users get standard-1
};

/**
 * Get the appropriate sandbox binding for a user based on their tier
 */
export function getSandboxForUser(env: MoltbotEnv, userId: string): MoltbotEnv['SandboxStandard1'] {
  const tier = USER_TIER_MAP[userId] || 1;
  
  switch (tier) {
    case 3:
      return env.SandboxStandard3 || env.Sandbox;
    case 2:
      return env.SandboxStandard2 || env.Sandbox;
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