// Generates the real Accounting Pack workbook from sampledata.db and checks it,
// so the Excel layer is verified without a browser.
import initSqlJs from 'sql.js';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { buildAccountingPack } from '../src/services/reports/accountingPack.js';
import { buildAccountingPackWorkbook } from '../src/services/reports/accountingPackExcel.js';

const dbFile = process.argv[2] || 'sampledata.db';
const start = process.argv[3] || '2000-01-01';
const end = process.argv[4] || '2099-12-31';
const out = process.argv[5] || path.join('C:\\Users\\Admin\\AppData\\Local\\Temp\\opencode', 'accounting-pack-test.xlsx');

const buf = fs.readFileSync(dbFile);
const SQL = await initSqlJs({ locateFile: f => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database(buf);
const query = async (sql, bind = []) => {
    const stmt = db.prepare(sql);
    try {
        stmt.bind(bind);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
    } finally { stmt.free(); }
};

const coop = (await query('SELECT id, full_name FROM cooperatives'))[0];
const pack = await buildAccountingPack({
    cooperativeId: coop.id, startDate: start, endDate: end,
    cooperativeName: coop.full_name, generatedBy: 'workbook-harness', query
});

const wb = await buildAccountingPackWorkbook(pack);
const buffer = await wb.xlsx.writeBuffer();
fs.writeFileSync(out, Buffer.from(buffer));

console.log(`workbook written: ${out}  (${Math.round(Buffer.from(buffer).length / 1024)} KB)`);
console.log(`sheets: ${wb.worksheets.length}`);
let bad = 0;
for (const ws of wb.worksheets) {
    const rows = ws.rowCount;
    const cols = ws.columnCount;
    const errs = [];
    if (rows < 4) errs.push('fewer than 4 rows');
    if (cols < 1) errs.push('no columns');
    // A merged banner on row 1 is expected; check it actually carries the coop name.
    if (String(ws.getCell(1, 1).value || '').indexOf('NASFAT') === -1) errs.push('banner missing cooperative name');
    if (errs.length) { bad++; console.log(`  FAIL ${ws.name}: ${errs.join('; ')}`); }
    else console.log(`  ok   ${ws.name.padEnd(26)} rows=${String(rows).padStart(6)} cols=${String(cols).padStart(3)}`);
}

console.log(`\nsheet names in order:`);
console.log('  ' + wb.worksheets.map(w => w.name).join(' | '));

// The Cover sheet advertises the worksheet list, so the workbook must contain
// exactly those sheets in that order, or the cover is lying to the reader.
const cover = wb.getWorksheet('Cover & Basis');
const advertised = [];
let listing = false;
cover.eachRow(row => {
    const a = String(row.getCell(1).value || '');
    if (a === 'Worksheets in this workbook') { listing = true; return; }
    if (a === 'Basis of preparation') { listing = false; return; }
    if (!listing) return;
    if (!a) return;
    advertised.push(a);
});
const actual = wb.worksheets.map(w => w.name);
console.log(`\ncover advertises ${advertised.length}: ${advertised.join(' | ')}`);
if (advertised.length !== actual.length) console.log(`  MISMATCH: cover lists ${advertised.length}, workbook has ${actual.length}`);
else advertised.forEach((n, i) => { if (n !== actual[i]) console.log(`  MISMATCH at ${i}: cover "${n}" vs workbook "${actual[i]}"`); });
const sheetsOk = advertised.length === actual.length && advertised.every((n, i) => n === actual[i]);
console.log(`cover worksheet list matches the workbook: ${sheetsOk ? 'yes' : 'NO'}`);

// Spot-check that the control difference text reached the Control Checks sheet.
const cs = wb.getWorksheet('Control Checks');
let found = false;
cs.eachRow(row => {
    const v = String(row.getCell(8).value || '');
    if (v.indexOf('never inserted') === -1 && v.indexOf('not been written off') !== -1) found = true;
});
console.log(`\ncontrol-difference narrative present on Control Checks: ${found ? 'yes' : 'NO'}`);

// The capitalised-asset section is only expected when there are capitalised
// asset movements to report; an empty period correctly has none.
const es = wb.getWorksheet('Expense Detail');
let assetSection = false;
es.eachRow(row => {
    if (String(row.getCell(1).value || '').indexOf('Capitalised cooperative asset') === 0) assetSection = true;
});
const assetExpected = pack.coopAssetDetail.length > 0;
const assetOk = assetSection === assetExpected;
console.log(`capitalised asset section present on Expense Detail: ${assetSection ? 'yes' : 'no'} (expected ${assetExpected ? 'yes' : 'no'})${assetOk ? '' : '  MISMATCH'}`);

// ---------------------------------------------------------------------------
// Content checks. Everything above only proves the sheets exist. These compare
// the numbers actually written into the file, read back from disk, against the
// model. They exist because a table can carry a perfect header and a correct
// row count while every one of its cells is empty, which no structural check
// would ever notice.
const rbook = new ExcelJS.Workbook();
await rbook.xlsx.readFile(out);

const num = v => (typeof v === 'number' ? v : v && typeof v === 'object' && typeof v.result === 'number' ? v.result : 0);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const flat = v => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return String(v.result ?? v.text ?? v.richText?.map(t => t.text).join('') ?? '');
    return v;
};
// Rows of the table whose header is on headerRow: contiguous, stopping at the
// first genuinely empty row that writeTable left before the totals.
const tableRows = (sheetName, headerRow, cols) => {
    const ws = rbook.getWorksheet(sheetName);
    if (!ws) return { error: `missing sheet ${sheetName}` };
    const out = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const vals = Array.from({ length: cols }, (_, i) => flat(ws.getCell(r, i + 1).value));
        if (vals.every(v => v === '')) break;
        out.push(vals);
    }
    return { rows: out, ws };
};
const findHeader = (sheetName, firstHeader) => {
    const ws = rbook.getWorksheet(sheetName);
    for (let r = 1; r <= Math.min(ws.rowCount, 12); r++) {
        if (String(flat(ws.getCell(r, 1).value)) === firstHeader) return r;
    }
    return 0;
};
// Some sheets carry more than one table, and the one that used to be first is
// no longer first. The Data Quality Exceptions sheet now leads with the grouped
// summary, because a reader should see how many findings of each kind exist
// before reading any of them, so the detail table has to be found explicitly
// rather than by taking whatever header comes first.
const findHeaderCol = (sheetName, header, col = 1) => {
    const ws = rbook.getWorksheet(sheetName);
    for (let r = 1; r <= ws.rowCount; r++) {
        if (String(flat(ws.getCell(r, col).value)) === header) return r;
    }
    return 0;
};
const findHeaderAfter = (sheetName, firstHeader, startRow) => {
    const ws = rbook.getWorksheet(sheetName);
    for (let r = startRow; r <= ws.rowCount; r++) {
        if (String(flat(ws.getCell(r, 1).value)) === firstHeader) return r;
    }
    return 0;
};

