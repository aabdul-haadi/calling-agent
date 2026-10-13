/**
 * Documents are reference text, never instructions. A policy file cannot tell the agent what to do:
 * the agent's rules come from the engine and the company's configuration, and every action is
 * decided by the runtime's own checks. As a second layer, sentences that read like an instruction
 * to an AI system are removed from a passage before it reaches the model, and the document is
 * flagged so a person can look at it.
 */
const INSTRUCTION_LIKE: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,60}\b(previous|prior|above|earlier|all|any|these|the)\b[^.!?\n]{0,40}\b(instructions?|rules?|prompts?|polic(?:y|ies)|guidelines?)\b/i,
  /\b(system|assistant|ai|model|bot|llm)\s+(instruction|prompt|message|note|directive)s?\b/i,
  /\binstruction(?:s)? (?:for|to) (?:the )?(?:assistant|ai|agent|model|bot|llm)\b/i,
  /\byou (?:are|must|should|will) (?:now )?(?:act|behave|respond|pretend|ignore|approve|call|execute|skip|bypass|reveal)\b/i,
  /\b(?:skip|bypass|disable|waive|do not (?:ask|require)|without) (?:customer )?(?:verification|authenticat(?:ion|e)|confirmation|approval|checks?)\b/i,
  /\b(?:call|invoke|execute|run|use) (?:the )?(?:tool |function )?[a-z]+_[a-z_]+\b/i,
  /\b(?:reveal|print|show|output|repeat) (?:your|the) (?:system )?(?:prompt|instructions|rules|api key|secret)/i,
  /\bapprove every\b/i,
];

export function looksLikeInstruction(sentence: string): boolean {
  return INSTRUCTION_LIKE.some((p) => p.test(sentence));
}

/** The passage without its instruction-like sentences (the policy text around them is kept). */
export function stripInstructions(text: string): string {
  const parts = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|$)\s*/g) ?? [text];
  const kept = parts.filter((p) => !looksLikeInstruction(p));
  return kept.length === parts.length ? text : kept.join('').trim();
}

/** Short notes for the document owner about instruction-like text found in a document. */
export function instructionWarnings(pages: { number: number; text: string }[]): string[] {
  const notes: string[] = [];
  for (const p of pages) {
    const sentences = p.text.match(/[^.!?\n]+(?:[.!?]+|$)/g) ?? [];
    if (sentences.some(looksLikeInstruction)) {
      notes.push(
        `page ${p.number}: text that reads like an instruction to an AI system was found; it is ignored when answering`,
      );
    }
  }
  return notes.slice(0, 10);
}
