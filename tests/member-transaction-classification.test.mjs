import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMemberInternalTransfer } from '../src/services/data/memberTransactionClassification.js'

const enterpriseData = [
  { id: 's', account_name: 'Ordinary Savings', account_type: 'Savings' },
  { id: 'l', account_name: 'Ordinary Loan', account_type: 'Loan' },
  { id: 'd', account_name: 'Compulsory Due', compulsory_due: 1, revenue: 1 },
  { id: 'p', account_name: 'Late Penalty', is_penalty: true, revenue: true }
]

test('maps savings Internal Transfer to Member Deposit / Member Liability', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 's', amount: 100 }], enterpriseData),
    { transaction_type: 'Member Deposit', category: 'Member Liability' }
  )
})

test('maps loan Internal Transfer to Member Loan / Loan Asset', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 'l', amount: -100 }], enterpriseData),
    { transaction_type: 'Member Loan', category: 'Loan Asset' }
  )
})

test('maps income due and penalty to enterprise name / Operating Income', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 'd', amount: -20 }], enterpriseData),
    { transaction_type: 'Compulsory Due', category: 'Operating Income' }
  )
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 'p', amount: -5 }], enterpriseData),
    { transaction_type: 'Late Penalty', category: 'Operating Income' }
  )
})

test('leaves mixed enterprise distributions as Internal Transfer for header safety', () => {
  assert.equal(
    classifyMemberInternalTransfer([
      { enterprise_id: 's', amount: 100 },
      { enterprise_id: 'd', amount: -20 }
    ], enterpriseData),
    null
  )
})
