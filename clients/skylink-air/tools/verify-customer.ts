import { z } from 'zod';
import { fail, ok } from '@adk/shared';
import { defineTool } from '@backend/tools/types';
import { fetchBooking, refSchema } from './api';

export const verifyCustomer = defineTool({
  name: 'verify_customer',
  description:
    'Verify the passenger. Requires the booking reference and the passenger last name exactly as the customer gives them. Must succeed before any booking tool.',
  input: z.object({ bookingRef: refSchema, lastName: z.string().trim().min(1).max(60) }),
  label: 'Checked identity',
  summarize: () => 'Identity verified',
  async run({ bookingRef, lastName }, ctx) {
    const res = await fetchBooking(bookingRef, ctx);
    if (!res.ok) {
      // Same answer for "no such booking" and "wrong name": do not reveal which refs exist.
      return res.error === 'NOT_FOUND'
        ? fail('UNAUTHORIZED', 'Those details do not match our records.')
        : res;
    }
    if (res.data.lastName.trim().toLowerCase() !== lastName.trim().toLowerCase()) {
      return fail('UNAUTHORIZED', 'Those details do not match our records.');
    }
    return ok({ passengerId: res.data.passengerId, firstName: res.data.firstName });
  },
  remember: (data) => ({
    verified: true,
    customerId: data.passengerId,
    collected: { passengerFirstName: data.firstName },
    step: 'verify',
  }),
});
