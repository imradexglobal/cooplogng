import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateAdviceByEnterprise } from '../src/services/data/advice.js'

const build = (enterprise, advice, balance = 0) => calculateAdviceByEnterprise(
    [enterprise],
    advice,
    [{ id: String(enterprise.id), sum_of_amount: balance }]
)[String(enterprise.id)]

test('ordinary savings uses the sum of raw advice unchanged', () => {
    assert.equal(build({ id: 's', account_type: 'Savings' }, [
        { enterprise_id: 's', amount: 125.25 }, { enterprise_id: 's', amount: 74.75 }
    ], 2), 200)
})

test('loan advice is capped by the absolute current or historical loan balance', () => {
    const loan = { id: 'l', account_type: 'Loan' }
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 100 }], 150), 100)
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 100 }], 100), 100)
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 100 }], 35), 35)
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 100 }], 0), 0)
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 0 }], 150), 0)
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 100 }], -20), 20)
    assert.equal(build(loan, [{ enterprise_id: 'l', amount: 100 }], -150), 100)
})

test('compulsory dues and revenue use configured compulsory amount', () => {
    assert.equal(build({ id: 'd', compulsory_due: 1, compulsory_amount: 20 }, [{ enterprise_id: 'd', amount: 700 }], 1), 20)
    assert.equal(build({ id: 'r', revenue: 'true', compulsory_amount: 55 }, [], 0), 55)
})

test('penalty takes precedence over due/revenue/loan and always returns zero', () => {
    assert.equal(build({ id: 'p', is_penalty: true, compulsory_due: 1, revenue: 1, compulsory_amount: 99, account_type: 'Loan' }, [{ enterprise_id: 'p', amount: 50 }], 40), 0)
})

test('deleted advice is ignored and raw rows remain unchanged', () => {
    const raw = [
        { enterprise_id: 's', amount: 10, is_deleted: 0 },
        { enterprise_id: 's', amount: 90, is_deleted: 1 }
    ]
    const before = structuredClone(raw)
    assert.equal(build({ id: 's', account_type: 'Savings' }, raw), 10)
    assert.deepEqual(raw, before)
})
