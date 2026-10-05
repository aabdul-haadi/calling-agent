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
    expect(registry.summaries().find((c) => c.id === 'novatel')?.channels).toEqual(['chat']);
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
    expect(h.llm.calls).toHaveLength(0);
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

  it('rejects voice (NovaTel is chat-only)', async () => {
    await expect(
      h.chat.chat({ clientId: 'novatel', message: 'hi', channel: 'voice' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_SUPPORTED' });
  });

  it('has 5 policy documents and 8 valid scenarios', async () => {
    const { readdirSync } = await import('node:fs');
    expect(
      readdirSync(resolve(REPO_ROOT, 'clients/novatel/knowledge')).filter((f) => f.endsWith('.md')),
    ).toHaveLength(5);
    const scenarios = await loadScenarios(resolve(REPO_ROOT, 'clients/novatel/scenarios'));
    expect(scenarios).toHaveLength(8);
    const tools = new Set(novatelModule.config.tools);
    for (const s of scenarios)
      for (const t of [...s.expectedTools, ...s.forbiddenTools])
        expect(tools.has(t), `${s.id}: ${t}`).toBe(true);
  });
});
