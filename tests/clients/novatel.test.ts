import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { REPO_ROOT } from '@backend/config/repo-root';
import { loadClients } from '@backend/clients';
import { NO_POLICY_REPLY } from '@backend/knowledge/types';
import { loadScenarios } from '@backend/evals';
import { novatelModule } from '@clients/novatel';
import { createHarness, say, callTool, type Harness } from '../helpers/harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    ingestKnowledge: true,
    classify: (m) => {
      if (/cancel my plan/i.test(m)) return { intent: 'cancellation_request' };
      if (/what(?:'s| is) your age/i.test(m)) return { intent: 'out_of_scope' };
      if (/zorb/i.test(m)) return { intent: 'unknown' };
      if (/I want Briani/i.test(m)) return { intent: 'cancellation_request' };
      if (/I want Biryani/i.test(m)) return { wantsHuman: true };
      if (/late|fee|policy|what happens/i.test(m))
        return { intent: 'billing_policy', isPolicyQuestion: true };
      if (/peacock|rocket/i.test(m)) return { intent: 'billing_policy', isPolicyQuestion: true };
      if (/outage/i.test(m)) return { intent: 'outage_check' };
      return { intent: 'bill_question' };
    },
  });
});
afterAll(() => h.close());
beforeEach(() => h.llm.reset());

const trace = async (id: string) => (await h.chat.view(id)).trace.filter((t) => t.type === 'tool');

