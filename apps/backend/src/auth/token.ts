import { SignJWT, jwtVerify, errors } from 'jose';

export interface SupabaseTokenClaims {
  sub: string; // user_id (from auth.users)
  aud: string; // audience (e.g. "authenticated")
  role: string; // "anon" or "authenticated"
  is_anonymous: boolean;
  iat: number;
  exp: number;
}

const ALG = 'HS256';

function getSecret(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export async function verifySupabaseToken(
  token: string,
  jwtSecret: string,
): Promise<SupabaseTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecret(jwtSecret));

    if (!payload.sub) {
      throw new Error('Invalid token claims: missing sub');
    }

    return {
      sub: payload.sub,
      aud: (payload.aud as string) ?? '',
      role: (payload.role as string) ?? '',
      is_anonymous: (payload.is_anonymous as boolean) ?? false,
      iat: payload.iat!,
      exp: payload.exp!,
    };
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new Error('Token expired', { cause: err });
    }
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      throw new Error('Invalid token signature', { cause: err });
    }
    throw err;
  }
}

/**
 * Mint a Supabase-compatible anonymous JWT for a user that was just created
 * via the Supabase Admin API. The token has the same structure Supabase Auth
 * would issue, signed with the project JWT secret.
 */
export async function createAnonymousToken(
  userId: string,
  jwtSecret: string,
  expiresInS = 3600,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresInS;

  const token = await new SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    is_anonymous: true,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(getSecret(jwtSecret));

  return { token, expiresAt };
}

/**
 * Test helper -- creates a token that mimics Supabase Auth anonymous sign-in.
 * NOT for production use.
 */
export async function _createTestSupabaseToken(
  userId: string,
  jwtSecret: string,
  overrides: Partial<{ aud: string; role: string; is_anonymous: boolean; expiresInS: number }> = {},
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresInS = overrides.expiresInS ?? 3600;
  const expiresAt = now + expiresInS;

  const token = await new SignJWT({
    aud: overrides.aud ?? 'authenticated',
    role: overrides.role ?? 'authenticated',
    is_anonymous: overrides.is_anonymous ?? true,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(getSecret(jwtSecret));

  return { token, expiresAt };
}
