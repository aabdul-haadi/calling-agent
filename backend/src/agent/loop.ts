import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Channel,
  Citation,
  HandoffView,
  SimulatorControls,
  TraceEvent,
  TraceStatus,
} from '@adk/shared';
import type { ClientModule } from '../clients/types';
import { evaluatePostTurn, evaluatePreTurn, type HandoffReason } from '../handoff/triggers';
import type { HandoffService } from '../handoff/types';
import { NO_POLICY_REPLY, type Retriever } from '../knowledge/types';
import type { LlmClient, LlmMessage, LlmToolSpec } from '../llm';
import type { Logger } from '../logger';
import { dispatch } from '../tools/dispatcher';
import type { ApiClient } from '../tools/http';
import { maskPII, type IdempotencyStore } from '../tools/security';
import type { AnyToolDefinition, StatePatch } from '../tools/types';
import { classifyTurn } from './classify';
import { buildSystemPrompt } from './prompt';
import { stepIndex, type ConversationState } from './state';

/** Rule 9: hard cap on model<->tool round trips per customer message. */
export const MAX_LOOP_ITERATIONS = 6;

export interface TurnDeps {
  llm: LlmClient;
  logger: Logger;
  makeApi: (sim: SimulatorControls) => ApiClient;
  idempotency: IdempotencyStore;
  retrieve?: Retriever;
  handoff: HandoffService;
}

export interface TurnInput {
  conversationId: string;
  module: ClientModule;
  state: ConversationState;
  history: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  channel: Channel;
  simulator: SimulatorControls;
}

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  output: unknown;
  status: 'ok' | 'error';
  latencyMs: number;
}

export interface TurnOutput {
  reply: string;
  state: ConversationState;
  trace: TraceEvent[];
  citations: Citation[];
  toolCalls: ToolCallRecord[];
  handoff?: HandoffView;
}

const HANDOFF_NOTICE =
  "I'm handing you over to a human colleague now. They'll see a summary, so you won't need to repeat yourself.";
const LOOP_GUARD_REPLY =
  "I'm sorry, I'm having trouble completing this on my own. I'm passing you to a human colleague who can help.";
const AI_DOWN_REPLY =
  "I'm sorry, I'm having technical trouble right now. I'm passing you to a human colleague who can help.";
const ALREADY_HANDED_OFF =
  "You're already in the queue for a human colleague. They have a summary of this chat and will be with you shortly.";

