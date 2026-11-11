import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAmount, parseDate, extractFromRawRows } from '../src/services/bankStatement/extractor.js';
import { normalizeText, matchMember, classifyTransaction } from '../src/services/bankStatement/intelligence.js';

test('parseAmount correctly handles positive, negative, parenthesized, and formatted amounts', () => {
    assert.equal(parseAmount('1,500.50'), 1500.50);
    assert.equal(parseAmount('₦25,000.00'), 25000);
    assert.equal(parseAmount('(5,000.00)'), -5000);
    assert.equal(parseAmount('-750.25'), -750.25);
    assert.equal(parseAmount(1200), 1200);
    assert.equal(parseAmount(''), 0);
    assert.equal(parseAmount(null), 0);
});

test('parseDate normalizes multiple date formats to YYYY-MM-DD', () => {
    assert.equal(parseDate('2026-11-04'), '2026-11-04');
    assert.equal(parseDate('04/11/2026'), '2026-11-04');
    assert.equal(parseDate('15-Nov-2024'), '2024-11-15');
    assert.equal(parseDate('04-Nov-26'), '2026-11-04');
});

test('extractFromRawRows identifies column headers and handles debits and credits', () => {
    const rawRows = [
        ['COOPERATIVE BANK STATEMENT', '', '', '', ''],
        ['Account: 0123456789', '', '', '', ''],
        ['Txn Date', 'Narration', 'Reference', 'Debit', 'Credit', 'Balance'],
        ['2026-10-01', 'Deposit from Adebowale Wasiu REG/001', 'REF1001', '', '50,000.00', '150,000.00'],
        ['2026-10-02', 'SMS Alert Fee', 'CHG9921', '10.75', '', '149,989.25'],
        ['2026-10-03', 'Total Brought Forward', '', '', '', '']
    ];

    const extracted = extractFromRawRows(rawRows);
    assert.equal(extracted.length, 2); // skips headers and summary row

    // Row 1
    assert.equal(extracted[0].date, '2026-10-01');
    assert.equal(extracted[0].credit, 50000);
    assert.equal(extracted[0].debit, 0);
    assert.equal(extracted[0].amount, 50000);
    assert.equal(extracted[0].reference, 'REF1001');

    // Row 2
    assert.equal(extracted[1].date, '2026-10-02');
    assert.equal(extracted[1].credit, 0);
    assert.equal(extracted[1].debit, 10.75);
    assert.equal(extracted[1].amount, -10.75);
});

test('matchMember matches member by Special ID, Registration No, Phone, and Name Tokens', () => {
    const members = [
        { id: 'm1', first_name: 'Wasiu', last_name: 'Adebowale', registration_no: 'REG-101', special_id: 'SP-99', mobile: '08012345678' },
        { id: 'm2', first_name: 'Kemi', middle_name: 'Grace', last_name: 'Olatunji', registration_no: 'REG-102', special_id: 'SP-100', mobile: '08098765432' },
        { id: 'm3', first_name: 'Wasiu', last_name: 'Bello', registration_no: 'REG-103', special_id: 'SP-101', mobile: '08055554444' }
    ];

    // Special ID match
    const r1 = matchMember('TRF FROM SP-99 MONTHLY CONTRIB', members);
    assert.equal(r1.member?.id, 'm1');
    assert.equal(r1.confidence, 'High');

    // Registration No match
    const r2 = matchMember('PAYMENT FROM REG-102 DUES', members);
    assert.equal(r2.member?.id, 'm2');
    assert.equal(r2.confidence, 'High');

    // Phone match
    const r3 = matchMember('NIP/08012345678/CONTRIB', members);
    assert.equal(r3.member?.id, 'm1');
    assert.equal(r3.confidence, 'High');

    // First + Last name tokens
    const r4 = matchMember('TRANSFER FROM ADEBOWALE WASIU VIA GTWORLD', members);
    assert.equal(r4.member?.id, 'm1');
    assert.equal(r4.confidence, 'High');

    // Ambiguous first name only -> returns Low/Unknown
    const r5 = matchMember('TRANSFER FROM WASIU MONTHLY', members);
    assert.equal(r5.member, null);
    assert.equal(r5.confidence, 'None');
});

