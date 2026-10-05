import { describe, expect, it } from 'vitest';
import {
  maskEmail,
  maskName,
  maskPII,
  maskPhone,
  maskRef,
  maskText,
} from '@backend/tools/security';

describe('PII masking', () => {
  it('masks references keeping prefix and suffix', () => {
    expect(maskRef('SK1092')).toBe('SK***92');
    expect(maskRef('AB')).toBe('**');
  });

  it('masks names, emails and phones', () => {
    expect(maskName('Maria Lopez')).toBe('M. L.');
    expect(maskEmail('maria@example.com')).toBe('m***@example.com');
    expect(maskPhone('+1 555 010 0042')).toBe('***42');
  });

  it('scrubs emails and phones inside free text', () => {
    const out = maskText('Call me on +1 555 010 0042 or mail maria@example.com');
    expect(out).not.toContain('maria@');
    expect(out).not.toContain('555 010');
  });

  it('deep-masks objects by key name', () => {
    const out = maskPII({
      bookingRef: 'SK1001',
      passenger: {
        firstName: 'Amira',
        lastName: 'Rahman',
        email: 'a@x.test',
        phone: '+15550100001',
      },
      list: [{ accountId: 'NT2001' }],
      note: 'ok',
    });
    expect(out).toEqual({
      bookingRef: 'SK***01',
      passenger: { firstName: 'A.', lastName: 'R.', email: 'a***@x.test', phone: '***01' },
      list: [{ accountId: 'NT***01' }],
      note: 'ok',
    });
  });
});
