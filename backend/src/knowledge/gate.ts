import { tokenize } from './text';

const SMALL_TALK =
  /^(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening)|thanks?|thank you|thx|ok(?:ay)?|yes|yeah|yep|yup|no|nope|sure|please|go ahead|that'?s (?:all|it)|bye|goodbye|never ?mind|alright|right|got it|cool|great|perfect|sounds good)(?:[\s,.!]+(?:there|please|thanks?|thank you|ava|nia|then|so much|a lot))*[\s.!?]*$/i;

/**
 * Does this message need a policy search? A greeting, a thanks or a bare yes/no does not, and
 * searching for it would only cost time (and could put unrelated policy text in the prompt).
 * Anything else is searched: a missed search is worse than a wasted one.
 */
export function needsKnowledge(message: string): boolean {
  const text = message.trim();
  if (text.length === 0) return false;
  if (SMALL_TALK.test(text)) return false;
  return tokenize(text).length > 0;
}