test('classifyTransaction classifies remittances, loans, expenses, income and unknowns', () => {
    const members = [
        { id: 'm1', first_name: 'Wasiu', last_name: 'Adebowale', registration_no: 'REG-101', special_id: 'SP-99', mobile: '08012345678' }
    ];
    const loanEnterprises = [{ id: 'ent-loan-1', account_name: 'Main Loan', account_type: 'loan' }];

    // 1. Positive credit with confident member -> Remittance
    const t1 = classifyTransaction({
        amount: 25000,
        description: 'Monthly savings from Wasiu Adebowale',
        reference: 'GTB1234'
    }, { members, loanEnterprises });
    assert.equal(t1.classification, 'Remittance');
    assert.equal(t1.memberId, 'm1');
    assert.equal(t1.transactionType, 'Member Deposit');

    // 2. Negative debit with confident member -> Loan (prepared for admin loan setup)
    const t2 = classifyTransaction({
        amount: -150000,
        description: 'Loan disbursement to Adebowale Wasiu REG-101',
        reference: 'DISB998'
    }, { members, loanEnterprises });
    assert.equal(t2.classification, 'Loan');
    assert.equal(t2.memberId, 'm1');
    assert.equal(t2.enterpriseId, 'ent-loan-1');
    assert.equal(t2.transactionType, 'Member Loan');

    // 3. Bank charge debit -> Confirmed Expense
    const t3 = classifyTransaction({
        amount: -50.00,
        description: 'Monthly SMS alert fee and VAT',
        reference: 'VAT001'
    }, { members, loanEnterprises });
    assert.equal(t3.classification, 'Expense');
    assert.equal(t3.memberId, '0000000000');
    assert.equal(t3.transactionType, 'Financial & Banking Expenses');
    assert.equal(t3.category, 'Finance Expense');

    // 4. Bank interest credit -> Confirmed Income
    const t4 = classifyTransaction({
        amount: 1420.50,
        description: 'Interest paid on savings account for October',
        reference: 'INT002'
    }, { members, loanEnterprises });
    assert.equal(t4.classification, 'Income');
    assert.equal(t4.memberId, '0000000000');
    assert.equal(t4.transactionType, 'Other Income');

    // 5. Uncertain transaction -> Unknown Payment under 0000000000
    const t5 = classifyTransaction({
        amount: 10000,
        description: 'POS CASH DEPOSIT AT IKEJA BRANCH',
        reference: 'POS8812'
    }, { members, loanEnterprises });
    assert.equal(t5.classification, 'Unknown');
    assert.equal(t5.memberId, '0000000000');
    assert.equal(t5.transactionType, 'Unknown Payments');
    assert.equal(t5.category, 'Member Liability');
});

test('extractFromRawRows handles statements with Amount and Cr/Dr column', () => {
    const rawRows = [
        ['Date', 'Particulars', 'Amount', 'Type', 'Bal'],
        ['2026-10-01', 'Transfer In from REG-101', '10,000.00', 'CR', '10,000.00'],
        ['2026-10-02', 'Bank Transfer Charge', '52.50', 'DR', '9,947.50']
    ];

    const extracted = extractFromRawRows(rawRows);
    assert.equal(extracted.length, 2);
    assert.equal(extracted[0].amount, 10000);
    assert.equal(extracted[0].credit, 10000);
    assert.equal(extracted[0].debit, 0);

    assert.equal(extracted[1].amount, -52.50);
    assert.equal(extracted[1].credit, 0);
    assert.equal(extracted[1].debit, 52.50);
});

test('classifyTransaction falls back to Unknown Payment when ambiguity or no match occurs', () => {
    const result = classifyTransaction({
        amount: 50000,
        description: 'CHQ DEP NO 98231',
        reference: '98231'
    }, { members: [], loanEnterprises: [] });

    assert.equal(result.classification, 'Unknown');
    assert.equal(result.memberId, '0000000000');
    assert.equal(result.transactionType, 'Unknown Payments');
    assert.equal(result.category, 'Member Liability');
});
