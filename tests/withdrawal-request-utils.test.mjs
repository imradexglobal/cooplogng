import test from 'node:test'
import assert from 'node:assert/strict'
import { appendRequestStatus, calculateGuarantorCoverage, createWithdrawalRequestReference } from '../src/utils/withdrawalRequestUtils.js'

test('guarantor coverage reports full, partial, and excess cover accurately', () => {
  assert.deepEqual(calculateGuarantorCoverage(100, [{ amount: 40 }, { guarantee_amount: 60 }]), {
    requested: 100, covered: 100, uncovered: 0, coveragePercent: 100, isFullyCovered: true,
  })
  assert.equal(calculateGuarantorCoverage(100, [{ amount: 30 }]).uncovered, 70)
  assert.equal(calculateGuarantorCoverage(100, [{ amount: 130 }]).coveragePercent, 100)
})

test('request references have a stable date prefix and unique-looking suffix', () => {
  assert.match(createWithdrawalRequestReference(new Date('2026-11-07T10:00:00Z')), /^WR-20261107-[A-Z0-9]{1,6}$/)
})

test('status history appends transitions and avoids consecutive duplicate statuses', () => {
  const first = appendRequestStatus([], 'Pending', 'member', '2026-11-07T10:00:00Z')
  assert.equal(first.length, 1)
  assert.equal(appendRequestStatus(first, 'Pending', 'member', 'later').length, 1)
  const declined = appendRequestStatus(first, 'Declined', 'reviewer', '2026-11-07T11:00:00Z', 'Missing signature')
  assert.equal(declined.length, 2)
  assert.equal(declined[1].comment, 'Missing signature')
})
