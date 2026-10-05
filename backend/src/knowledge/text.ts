const STOPWORDS = new Set(
  ('a an the and or but if of to in on at for from by with about as is are was were be been am do does did ' +
    'can could should would will shall may might i me my we our you your it its this that these those there ' +
    'what which who whom how many much any some no not so than then too very just also please tell know ' +
    'get got have has had need want like us them they their').split(' '),
);

// The local (offline) embedding is lexical, so we fold common synonyms together by hand.
const SYNONYMS: Record<string, string> = {
  bag: 'baggage', luggage: 'baggage', suitcase: 'baggage', carryon: 'baggage',
  canceled: 'cancel', cancelled: 'cancel', cancellation: 'cancel', cancelling: 'cancel',
  reimburse: 'refund', reimbursement: 'refund', refunded: 'refund',
  charge: 'fee', cost: 'fee', price: 'fee',
  rebooking: 'rebook', rebooked: 'rebook', reschedule: 'rebook',
  dog: 'pet', cat: 'pet', animal: 'pet',
  kg: 'weight', kilo: 'weight', heavy: 'weight', pound: 'weight',
};

export function stem(word: string): string {
  let w = word;
  if (SYNONYMS[w]) return SYNONYMS[w]!;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return SYNONYMS[w] ?? w;
}

/** Lowercase, drop stopwords, stem. Used by both the local embedding and the lexical rerank. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}
