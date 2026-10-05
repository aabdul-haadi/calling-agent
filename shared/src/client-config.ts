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
  steps: z.array(z.object({ id: idSchema, label: z.string() })).min(2),
});

export const clientConfigSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  initials: z.string().min(1).max(3),
  accent: z.enum(['sky', 'violet']),
  tagline: z.string(),
  channels: z.array(z.enum(['chat', 'voice'])).min(1),
  persona: z.object({ name: z.string(), tone: z.string(), voiceStyle: z.string() }),
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
