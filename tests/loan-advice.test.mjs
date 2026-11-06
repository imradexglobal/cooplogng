import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMonthlyLoanAdvice } from '../src/services/data/loanAdvice.js';

test('50,000 over six months is advised as 8,400 per month', () => {
  assert.equal(calculateMonthlyLoanAdvice(50000, 6), 8400);
});

test('monthly advice rounds up to the next hundred', () => {
  assert.equal(calculateMonthlyLoanAdvice(50000, 12), 4200);
  assert.equal(calculateMonthlyLoanAdvice(50000, 7), 7200);
});

test('exact hundreds remain unchanged', () => {
  assert.equal(calculateMonthlyLoanAdvice(50000, 5), 10000);
  assert.equal(calculateMonthlyLoanAdvice(1000, 10), 100);
});

test('invalid or non-positive loan inputs produce no advice', () => {
  assert.equal(calculateMonthlyLoanAdvice(0, 6), 0);
  assert.equal(calculateMonthlyLoanAdvice(50000, 0), 0);
  assert.equal(calculateMonthlyLoanAdvice('invalid', 6), 0);
});
