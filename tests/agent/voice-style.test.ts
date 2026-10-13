import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clientConfigSchema, voiceProfileSchema, type TurnEvent } from '@adk/shared';
import { buildSystemPrompt, voiceStyleLines } from '@backend/agent/prompt';
import { newState } from '@backend/agent/state';
import { loadClients } from '@backend/clients';
import { styleMetrics, summarizeStyle } from '@backend/evals/style-metrics';
import { createHarness, say, type Harness } from '../helpers/harness';

const registry = loadClients();
const config = (id: string) => registry.get(id)!.config;
const prompt = (id: string, channel: 'chat' | 'voice', voiceUncertain = false) =>
  buildSystemPrompt({
    config: config(id),
    state: newState(config(id)),
    channel,
    knowledge: [],
    voiceUncertain,
  });

describe('spoken style lives in configuration, safety lives in the engine', () => {
  it('gives each company its own voice profile and keeps it out of chat', () => {
    const sky = prompt('skylink-air', 'voice');
    const nova = prompt('novatel', 'voice');
    expect(sky).toContain(
      'Never say a seat or flight is available until the flight search has returned it',
    );
    expect(sky).toContain('Most replies are one or two short sentences');
    expect(sky.length).toBeLessThan(6000); // every call pays for these words in time and tokens
    expect(nova).toContain(
      'Never say a payment, credit or account change went through unless a tool result confirms it',
    );
    expect(nova).toContain('four at the most');
    expect(nova).not.toContain('flight search');
    expect(sky).not.toContain('payment, credit');

    const chat = prompt('skylink-air', 'chat');
    expect(chat).not.toContain('VOICE CALL');
    expect(chat).not.toContain('Never say a seat or flight is available');
  });

  it('teaches the spoken manner the task asks for', () => {
    const p = prompt('skylink-air', 'voice');
    expect(p).toMatch(/Answer first; do not restate the request/);
    expect(p).toMatch(/No stock openers \("Certainly", "Of course"/);
    expect(p).toMatch(/no stock closers/);
    expect(p).toMatch(/Upset customer: one short sincere line, once/);
    expect(p).toMatch(/You are an AI assistant/);
    expect(p).toMatch(/I heard Rahman\. Is that right\?/);
    expect(p).toMatch(/Never ask the same question twice in a row/);
    expect(p).toMatch(/recommend one, with the reason from tool facts/);
    expect(p).toMatch(/NEVER use lists, markdown, URLs/);
    // the model writes digits; the speech layer says them (so the model cannot garble a flight number)
    expect(p).toMatch(/never spell them out in words/);
    expect(p).toMatch(/never "reply" or "type"/);
    expect(p).toMatch(/Only say you are checking something if you are calling a tool/);
    expect(p).toMatch(/Never promise availability/);
    expect(p).toMatch(/say plainly what will change/);
    expect(p).toMatch(/One thought and one question at a time/);
  });

  it('never loosens a rule: every safety rule and the speech-recognition caution survive in voice', () => {
    for (const id of ['skylink-air', 'novatel']) {
      const p = prompt(id, 'voice');
      const c = prompt(id, 'chat');
      const rules = c.slice(c.indexOf('General rules:'), c.indexOf('Customer verified:'));
      expect(rules.length).toBeGreaterThan(500);
      expect(p).toContain(rules);
      expect(p).toContain('can mishear names, booking references, numbers and flight times');
      expect(p).toContain('Never guess a value you are not sure of');
    }
  });

  it('still tells the agent not to act on a doubtful transcript', () => {
    expect(prompt('skylink-air', 'voice', true)).toContain('was NOT confident');
    expect(prompt('skylink-air', 'voice', false)).not.toContain('was NOT confident');
  });

  it('works for a company with no voice profile, using the defaults', () => {
    const lines = voiceStyleLines('Speak plainly').join('\n');
    expect(lines).toContain('Speak plainly.');
    expect(lines).toContain('three at the most');
  });
});

describe('the voice profile is validated like the rest of the configuration', () => {
  it('fills in defaults', () => {
    expect(voiceProfileSchema.parse({})).toEqual({
      language: 'en-US',
      verbosity: 'brief',
      style: [],
      speech: { speed: 1 },
    });
  });

  it.each([
    { speech: { speed: 3 } },
    { speech: { speed: 0.2 } },
    { speech: { speaker: '../etc/passwd' } },
    { verbosity: 'chatty' },
    { style: Array.from({ length: 9 }, () => 'x') },
    { progressLine: 'x'.repeat(121) },
  ])('rejects %j', (bad) => {
    expect(voiceProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('is part of the persona and optional', () => {
    const base = { ...config('skylink-air') };
    expect(clientConfigSchema.safeParse(base).success).toBe(true);
    const without = { ...base, persona: { ...base.persona, voice: undefined } };
    expect(clientConfigSchema.safeParse(without).success).toBe(true);
  });

  it('gives the two companies different personas without touching their rules', () => {
    const sky = config('skylink-air');
    const nova = config('novatel');
    expect(sky.channels).toContain('voice');
    expect(nova.channels).toContain('voice');
    expect(sky.persona.voice?.verbosity).toBe('brief');
    expect(nova.persona.voice?.verbosity).toBe('balanced');
    expect(sky.persona.voice?.speech.speaker).not.toBe(nova.persona.voice?.speech.speaker);
    // style fields hold no permissions or rules, and name no tool; the only tool names are the keys of
    // the waiting lines, which must belong to tools the company really has
    for (const c of [sky, nova]) {
      const { progress, ...style } = c.persona.voice!;
      for (const tool of c.tools) expect(JSON.stringify(style)).not.toContain(tool);
      for (const tool of Object.keys(progress?.tools ?? {})) expect(c.tools).toContain(tool);
    }
  });
});

describe('speech preferences travel with the turn', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());
  beforeEach(() => h.llm.reset());

  const turnStarted = async (clientId: string, channel: 'chat' | 'voice') => {
    h.llm.script(say('Okay.'));
    const events: TurnEvent[] = [];
    await h.chat.chat({ clientId, message: 'Hello', channel }, { onEvent: (e) => events.push(e) });
    return events[0] as Extract<TurnEvent, { type: 'turn.started' }>;
  };

  it('sends the company speech settings on voice', async () => {
    const sky = await turnStarted('skylink-air', 'voice');
    expect(sky.speech).toMatchObject({ speaker: 'af_heart', speed: 0.97, language: 'en-US' });
    expect(sky.speech?.progressLine).toMatch(/still checking/);
    const nova = await turnStarted('novatel', 'voice');
    expect(nova.speech).toMatchObject({ speaker: 'af_bella', speed: 1 });
  });

  it('sends nothing on chat', async () => {
    expect((await turnStarted('skylink-air', 'chat')).speech).toBeUndefined();
  });

  it('carries style only: no business data or reasoning', async () => {
    const wire = JSON.stringify(await turnStarted('skylink-air', 'voice'));
    expect(wire).not.toMatch(/SK1001|Rahman|system|prompt|reasoning/i);
    // the progress lines are keyed by tool name (the events already name tools), but no arguments or results travel
    expect(wire).not.toMatch(/bookingRef|lastName|flightId/i);
  });
});

describe('style metrics', () => {
  it('flags stock openers, markdown and tool talk, and counts contractions', () => {
    expect(styleMetrics('Certainly! I will look that up.').stockOpener).toBe(true);
    expect(styleMetrics('Sorry about that. Let me check.').stockOpener).toBe(false);
    expect(styleMetrics('- **First** option [Source: refunds]').unspeakable).toBe(true);
    expect(styleMetrics('I am calling the search_alternatives tool now.').narratesTools).toBe(true);
    expect(styleMetrics('It is not ready, I am sorry.').uncontracted).toBe(1);
    expect(styleMetrics("It isn't ready, and I'm sorry.").uncontracted).toBe(0);
    expect(styleMetrics('Which one? And when?').questions).toBe(2);
  });

  it('summarizes a set of replies', () => {
    const s = summarizeStyle(['Certainly. Done.', 'All set.'].map(styleMetrics));
    expect(s).toMatchObject({ replies: 2, stockOpenerRate: 0.5, unspeakableRate: 0 });
  });
});
