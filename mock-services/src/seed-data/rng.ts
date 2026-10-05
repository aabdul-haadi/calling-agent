// Seeded PRNG (mulberry32) so "random" fake data is identical on every run and in every test.
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

export const FIRST_NAMES = [
  'Amira',
  'Daniel',
  'Elena',
  'Kenji',
  'Sofia',
  'Marcus',
  'Leila',
  'Tomas',
  'Priya',
  'Noah',
  'Ingrid',
  'Carlos',
  'Zainab',
  'Oliver',
  'Mei',
  'Hassan',
  'Clara',
  'Jonas',
  'Aisha',
  'Lucas',
];

export const LAST_NAMES = [
  'Rahman',
  'Okafor',
  'Lindqvist',
  'Tanaka',
  'Alvarez',
  'Novak',
  'Haddad',
  'Chen',
  'Petrov',
  'Mensah',
  'Kowalski',
  'Santos',
  'Fraser',
  'Ibrahim',
  'Larsen',
  'Verma',
  'Duarte',
  'Moreau',
  'Schmidt',
  'Ali',
];
