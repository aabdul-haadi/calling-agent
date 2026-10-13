import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Channel,
  Citation,
  HandoffView,
  SimulatorControls,
  StageTiming,
  TraceEvent,
  TraceStatus,
  TurnEvent,
  TurnTimings,
  VoiceTranscriptMeta,
} from '@adk/shared';
import type { ClientModule } from '../clients/types';
import { evaluatePostTurn, evaluatePreTurn, type HandoffReason } from '../handoff/triggers';
import type { HandoffService } from '../handoff/types';
import { asksForPerson, looksLikeQuestion, needsKnowledge } from '../knowledge/gate';
import { NO_POLICY_REPLY, type Retriever } from '../knowledge/types';
import type { LlmClient, LlmMessage, LlmToolSpec } from '../llm';
import { waitContext } from '../llm/http';
import type { Logger } from '../logger';
import { dispatch } from '../tools/dispatcher';
import type { ApiClient } from '../tools/http';
import { maskPII, type IdempotencyStore } from '../tools/security';
import type { AnyToolDefinition, StatePatch } from '../tools/types';
import { auditEvent, type AuditEvent, type AuditType } from './audit';
import { resolveProposal } from './approval';
import { transition, type PhaseEvent } from './phase';
import { classifyPlainMessage, classifyTurn } from './classify';
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
  /** Answer "yes", "no", greetings and thanks by rules instead of a model call (default on). */
  fastClassify?: boolean;
  /** Start the model's first answer while the message is still being classified (default on). */
  speculate?: boolean;
}

export interface TurnInput {
  conversationId: string;
  module: ClientModule;
  state: ConversationState;
  history: { role: 'user' | 'assistant'; content: string }[];
  userMessage: string;
  channel: Channel;
  simulator: SimulatorControls;
  /** The customer interrupted: stop at the next safe point. A running tool call is never cut off. */
  signal?: AbortSignal;
  /** Receives the turn's events as they happen (tool names and outcomes, text, approvals). */
  onEvent?: (event: TurnEvent) => void;
  /** How the customer's words were recognised, when they were spoken. */
  voice?: VoiceTranscriptMeta;
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
  /** Decisions that mattered this turn (proposals, approvals, executions), for the audit log. */
  audit: AuditEvent[];
  handoff?: HandoffView;
  timings?: TurnTimings;
  /** The customer interrupted. State and trace are kept; there is no reply. */
  cancelled?: boolean;
}

const HANDOFF_NOTICE =
  "I'm handing you over to a human colleague now. They'll see a summary, so you won't need to repeat yourself.";
const LOOP_GUARD_REPLY =
  "I'm sorry, I'm having trouble completing this on my own. I'm passing you to a human colleague who can help.";
const AI_DOWN_REPLY =
  "I'm sorry, I'm having technical trouble right now. I'm passing you to a human colleague who can help.";
export const ALREADY_HANDED_OFF =
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
  if (patch.proposal) next.proposal = patch.proposal;
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

/** "Where the time went: understanding 420 ms, policies 90 ms, model 1.5 s, tools 200 ms (turn 2.2 s)". */
export function describeTimings(t: TurnTimings): string {
  const sum = (stage: StageTiming['stage']) =>
    t.stages.filter((s) => s.stage === stage).reduce((n, s) => n + s.ms, 0);
  const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  const parts = [
    ['understanding', sum('understand')],
    ['policies', sum('retrieve')],
    ['model', sum('llm')],
    ['tools', sum('tool')],
  ] as const;
  return `Where the time went: ${parts
    .filter(([, ms]) => ms > 0)
    .map(([name, ms]) => `${name} ${fmt(ms)}`)
    .join(', ')} (turn ${fmt(t.totalMs)})`;
}

