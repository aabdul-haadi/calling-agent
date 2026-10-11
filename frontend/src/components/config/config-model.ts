import type { ClientDetail } from '@adk/shared';

export interface Finding {
  level: 'ok' | 'warn' | 'error';
  message: string;
}

/**
 * Cross-checks the configuration the backend served. The backend already validated its shape with
 * zod at startup; these are the relationships a person editing the files would want to see.
 */
export function validateConfig(c: ClientDetail): Finding[] {
  const out: Finding[] = [];
  const tools = new Set(c.tools);

  for (const r of c.rules) {
    if (r.kind === 'requiresVerification') {
      const missing = r.tools.filter((t) => !tools.has(t));
      out.push(
        missing.length
          ? {
              level: 'warn',
              message: `Rule "${r.id}" protects tools that are not in the allow-list: ${missing.join(', ')}.`,
            }
          : {
              level: 'ok',
              message: `Rule "${r.id}" protects ${r.tools.length} allow-listed tool(s).`,
            },
      );
    } else if (r.kind === 'maxCallsPerConversation') {
      out.push(
        tools.has(r.tool)
          ? {
              level: 'ok',
              message: `Rule "${r.id}" limits ${r.tool} to ${r.limit} call(s) per conversation.`,
            }
          : {
              level: 'warn',
              message: `Rule "${r.id}" limits ${r.tool}, which is not in the allow-list.`,
            },
      );
    }
  }

  const unprotected = c.tools.filter(
    (t) =>
      t !== 'transfer_to_human' &&
      t !== 'verify_customer' &&
      !c.rules.some((r) => r.kind === 'requiresVerification' && r.tools.includes(t)),
  );
  if (unprotected.length)
    out.push({
      level: 'warn',
      message: `No verification rule covers: ${unprotected.join(', ')}.`,
    });

  for (const j of c.journeys) {
    const ids = j.steps.map((s) => s.id);
    out.push(
      new Set(ids).size === ids.length
        ? { level: 'ok', message: `Journey "${j.label}" has ${ids.length} unique steps.` }
        : { level: 'error', message: `Journey "${j.label}" has duplicate step ids.` },
    );
  }

  const escalate = c.escalation.alwaysEscalateIntents.filter((i) => !c.intents.includes(i));
  if (escalate.length)
    out.push({
      level: 'warn',
      message: `Always-escalate intents that are not declared intents: ${escalate.join(', ')}.`,
    });
  if (c.starterPrompts.length === 0)
    out.push({
      level: 'warn',
      message: 'No starter prompts: the empty chat has nothing to suggest.',
    });
  if (c.channels.includes('voice') && !c.persona.voiceStyle)
    out.push({ level: 'warn', message: 'Voice is enabled but the persona has no voice style.' });

  return out;
}

export const worstLevel = (f: Finding[]): Finding['level'] =>
  f.some((x) => x.level === 'error') ? 'error' : f.some((x) => x.level === 'warn') ? 'warn' : 'ok';
