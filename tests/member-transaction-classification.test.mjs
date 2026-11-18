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


test('recognizes common brought-forward note wording and abbreviations', () => {
  for (const description of [
    'Opening Balance 2025',
    'opening bal',
    'Balance Brought Forward',
    'Brought Forward from 2025',
    'Balance BF 2025',
    'Bal. B/F ordinary savings',
    'B/F 2025',
    'BF 2025',
    'Brought fwd from 2025',
    'BBF - loan',
    'Carried forward balance',
    'Balance brought foward'
  ]) {
    assert.deepEqual(
      classifyMemberInternalTransfer([{ enterprise_id: 'l', amount: -100 }], enterpriseData, { amount: -100, description }),
      { transaction_type: 'Opening Member Loan', category: 'Loan Asset' },
      `Expected brought-forward recognition for: ${description}`
    )
  }
})

test('classifies reconciled savings brought-forward entries as Opening Member Savings', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 's', amount: 100 }], enterpriseData, { amount: 100, description: 'Balance brought forward' }),
    { transaction_type: 'Opening Member Savings', category: 'Member Liability' }
  )
})

test('classifies mixed loan and savings brought-forward entries as Opening Member Savings', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([
      { enterprise_id: 'l', amount: -100 },
      { enterprise_id: 's', amount: 250 }
    ], enterpriseData, { amount: 150, description: 'Opening Balance adjustment' }),
    { transaction_type: 'Opening Member Savings', category: 'Member Liability' }
  )
})

test('assigns zero-amount brought-forward entries to Opening Member Savings', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([], enterpriseData, { amount: 0, description: 'BBF' }),
    { transaction_type: 'Opening Member Savings', category: 'Member Liability' }
  )
  assert.deepEqual(
    classifyMemberInternalTransfer([
      { enterprise_id: 'l', amount: 100 },
      { enterprise_id: 'l', amount: -100 }
    ], enterpriseData, { amount: 0, description: 'Opening Balance' }),
    { transaction_type: 'Opening Member Savings', category: 'Member Liability' }
  )
})

test('does not assign an opening type when the distribution does not match the header', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 'l', amount: -100 }], enterpriseData, { amount: -90, description: 'Opening Balance' }),
    { transaction_type: 'Member Loan', category: 'Loan Asset' }
  )
})

test('matching amounts without brought-forward wording retain ordinary transaction classification', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 'l', amount: -100 }], enterpriseData, { amount: -100, description: 'Loan repayment' }),
    { transaction_type: 'Member Loan', category: 'Loan Asset' }
  )
})


test('does not assign an opening member type when a nonzero detail has no active enterprise assignment', () => {
  assert.deepEqual(
    classifyMemberInternalTransfer([{ enterprise_id: 'missing', amount: 100 }], enterpriseData, { amount: 100, description: 'Opening Balance' }),
    { transaction_type: 'Internal Transfer', category: 'Transfer' }
  )
})
