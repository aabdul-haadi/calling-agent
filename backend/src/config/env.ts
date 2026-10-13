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
  /** For reasoning models (e.g. gpt-oss on Groq): "low" spends far fewer tokens per reply. */
  LLM_REASONING_EFFORT: z
    .enum(['low', 'medium', 'high'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Point `LLM_PROVIDER=openai` at any OpenAI-compatible server (Ollama, Groq, OpenRouter...). */
  OPENAI_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),

  /** semantic (also spelled local): a small local model that understands meaning. hash: offline, word matching only. */
  EMBEDDING_PROVIDER: z.enum(['local', 'semantic', 'hash', 'openai']).default('semantic'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  /** Largest PDF accepted by the knowledge console, in megabytes. */
  KNOWLEDGE_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(100),
  /** Read the best few passages with a small cross-encoder before answering (about 50 ms, clearly better ranking). */
  RAG_RERANK: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** auto reads scanned pages with OCR; off never runs OCR. */
  KNOWLEDGE_OCR: z.enum(['auto', 'off']).default('auto'),

  MOCK_SERVICES_URL: z.string().url().default('http://localhost:4100'),
  MOCK_CLIENT_ID: z.string().min(1),
  MOCK_CLIENT_SECRET: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(8),

  // Optional Python voice gateway (see voice-service/). Without a secret, voice falls back to the
  // browser's own speech recognition.
  VOICE_GATEWAY_SECRET: z.string().default(''),
  VOICE_GATEWAY_URL: z.string().default('ws://localhost:8765/ws'),
  VOICE_GATEWAY_HTTP_URL: z.string().url().default('http://localhost:8765'),
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
