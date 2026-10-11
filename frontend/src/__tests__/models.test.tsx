import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EvalRunView, TraceEvent } from '@adk/shared';
import { deriveAgentMode, IDLE_SIGNALS, MODE_META, type AgentSignals } from '@/agent3d/agent-state';
import { splitBold, splitCitations } from '@/components/chat/citation-text';
import { validateConfig, worstLevel } from '@/components/config/config-model';
import { categorize, compareRuns, splitFailures } from '@/components/tests/eval-model';
import { classifyEvent, filterTurns, groupTurns, NO_FILTER } from '@/components/trace/trace-model';
import { highlightJson } from '@/components/ui/json-view';
import { lastTurnTools } from '@/hooks/use-agent-signals';
import { formatDuration, relativeTime } from '@/lib/utils';
import { clientDetail, run } from './fixtures';

const ev = (over: Partial<TraceEvent> & { id: string }): TraceEvent => ({
  at: '2026-11-10T10:00:00.000Z',
  type: 'tool',
  label: 'x',
  status: 'ok',
  ...over,
});

describe('agent mode (derived only from real signals)', () => {
  const mode = (s: Partial<AgentSignals>) => deriveAgentMode({ ...IDLE_SIGNALS, ...s });

  it('rests when nothing is happening', () => expect(mode({})).toBe('idle'));
  it('thinks while a request is in flight', () => expect(mode({ sending: true })).toBe('thinking'));
  it('listens only when the microphone is open', () => {
    expect(mode({ voiceActive: true })).toBe('listening');
    expect(mode({ voiceActive: false })).toBe('idle');
  });
  it('speaks while the browser speaks', () =>
    expect(mode({ voiceSpeaking: true })).toBe('speaking'));
  it('waits for approval when the server says so', () =>
    expect(mode({ awaitingApproval: true })).toBe('awaiting'));
  it('shows the tool that ran', () =>
    expect(mode({ activeTool: 'change_flight' })).toBe('executing'));
  it('shows success only for a completed change', () =>
    expect(mode({ justCompleted: true })).toBe('success'));
  it('a handoff outranks animation, and an error outranks a handoff', () => {
    expect(mode({ handedOff: true, sending: true, voiceSpeaking: true })).toBe('handoff');
    expect(mode({ handedOff: true, error: 'boom' })).toBe('error');
  });
  it('every mode has a label and colour for both renderers', () => {
    for (const m of Object.values(MODE_META)) {
      expect(m.label).not.toBe('');
      expect(m.color).toHaveLength(3);
      expect(m.hsl).toMatch(/^\d+ \d+% \d+%$/);
    }
  });
});

describe('trace model', () => {
  const events = [
    ev({ id: '1', type: 'intent', label: 'Understood intent' }),
    ev({
      id: '2',
      type: 'tool',
      label: 'Checked identity',
      latencyMs: 30,
      detail: { tool: 'verify_customer' },
    }),
    ev({
      id: '3',
      type: 'tool',
      status: 'warn',
      label: 'Blocked',
      detail: { tool: 'get_booking', output: { error: 'AUTH_REQUIRED' } },
    }),
    ev({ id: '4', type: 'intent', label: 'Second turn' }),
    ev({
      id: '5',
      type: 'tool',
      status: 'error',
      label: 'Down',
      detail: { tool: 'change_flight', output: { error: 'UNAVAILABLE' } },
    }),
  ];

  it('groups events into turns that start at each intent', () => {
    const turns = groupTurns(events);
    expect(turns.map((t) => t.events.length)).toEqual([3, 2]);
    expect(turns[0]!.totalMs).toBe(30);
    expect(turns[0]!.status).toBe('warn');
    expect(turns[1]!.status).toBe('error');
  });

  it('calls out authorization, rules and outages in plain words', () => {
    expect(classifyEvent(events[2]!)).toMatchObject({
      kind: 'authorization',
      outcome: 'Authorization denied',
    });
    expect(classifyEvent(events[4]!).outcome).toBe('Company system unavailable');
    expect(
      classifyEvent(
        ev({ id: 'r', status: 'warn', detail: { tool: 't', output: { error: 'RULE_BLOCKED' } } }),
      ).kind,
    ).toBe('policy');
    expect(
      classifyEvent(ev({ id: 'p', detail: { tool: 'change_flight', awaitingApproval: true } }))
        .kind,
    ).toBe('approval');
  });

  it('filters by status, kind and free text (including JSON detail)', () => {
    const turns = groupTurns(events);
    expect(filterTurns(turns, { ...NO_FILTER, status: 'error' })).toHaveLength(1);
    expect(filterTurns(turns, { ...NO_FILTER, kind: 'authorization' })[0]!.events).toHaveLength(1);
    expect(filterTurns(turns, { ...NO_FILTER, query: 'verify_customer' })[0]!.events[0]!.id).toBe(
      '2',
    );
    expect(filterTurns(turns, { ...NO_FILTER, query: 'nothing-like-this' })).toEqual([]);
  });

  it('finds the tools of the newest turn only', () => {
    expect(lastTurnTools(events)).toEqual(['change_flight']);
    expect(lastTurnTools([])).toEqual([]);
  });
});

