import AsyncStorage from '@react-native-async-storage/async-storage';
import { Config } from '../config';

const TOKEN_KEY = '@coach/auth_token';
const EXPIRES_KEY = '@coach/auth_expires';

/**
 * Returns a valid Supabase anonymous JWT, refreshing it if expired.
 * The token is persisted in AsyncStorage so it survives app restarts.
 */
export async function getToken(): Promise<string> {
  const [token, expiresStr] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY),
    AsyncStorage.getItem(EXPIRES_KEY),
  ]);

  if (token && expiresStr && Date.now() < parseInt(expiresStr, 10)) {
    return token;
  }

  return refreshToken();
}

async function refreshToken(): Promise<string> {
  const res = await fetch(
    `${Config.SUPABASE_URL}/auth/v1/token?grant_type=anonymous`,
    {
      method: 'POST',
      headers: {
        apikey: Config.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Auth failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh 60 seconds before actual expiry
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

  await Promise.all([
    AsyncStorage.setItem(TOKEN_KEY, data.access_token),
    AsyncStorage.setItem(EXPIRES_KEY, String(expiresAt)),
  ]);

  return data.access_token;
}

/** Clear cached credentials (e.g. on sign-out). */
export async function clearToken(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(TOKEN_KEY),
    AsyncStorage.removeItem(EXPIRES_KEY),
  ]);
}
