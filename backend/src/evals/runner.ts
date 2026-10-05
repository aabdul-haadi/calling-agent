import type { ChatService } from '../agent';
import type { EvalResultView } from '@adk/shared';
import type { LlmClient } from '../llm';
import { runDeterministicChecks, type ObservedTool } from './checks';
import { judge } from './judge';
import type { Scenario } from './scenario';

export interface RunnerDeps {
  chat: ChatService;
  llm: LlmClient;
  clientId: string;
}

export async function runScenario(
  deps: RunnerDeps,
  s: Scenario,
): Promise<Omit<EvalResultView, 'id'>> {
  const transcript: { role: 'user' | 'assistant'; content: string }[] = [];
  const tools: ObservedTool[] = [];
  const replies: string[] = [];
  let handedOff = false;
  const failures: string[] = [];

  try {
    let conversationId: string | undefined;
    for (const message of s.turns) {
      const res = await deps.chat.chat({
        clientId: deps.clientId,
        conversationId,
        message,
        channel: s.channel,
        simulator: s.simulator,
      });
      conversationId = res.conversationId;
      transcript.push(
        { role: 'user', content: message },
        { role: 'assistant', content: res.reply },
      );
      replies.push(res.reply);
      for (const ev of res.trace) {
        const detail = ev.detail as { tool?: string } | undefined;
        if (ev.type === 'tool' && detail?.tool)
          tools.push({ tool: detail.tool, ok: ev.status === 'ok' });
      }
      if (res.handoff) handedOff = true;
    }
  } catch (err) {
    failures.push(`Run crashed: ${err instanceof Error ? err.message : String(err)}`);
  }

  failures.push(...runDeterministicChecks(s, { replies, tools, handedOff }));
  const verdict = await judge(
    deps.llm,
    s,
    transcript,
    tools.map((t) => `${t.tool}${t.ok ? '' : ' (failed)'}`).join(', '),
  );
  if (!verdict.pass) failures.push(`Judge: ${verdict.reason}`);

  return {
    scenarioId: s.id,
    title: s.title,
    passed: failures.length === 0,
    transcript,
    expected: s.expectedOutcome,
    toolsCalled: tools.map((t) => `${t.tool}${t.ok ? '' : ' (failed)'}`),
    failures,
    judgeReason: verdict.reason,
  };
}
