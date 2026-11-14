import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAmount, parseDate, extractFromRawRows, reconstructPdfRows, mergePdfContinuationRows } from '../src/services/bankStatement/extractor.js';
import { normalizeText, matchMember, classifyTransaction } from '../src/services/bankStatement/intelligence.js';
import { detectAgainstSavedRemittances } from '../src/services/bankStatement/duplicateDetector.js';
import { filterStatementTransactions } from '../src/services/bankStatement/reviewFilters.js';

test('duplicate checking only compares statement rows with saved remittances, not other rows in the same statement', () => {
    const statementRows = [
        { date: '2026-11-01', amount: 25000, memberId: 'm1', description: 'Wasiu Adebowale deposit', reference: 'TXN-101' },
        { date: '2026-11-01', amount: 25000, memberId: 'm1', description: 'Wasiu Adebowale deposit', reference: 'TXN-101' }
    ];

    const withoutSavedMatch = detectAgainstSavedRemittances(statementRows, {
        bankName: 'Example Bank',
        existingRemittances: []
    });
    assert.deepEqual(withoutSavedMatch.map(row => row.duplicateStatus), ['New', 'New']);

    const savedRemittance = {
        id: 'saved-1',
        remittance_date: '2026-11-01',
        bank_name: 'Example Bank',
        amount: 25000,
        member_id: 'm1',
        description: 'Wasiu Adebowale deposit',
        cheque_number: 'TXN-101',
        status: 'Approved'
    };
    const withSavedMatch = detectAgainstSavedRemittances(statementRows, {
        bankName: 'Example Bank',
        existingRemittances: [savedRemittance]
    });
    assert.deepEqual(withSavedMatch.map(row => row.duplicateStatus), ['Confirmed Duplicate', 'Confirmed Duplicate']);
    assert.deepEqual(withSavedMatch.map(row => row.matchedExistingId), ['saved-1', 'saved-1']);
});

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
    assert.equal(parseDate('02-MAR- 26'), '2026-03-02');
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

test('PDF reconstruction keeps amount columns aligned and joins wrapped narration to its transaction', () => {
    const item = (str, x, y, width = 50) => ({ str, transform: [1, 0, 0, 1, x, y], width });
    const pdfItems = [
        item('Txn Date', 50, 800, 30),
        item('Narration', 140, 800, 100),
        item('Reference', 380, 800, 60),
        item('Debit', 500, 800, 40),
        item('Credit', 600, 800, 45),
        item('Balance', 710, 800, 55),
        item('2026-10-01', 50, 780, 65),
        item('Transfer from Wasiu Adebowale', 140, 780, 200),
        item('REF-1001', 380, 780, 55),
        item('50,000.00', 600, 780, 65),
        item('150,000.00', 710, 780, 70),
        item('Monthly savings contribution', 140, 765, 210),
        item('2026-10-02', 50, 745, 65),
        item('SMS alert fee', 140, 745, 100),
        item('CHG-9921', 380, 745, 55),
        item('10.75', 500, 745, 45),
        item('149,989.25', 710, 745, 70)
    ];

    const { rows } = reconstructPdfRows(pdfItems);
    assert.deepEqual(rows[1], ['2026-10-01', 'Transfer from Wasiu Adebowale', 'REF-1001', '', '50,000.00', '150,000.00']);
    assert.deepEqual(rows[2], ['', 'Monthly savings contribution', '', '', '', '']);

    const extracted = extractFromRawRows(rows, { joinContinuationRows: true });
    assert.equal(extracted.length, 2);
    assert.equal(extracted[0].amount, 50000);
    assert.equal(extracted[0].reference, 'REF-1001');
    assert.equal(extracted[0].description, 'Transfer from Wasiu Adebowale Monthly savings contribution');
    assert.equal(extracted[1].amount, -10.75);
    assert.equal(extracted[1].description, 'SMS alert fee');
});