describe('evaluation model', () => {
  it('infers categories from scenario ids', () => {
    expect(categorize('prompt-injection-reveal-prompt')).toBe('Security');
    expect(categorize('duplicate-rebooking')).toBe('Business rules');
    expect(categorize('api-down')).toBe('Resilience');
    expect(categorize('angry-customer')).toBe('Escalation & scope');
    expect(categorize('policy-baggage')).toBe('Knowledge');
    expect(categorize('rebook-happy-path')).toBe('Functional');
  });

  it('keeps deterministic failures apart from the judge verdict', () => {
    const r = {
      ...run.results[1]!,
      failures: ['Reply contained forbidden phrase', 'Judge: Leaked'],
    };
    expect(splitFailures(r)).toEqual({
      deterministic: ['Reply contained forbidden phrase'],
      judge: 'Leaked',
    });
    expect(splitFailures(run.results[0]!)).toEqual({ deterministic: [], judge: undefined });
  });

  it('compares two runs scenario by scenario', () => {
    const before: EvalRunView = { ...run, id: 'a', passed: 1, results: run.results };
    const after: EvalRunView = {
      ...run,
      id: 'b',
      passed: 1,
      results: [
        { ...run.results[0]!, passed: false },
        { ...run.results[1]!, passed: true },
        { ...run.results[0]!, id: 'c', scenarioId: 'brand-new', passed: true },
      ],
    };
    const d = compareRuns(before, after);
    expect(d.regressed.map((r) => r.scenarioId)).toEqual(['happy']);
    expect(d.fixed.map((r) => r.scenarioId)).toEqual(['injection']);
    expect(d.added.map((r) => r.scenarioId)).toEqual(['brand-new']);
    expect(d.unchanged).toBe(0);
  });
});

describe('small pure helpers', () => {
  it('splits [Source: x] markers out of a reply', () => {
    expect(splitCitations('Bags are free [Source: checked-baggage] today.')).toEqual([
      { text: 'Bags are free ' },
      { source: 'checked-baggage' },
      { text: ' today.' },
    ]);
    expect(splitCitations('Plain.')).toEqual([{ text: 'Plain.' }]);
  });

  it('turns **bold** into bold runs and leaves stray asterisks alone', () => {
    expect(splitBold('Booking **SK1001** moved')).toEqual([
      { text: 'Booking ', bold: false },
      { text: 'SK1001', bold: true },
      { text: ' moved', bold: false },
    ]);
    expect(splitBold('2 ** 3 and ** alone')).toEqual([
      { text: '2 ** 3 and ** alone', bold: false },
    ]);
  });

  it('highlights JSON without altering its text', () => {
    const text = JSON.stringify({ a: 1, b: 'x', c: null, d: true }, null, 2);
    const { container } = render(<pre>{highlightJson(text)}</pre>);
    expect(container.textContent).toBe(text);
  });

  it('formats durations and relative times', () => {
    expect(formatDuration(42)).toBe('42 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    const now = Date.parse('2026-11-10T10:00:00.000Z');
    expect(relativeTime('2026-11-10T09:59:50.000Z', now)).toBe('just now');
    expect(relativeTime('2026-11-10T09:30:00.000Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-11-10T04:00:00.000Z', now)).toBe('6 h ago');
  });

  it('validates a configuration against itself', () => {
    expect(worstLevel(validateConfig(clientDetail))).toBe('warn'); // change_flight-like gaps
    const bad = {
      ...clientDetail,
      rules: [
        {
          id: 'r',
          kind: 'maxCallsPerConversation' as const,
          description: 'x',
          tool: 'ghost',
          limit: 1,
        },
      ],
    };
    expect(validateConfig(bad).some((f) => f.message.includes('ghost'))).toBe(true);
    const dup = {
      ...clientDetail,
      journeys: [
        {
          id: 'j',
          label: 'J',
          steps: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'A2' },
          ],
        },
      ],
    };
    expect(worstLevel(validateConfig(dup))).toBe('error');
  });
});
