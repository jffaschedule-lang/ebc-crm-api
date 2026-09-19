import 'dotenv/config';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  FRONTEND_URL: z.string().url().default('https://ebc-crm-web.vercel.app'),
  RESEND_API_KEY: z.string().optional().default(''),
  FROM_EMAIL: z.string().default('crm@ebc-fire.org'),
  CRON_SECRET: z.string().optional().default(''),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration — see .env.example');
  }
  return parsed.data;
}

export const config = loadConfig();

/** Server-only client — bypasses RLS. Never expose to the frontend. */
export const supabaseAdmin = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Used only to verify incoming user JWTs via auth.getUser(token). */
export const supabaseAnon = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
