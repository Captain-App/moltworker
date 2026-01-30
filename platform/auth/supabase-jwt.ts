import { jwtVerify } from 'jose';

/**
 * Supabase JWT payload structure
 */
export interface SupabaseJWTPayload {
  /** Audience - typically 'authenticated' */
  aud: string;
  /** Expiration time (Unix timestamp) */
  exp: number;
  /** Issued at time (Unix timestamp) */
  iat: number;
  /** Issuer - the Supabase project URL */
  iss: string;
  /** Subject - the user's UUID */
  sub: string;
  /** User email */
  email?: string;
  /** Phone number */
  phone?: string;
  /** App metadata (role, provider, etc.) */
  app_metadata?: {
    provider?: string;
    providers?: string[];
  };
  /** User metadata (custom fields) */
  user_metadata?: Record<string, unknown>;
  /** User role */
  role?: string;
  /** Session ID */
  session_id?: string;
}

/**
 * Verify a Supabase JWT token using HS256 with the JWT secret.
 *
 * Supabase uses HS256 symmetric signing with SUPABASE_JWT_SECRET.
 * The JWT secret can be found in your Supabase project settings under API.
 *
 * @param token - The JWT token string (from Authorization: Bearer header)
 * @param jwtSecret - The Supabase JWT secret
 * @param expectedIssuer - Optional: The expected issuer (Supabase project URL)
 * @returns The decoded JWT payload if valid
 * @throws Error if the token is invalid, expired, or doesn't match expected values
 */
export async function verifySupabaseJWT(
  token: string,
  jwtSecret: string,
  expectedIssuer?: string
): Promise<SupabaseJWTPayload> {
  // Convert the secret to a Uint8Array for jose
  const secret = new TextEncoder().encode(jwtSecret);

  // Verify the JWT using jose
  const verifyOptions: { algorithms?: string[]; issuer?: string } = {
    algorithms: ['HS256'],
  };

  if (expectedIssuer) {
    verifyOptions.issuer = expectedIssuer;
  }

  const { payload } = await jwtVerify(token, secret, verifyOptions);

  // Validate required claims
  if (!payload.sub) {
    throw new Error('JWT missing sub claim (user ID)');
  }

  if (payload.aud !== 'authenticated') {
    throw new Error(`Invalid audience: expected 'authenticated', got '${payload.aud}'`);
  }

  return payload as unknown as SupabaseJWTPayload;
}

/**
 * Extract user ID from a verified Supabase JWT payload
 */
export function getUserIdFromPayload(payload: SupabaseJWTPayload): string {
  return payload.sub;
}

/**
 * Extract user email from a verified Supabase JWT payload
 */
export function getUserEmailFromPayload(payload: SupabaseJWTPayload): string | undefined {
  return payload.email;
}
