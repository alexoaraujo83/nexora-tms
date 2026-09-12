import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  parseCreateCarrierPaymentObligation,
  parseCreateCarrierPaymentTransaction,
  parseUpdateCarrierPaymentObligation,
} from './finance-payment.validation.js';

const CONTRACT_ID = '62000000-0000-4000-8000-000000000901';
const TRANSACTION_ID = '62000000-0000-4000-8000-000000000951';

test('create obligation normalizes contract, due date and optional fields', () => {
  const parsed = parseCreateCarrierPaymentObligation({
    transportContractId: CONTRACT_ID,
    dueAt: '2026-09-20T12:00:00-03:00',
    notes: '  pagamento do transportador  ',
  });

  assert.equal(parsed.transportContractId, CONTRACT_ID);
  assert.equal(parsed.tripId, null);
  assert.equal(parsed.dueAt, '2026-09-20T15:00:00.000Z');
  assert.equal(parsed.notes, 'pagamento do transportador');
});

test('transaction validates positive money and reversal reference', () => {
  const payment = parseCreateCarrierPaymentTransaction({ kind: 'advance', amount: 2500 });
  assert.equal(payment.amount, '2500.00');
  assert.equal(payment.relatedTransactionId, null);

  const reversal = parseCreateCarrierPaymentTransaction({
    kind: 'reversal',
    amount: '2500.00',
    relatedTransactionId: TRANSACTION_ID,
  });
  assert.equal(reversal.relatedTransactionId, TRANSACTION_ID);

  assert.throws(
    () => parseCreateCarrierPaymentTransaction({ kind: 'reversal', amount: 100 }),
    /relatedTransactionId is required/,
  );
  assert.throws(
    () => parseCreateCarrierPaymentTransaction({ kind: 'payment', amount: 0 }),
    /must be greater than zero/,
  );
});

test('money validation preserves decimal strings without IEEE-754 rounding', () => {
  const parsed = parseCreateCarrierPaymentTransaction({ kind: 'payment', amount: '0.10' });
  assert.equal(parsed.amount, '0.10');

  const maximum = parseCreateCarrierPaymentTransaction({
    kind: 'payment',
    amount: '999999999999.99',
  });
  assert.equal(maximum.amount, '999999999999.99');

  assert.throws(
    () => parseCreateCarrierPaymentTransaction({ kind: 'payment', amount: '1000000000000.00' }),
    /positive monetary value/,
  );
  assert.throws(
    () => parseCreateCarrierPaymentTransaction({ kind: 'payment', amount: '0.00' }),
    /must be greater than zero/,
  );
});

test('obligation update rejects empty payload', () => {
  assert.throws(() => parseUpdateCarrierPaymentObligation({}), /at least one obligation field/);
});
