import { describe, expect, it } from 'vitest';
import { lastNameMatches } from '@backend/tools/names';
import { normalizeRef, refSchema } from '@clients/skylink-air/tools/api';
import { accountIdSchema, normalizeId } from '@clients/novatel/tools/api';

describe('last name matching', () => {
  it.each([
    ['Rahman', 'Rahman'],
    ['Rahman', 'rahman'],
    ['Rahman', '  RAHMAN '],
    ['Rahman', 'Mr Rahman'],
    ['Rahman', 'Mrs. Rahman'],
    ['Rahman', 'Amira Rahman'],
    ['Müller', 'Muller'],
    ['van der Berg', 'Van Der Berg'],
    ['van der Berg', 'Jan van der Berg'],
  ])('%s accepts "%s"', (actual, given) => {
    expect(lastNameMatches(actual, given)).toBe(true);
  });

  it.each([
    ['Rahman', 'Amira'],
    ['Rahman', 'Rahmen'],
    ['Rahman', 'Rahman Smith'],
    ['Rahman', 'man'],
    ['Rahman', 'Mr'],
    ['Rahman', ''],
    ['Rahman', 'Smith'],
  ])('%s rejects "%s"', (actual, given) => {
    expect(lastNameMatches(actual, given)).toBe(false);
  });
});

describe('booking and account references', () => {
  it.each(['SK1001', 'sk1001', 'SK 1001', 'SK-1001', ' sk 1001 '])('accepts %j', (v) => {
    expect(refSchema.safeParse(v).success).toBe(true);
    expect(normalizeRef(v)).toBe('SK1001');
  });
  it.each(['', 'SK', 'SK1001; DROP TABLE', 'SK/1001', '../etc', 'S K 1 0 0 1 2 3 4 5 6'])(
    'rejects %j',
    (v) => {
      expect(refSchema.safeParse(v).success).toBe(false);
    },
  );
  it('works the same for NovaTel account numbers', () => {
    expect(accountIdSchema.safeParse('NT 2002').success).toBe(true);
    expect(normalizeId('nt-2002')).toBe('NT2002');
    expect(accountIdSchema.safeParse('NT/2002').success).toBe(false);
  });
});
