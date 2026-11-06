import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isDuesSettlementTransfer,
  isExternalBankOrCashTransaction,
  scopeRows,
  LEDGER_ALL,
} from '../src/experimental/lib/ledgerFilters.js'

const memberId = 'member-1'

const rows = [
  {
    uid: 'payment',
    accountId: 'savings',
    memberId,
    bankName: 'Lotus Bank',
    amount: 22000,
    description: 'Lotus transfer deposit',
  },
  {
    uid: 'registration-fee',
    accountId: 'registration',
    memberId,
    bankName: 'Internal Transfer',
    amount: -2000,
    description: 'Auto Internal Charges (Registration Fee)',
    isDuesSettlementTransfer: isDuesSettlementTransfer({
      autogen: 1,
      description: 'Auto Internal Charges (Registration Fee)',
    }),
  },
  {
    uid: 'transfer-credit',
    accountId: 'registration',
    memberId,
    bankName: 'Internal Transfer',
    amount: 2000,
    description: 'Auto Dues Transfer (Savings → Dues & Penalties) - Member',
    isDuesSettlementTransfer: isDuesSettlementTransfer({
      autogen: 1,
      description: 'Auto Dues Transfer (Savings → Dues & Penalties) - Member',
    }),
  },
  {
    uid: 'transfer-debit',
    accountId: 'savings',
    memberId,
    bankName: 'Internal Transfer',
    amount: -2000,
    description: 'Auto Dues Transfer (Savings → Dues & Penalties) - Member',
    isDuesSettlementTransfer: isDuesSettlementTransfer({
      autogen: 1,
      description: 'Auto Dues Transfer (Savings → Dues & Penalties) - Member',
    }),
  },
  {
    uid: 'ordinary-withdrawal',
    accountId: 'savings',
    memberId,
    bankName: 'Internal Transfer',
    amount: -1000,
    description: 'Member savings withdrawal',
    isDuesSettlementTransfer: false,
  },
]

test('member scope keeps the Auto Internal Charges row and hides both Auto Dues Transfer handshake lines', () => {
  assert.equal(
    isDuesSettlementTransfer({ autogen: '1', description: 'Auto Dues Transfer (Savings → Dues & Penalties)' }),
    true
  )
  assert.equal(
    isDuesSettlementTransfer({ autogen: 1, description: 'Auto Internal Charges (Registration Fee)' }),
    false
  )

  const memberRows = scopeRows(rows, { accountId: LEDGER_ALL, memberId })
  assert.deepEqual(memberRows.map((row) => row.uid), ['payment', 'registration-fee', 'ordinary-withdrawal'])
  assert.equal(memberRows.reduce((balance, row) => balance + row.amount, 0), 19000)
  assert.equal(memberRows.find((row) => row.uid === 'registration-fee').amount, -2000)
})

test('general scope excludes internal rows while member scope suppresses dues handshake under account filters', () => {
  const allMemberRows = scopeRows(rows, { accountId: LEDGER_ALL, memberId: LEDGER_ALL })
  assert.deepEqual(allMemberRows.map((row) => row.uid), ['payment'])

  const savingsRows = scopeRows(rows, { accountId: 'savings', memberId })
  assert.deepEqual(savingsRows.map((row) => row.uid), ['payment', 'ordinary-withdrawal'])

  const registrationRows = scopeRows(rows, { accountId: 'registration', memberId })
  assert.deepEqual(registrationRows.map((row) => row.uid), ['registration-fee'])
})

test('general view includes only external bank/cash transactions, excluding internal and unassigned records', () => {
  const candidates = [
    { uid: 'cash', memberId, bankName: 'Cash', transactionType: 'Member Deposit' },
    { uid: 'bank', memberId, bankName: 'Community Bank', transactionType: 'Bank Deposit' },
    { uid: 'internal-bank-label', memberId, bankName: 'Internal Transfer', transactionType: 'Transfer' },
    { uid: 'internal-type', memberId, bankName: 'Community Bank', transactionType: 'Internal Transfer' },
    { uid: 'unassigned', memberId, bankName: '', transactionType: 'Member Deposit' },
  ]
  assert.deepEqual(
    candidates.filter(isExternalBankOrCashTransaction).map((row) => row.uid),
    ['cash', 'bank']
  )
  assert.deepEqual(
    scopeRows(candidates, { accountId: LEDGER_ALL, memberId: LEDGER_ALL }).map((row) => row.uid),
    ['cash', 'bank']
  )
  assert.deepEqual(
    scopeRows(candidates, { accountId: LEDGER_ALL, memberId }).map((row) => row.uid),
    candidates.map((row) => row.uid)
  )
})