test('PDF horizontal and vertical grid rules group multi-baseline bank rows into one transaction', () => {
    const item = (str, x, y, width = 40) => ({ str, transform: [1, 0, 0, 1, x, y], width });
    const items = [
        item('EntryDate', 30, 622, 43),
        item('Details', 211, 622, 33),
        item('ValueDate', 378, 622, 48),
        item('Debit', 437, 622, 34),
        item('Credit', 491, 622, 38),
        item('Balance', 542, 622, 45),
        item('ELECTRONIC TRANSFER LEVY FOR', 74, 598, 250),
        item('02-JAN-', 378, 598, 48),
        item('02-JAN-26', 30, 594, 43),
        item('50.00', 437, 594, 34),
        item('0.00', 491, 594, 30),
        item('242,717.22', 542, 594, 55),
        item('TAX ON 30-DEC-2025', 74, 588, 170),
        item('26', 378, 588, 15),
        item('FINAL FRAGMENT', 74, 580, 95)
    ];
    const horizontalRules = [632, 620, 608, 585];
    const verticalRules = [28, 73, 378, 420, 476, 532, 584];
    const { rows } = reconstructPdfRows(items, null, horizontalRules, verticalRules);
    const headerIndex = rows.findIndex(row => row[0] === 'EntryDate');
    assert.ok(headerIndex >= 0);

    const extracted = extractFromRawRows(mergePdfContinuationRows(rows));
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].date, '2026-01-02');
    assert.equal(extracted[0].description, 'ELECTRONIC TRANSFER LEVY FOR TAX ON 30-DEC-2025 FINAL FRAGMENT');
    assert.equal(extracted[0].debit, 50);
    assert.equal(extracted[0].credit, 0);
    assert.equal(extracted[0].balance, 242717.22);
});

test('PDF logical-row assembly preserves two-, three-, and five-line descriptions and delayed amounts', () => {
    const headers = ['Date', 'Narration', 'Reference', 'Debit', 'Credit', 'Balance'];
    const physicalRows = [
        headers,
        ['12/05/2026', 'TRANSFER FROM JOHN DOE FOR PAYMENT OF', 'REF-2LINE', '', '50,000.00', '150,000.00'],
        ['', 'GOODS SUPPLIED TO THE COOPERATIVE', '', '', '', ''],
        ['', 'Page 1 of 3', '', '', '', ''],
        ['13/05/2026', 'PAYMENT FOR EQUIPMENT ORDERED BY', '', '', '', ''],
        ['', 'THE COOPERATIVE FROM ACME STORES', '', '', '', ''],
        ['', '', 'REF-3LINE', '', '25,000.00', '175,000.00'],
        ['14/05/2026', 'MEMBER CONTRIBUTION COLLECTED FOR', '', '', '', ''],
        ['', 'THE MAY SAVINGS CYCLE THROUGH', '', '', '', ''],
        ['', 'THE NORTH DISTRICT COLLECTION POINT', '', '', '', ''],
        ['', 'AND REMITTED TO THE COOPERATIVE', '', '', '', ''],
        ['', '', 'REF-5LINE', '1,000.00', '', '174,000.00']
    ];

    const logicalRows = mergePdfContinuationRows(physicalRows);
    const extracted = extractFromRawRows(logicalRows);
    assert.equal(extracted.length, 3);
    assert.deepEqual(extracted.map(row => row.description), [
        'TRANSFER FROM JOHN DOE FOR PAYMENT OF GOODS SUPPLIED TO THE COOPERATIVE',
        'PAYMENT FOR EQUIPMENT ORDERED BY THE COOPERATIVE FROM ACME STORES',
        'MEMBER CONTRIBUTION COLLECTED FOR THE MAY SAVINGS CYCLE THROUGH THE NORTH DISTRICT COLLECTION POINT AND REMITTED TO THE COOPERATIVE'
    ]);
    assert.deepEqual(extracted.map(row => row.amount), [50000, 25000, -1000]);
    assert.deepEqual(extracted.map(row => row.reference), ['REF-2LINE', 'REF-3LINE', 'REF-5LINE']);
});

