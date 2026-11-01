import { z } from 'zod';

export const envSchema = z.object({
  BACKEND_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  AUTH_MODE: z.enum(['development', 'oidc']).default('development'),
  // An empty value (a blank line in an env file, or an unset variable passed on by Docker) means "not set".
  OIDC_ISSUER: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  OIDC_AUDIENCE: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  OIDC_ROLE_CLAIM: z.string().min(1).default('roles'),
  OIDC_TENANT_CLAIM: z.string().min(1).default('tenant_ids'),
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

  /** If the main model is rate limited for longer than LLM_FALLBACK_AFTER_MS, answer with this one instead of waiting. */
  LLM_FALLBACK_MODEL: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  LLM_FALLBACK_AFTER_MS: z.coerce.number().int().min(0).default(1500),
  /** Longest model reply, reasoning included. Providers count this against the per-minute token limit. */
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(4096).default(700),
  /** Optional smaller, faster model just for classifying each message (intent, mood, yes/no). Same provider and key. */
  LLM_CLASSIFIER_MODEL: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
  /** Handle a bare yes / no / greeting / thanks by rules instead of a model call. */
  AGENT_FAST_CLASSIFY: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** Start the model's first answer while the message is still being classified (faster; nothing is used before the check). */
  AGENT_SPECULATIVE: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** Largest PDF accepted by the knowledge console, in megabytes. */
  KNOWLEDGE_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(100),
  /** Read the best few passages with a small cross-encoder before answering (about 50 ms, clearly better ranking). */
  RAG_RERANK: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** Learning from real conversations (redacted capture, review queue, evaluated releases). */
  LEARNING_ENABLED: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  /** Tenants with verified notice, contractual, and data-handling authorization for learning capture. */
  LEARNING_AUTHORIZED_CLIENTS: z
    .string()
    .default('')
    .transform((v) => [...new Set(v.split(',').map((id) => id.trim()).filter(Boolean))]),
  /** Unreviewed learning rows are deleted after this many days. Approved examples stay until removed. */
  LEARNING_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** A fine-tuning dataset is only called ready with at least this many approved, checked examples. */
  LEARNING_MIN_SFT_EXAMPLES: z.coerce.number().int().min(1).default(200),
  /** Approved intent examples needed before the local intent model is retrained from live data. */
  LEARNING_MIN_INTENT_EXAMPLES: z.coerce.number().int().min(1).default(30),
  /** Run the learning cycle on this schedule (minutes). 0 means only when started by hand. */
  LEARNING_SCHEDULE_MINUTES: z.coerce.number().int().min(0).default(0),
  /** Where `ml/serve_local.py` serves a fine-tuned candidate (this machine only). */
  LOCAL_MODEL_URL: z.string().url().default('http://127.0.0.1:8790'),
  /** Let a released local model phrase tool-free policy answers. Off by default; the hosted model answers otherwise. */
  LOCAL_MODEL_ROUTE: z.enum(['on', 'off']).default('off').transform((v) => v === 'on'),
  /** Held-out reviewed examples needed before a model comparison can decide anything. */
  LEARNING_MIN_EVAL_EXAMPLES: z.coerce.number().int().min(1).default(30),
  /** A candidate's slowest typical answer (95th percentile, ms) must stay under this unless a person accepts it. */
  LEARNING_MODEL_P95_MS: z.coerce.number().int().min(100).default(8000),
  /** Shadow answers needed before a candidate may be promoted. */
  LEARNING_MIN_SHADOW: z.coerce.number().int().min(1).default(20),
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
  if (source.NODE_ENV === 'production' && parsed.data.AUTH_MODE !== 'oidc')
    throw new Error('AUTH_MODE=oidc is required in production.');
  if (parsed.data.AUTH_MODE === 'oidc' && (!parsed.data.OIDC_ISSUER || !parsed.data.OIDC_AUDIENCE))
    throw new Error('OIDC_ISSUER and OIDC_AUDIENCE are required when AUTH_MODE=oidc.');
  if (
    source.NODE_ENV === 'production' &&
    parsed.data.OIDC_ISSUER &&
    new URL(parsed.data.OIDC_ISSUER).protocol !== 'https:'
  )
    throw new Error('OIDC_ISSUER must use HTTPS in production.');
  return parsed.data;
}

/** Placeholder values from .env.example ("replace-me") count as "not configured". */
export const isConfigured = (value: string | undefined): value is string =>
  Boolean(value) && !value!.startsWith('replace-me');