describe('NovaTel: second client on the same engine', () => {
  it('registers alongside SkyLink with a valid config and its own tool set', () => {
    const registry = loadClients();
    expect(registry.list().map((m) => m.config.id)).toEqual(['skylink-air', 'novatel']);
    expect(novatelModule.config.tools).toEqual([
      'verify_customer',
      'get_bill',
      'check_outage',
      'transfer_to_human',
    ]);
    expect(novatelModule.config.accent).toBe('violet');
    expect(registry.summaries().find((c) => c.id === 'novatel')?.channels).toEqual([
      'chat',
      'voice',
    ]);
  });

  it('explains a higher bill after verification', async () => {
    h.llm.script(
      callTool('verify_customer', { accountId: 'NT2002', lastName: 'Alvarez' }),
      callTool('get_bill', { accountId: 'NT2002' }),
      say('Your bill is $18 higher because of 3 days of roaming.'),
    );
    const res = await h.chat.chat({
      clientId: 'novatel',
      message: 'NT2002 Alvarez, why is my bill higher?',
    });
    expect(res.state.verified).toBe(true);
    const bill = res.state.collected.bill as { change: number; lineItems: { label: string }[] };
    expect(bill.change).toBe(18);
    expect(bill.lineItems.map((l) => l.label)).toContain('International roaming (3 days)');
    expect(res.state.journeyStep).toBe('close'); // explain -> close at end of turn
    expect(res.handoff).toBeUndefined();
  });

  it('checks outages without verification (public information)', async () => {
    h.llm.script(
      callTool('check_outage', { area: 'Northgate' }),
      say('Northgate has an outage; a fibre cut is being repaired.'),
    );
    const res = await h.chat.chat({
      clientId: 'novatel',
      message: 'Is there an outage in Northgate?',
    });
    expect(res.state.verified).toBe(false);
    expect((res.state.collected.outage as { status: string }).status).toBe('OUTAGE');
  });

  it('blocks get_bill before verification and for other accounts', async () => {
    h.llm.script(callTool('get_bill', { accountId: 'NT2003' }), say('I need to verify you first.'));
    const a = await h.chat.chat({ clientId: 'novatel', message: 'bill for NT2003 please' });
    expect((await trace(a.conversationId))[0]?.label).toContain('must be verified');

    h.llm.script(
      callTool('verify_customer', { accountId: 'NT2001', lastName: 'Tanaka' }),
      callTool('get_bill', { accountId: 'NT2002' }),
      say('I can only show your own account.'),
    );
    const b = await h.chat.chat({ clientId: 'novatel', message: 'Tanaka NT2001, and show NT2002' });
    expect(b.state.collected.bill).toBeUndefined();
    expect((await trace(b.conversationId))[1]?.label).toContain('does not belong');
  });

  it("does not let one client call the other client's tools", async () => {
    h.llm.script(
      callTool('search_alternatives', { bookingRef: 'SK1001' }),
      say('Sorry, I cannot do that.'),
    );
    const res = await h.chat.chat({ clientId: 'novatel', message: 'find me flights' });
    expect((await trace(res.conversationId))[0]?.label).toContain('Unknown tool');
  });

  it('cancellation requests always go to a human (config-driven escalation)', async () => {
    const res = await h.chat.chat({ clientId: 'novatel', message: 'I want to cancel my plan' });
    expect(res.handoff?.reason).toMatch(/always goes to a human/i);
    // the model may have started an answer in parallel, but nothing it wrote or asked for was used
    expect(res.reply).toMatch(/human colleague/);
    expect(res.trace.some((t) => t.type === 'tool')).toBe(false);
  });

  it('does not transfer for an unrelated phrase misclassified as a cancellation request', async () => {
    h.llm.script(
      callTool('transfer_to_human', { reason: 'outside scope' }),
      callTool('transfer_to_human', { reason: 'outside scope' }),
    );
    const res = await h.chat.chat({ clientId: 'novatel', message: 'I want Briani' });
    expect(res.handoff).toBeUndefined();
    expect(res.state.handedOff).toBe(false);
    expect(res.trace.find((event) => event.label.startsWith('Understood intent'))?.label).toContain(
      'unknown',
    );
    expect(res.reply).toContain('bill explanations');
    expect(res.trace.some((event) => event.label.includes('Blocked an automatic human transfer'))).toBe(
      true,
    );
    expect(res.trace.some((event) => event.type === 'tool')).toBe(false);
    expect(h.llm.calls.at(-1)?.system).toContain('Nia');
    expect(h.llm.calls.at(-1)?.system).toContain('request is unclear or unrelated');
  });

  it('does not escalate after an out-of-scope question followed by an ambiguous request', async () => {
    h.llm.script(
      say("I'm an AI assistant, so I don't have an age. I can help with NovaTel services."),
      callTool('transfer_to_human', { reason: 'outside scope' }),
      callTool('transfer_to_human', { reason: 'outside scope' }),
    );
    const first = await h.chat.chat({ clientId: 'novatel', message: "What's your age?" });
    expect(first.handoff).toBeUndefined();

    const next = await h.chat.chat({
      clientId: 'novatel',
      conversationId: first.conversationId,
      message: 'I want Briani',
    });
    expect(next.handoff).toBeUndefined();
    expect(next.state.handedOff).toBe(false);
    expect(next.reply).toContain('bill explanations');
    expect(next.trace.some((event) => event.label.includes('Blocked an automatic human transfer'))).toBe(
      true,
    );
  });

  it('does not treat two unsupported messages as two failed attempts', async () => {
    h.llm.script(
      say('I am not sure what you mean by a zorb. I can help with NovaTel services.'),
      say('I am not sure what you mean by a zorb. I can help with NovaTel services.'),
      say('Could you clarify what you mean by Briani?'),
      say('Could you clarify what you mean by Briani?'),
    );
    const first = await h.chat.chat({ clientId: 'novatel', message: 'What is a zorb?' });
    const second = await h.chat.chat({
      clientId: 'novatel',
      conversationId: first.conversationId,
      message: 'I want Briani',
    });

    expect(first.handoff).toBeUndefined();
    expect(second.handoff).toBeUndefined();
    expect(second.state.handedOff).toBe(false);
  });

  it('does not treat an unrelated phrase as a human request when classification is wrong', async () => {
    h.llm.script(say('I can help with your bill or check for a service outage.'));
    const res = await h.chat.chat({ clientId: 'novatel', message: 'I want Biryani' });
    expect(res.handoff).toBeUndefined();
    expect(res.state.handedOff).toBe(false);
    expect(res.trace.some((event) => event.type === 'handoff')).toBe(false);
  });

  it('answers policy questions from NovaTel documents only', async () => {
    h.llm.script(say('A 5 dollar late fee applies after 7 days [Source: late-payment-and-fees].'));
    const res = await h.chat.chat({
      clientId: 'novatel',
      message: 'What happens if I pay my bill late?',
    });
    expect(res.citations[0]?.source).toBe('late-payment-and-fees');
    expect(h.llm.calls[0]!.system).not.toContain('checked-baggage');

    h.llm.reset();
    const unknown = await h.chat.chat({
      clientId: 'novatel',
      message: 'Do you allow emotional support peacocks?',
    });
    expect(unknown.reply).toBe(NO_POLICY_REPLY);
  });

  it('accepts voice, with its own friendly, plain-spoken persona', async () => {
    expect(novatelModule.config.channels).toContain('voice');
    expect(novatelModule.config.persona.voice?.verbosity).toBe('balanced');
  });

  it('has 5 policy documents and 9 valid scenarios', async () => {
    const { readdirSync } = await import('node:fs');
    expect(
      readdirSync(resolve(REPO_ROOT, 'clients/novatel/knowledge')).filter((f) => f.endsWith('.md')),
    ).toHaveLength(5);
    const scenarios = await loadScenarios(resolve(REPO_ROOT, 'clients/novatel/scenarios'));
    expect(scenarios).toHaveLength(9);
    const tools = new Set(novatelModule.config.tools);
    for (const s of scenarios)
      for (const t of [...s.expectedTools, ...s.forbiddenTools])
        expect(tools.has(t), `${s.id}: ${t}`).toBe(true);
  });
});
