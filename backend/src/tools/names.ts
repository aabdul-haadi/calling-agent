const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof']);

/** Lower case, accents and punctuation removed, titles dropped: "Mr. Müller" -> "muller". */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !TITLES.has(w))
    .join(' ');
}

/**
 * Does what the customer typed match the last name on record? People type "Rahman", "rahman",
 * "Mr Rahman" or "Amira Rahman", and all of those are the same person. A first name alone, or a
 * different surname, never matches, so this is no weaker for someone guessing at a booking.
 */
export function lastNameMatches(actual: string, given: string): boolean {
  const a = normalizeName(actual);
  const g = normalizeName(given);
  if (!a || !g) return false;
  return g === a || g.endsWith(` ${a}`);
}
