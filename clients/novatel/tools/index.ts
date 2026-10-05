import { transferToHuman } from '@backend/tools/transfer-to-human';
import { verifyCustomer } from './verify-customer';
import { getBill } from './get-bill';
import { checkOutage } from './check-outage';

export const novatelTools = [verifyCustomer, getBill, checkOutage, transferToHuman];