test('PDF description continuation and its amount are retained across a page boundary', () => {
    const item = (str, x, y, width = 50) => ({ str, transform: [1, 0, 0, 1, x, y], width });
    const firstPage = reconstructPdfRows([
        item('Txn Date', 50, 800, 30),
        item('Narration', 140, 800, 100),
        item('Reference', 380, 800, 60),
        item('Debit', 500, 800, 40),
        item('Credit', 600, 800, 45),
        item('Balance', 710, 800, 55),
        item('15/05/2026', 50, 780, 65),
        item('TRANSFER TO THE COOPERATIVE', 140, 780, 190)
    ]);
    const secondPage = reconstructPdfRows([
        item('FOR MEMBER', 140, 800, 70),
        item('SAVINGS', 220, 800, 50),
        item('ALLOCATION', 310, 800, 60),
        item('REF-PAGE-2', 380, 800, 65),
        item('80,000.00', 600, 800, 65),
        item('230,000.00', 710, 800, 70)
    ], firstPage.layout);

    const logicalRows = mergePdfContinuationRows([...firstPage.rows, ...secondPage.rows]);
    const extracted = extractFromRawRows(logicalRows);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].description, 'TRANSFER TO THE COOPERATIVE FOR MEMBER SAVINGS ALLOCATION');
    assert.equal(extracted[0].reference, 'REF-PAGE-2');
    assert.equal(extracted[0].amount, 80000);
});

test('PDF timestamped page header is not merged into a transaction description', () => {
    const extracted = extractFromRawRows(mergePdfContinuationRows([
        ['EntryDate', 'Details', 'ValueDate', 'Debit', 'Credit', 'Balance'],
        ['02-AUG-26', 'Previous transfer', '02-AUG-26', '', '100,000.00', '200,000.00'],
        ['11/9/26, 2:34 PM', 'Example Bank Statement', '', '', '', ''],
        ['03-AUG-26', 'Branch transfer', '03-AUG-26', '1,000,000.00', '0', '27,868.02']
    ]));

    assert.equal(extracted.length, 2);
    assert.equal(extracted[0].description, 'Previous transfer');
    assert.equal(extracted[1].description, 'Branch transfer');
    assert.equal(extracted[1].date, '2026-08-03');
});

test('PDF continuation completes a partial transaction date and its wrapped description', () => {
    const extracted = extractFromRawRows(mergePdfContinuationRows([
        ['EntryDate', 'Details', 'Debit', 'Credit', 'Balance'],
        ['03-AUG-26', 'Previous service charge', '50.00', '0', '1,027,918.02'],
        ['03-AUG-', 'BRANCHTELLER:011/SOLOMON NTIEDO', '1,000,000.00', '0', '27,868.02'],
        ['26', 'EDEM/BTI182639213582347645185:FT IFO SOLOMON NTIEDO EDEM', '', '', '']
    ]));

    assert.equal(extracted.length, 2);
    assert.equal(extracted[1].date, '2026-08-03');
    assert.equal(extracted[1].amount, -1000000);
    assert.equal(extracted[1].description, 'BRANCHTELLER:011/SOLOMON NTIEDO EDEM/BTI182639213582347645185:FT IFO SOLOMON NTIEDO EDEM');
});

test('extractor retains dated transactions with Total in narration and reports skipped summary rows', () => {
    const extracted = extractFromRawRows([
        ['Date', 'Narration', 'Reference', 'Debit', 'Credit', 'Balance'],
        ['2026-11-01', 'Total transfer to vendor', 'REF-1', '0', '2500', '2500'],
        ['', 'Total', '', '', '', ''],
        ['', '', '', '', '', '']
    ]);

    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].description, 'Total transfer to vendor');
    assert.deepEqual(extracted.extractionInfo, {
        sourceRowCount: 4,
        headerRowNumber: 1,
        dataRowCount: 2,
        extractedCount: 1,
        skippedRows: [{ rowNumber: 3, reason: 'Statement summary/balance row.', description: 'Total' }]
    });
});

