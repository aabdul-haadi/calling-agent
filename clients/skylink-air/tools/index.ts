import { transferToHuman } from '@backend/tools/transfer-to-human';
import { verifyCustomer } from './verify-customer';
import { getBooking } from './get-booking';
import { searchAlternatives } from './search-alternatives';
import { changeFlight } from './change-flight';

export const skylinkTools = [
  verifyCustomer,
  getBooking,
  searchAlternatives,
  changeFlight,
  transferToHuman,
];
