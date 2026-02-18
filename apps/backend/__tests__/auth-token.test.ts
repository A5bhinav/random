import { describe, it, expect } from 'vitest';
import { verifySupabaseToken, _createTestSupabaseToken } from '../src/auth/token.js';

const SECRET = 'test-secret-at-least-32-chars-long!!';

describe('Supabase JWT token module', () => {
  it('creates and verifies a valid token', async () => {
    const userId = 'user_123';

    const { token, expiresAt } = await _createTestSupabaseToken(userId, SECRET);

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const claims = await verifySupabaseToken(token, SECRET);
    expect(claims.sub).toBe(userId);
    expect(claims.aud).toBe('authenticated');
    expect(claims.role).toBe('authenticated');
    expect(claims.is_anonymous).toBe(true);
    expect(claims.exp).toBe(expiresAt);
  });

  it('rejects token signed with wrong secret', async () => {
    const { token } = await _createTestSupabaseToken('user_1', SECRET);

    await expect(verifySupabaseToken(token, 'wrong-secret-also-32-chars-long!!')).rejects.toThrow(
      'Invalid token signature',
    );
  });

  it('rejects tampered token', async () => {
    const { token } = await _createTestSupabaseToken('user_1', SECRET);
    const tampered = token.slice(0, -5) + 'XXXXX';

    await expect(verifySupabaseToken(tampered, SECRET)).rejects.toThrow();
  });

  it('token contains correct Supabase claims structure', async () => {
    const { token } = await _createTestSupabaseToken('user_42', SECRET);
    const claims = await verifySupabaseToken(token, SECRET);

    expect(claims).toHaveProperty('sub', 'user_42');
    expect(claims).toHaveProperty('aud', 'authenticated');
    expect(claims).toHaveProperty('role', 'authenticated');
    expect(claims).toHaveProperty('is_anonymous', true);
    expect(claims).toHaveProperty('iat');
    expect(claims).toHaveProperty('exp');
  });

  it('supports custom claim overrides', async () => {
    const { token } = await _createTestSupabaseToken('user_99', SECRET, {
      role: 'anon',
      is_anonymous: false,
      aud: 'custom',
    });
    const claims = await verifySupabaseToken(token, SECRET);

    expect(claims.role).toBe('anon');
    expect(claims.is_anonymous).toBe(false);
    expect(claims.aud).toBe('custom');
  });

  it('rejects token missing sub claim', async () => {
    // Manually craft a token without sub
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);

    await expect(verifySupabaseToken(token, SECRET)).rejects.toThrow('missing sub');
  });
});
