import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMemberLedgerView } from '../src/services/data/memberLedgerView.js'

const novemberStart = new Date('2026-11-01T00:00:00')
const novemberEnd = new Date('2026-11-30T23:59:59.999')

const enterprises = [
  { id: 'savings', account_name: 'Ordinary Savings', account_type: 'Savings', revenue: 0 },
  { id: 'due', account_name: 'Compulsory Due', account_type: 'Savings', revenue: 1, compulsory_due: 1 },
  { id: 'loan', account_name: 'Loan', account_type: 'Loan', revenue: 0 },
]

function dueFamily() {
  return [
    {
      id: 'PAYMENT-1',
      member_id: 'M-1',
      remittance_date: '2026-11-06T10:00:00',
      created_at: '2026-11-06T10:00:00',
      bank_name: 'Community Bank',
      amount: 20000,
      status: 'Approved',
      details: [{ enterprise_id: 'savings', amount: 20000 }],
      description: 'Member deposit',
      transaction_type: 'Member Deposit',
    },
    {
      id: 'PAYMENT-1-DUE-01',
      member_id: 'M-1',
      remittance_date: '2026-11-06T10:00:00',
      created_at: '2026-11-06T10:00:00',
      bank_name: 'Internal Transfer',
      amount: -200,
      status: 'Approved',
      autogen: 1,
      loan_id: 'PAYMENT-1',
      details: [{ enterprise_id: 'due', amount: -200 }],
      description: 'Auto Internal Charges (Compulsory Due)',
      transaction_type: 'Internal Transfer',
    },
    {
      id: 'PAYMENT-1-INCOME',
      member_id: '0000000000',
      remittance_date: '2026-11-06T10:00:00',
      created_at: '2026-11-06T10:00:00',
      bank_name: 'Internal Transfer',
      amount: 200,
      status: 'Approved',
      autogen: 1,
      parent_remittance_id: 'PAYMENT-1',
      description: 'Auto Compulsory Due (Dues & Penalties) - Member',
      transaction_type: 'Compulsory Due',
    },
    {
      id: 'PAYMENT-1-TR-01',
      member_id: 'M-1',
      remittance_date: '2026-11-06T10:00:00',
      created_at: '2026-11-06T10:00:00',
      bank_name: 'Internal Transfer',
      amount: 0,
      status: 'Approved',
      autogen: 1,
      parent_remittance_id: 'PAYMENT-1',
      details: [
        { enterprise_id: 'savings', amount: -200 },
        { enterprise_id: 'due', amount: 200 },
      ],
      description: 'Auto Dues Transfer (Savings → Dues & Penalties)',
      transaction_type: 'Internal Transfer',
    },
  ]
}

test('general account shows only posted external bank/method activity in balance and bank summaries', () => {
  const rows = [
    ...dueFamily(),
    {
      id: 'BANK-OUT', member_id: 'M-1', remittance_date: '2026-11-10',
      bank_name: 'Community Bank', amount: -1500, status: 'Approved',
      description: 'Bank withdrawal',
    },
    {
      id: 'NAMED-BANK-INTERNAL', member_id: 'M-1', remittance_date: '2026-11-10',
      bank_name: 'Community Bank', amount: 0, status: 'Approved',
      transaction_type: 'Internal Transfer', description: 'Internal account reallocation',
    },
    {
      id: 'NO-BANK', member_id: 'M-1', remittance_date: '2026-11-11',
      bank_name: '', amount: 400, status: 'Approved', description: 'Unassigned',
    },
    {
      id: 'PENDING', member_id: 'M-1', remittance_date: '2026-11-12',
      bank_name: 'Community Bank', amount: 900, status: 'Pending',
    },
  ]

  const result = buildMemberLedgerView({
    remittances: rows,
    enterprises,
    memberId: 'All',
    start: novemberStart,
    end: novemberEnd,
  })

  assert.equal(result.closing, 18500)
  assert.equal(result.credits, 20000)
  assert.equal(result.debits, 1500)
  assert.deepEqual(result.periodRows.map((row) => row.remittance.id), ['PAYMENT-1', 'BANK-OUT'])
  assert.equal(result.bankBalances.length, 1)
  assert.equal(result.bankBalances[0].closing, 18500)
})

test('member ledger shows 20,000 paid then 200 charged, hides the balancing family rows, and preserves account closings', () => {
  const result = buildMemberLedgerView({
    remittances: dueFamily(),
    enterprises,
    memberId: 'M-1',
    start: novemberStart,
    end: novemberEnd,
  })

  assert.deepEqual(result.periodRows.map((row) => row.remittance.id), [
    'PAYMENT-1',
    'PAYMENT-1-DUE-01',
  ])
  assert.equal(result.periodRows[0].credit, 20000)
  assert.equal(result.periodRows[0].balanceAfter, 20000)
  assert.equal(result.periodRows[1].debit, 200)
  assert.equal(result.periodRows[1].balanceAfter, 19800)
  assert.equal(result.closing, 19800)

  const balances = Object.fromEntries(result.memberAccountBalances.map((account) => [account.id, account.closing]))
  assert.equal(balances.savings, 19800)
  assert.equal(balances.due, 0)
})

test('member opening balance carries forward while only the selected period activity is listed', () => {
  const rows = dueFamily().map((row) => ({ ...row }))
  rows[0].remittance_date = '2026-10-31T23:00:00'
  rows[0].created_at = '2026-10-31T23:00:00'
  rows[3].remittance_date = '2026-10-31T23:00:00'
  rows[3].created_at = '2026-10-31T23:00:00'

  const result = buildMemberLedgerView({
    remittances: rows,
    enterprises,
    memberId: 'M-1',
    start: novemberStart,
    end: novemberEnd,
  })

  assert.equal(result.opening, 20000)
  assert.deepEqual(result.periodRows.map((row) => row.remittance.id), ['PAYMENT-1-DUE-01'])
  assert.equal(result.periodRows[0].balanceAfter, 19800)
  assert.equal(result.closing, 19800)
})