export async function runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutput> {
  const { module, conversationId } = input;
  const turnStart = performance.now();
  const stages: StageTiming[] = [];
  /** Run one step of the turn and record when it started and how long it took. */
  async function timed<T>(
    stage: StageTiming['stage'],
    label: string,
    fn: () => Promise<T>,
    extra?: () => Partial<StageTiming>,
  ): Promise<T> {
    const start = performance.now();
    const waits = { waitedMs: 0, hits: 0 };
    try {
      return await waitContext.run(waits, fn);
    } finally {
      stages.push({
        stage,
        label,
        startMs: Math.round(start - turnStart),
        ms: Math.round(performance.now() - start),
        ...(waits.hits > 0 ? { rateLimitMs: Math.round(waits.waitedMs) } : {}),
        ...extra?.(),
      });
    }
  }
  const { config } = module;
  const snapshot = (): TurnTimings => ({
    totalMs: Math.round(performance.now() - turnStart),
    stages: [...stages],
  });
  const trace: TraceEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const audit: AuditEvent[] = [];
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

  const emit = input.onEvent;
  /** Everything the agent has said (and, in streaming mode, already sent) this turn. */
  let spoken = '';
  const isCancelled = () => input.signal?.aborted === true;

  const record = (type: AuditType, data: Record<string, unknown> = {}) =>
    audit.push(
      auditEvent(type, {
        conversationId,
        clientId: config.id,
        customerId: state.customerId,
        ...data,
      }),
    );
  /** Move the conversation phase along an allowed edge; an illegal move is refused and audited. */
  const move = (event: PhaseEvent, quiet = false) => {
    const next = transition(state.phase, event);
    if (next) {
      state = { ...state, phase: next };
    } else if (!quiet) {
      record('phase_refused', { from: state.phase, event });
      addTrace('state', `Ignored an unexpected step (${event} while ${state.phase})`, 'warn');
    }
  };

  /**
   * Stop because the customer interrupted. What already happened stays: tools that ran, the state
   * and the trace are saved, so the next turn continues from the truth. Nothing is rolled back and
   * nothing is said. If a change was approved but had not started, the approval simply lapses at
   * the start of the next turn and the customer is asked again.
   */
  const cancelTurn = (): TurnOutput => {
    addTrace('guard', 'Stopped because the customer started speaking', 'warn');
    record('turn_cancelled', {
      toolsRun: toolCalls.map((t) => t.tool),
      proposalStatus: state.proposal?.status,
    });
    return {
      reply: '',
      state,
      trace,
      citations,
      toolCalls,
      audit,
      cancelled: true,
      timings: snapshot(),
    };
  };

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
      move('handoff', true);
      state = { ...state, handedOff: true, pendingHandoff: undefined };
      addTrace('handoff', `Handed over to a human: ${handoff.reason}`, 'warn');
      emit?.({ type: 'handoff.started', reason: handoff.reason });
      if (!finalReply.includes('human')) finalReply = `${finalReply}\n\n${HANDOFF_NOTICE}`.trim();
    }
    if (emit) {
      // The customer has already heard `spoken`: send only what is new, and keep the saved reply
      // identical to what was said.
      const said = spoken.trim();
      const prefixed = said !== '' && finalReply.startsWith(said);
      const tail = prefixed ? finalReply.slice(said.length) : finalReply;
      if (tail.trim()) {
        emit({ type: 'agent.text.delta', text: said ? ` ${tail.trim()}` : tail.trim() });
      }
      if (said && !prefixed) finalReply = `${said} ${finalReply}`.trim();
    }
    state = stepHook(state, module, 'afterTurn');
    const timings = snapshot();
    addTrace('timing', describeTimings(timings), 'ok', undefined, timings);
    emit?.({ type: 'turn.timing', timings });
    return { reply: finalReply, state, trace, citations, toolCalls, audit, handoff, timings };
  };

  if (state.handedOff) {
    addTrace('handoff', 'Customer is already waiting for a human', 'warn');
    return { reply: ALREADY_HANDED_OFF, state, trace, citations, toolCalls, audit };
  }

  // A finished conversation can start a new request; a brand-new one is now being worked on.
  if (state.phase === 'NEW') move('message', true);
  else move('reopened', true);

  // 1. Understand the message (intent + mood + does it approve the pending change?), then check the
  // "before we even try" handoff triggers.
  emit?.({ type: 'agent.thinking' });
  const pendingChange = state.proposal?.status === 'pending' ? state.proposal.summary : undefined;
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

  /**
   * One model call, started now. While `speculative`, what it writes is held back until `release()`;
   * `abort()` throws the call away. `done` settles with the model's answer either way.
   */
  interface ModelRound {
    done: ReturnType<typeof timedModel>;
    release(): void;
    abort(): void;
    streamedChars(): number;
  }
  const timedModel = (
    i: number,
    run: () => ReturnType<LlmClient['complete']>,
    first: () => number | undefined,
  ) =>
    timed('llm', `model call ${i + 1}`, run, () => {
      const firstTokenMs = first();
      return firstTokenMs === undefined ? {} : { firstTokenMs };
    });
  function startModelCall(i: number, speculative: boolean): ModelRound {
    const system = buildSystemPrompt({
      config,
      state,
      channel: input.channel,
      knowledge: citations,
      voiceUncertain: uncertain,
    });
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const callStart = performance.now();
    let open = !speculative;
    let streamed = 0;
    let firstTokenMs: number | undefined;
    const held: string[] = [];
    const say = (text: string) => {
      streamed += text.length;
      spoken += text;
      emit?.({ type: 'agent.text.delta', text });
    };
    const done = timedModel(
      i,
      () =>
        deps.llm.complete(
          { system, messages, tools: specs },
          {
            signal,
            onTextDelta: emit
              ? (text) => {
                  firstTokenMs ??= Math.round(performance.now() - callStart);
                  if (open) say(text);
                  else held.push(text);
                }
              : undefined,
          },
        ),
      () => firstTokenMs,
    );
    return {
      done,
      release() {
        open = true;
        for (const text of held.splice(0)) say(text);
      },
      abort: () => controller.abort(),
      streamedChars: () => streamed,
    };
  }

  const uncertain = input.voice?.lowConfidence === true;
  let lastToolFailed: 'error' | 'ok' | 'none' = 'none';

  // Understanding the message and searching the policies do not depend on each other, so they run
  // together. The search starts at once; the classification is not awaited until it is needed.
  const plain =
    deps.fastClassify === false
      ? undefined
      : classifyPlainMessage(input.userMessage, pendingChange, state.lastIntent ?? 'unknown');
  const classifyP = plain
    ? timed('understand', 'plain message (rules)', async () => plain)
    : timed('understand', 'classify the message', () =>
        classifyTurn(
          deps.llm,
          config,
          input.history,
          input.userMessage,
          pendingChange,
          input.signal,
        ),
      );
  const wantsKnowledge = Boolean(deps.retrieve) && needsKnowledge(input.userMessage);
  if (wantsKnowledge) emit?.({ type: 'knowledge.searching' });
  const recentQuestions = input.history
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .slice(-3);
  const retrievalP = wantsKnowledge
    ? timed('retrieve', 'search the policies', () =>
        deps.retrieve!(config.id, input.userMessage, { recentQuestions }),
      )
    : undefined;

  // The model's first answer is the slowest step, and it needs only the question and the policy
  // excerpts. So it is started now, while the message is still being classified, and nothing it says
  // or asks for is used until the classification has been checked: a handoff, an approval, or a
  // refusal first discards it. (When a change is waiting for approval the classification decides
  // what the model is told, so that case is not started early.)
  let early: ModelRound | undefined;
  let foundEarly: Awaited<NonNullable<typeof retrievalP>> | undefined;
  if (!pendingChange && deps.speculate !== false && !asksForPerson(input.userMessage)) {
    foundEarly = retrievalP ? await retrievalP : undefined;
    citations = foundEarly?.citations ?? [];
    // A question the documents do not answer ends with the fixed "not sure" reply, never a model
    // call, so there is nothing to start early.
    const willRefuse =
      foundEarly !== undefined && !foundEarly.relevant && looksLikeQuestion(input.userMessage);
    if (!willRefuse) early = startModelCall(0, true);
  }
  const abandon = () => {
    early?.abort();
    void early?.done.catch(() => undefined);
  };

  const heard = await classifyP;
  // A transcript the speech recognizer was unsure about can never approve a change: a misheard
  // "yes" must not authorise anything. The agent is told to ask again (see the prompt).
  const classification =
    uncertain && heard.confirmation !== 'none'
      ? { ...heard, confirmation: 'none' as const }
      : heard;
  state = { ...state, lastIntent: classification.intent, lastSentiment: classification.sentiment };
  if (uncertain) {
    addTrace(
      'state',
      'Speech recognition was unsure about this message, so it cannot approve a change',
      'warn',
    );
  }
  if (isCancelled()) {
    abandon();
    return cancelTurn();
  }
  addTrace(
    'intent',
    `Understood intent: ${classification.intent.replace(/_/g, ' ')}`,
    'ok',
    undefined,
    classification,
  );

  // Settle the pending proposal from the CUSTOMER's message only. This runs before the model is called
  // for the turn, so nothing the model says (or a document it read) can approve anything.
  const settled = resolveProposal(state.proposal, classification.confirmation);
  if (settled.event && state.proposal) {
    const proposal = settled.proposal!;
    state = { ...state, proposal };
    const audited = { proposalId: proposal.id, tool: proposal.tool, binding: proposal.binding };
    if (settled.event === 'approved') {
      record('approval_granted', audited);
      move('approval_granted');
      addTrace('approval', `Customer approved: ${proposal.summary}`, 'ok');
    } else if (settled.event === 'rejected') {
      record('approval_rejected', audited);
      move('approval_rejected');
      addTrace('approval', 'Customer declined the proposed change', 'warn');
    } else {
      record('approval_expired', audited);
      move('approval_expired', true);
      addTrace('approval', 'The earlier proposal expired and needs a new approval', 'warn');
    }
  }

  // Words the recognizer was unsure of say little about the customer's mood, so a doubtful
  // transcript never starts a handoff for frustration. (A plain request for a person still does.)
  const preReason = evaluatePreTurn(
    config,
    uncertain ? { ...classification, sentiment: 'neutral' } : classification,
  );
  if (preReason) {
    abandon();
    return finish('I understand, and I want to make sure you get the right help.', preReason);
  }

  // 2. Policy lookup (RAG). No policy found for a policy question => safe fallback, no improvising.
  // A greeting, a thanks or a bare yes/no has nothing to look up, so it skips the search.
  if (retrievalP) {
    const found = foundEarly ?? (await retrievalP);
    citations = found.citations;
    if (isCancelled()) {
      abandon();
      return cancelTurn();
    }
    if (found.relevant) {
      const sources = [...new Set(citations.map((c) => c.source))];
      addTrace(
        'knowledge',
        `Looked up policy: ${sources.join(', ')}`,
        'ok',
        found.timings?.totalMs,
        { citations, searched: found.searched, reason: found.reason, timings: found.timings },
      );
      emit?.({
        type: 'knowledge.used',
        sources,
        passages: citations.slice(0, 5).map((c) => ({
          source: c.source,
          heading: c.heading,
          ...(c.page ? { page: c.page } : {}),
          ...(c.pageEnd ? { pageEnd: c.pageEnd } : {}),
          ...(c.version ? { version: c.version } : {}),
          excerpt: c.snippet.replace(/\s+/g, ' ').slice(0, 220),
        })),
      });
    } else if (classification.isPolicyQuestion) {
      addTrace(
        'knowledge',
        'Searched policies, found nothing relevant',
        'warn',
        found.timings?.totalMs,
        {
          searched: found.searched,
          reason: found.reason,
          timings: found.timings,
        },
      );
      abandon();
      return finish(NO_POLICY_REPLY, null);
    }
  }

  // 3. The agent loop.
  let lastErrorCode = '';
  let reply = '';
  let loopGuardHit = false;
  let aiUnavailable = false;

  for (let i = 0; ; i++) {
    if (i >= MAX_LOOP_ITERATIONS) {
      loopGuardHit = true;
      break;
    }
    if (isCancelled()) return cancelTurn();
    const started = Date.now();
    // Text is forwarded as the model writes it. Anything said before a tool call is kept: the
    // customer heard it, so it stays part of the reply.
    if (emit && spoken.trim()) {
      spoken += ' ';
      emit({ type: 'agent.text.delta', text: ' ' });
    }
    const round = i === 0 && early ? early : startModelCall(i, false);
    round.release(); // the classification has been checked: what the model wrote may now be said
    const res = await round.done;
    const streamed = round.streamedChars();
    if (isCancelled()) return cancelTurn();
    if (!res.ok) {
      aiUnavailable = true;
      log.error({ reason: res.message }, 'llm call failed');
      addTrace('llm', 'The AI model was unavailable', 'error', Date.now() - started, {
        reason: res.message,
      });
      break;
    }
    // A model client that cannot stream still returns its text: say it once, now.
    if (emit && streamed === 0 && res.data.text) {
      spoken += res.data.text;
      emit({ type: 'agent.text.delta', text: res.data.text });
    }
    if (res.data.toolCalls.length === 0) {
      reply = emit ? spoken.trim() : res.data.text;
      break;
    }
    messages.push({ role: 'assistant', content: res.data.text, toolCalls: res.data.toolCalls });

    for (const call of res.data.toolCalls) {
      // Between two tool calls is a safe place to stop. Once a call starts it always finishes.
      if (isCancelled()) return cancelTurn();
      const known = config.tools.includes(call.name);
      if (known) emit?.({ type: 'tool.started', tool: call.name });
      const outcome = await timed('tool', call.name, () =>
        dispatch(
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
            audit: record,
          },
          deps2,
        ),
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
        {
          tool: call.name,
          input: safeInput,
          output: safeOutput,
          awaitingApproval: outcome.approvalStage === 'proposed',
        },
      );
      log.info({ tool: call.name, ok: r.ok, latencyMs: outcome.latencyMs }, 'tool call');
      if (known) {
        const blocked =
          !r.ok &&
          (r.error === 'AUTH_REQUIRED' || r.error === 'RULE_BLOCKED' || r.error === 'UNAUTHORIZED');
        emit?.({
          type: 'tool.completed',
          tool: call.name,
          status: r.ok ? 'ok' : blocked ? 'blocked' : 'error',
        });
      }

      const wasVerified = state.verified;
      if (r.ok) {
        // A proposal is not a change, so it must not use up the "one change per conversation" rule.
        const counted = outcome.approvalStage !== 'proposed';
        state = applyPatch(
          {
            ...state,
            unavailableStreak: 0,
            toolCallCounts: counted
              ? {
                  ...state.toolCallCounts,
                  [call.name]: (state.toolCallCounts[call.name] ?? 0) + 1,
                }
              : state.toolCallCounts,
          },
          outcome.patch,
          module,
        );
        lastToolFailed = 'ok';
        if (outcome.patch.verified) addTrace('state', 'Customer identity verified', 'ok');
        if (!wasVerified && state.verified) move('identity_verified', true);
        if (outcome.approvalStage === 'proposed' && outcome.proposal) {
          record('proposal_created', {
            proposalId: outcome.proposal.id,
            tool: call.name,
            summary: outcome.proposal.summary,
            binding: outcome.proposal.binding,
            expiresAt: outcome.proposal.expiresAt,
          });
          move('proposal_created');
          emit?.({
            type: 'approval.required',
            summary: outcome.proposal.summary,
            expiresAt: outcome.proposal.expiresAt,
          });
        } else if (outcome.approvalStage === 'executing' && outcome.proposal) {
          record('mutation_executed', {
            proposalId: outcome.proposal.id,
            tool: call.name,
            summary: outcome.proposal.summary,
            binding: outcome.proposal.binding,
          });
          move('executed');
        } else {
          move('tool_ok', true);
        }
      } else {
        if (outcome.approvalStage === 'executing' && outcome.proposal) {
          record('mutation_failed', {
            proposalId: outcome.proposal.id,
            tool: call.name,
            error: r.error,
            message: r.message,
          });
          move('execution_failed');
        }
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