function toolSpecs(tools: AnyToolDefinition[]): LlmToolSpec[] {
  return tools.map((t) => {
    // zod 4 can emit JSON Schema directly; "$schema" is noise for the model providers.
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

function applyPatch(
  state: ConversationState,
  patch: StatePatch,
  module: ClientModule,
): ConversationState {
  const next: ConversationState = {
    ...state,
    collected: { ...state.collected, ...patch.collected },
  };
  if (patch.verified !== undefined) next.verified = patch.verified;
  if (patch.customerId !== undefined) next.customerId = patch.customerId;
  if (patch.pendingHandoff) next.pendingHandoff = patch.pendingHandoff;
  if (patch.step) next.journeyStep = furthest(next, patch.step, module);
  return next;
}

/** The progress bar only moves forward. */
function furthest(state: ConversationState, candidate: string, module: ClientModule): string {
  const cur = stepIndex(module.config, state.journeyId, state.journeyStep);
  const nxt = stepIndex(module.config, state.journeyId, candidate);
  return nxt > cur ? candidate : state.journeyStep;
}

function stepHook(
  state: ConversationState,
  module: ClientModule,
  hook: 'afterUserReply' | 'afterTurn',
): ConversationState {
  const journey = module.config.journeys.find((j) => j.id === state.journeyId);
  const target = journey?.steps.find((s) => s.id === state.journeyStep)?.[hook];
  return target ? { ...state, journeyStep: furthest(state, target, module) } : state;
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
  const { module, conversationId } = input;
  const { config } = module;
  const trace: TraceEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const log = deps.logger.child({ conversationId });
  // Strictly increasing timestamps keep the trace in order even when events share a millisecond.
  let lastAt = 0;
  const addTrace = (
    type: string,
    label: string,
    status: TraceStatus = 'ok',
    latencyMs?: number,
    detail?: unknown,
  ) => {
    lastAt = Math.max(Date.now(), lastAt + 1);
    trace.push({
      id: randomUUID(),
      at: new Date(lastAt).toISOString(),
      type,
      label,
      status,
      latencyMs,
      detail,
    });
  };

  let state = stepHook(input.state, module, 'afterUserReply');
  let citations: Citation[] = [];

  const finish = async (
    reply: string,
    reason: HandoffReason | null,
    detail?: string,
  ): Promise<TurnOutput> => {
    let handoff: HandoffView | undefined;
    let finalReply = reply;
    if (reason) {
      const tried = trace.filter((t) => t.type === 'tool').map((t) => t.label);
      handoff = await deps.handoff.create({
        conversationId,
        clientId: config.id,
        config,
        reason,
        detail,
        state,
        transcript: [
          ...input.history,
          { role: 'user', content: input.userMessage },
          { role: 'assistant', content: reply },
        ],
        tried,
      });
      state = { ...state, handedOff: true, pendingHandoff: undefined };
      addTrace('handoff', `Handed over to a human: ${handoff.reason}`, 'warn');
      if (!finalReply.includes('human')) finalReply = `${finalReply}\n\n${HANDOFF_NOTICE}`.trim();
    }
    state = stepHook(state, module, 'afterTurn');
    return { reply: finalReply, state, trace, citations, toolCalls, handoff };
  };

  if (state.handedOff) {
    addTrace('handoff', 'Customer is already waiting for a human', 'warn');
    return { reply: ALREADY_HANDED_OFF, state, trace, citations, toolCalls };
  }

  // 1. Understand the message (intent + mood), then check the "before we even try" handoff triggers.
  const classification = await classifyTurn(deps.llm, config, input.history, input.userMessage);
  state = { ...state, lastIntent: classification.intent, lastSentiment: classification.sentiment };
  addTrace(
    'intent',
    `Understood intent: ${classification.intent.replace(/_/g, ' ')}`,
    'ok',
    undefined,
    classification,
  );

  const preReason = evaluatePreTurn(config, classification);
  if (preReason) {
    return finish('I understand, and I want to make sure you get the right help.', preReason);
  }

  // 2. Policy lookup (RAG). No policy found for a policy question => safe fallback, no improvising.
  if (deps.retrieve) {
    const found = await deps.retrieve(config.id, input.userMessage);
    citations = found.citations;
    if (found.relevant) {
      addTrace(
        'knowledge',
        `Looked up policy: ${[...new Set(citations.map((c) => c.source))].join(', ')}`,
        'ok',
        undefined,
        citations,
      );
    } else if (classification.isPolicyQuestion) {
      addTrace('knowledge', 'Searched policies, found nothing relevant', 'warn');
      return finish(NO_POLICY_REPLY, null);
    }
  }

  // 3. The agent loop.
  const allowed = module.tools.filter((t) => config.tools.includes(t.name));
  const specs = toolSpecs(allowed);
  // Each client has its own tool set (two clients may both have a `verify_customer`).
  const registry = new Map(module.tools.map((t) => [t.name, t]));
  const deps2 = { registry, allowed: config.tools, rules: config.rules };
  const api = deps.makeApi(input.simulator);
  const messages: LlmMessage[] = [
    ...input.history.map((m): LlmMessage => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.userMessage },
  ];

  let lastToolFailed: 'error' | 'ok' | 'none' = 'none';
  let lastErrorCode = '';
  let reply = '';
  let loopGuardHit = false;
  let aiUnavailable = false;

  for (let i = 0; ; i++) {
    if (i >= MAX_LOOP_ITERATIONS) {
      loopGuardHit = true;
      break;
    }
    const system = buildSystemPrompt({
      config,
      state,
      channel: input.channel,
      knowledge: citations,
    });
    const started = Date.now();
    const res = await deps.llm.complete({ system, messages, tools: specs });
    if (!res.ok) {
      aiUnavailable = true;
      log.error({ reason: res.message }, 'llm call failed');
      addTrace('llm', 'The AI model was unavailable', 'error', Date.now() - started, {
        reason: res.message,
      });
      break;
    }
    if (res.data.toolCalls.length === 0) {
      reply = res.data.text;
      break;
    }
    messages.push({ role: 'assistant', content: res.data.text, toolCalls: res.data.toolCalls });

    for (const call of res.data.toolCalls) {
      const outcome = await dispatch(
        call.name,
        call.input,
        {
          conversationId,
          clientId: config.id,
          state,
          stateAtTurnStart: input.state,
          logger: log,
          api,
          idempotency: deps.idempotency,
        },
        deps2,
      );
      const r = outcome.result;
      const safeInput = maskPII(call.input);
      const safeOutput = maskPII(r.ok ? r.data : { error: r.error, message: r.message });
      toolCalls.push({
        tool: call.name,
        input: safeInput,
        output: safeOutput,
        status: r.ok ? 'ok' : 'error',
        latencyMs: outcome.latencyMs,
      });
      const failedStatus: TraceStatus =
        !r.ok && (r.error === 'AUTH_REQUIRED' || r.error === 'RULE_BLOCKED') ? 'warn' : 'error';
      addTrace(
        'tool',
        r.ok
          ? `${outcome.label}${outcome.summary ? ` — ${outcome.summary}` : ''}`
          : `${outcome.label} — ${r.message}`,
        r.ok ? 'ok' : failedStatus,
        outcome.latencyMs,
        { tool: call.name, input: safeInput, output: safeOutput },
      );
      log.info({ tool: call.name, ok: r.ok, latencyMs: outcome.latencyMs }, 'tool call');

      if (r.ok) {
        state = applyPatch(
          {
            ...state,
            unavailableStreak: 0,
            toolCallCounts: {
              ...state.toolCallCounts,
              [call.name]: (state.toolCallCounts[call.name] ?? 0) + 1,
            },
          },
          outcome.patch,
          module,
        );
        lastToolFailed = 'ok';
        if (outcome.patch.verified) addTrace('state', 'Customer identity verified', 'ok');
      } else {
        lastToolFailed = 'error';
        lastErrorCode = r.error;
        if (r.error === 'UNAVAILABLE')
          state = { ...state, unavailableStreak: state.unavailableStreak + 1 };
      }
      // What the model sees is small and flat: result data, or a typed error it must explain gracefully.
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(
          r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, message: r.message },
        ),
      });
    }
    // Stop calling tools once two systems in a row are down: handing off beats hammering a dead API.
    if (state.unavailableStreak >= 2) break;
  }

  // 4. Failed-turn accounting + post-turn handoff triggers.
  const toolFailureCounts =
    lastToolFailed === 'error' &&
    ['UNAVAILABLE', 'NOT_FOUND', 'UNAUTHORIZED', 'INVALID_ARGS'].includes(lastErrorCode);
  const turnFailed = classification.intent === 'unknown' || toolFailureCounts;
  state = { ...state, failedTurns: turnFailed ? state.failedTurns + 1 : 0 };

  if (aiUnavailable)
    return finish(AI_DOWN_REPLY, evaluatePostTurn(config, state, { loopGuardHit, aiUnavailable }));
  if (loopGuardHit) {
    addTrace('guard', 'Stopped after too many steps', 'warn');
    return finish(LOOP_GUARD_REPLY, 'loop_guard');
  }
  if (!reply && state.unavailableStreak >= 2) {
    reply =
      "I'm sorry, the company's systems aren't responding right now, so I can't finish this myself.";
  }
  if (!reply) reply = "Sorry, I didn't quite get that. Could you tell me a bit more?";
  const post = evaluatePostTurn(config, state, { loopGuardHit, aiUnavailable });
  return finish(reply, post, state.pendingHandoff?.reason);
}
