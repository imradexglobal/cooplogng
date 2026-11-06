import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoShareStatus } from '../src/services/autoShare/status.js';

test('Auto Share is approved when the user can approve remittances', () => {
  assert.equal(resolveAutoShareStatus(true), 'Approved');
});

test('Auto Share remains pending when the user cannot approve remittances', () => {
  assert.equal(resolveAutoShareStatus(false), 'Pending');
  assert.equal(resolveAutoShareStatus(undefined), 'Pending');
  assert.equal(resolveAutoShareStatus('true'), 'Pending');
});
