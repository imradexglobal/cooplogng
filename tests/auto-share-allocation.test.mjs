import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateAutoShare, validateAllocation } from '../src/services/autoShare/allocator.js';

const enterprise = (id, auto_rem = 0, account_type = 'Savings', extra = {}) => ({
  id,
  account_name: `Account ${id}`,
  account_type,
  auto_rem,
  distribution_priority: 0,
  ...extra
});
const byId = result => Object.fromEntries(result.allocations.map(row => [row.enterpriseId, row.allocatedAmount]));

 test('one configured Savings enterprise receives all remaining funds regardless of its percentage', () => {
  const result = allocateAutoShare({
    remittanceAmount: 300,
    enterprises: [enterprise('s1', 20), enterprise('s2')],
    adviceByEnterprise: { s2: 100 }
  });
  assert.deepEqual(byId(result), { s1: 200, s2: 100 });
  assert.equal(result.allocatedTotal, 300);
  assert.equal(result.remainder, 0);
  assert.deepEqual(validateAllocation(result, 300), []);
});

test('multiple Savings auto_rem values totaling 100 split the remainder by percentage', () => {
  const result = allocateAutoShare({
    remittanceAmount: 1000,
    enterprises: [enterprise('a', 25), enterprise('b', 75)]
  });
  assert.deepEqual(byId(result), { a: 250, b: 750 });
  assert.equal(result.allocatedTotal, 1000);
});

test('multiple configured percentages not totaling 100 split remainder equally', () => {
  const result = allocateAutoShare({
    remittanceAmount: 10,
    enterprises: [enterprise('a', 20), enterprise('b', 20), enterprise('c')]
  });
  assert.deepEqual(byId(result), { a: 0, b: 10, c: 0 });
  assert.ok(result.warnings.some(warning => warning.type === 'auto_rem_total_not_100'));
});

test('without auto_rem, fallback splits remainder equally across eligible Savings accounts', () => {
  const result = allocateAutoShare({ remittanceAmount: 5, enterprises: [enterprise('a'), enterprise('b')] });
  assert.deepEqual(byId(result), { a: 0, b: 5 });
});

test('auto_rem on a loan account is never used as a Savings remainder target', () => {
  const result = allocateAutoShare({
    remittanceAmount: 15,
    enterprises: [enterprise('loan', 100, 'Loan'), enterprise('savings')]
  });
  assert.deepEqual(byId(result), { loan: 0, savings: 15 });
});

test('minor-unit rounding always allocates the exact remittance total', () => {
  const result = allocateAutoShare({
    remittanceAmount: 10.01,
    enterprises: [enterprise('a', 33.33), enterprise('b', 33.33), enterprise('c', 33.34)]
  });
  assert.equal(Math.round(result.allocatedTotal * 100), 1001);
  assert.equal(result.remainder, 0);
  assert.equal(Math.round(result.allocations.reduce((sum, row) => sum + row.allocatedAmount, 0) * 100), 1001);
});

test('remainder is rounded down to ten-unit amounts except for the final enterprise', () => {
  const result = allocateAutoShare({
    remittanceAmount: 10000.5,
    enterprises: [enterprise('a'), enterprise('b'), enterprise('c')]
  });
  assert.deepEqual(byId(result), { a: 3330, b: 3330, c: 3340.5 });
  assert.equal(Math.round(result.allocatedTotal * 100), 1000050);
  assert.equal(result.remainder, 0);
});

test('payment-advice cents stay with their advice allocation and remaining cents go to the final target', () => {
  const result = allocateAutoShare({
    remittanceAmount: 100.5,
    enterprises: [enterprise('a'), enterprise('b'), enterprise('c')],
    adviceByEnterprise: { a: 10.25 }
  });
  assert.deepEqual(byId(result), { a: 40.25, b: 30, c: 30.25 });
  assert.equal(Math.round(result.allocatedTotal * 100), 10050);
});

test('excluded enterprises cannot absorb remainder and an all-excluded case remains explicit', () => {
  const result = allocateAutoShare({
    remittanceAmount: 4,
    enterprises: [enterprise('due', 100, 'Savings', { compulsory_due: 1 })]
  });
  assert.equal(result.allocatedTotal, 0);
  assert.equal(result.remainder, 4);
  assert.ok(validateAllocation(result, 4).some(message => message.includes('equal')));
});
