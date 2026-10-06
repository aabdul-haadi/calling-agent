import { z } from 'zod';

export const envSchema = z.object({
  BACKEND_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().default('postgres://adk:adk@localhost:5432/adk'),
  /** Set to "true" for hosted Postgres such as Supabase. */
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  LLM_MODEL: z.string().default('claude-sonnet-5-5'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  MOCK_SERVICES_URL: z.string().url().default('http://localhost:4100'),
  MOCK_CLIENT_ID: z.string().min(1),
  MOCK_CLIENT_SECRET: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(8),
});

export type Env = z.infer<typeof envSchema>;

/** Throws a readable error at startup if the environment is wrong (fail fast, never half-run). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}\nCopy .env.example to .env.`);
  }
  return parsed.data;
}

/** Placeholder values from .env.example ("replace-me") count as "not configured". */
export const isConfigured = (value: string | undefined): value is string =>
  Boolean(value) && !value!.startsWith('replace-me');
