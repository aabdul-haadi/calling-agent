/**
 * Can the customer take themselves back out of the queue?
 *
 * Until a person has accepted a handoff the customer is only waiting. If they say they would rather
 * carry on with the assistant, the handoff is withdrawn and the assistant answers again. Once a
 * person has accepted, only that person can hand the conversation back.
 *
 * This is a deliberately narrow pattern match on explicit wording, so a customer who wants a human
 * ("you can't help, get me a person") is never pulled back by accident.
 */
const STAY_WITH_ASSISTANT: RegExp[] = [
  /\b(?:out of|from|off) the (?:queue|line|list)\b/i,
  /\bkeep (?:me )?out\b/i,
  /\btake me out\b/i,
  /\b(?:don'?t|do not|not|no longer) (?:want|need|wish)[^.?!]{0,30}\b(?:human|person|colleague|agent|queue|transfer)\b/i,
  /\b(?:don'?t|do not) (?:transfer|send|put|pass)[^.?!]{0,30}\b(?:human|person|colleague|queue)\b/i,
  /\bcancel[^.?!]{0,20}\b(?:queue|transfer|handoff|hand-off|human)\b/i,
  /\b(?:stay|continue|carry on|keep going) with (?:you|ava|nia)\b/i,
  /^\W*no\W+no\W+you\b/i,
  /\byou (?:find|check|look (?:it )?up|do) it\b/i,
];

export function wantsToStayWithAssistant(message: string): boolean {
  return STAY_WITH_ASSISTANT.some((p) => p.test(message));
}
