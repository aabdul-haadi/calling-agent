import { z } from 'zod';

export const SENTIMENTS = ['positive', 'neutral', 'frustrated', 'angry'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

const idSchema = z.string().regex(/^[a-z0-9_-]+$/, 'use lowercase letters, digits, - or _');

// Rules are DATA describing what the engine enforces in code (never only in the prompt).
export const ruleSchema = z.discriminatedUnion('kind', [
  z.object({
    id: idSchema,
    kind: z.literal('requiresVerification'),
    description: z.string(),
    tools: z.array(z.string()).min(1),
  }),
  z.object({
    id: idSchema,
    kind: z.literal('maxCallsPerConversation'),
    description: z.string(),
    tool: z.string(),
    limit: z.number().int().min(1),
  }),
]);
export type Rule = z.infer<typeof ruleSchema>;

export const journeySchema = z.object({
  id: idSchema,
  label: z.string(),
  // The bar shows the furthest step reached. Tools move it forward on success; these two
  // optional hooks move it generically: after the customer's next message / at end of the turn.
  steps: z
    .array(
      z.object({
        id: idSchema,
        label: z.string(),
        afterUserReply: idSchema.optional(),
        afterTurn: idSchema.optional(),
      }),
    )
    .min(2),
});

/**
 * How the agent sounds when it speaks. Style and speech preferences only: nothing here can change
 * what the agent is allowed to do (rules, tools, verification and approvals live elsewhere).
 */
export const voiceProfileSchema = z.object({
  /** Language the voice speaks and understands (BCP-47). */
  language: z.string().min(2).max(20).default('en-US'),
  /** brief: one or two sentences. balanced: up to four. detailed: as many as the answer needs. */
  verbosity: z.enum(['brief', 'balanced', 'detailed']).default('brief'),
  /** Extra spoken-style guidance for this company, one short instruction per line. */
  style: z.array(z.string().min(1).max(240)).max(8).default([]),
  speech: z
    .object({
      /** Name of a speaker on a multi-speaker voice model; ignored by single-voice models. */
      speaker: z
        .string()
        .regex(/^[a-z0-9_]{1,40}$/)
        .optional(),
      /** 1 is normal speed. */
      speed: z.number().min(0.8).max(1.25).default(1),
    })
    .default({ speed: 1 }),
  /** Said once, only if a lookup is really running and takes a moment, and nothing has been said yet. */
  progressLine: z.string().min(1).max(120).optional(),
  /**
   * What to say while a particular step runs, in the company's own words. Spoken only when that step
   * really started and is still running after a moment: `knowledge` while policies are searched,
   * `tools` keyed by tool name. A step without an entry falls back to `progressLine`.
   */
  progress: z
    .object({
      knowledge: z.string().min(1).max(120).optional(),
      tools: z
        .record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.string().min(1).max(120))
        .default({}),
    })
    .optional(),
});
export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const clientConfigSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  initials: z.string().min(1).max(3),
  accent: z.enum(['sky', 'violet']),
  tagline: z.string(),
  channels: z.array(z.enum(['chat', 'voice'])).min(1),
  persona: z.object({
    name: z.string(),
    tone: z.string(),
    voiceStyle: z.string(),
    voice: voiceProfileSchema.optional(),
  }),
  scope: z.array(z.string()).min(1),
  outOfScope: z.array(z.string()),
  intents: z.array(idSchema).min(1),
  starterPrompts: z.array(z.string()).min(1),
  journeys: z.array(journeySchema).min(1),
  rules: z.array(ruleSchema),
  tools: z.array(z.string()).min(1),
  escalation: z.object({
    onUserRequest: z.boolean(),
    maxFailedTurns: z.number().int().min(1),
    sentimentThreshold: z.enum(['frustrated', 'angry']),
    alwaysEscalateIntents: z.array(idSchema),
  }),
  knowledgeDir: z.string(),
  scenariosDir: z.string().default('./scenarios'),
});

export type ClientConfig = z.input<typeof clientConfigSchema>;
export type ParsedClientConfig = z.output<typeof clientConfigSchema>;

/** Sentiment ordering used by the escalation check: angry >= frustrated >= neutral >= positive. */
export const sentimentAtLeast = (actual: Sentiment, threshold: 'frustrated' | 'angry'): boolean =>
  SENTIMENTS.indexOf(actual) >= SENTIMENTS.indexOf(threshold);
