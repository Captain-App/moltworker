import type { AuthenticatedUser } from '../../src/types';

/**
 * Get the sandbox name for a user
 *
 * @param userId - The user's UUID
 * @returns The sandbox name (e.g., 'openclaw-abc123')
 */
export function getSandboxNameForUser(userId: string): string {
  return `openclaw-${userId}`;
}

/**
 * Get the R2 prefix for a user's data
 *
 * @param userId - The user's UUID
 * @returns The R2 prefix path (e.g., 'users/abc123')
 */
export function getR2PrefixForUser(userId: string): string {
  return `users/${userId}`;
}

/**
 * Build user routing info from user ID
 *
 * @param userId - The user's UUID
 * @param email - Optional email
 * @returns AuthenticatedUser object with routing info
 */
export function buildUserRoutingInfo(userId: string, email?: string): AuthenticatedUser {
  return {
    id: userId,
    email,
    sandboxName: getSandboxNameForUser(userId),
    r2Prefix: getR2PrefixForUser(userId),
  };
}