const fails = [];
const expect = (label, actual, want) => {
    const a = typeof want === 'number' ? r2(actual) : actual;
    const w = typeof want === 'number' ? r2(want) : want;
    const ok = typeof w === 'number' ? Math.abs(a - w) < 0.01 : a === w;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${a}${ok ? '' : `  (expected ${w})`}`);
    if (!ok) fails.push(label);
};

console.log('\ncontent read back from the written file:');

// The model is the reference. Every expectation below is derived from it.
const glHdr = findHeader('General Ledger', 'Code');
const glT = tableRows('General Ledger', glHdr, 18);
expect('General Ledger data rows', glT.rows.length, pack.generalLedger.length);
expect('General Ledger blank rows', glT.rows.filter(r => r.every(v => v === '')).length, 0);
// Opening and closing balance rows carry a balance but no debit or credit, so
// the ledger's debit and credit columns are the period movement in gross. The
// trial balance instead records the net movement of each account on one side,
// so its period columns are smaller by design and must not be compared with the
// ledger's gross columns. What must hold is that the ledger's gross difference
// equals the trial balance's net period movement, which is the cumulative
// control difference less the opening difference.
expect('General Ledger period debits', r2(glT.rows.reduce((s, r) => s + num(r[15]), 0)), pack.generalLedger.reduce((s, x) => s + (x.debit || 0), 0));
expect('General Ledger period credits', r2(glT.rows.reduce((s, r) => s + num(r[16]), 0)), pack.generalLedger.reduce((s, x) => s + (x.credit || 0), 0));
expect('General Ledger period difference (Dr less Cr)', r2(glT.rows.reduce((s, r) => s + num(r[15]) - num(r[16]), 0)), pack.trialBalanceTotals.closingDiff - pack.trialBalanceTotals.openingDiff);

const tbHdr = findHeader('Trial Balance', 'Code');
expect('Trial Balance data rows', tableRows('Trial Balance', tbHdr, 11).rows.length, pack.trialBalance.length);

const ccHdr = findHeader('Control Checks', 'ID');
const ccT = tableRows('Control Checks', ccHdr, 8);
const ccIds = ccT.rows.map(r => String(r[0]));
expect('Control Checks rows', ccT.rows.length, pack.controlChecks.length);
expect('Control Checks ids rendered', ccIds.filter(id => /^C\d+$/.test(id)).join(','), pack.controlChecks.map(c => c.id).join(','));
expect('Control Checks every row has a result', ccT.rows.filter(r => r[6] === '').length, 0);
expect('Control Checks review/fail count', ccT.rows.filter(r => r[6] !== 'PASS').length, pack.controlChecks.filter(c => c.status !== 'PASS').length);

const cashHdr = findHeader('Cash & Bank Book', 'Code');
expect('Cash & Bank summary rows', tableRows('Cash & Bank Book', cashHdr, 7).rows.length, pack.cashBook.summary.length);

const maHdr = findHeader('Member Accounts', 'Member ID');
const maT = tableRows('Member Accounts', maHdr, 10);
expect('Member Accounts rows', maT.rows.length, pack.memberAccounts.rows.length);
expect('Member Accounts blank rows', maT.rows.filter(r => r.every(v => v === '')).length, 0);
expect('Member Accounts closing total', r2(maT.rows.reduce((s, r) => s + num(r[9]), 0)), pack.memberAccounts.closingTotal);
// Gross credits less gross debits must equal the movement in the balances, or
// the credits/debits columns are not describing the same rows as the balances.
const maCredits = maT.rows.reduce((s, r) => s + num(r[7]), 0);
const maDebits = maT.rows.reduce((s, r) => s + num(r[8]), 0);
const maMovement = pack.memberAccounts.rows.reduce((s, x) => s + ((x.closing || 0) - (x.opening || 0)), 0);
expect('Member Accounts credits less debits', r2(maCredits - maDebits), r2(maMovement));
expect('Member Accounts opening total', r2(maT.rows.reduce((s, r) => s + num(r[6]), 0)), pack.memberAccounts.rows.reduce((s, x) => s + (x.opening || 0), 0));

const lrHdr = findHeader('Loan Register', 'Loan ID');
expect('Loan Register rows', tableRows('Loan Register', lrHdr, 16).rows.length, pack.loanRegister.rows.length);

const lmHdr = findHeader('Loan Movements', 'Date');
const lmT = tableRows('Loan Movements', lmHdr, 13);
expect('Loan Movements rows', lmT.rows.length, pack.loanRegister.movements.length);
expect('Loan Movements loan account total', r2(lmT.rows.reduce((s, r) => s + num(r[8]), 0)), pack.loanRegister.movements.reduce((s, x) => s + (x.loanAccountAmount || 0), 0));

const idHdr = findHeader('Income Detail', 'Date');
expect('Income Detail rows', tableRows('Income Detail', idHdr, 11).rows.length, pack.incomeDetail.length);
expect('Income Detail effect total', r2(tableRows('Income Detail', idHdr, 11).rows.reduce((s, r) => s + num(r[9]), 0)), pack.periodResult.income);
const edHdr = findHeader('Expense Detail', 'Date');
expect('Expense Detail rows', tableRows('Expense Detail', edHdr, 11).rows.length, pack.expenseDetail.length);
expect('Expense Detail effect total', r2(tableRows('Expense Detail', edHdr, 11).rows.reduce((s, r) => s + num(r[9]), 0)), pack.periodResult.expense);

const amHdr = findHeader('Account Mapping', 'Code');
expect('Account Mapping rows', tableRows('Account Mapping', amHdr, 7).rows.length, pack.accountMapping.length);

const atHdr = findHeader('Transaction Audit Trail', 'Date');
const atT = tableRows('Transaction Audit Trail', atHdr, 28);
expect('Transaction Audit Trail rows', atT.rows.length, pack.auditTrail.length);
expect('Transaction Audit Trail blank rows', atT.rows.filter(r => r.every(v => v === '')).length, 0);
// The approver identity must actually be present on Approved rows. The pack
// used to assert no approver was recorded anywhere, which was false: approving
// a remittance writes the approver into the last-modified-by field.
const approvedRows = pack.auditTrail.filter(r => r.status === 'Approved');
expect('Audit Trail approver populated on approved rows', atT.rows.filter(r => r[3] === 'Approved' && r[21] !== '').length, approvedRows.length);

// Entry balance proof: the sheet must list every derived entry, with the
// out-of-balance ones present, because that population cannot be recovered from
// the trial balance.
const ebHdr = findHeader('Entry Balance Proof', 'Remittance ID');
const ebT = tableRows('Entry Balance Proof', ebHdr, 11);
expect('Entry Balance Proof rows', ebT.rows.length, pack.entryBalanceProof.rows.length);
expect('Entry Balance Proof blank rows', ebT.rows.filter(r => r.every(v => v === '')).length, 0);
const ebUnbalancedInFile = ebT.rows.filter(r => Math.abs(num(r[10])) >= 0.01).length;
expect('Entry Balance Proof unbalanced entries listed', ebUnbalancedInFile, pack.entryBalanceProof.unbalancedCount);
// The out-of-balance entries must come first, largest first.
const ebFirst = Math.abs(num(ebT.rows[0]?.[10]));
expect('Entry Balance Proof leads with the largest imbalance', pack.entryBalanceProof.unbalancedCount ? ebFirst : 0, pack.entryBalanceProof.unbalancedCount ? Math.abs(pack.entryBalanceProof.unbalanced[0].outOfBalance) : 0);

// The three statements must agree with the trial balance. These are the same
// identities the C19, C20 and C21 controls assert, checked here against the
// cells actually written to the file.
const cellAt = (sheet, label, col) => {
    const ws = rbook.getWorksheet(sheet);
    for (let r = 1; r <= ws.rowCount; r++) {
        if (String(flat(ws.getCell(r, 1).value)) === label) return num(ws.getCell(r, col).value);
    }
    return null;
};
const sfpAssets = cellAt('Statement of Financial Position', 'TOTAL ASSETS', 3);
const sfpLe = cellAt('Statement of Financial Position', 'TOTAL EQUITY AND LIABILITIES', 3);
const sfpDiff = cellAt('Statement of Financial Position', 'DIFFERENCE (assets less equity and liabilities)', 3);
expect('Statement of Financial Position total assets', r2(sfpAssets), pack.financialPosition.assetsTotal);
expect('Statement of Financial Position total equity and liabilities', r2(sfpLe), pack.financialPosition.liabilitiesAndEquity);
expect('Statement of Financial Position difference', r2(sfpDiff), pack.financialPosition.difference);
// The statement foots to the trial balance's own control difference, which is
// what proves it was not built by a calculation that drifted from the balances.
expect('Statement of Financial Position foots to the trial balance', r2(sfpDiff), pack.trialBalanceTotals.closingDiff);
const ieIncome = cellAt('Income & Expenditure', 'TOTAL INCOME', 3);
const ieExpense = cellAt('Income & Expenditure', 'TOTAL EXPENDITURE', 3);
expect('Income & Expenditure total income', r2(ieIncome), pack.incomeExpenditure.incomeTotal);
expect('Income & Expenditure total expenditure', r2(ieExpense), pack.incomeExpenditure.expenditureTotal);
const ieSurplus = pack.incomeExpenditure.surplus < 0
    ? cellAt('Income & Expenditure', 'NET DEFICIT FOR THE PERIOD', 3)
    : cellAt('Income & Expenditure', 'NET SURPLUS FOR THE PERIOD', 3);
expect('Income & Expenditure surplus foots to the trial balance', r2(ieSurplus), pack.periodResult.surplus);
const cfClose = cellAt('Cash Flow', 'Cash and bank balances at the end of the period', 3);
expect('Cash Flow closing cash equals the cash book', r2(cfClose), pack.cashBook.totals.closing);

const laHdr = findHeader('Loan Ageing', 'Ageing bucket');
expect('Loan Ageing rows', tableRows('Loan Ageing', laHdr, 4).rows.length, pack.loanAging.buckets.length);
const upHdr = findHeader('Unidentified Payments', 'Code');
if (pack.suspense.rows.length) {
    expect('Unidentified Payments rows', tableRows('Unidentified Payments', upHdr, 5).rows.length, pack.suspense.rows.length);
}

// The exceptions sheet leads with the grouped summary, so the detail table is
// found after it rather than by taking the first Severity header on the sheet.
const exSumHdr = findHeader('Data Quality Exceptions', 'Severity');
expect('Exception summary rows', tableRows('Data Quality Exceptions', exSumHdr, 5).rows.length, [...new Set(pack.exceptions.map(e => e.code))].length);
const exHdr = findHeaderAfter('Data Quality Exceptions', 'Severity', exSumHdr + 2);
expect('Exception detail header found after the summary', exHdr > exSumHdr ? 1 : 0, 1);
const exT = tableRows('Data Quality Exceptions', exHdr, 6);
expect('Exception rows', exT.rows.length, pack.exceptions.length);
expect('Exception rows blank', exT.rows.filter(r => r.every(v => v === '')).length, 0);
expect('Exception severities rendered', [...new Set(exT.rows.map(r => r[0]))].sort().join(','), [...new Set(pack.exceptions.map(e => e.severity))].sort().join(','));
// Severity is a ranked scale. If it is alphabetised again, a reader scanning
// top-down meets every Low finding before the first Medium one.
const rank = { High: 0, Medium: 1, Low: 2 };
const renderedOrder = exT.rows.map(r => rank[r[0]] ?? 9);
expect('Exception severities are in ranked order', renderedOrder.every((v, i) => i === 0 || v >= renderedOrder[i - 1]) ? 1 : 0, 1);

// Every cell that the model filled must be non-empty in the file. This is the
// direct regression test for a table written under a correct header with no data.
// The key arrays mirror the ones in accountingPackExcel.js.
const coverage = [
    ['General Ledger', glHdr, pack.generalLedger, ['code', 'account', 'accountType', 'leg', 'date', 'reference', 'sourceTable', 'sourceId', 'remittanceId', 'detailId', 'memberId', 'enterpriseId', 'loanId', 'description', 'member', 'debit', 'credit', 'balance']],
    ['Member Accounts', maHdr, pack.memberAccounts.rows, ['memberId', 'member', 'regNo', 'memberStatus', 'account', 'classification', 'opening', 'credits', 'debits', 'closing']],
    ['Loan Movements', lmHdr, pack.loanRegister.movements, ['date', 'remittanceId', 'transactionType', 'category', 'member', 'regNo', 'bank', 'amount', 'loanAccountAmount', 'detailCount', 'detailSum', 'loanId', 'parentId']],
    ['Transaction Audit Trail', atHdr, pack.auditTrail, ['date', 'remittanceId', 'family', 'status', 'deleted', 'transactionType', 'category', 'classification', 'memberId', 'member', 'regNo', 'memberStatus', 'bank', 'headerAmount', 'detailCount', 'detailSum', 'headerMinusDetail', 'autogen', 'parentId', 'loanId', 'description', 'approvedBy', 'approvedAt', 'cooperativeId', 'createdBy', 'createdAt', 'modifiedBy', 'modifiedAt']],
    ['Entry Balance Proof', ebHdr, pack.entryBalanceProof.rows, ['remittanceId', 'date', 'family', 'transactionType', 'category', 'member', 'bank', 'legs', 'debit', 'credit', 'outOfBalance']],
    ['Data Quality Exceptions', exHdr, pack.exceptions, ['severity', 'code', 'title', 'remittanceId', 'amount', 'explanation']],
    ['Control Checks', ccHdr, pack.controlChecks, ['id', 'name', 'description', 'valueA', 'valueB', 'difference', 'status', 'note']],
];
const filled = v => v !== undefined && v !== null && v !== '';
for (const [name, hdr, modelRows, keys] of coverage) {
    const { rows } = tableRows(name, hdr, keys.length);
    const diffs = [];
    keys.forEach((k, c) => {
        const want = modelRows.filter(x => filled(x[k])).length;
        const got = rows.filter(r => r[c] !== '').length;
        if (want !== got) diffs.push(`${k}: file ${got} vs model ${want}`);
    });
    expect(`${name} filled cells match the model`, diffs.length, 0);
    if (diffs.length) for (const d of diffs) console.log(`        ${d}`);
}

const failed = bad || !found || !assetOk || !sheetsOk || fails.length;
console.log(fails.length ? `\ncontent failures (${fails.length}): ${fails.join('; ')}` : '\nall content checks passed');
console.log(failed ? '\nWORKBOOK CHECK: FAIL' : '\nWORKBOOK CHECK: PASS');
process.exit(failed ? 1 : 0);