test('extractor excludes a dated Balance B/F row without dropping the first real transaction', () => {
    const extracted = extractFromRawRows([
        ['EntryDate', 'Details', 'Debit', 'Credit', 'Balance'],
        ['01-jan-26', 'Balance B/F........', '', '', '242,767.22'],
        ['02-jan-26', 'Electronic transfer levy', '50.00', '0.00', '242,717.22'],
        ['', 'Totals.......... End of Report', '', '3,019,366.15', '']
    ]);

    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].date, '2026-01-02');
    assert.equal(extracted[0].description, 'Electronic transfer levy');
    assert.equal(extracted[0].amount, -50);
});

test('Debits/Loans filter returns all negative transactions counted by its badge', () => {
    const transactions = [
        ...Array.from({ length: 8 }, (_, index) => ({ amount: -1000 - index, classification: 'Loan', description: 'needle' })),
        ...Array.from({ length: 148 }, (_, index) => ({ amount: -10 - index, classification: 'Expense', description: 'other' })),
        ...Array.from({ length: 148 }, (_, index) => ({ amount: 100 + index, classification: 'Remittance' }))
    ];

    const debitBadgeCount = transactions.filter(transaction => transaction.amount < 0).length;
    const visibleDebits = filterStatementTransactions(transactions, 'loan');
    assert.equal(debitBadgeCount, 156);
    assert.equal(visibleDebits.length, debitBadgeCount);
    assert.ok(visibleDebits.every(transaction => transaction.amount < 0));
    assert.equal(filterStatementTransactions(transactions, 'loan', 'needle').length, 8);
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
    assert.deepEqual(r4.matchedDescriptionRanges.map(range => 'TRANSFER FROM ADEBOWALE WASIU VIA GTWORLD'.slice(range.start, range.end)), ['ADEBOWALE WASIU']);

    // Ambiguous first name only -> returns Low/Unknown
    const r5 = matchMember('TRANSFER FROM WASIU MONTHLY', members);
    assert.equal(r5.member, null);
    assert.equal(r5.confidence, 'None');
});

test('name matching requires exact spelling on any two of first, middle, and last names', () => {
    const member = {
        id: 'm-name',
        first_name: 'Taofekat',
        middle_name: 'Abdul-wasiu',
        last_name: 'Adebowale',
        mobile: '08082291176'
    };

    const firstAndLast = matchMember('Transfer from Adebowale Taofekat', [member]);
    assert.equal(firstAndLast.member?.id, 'm-name');
    assert.equal(firstAndLast.matchType, 'name');

    const lastAndMiddle = matchMember('Deposit Adebowale Abdulwasiu', [member]);
    assert.equal(lastAndMiddle.member?.id, 'm-name');

    const firstAndMiddle = matchMember('Payment Taofekat Abdulwasiu', [member]);
    assert.equal(firstAndMiddle.member?.id, 'm-name');

    const oneTypoNameOnly = matchMember('Transfer from Taofekah Adebowale', [member]);
    assert.equal(oneTypoNameOnly.member, null);
    assert.equal(oneTypoNameOnly.confidence, 'None');

    const typoNameWithPhone = matchMember('Transfer from Taofekah Adebowale 08082291176', [member]);
    assert.equal(typoNameWithPhone.member?.id, 'm-name');
    assert.equal(typoNameWithPhone.matchType, 'phone');

    const oneNameOnly = matchMember('Transfer from Taofekat', [member]);
    assert.equal(oneNameOnly.member, null);
    assert.equal(oneNameOnly.confidence, 'None');

    // Hyphenation/case normalize consistently; the letters themselves remain exact.
    assert.equal(matchMember('PAYMENT TAOFEKAT ABDULWASIU', [member]).member?.id, 'm-name');
});

test('ambiguous two-name matches remain unmapped unless the phone fallback resolves them', () => {
    const members = [
        { id: 'm1', first_name: 'Wasiu', middle_name: 'Adebayo', last_name: 'Adebowale', mobile: '08011112222' },
        { id: 'm2', first_name: 'Wasiu', middle_name: 'Abdulwasiu', last_name: 'Adebowale', mobile: '08033334444' }
    ];

    const ambiguous = matchMember('Wasiu Adebowale', members);
    assert.equal(ambiguous.member, null);
    assert.equal(ambiguous.confidence, 'Low');

    const resolvedByPhone = matchMember('Wasiu Adebowale 08033334444', members);
    assert.equal(resolvedByPhone.member?.id, 'm2');
    assert.equal(resolvedByPhone.matchType, 'phone');
});

