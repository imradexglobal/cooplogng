import assert from 'node:assert/strict';
import {
    BALANCE_SHEET_CLASSIFICATIONS,
    CLASSIFICATION_OPTIONS,
    DEFAULT_TRANSACTION_TYPES,
    TRANSACTION_TYPES
} from '../src/utils/constants.js';
import { buildAccountingPack } from '../src/services/reports/accountingPack.js';

const txName = 'Bank/General Asset';
const classification = 'General Asset';
const coopId = 'GENERAL_ASSET_TEST';
const defaultType = DEFAULT_TRANSACTION_TYPES.find(t => t.name === txName);

assert.ok(TRANSACTION_TYPES.includes(txName), 'transaction-type list includes Bank/General Asset');
assert.ok(defaultType, 'the type is part of the default transaction types');
assert.equal(defaultType.classification, classification, 'the default type maps to General Asset');
assert.ok(CLASSIFICATION_OPTIONS.includes(classification), 'General Asset is selectable');
assert.ok(BALANCE_SHEET_CLASSIFICATIONS.has(classification), 'General Asset is recognized as balance sheet classification');

// A bank payment to acquire/record an asset should credit cash and debit an
// asset account. The synthetic query bridge exercises the same accounting-pack
// model used by the reports without reading or writing a user database.
const tables = {
    remittance: [{
        id: 'GA-001', cooperative_id: coopId, member_id: '0000000000', amount: '-1000.00',
        bank_name: 'Test Bank', description: 'Synthetic general asset transaction',
        transaction_type: txName, category: classification, status: 'Approved',
        remittance_date: '2025-12-31', is_deleted: '0', is_synced: '0', created_by: 'test',
        modified_by: 'test', created_at: '2025-12-31T12:00:00.000Z', modified_at: '2025-12-31T12:00:00.000Z'
    }],
    remittance_detail: [],
    members: [],
    enterprise: [],
    loans: [],
    bank: [],
    transaction_types: [{
        id: 'TT-GA', cooperative_id: coopId, transaction_type: txName,
        classification, is_deleted: '0', is_active: '1'
    }],
    bank_reconciliation_summary: []
};

const query = async (sql, bind = []) => {
    const scoped = sql.match(/^SELECT \* FROM ([a-z_]+) WHERE cooperative_id = \?$/i);
    if (scoped) return (tables[scoped[1]] || []).filter(row => String(row.cooperative_id) === String(bind[0]));
    if (/^SELECT id, full_name, short_name FROM cooperatives$/i.test(sql.trim())) {
        return [{ id: coopId, full_name: 'General Asset Test Co-op', short_name: 'GAT' }];
    }
    throw new Error(`Unexpected accounting-pack query in test: ${sql}`);
};

const pack = await buildAccountingPack({
    cooperativeId: coopId,
    startDate: '2025-12-31',
    endDate: '2025-12-31',
    cooperativeName: 'General Asset Test Co-op',
    generatedBy: 'test-general-asset',
    query
});

const account = pack.accounts.find(a => a.bucket === 'coopAsset' && a.name === txName);
assert.ok(account, 'General Asset creates a cooperative asset account in the trial balance');
assert.equal(account.type, 'Asset', 'General Asset account is an asset, not income or expense');
assert.equal(account.periodNet, 1000, 'negative bank payment debits the General Asset account');

const assetGroup = pack.financialPosition.assets.find(g => g.label === 'Cooperative assets');
const assetLine = assetGroup?.lines.find(line => line.account === txName);
assert.equal(assetLine?.closing, 1000, 'General Asset appears in the Statement of Financial Position');
assert.equal(pack.coopAssetDetail.length, 1, 'General Asset appears in the capitalized-asset detail schedule');
assert.equal(pack.incomeDetail.length, 0, 'General Asset is excluded from income detail');
assert.equal(pack.expenseDetail.length, 0, 'General Asset is excluded from expense detail');
assert.equal(pack.incomeExpenditure.incomeTotal, 0, 'General Asset does not inflate income');
assert.equal(pack.incomeExpenditure.expenditureTotal, 0, 'General Asset does not inflate expenditure');
assert.equal(pack.cashFlow.lines.find(line => line.label === 'Capitalised cooperative asset purchases')?.amount, -1000,
    'General Asset movement flows through the investing/capitalized-asset cash-flow line');
assert.ok(!pack.exceptions.some(e => e.code === 'UNKNOWN_CATEGORY' || e.code === 'UNMAPPED_TRANSACTION_TYPE'),
    'General Asset is recognized and its transaction type has a classification mapping');

console.log('PASS: Bank/General Asset is selectable, recognized as a balance-sheet asset, excluded from P&L, and reflected in the financial position and cash flow.');
