import 'dotenv/config';

interface AppConfig {
  NODE_ENV: string;
  PORT: number;
  HOST: string;

  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  REDIS_URL: string;

  DEEPGRAM_API_KEY: string;
  OPENAI_API_KEY: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): AppConfig {
  return {
    NODE_ENV: optionalEnv('NODE_ENV', 'development'),
    PORT: parseInt(optionalEnv('PORT', '3000'), 10),
    HOST: optionalEnv('HOST', '0.0.0.0'),

    SUPABASE_URL: requireEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_JWT_SECRET: requireEnv('SUPABASE_JWT_SECRET'),
    REDIS_URL: requireEnv('REDIS_URL'),

    DEEPGRAM_API_KEY: requireEnv('DEEPGRAM_API_KEY'),
    OPENAI_API_KEY: requireEnv('OPENAI_API_KEY'),
  };
}

export type { AppConfig };