test('description name match takes precedence over a different member phone in the same description', () => {
    const members = [
        { id: 'm-name', first_name: 'Taofekat', middle_name: 'Abdul-wasiu', last_name: 'Adebowale' },
        { id: 'm-phone', first_name: 'Other', last_name: 'Member', mobile: '08082291176' }
    ];
    const result = classifyTransaction({
        amount: 25000,
        description: 'Taofekat Abdulwasiu transfer 08082291176',
        reference: 'REF123'
    }, { members });

    assert.equal(result.classification, 'Remittance');
    assert.equal(result.memberId, 'm-name');
});

test('classification ignores payer and reference for automatic member matching', () => {
    const members = [{ id: 'm1', first_name: 'Wasiu', last_name: 'Adebowale', mobile: '08082291176' }];
    const result = classifyTransaction({
        amount: 25000,
        description: 'NIP transfer deposit',
        payer: 'Wasiu Adebowale',
        reference: '08082291176'
    }, { members });

    assert.equal(result.classification, 'Unknown');
    assert.equal(result.memberId, '0000000000');
});

test('initial classification maps members by names only; mobile or IDs alone stay Unknown', () => {
    const members = [{
        id: 'm1',
        first_name: 'Taofekat',
        middle_name: 'Abdul-wasiu',
        last_name: 'Adebowale',
        mobile: '08082291176',
        special_id: 'SP-123',
        registration_no: 'REG-123'
    }];

    for (const description of [
        'NIP transfer 08082291176',
        'Taofekah Adebowale 08082291176',
        'Payment SP-123',
        'Transfer REG-123'
    ]) {
        const result = classifyTransaction({ amount: 25000, description }, { members });
        assert.equal(result.classification, 'Unknown', description);
        assert.equal(result.memberId, '0000000000', description);
    }

    const exactNames = classifyTransaction({
        amount: 25000,
        description: 'Taofekat Adebowale'
    }, { members });
    assert.equal(exactNames.classification, 'Remittance');
    assert.equal(exactNames.memberId, 'm1');
});

test('phone fallback permits at most a 10% digit difference and requires at least nine digits', () => {
    const members = [{ id: 'm-phone', first_name: 'Phone', last_name: 'Member', mobile: '08082291176' }];

    const oneWrongDigit = matchMember('NIP transfer to 08082291170', members);
    assert.equal(oneWrongDigit.member?.id, 'm-phone');
    assert.equal(oneWrongDigit.matchType, 'phone');

    const tooFewDigits = matchMember('Transfer reference 2291176', members);
    assert.equal(tooFewDigits.member, null);
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

test('debits below 100 are expenses even when their description matches a member', () => {
    const members = [
        { id: 'm1', first_name: 'Taofekat', middle_name: 'Abdul-wasiu', last_name: 'Adebowale', mobile: '08082291176' }
    ];

    const smallDebit = classifyTransaction({
        amount: -99.99,
        description: 'Taofekah Abdulwasiu 08082291176'
    }, { members, loanEnterprises: [{ id: 'loan-1', account_type: 'loan' }] });
    assert.equal(smallDebit.classification, 'Expense');
    assert.equal(smallDebit.memberId, '0000000000');
    assert.equal(smallDebit.transactionType, 'Financial & Banking Expenses');
    assert.equal(smallDebit.category, 'Finance Expense');

    const boundaryDebit = classifyTransaction({
        amount: -100,
        description: 'Taofekat Abdulwasiu'
    }, { members, loanEnterprises: [{ id: 'loan-1', account_type: 'loan' }] });
    assert.equal(boundaryDebit.classification, 'Loan');
    assert.equal(boundaryDebit.memberId, 'm1');
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
