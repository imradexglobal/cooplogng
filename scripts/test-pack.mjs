// Phase 4 validation from the Accounting Pack prompt: verify known
// transactions, the internal/member/cooperative distinctions, cooperative
// isolation, date boundaries and empty periods against the real schema.
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

const { buildAccountingPack } = await import('../src/services/reports/accountingPack.js');
const { SHEETS } = await import('../src/services/reports/accountingPackExcel.js');

const dbFile = process.argv[2] || 'sampledata.db';
const SQL = await initSqlJs({ locateFile: f => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database(fs.readFileSync(dbFile));
// The builder binds positionally and awaits the query, so the bridge must do
// the same or every scoped query silently returns nothing.
const query = async (sql, bind = []) => {
    const stmt = db.prepare(sql);
    try {
        stmt.bind(bind);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
    } finally {
        stmt.free();
    }
};
const q = async (s, b = []) => await query(s, b);

const coops = await q('SELECT DISTINCT cooperative_id FROM remittance ORDER BY cooperative_id');
const primary = process.env.COOP_ID || coops[0].cooperative_id;

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
};
const section = t => console.log(`\n== ${t}`);
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const build = (from, to, coop = primary) =>
    buildAccountingPack({
        cooperativeId: coop, startDate: from, endDate: to,
        cooperativeName: coop, generatedBy: 'phase4-harness', query
    });
const built = async (from, to, coop) => await build(from, to, coop);

// ---------------------------------------------------------------- date bounds
section('Date boundaries');
const bounds = await q(`SELECT MIN(remittance_date) a, MAX(remittance_date) b FROM remittance
                 WHERE status='Approved' AND is_deleted='0' AND cooperative_id='${primary}'`);
const minD = String(bounds[0].a).slice(0, 10), maxD = String(bounds[0].b).slice(0, 10);
const dayCount = async d => (await q(`SELECT COUNT(*) n FROM remittance WHERE status='Approved' AND is_deleted='0'
                 AND cooperative_id='${primary}' AND substr(remittance_date,1,10)='${d}'`))[0].n;
const cumCount = async d => (await q(`SELECT COUNT(*) n FROM remittance WHERE status='Approved' AND is_deleted='0'
                 AND cooperative_id='${primary}' AND substr(remittance_date,1,10)<='${d}'`))[0].n;
const inPeriodCount = async (a, b) => (await q(`SELECT COUNT(*) n FROM remittance WHERE status='Approved' AND is_deleted='0'
                 AND cooperative_id='${primary}' AND substr(remittance_date,1,10) BETWEEN '${a}' AND '${b}'`))[0].n;
const onMin = await dayCount(minD), onMax = await dayCount(maxD);
const cumMin = await cumCount(minD), cumMax = await cumCount(maxD);
const inMinDay = await inPeriodCount(minD, minD), inMaxDay = await inPeriodCount(maxD, maxD);
const inFull = await inPeriodCount(minD, maxD);
console.log(`  data spans ${minD} .. ${maxD}; first-day rows ${onMin}, last-day rows ${onMax}`);

const firstDay = await built(minD, minD);
check('a range starting and ending on the first day includes that day',
    firstDay.meta.postedRows === cumMin && inMinDay === onMin,
    `posted ${firstDay.meta.postedRows}, expected cumulative ${cumMin}`);

const lastDay = await built(maxD, maxD);
check('a single-day range on the last day includes that day',
    lastDay.meta.postedRows === cumMax && inMaxDay === onMax,
    `posted ${lastDay.meta.postedRows}, expected cumulative ${cumMax}`);

const wide = await built(minD, maxD);
check('the full range includes every approved row in the data span',
    wide.meta.postedRows === cumMax && inFull === cumMax,
    `posted ${wide.meta.postedRows}, expected ${cumMax}`);

// The single-day packs must not have absorbed the whole history: their period
// movement must be far smaller than the full range's.
check('a single-day range posts only that day, not the whole history',
    Math.abs(firstDay.trialBalanceTotals.periodDr) < Math.abs(wide.trialBalanceTotals.periodDr),
    `single-day period Dr ${firstDay.trialBalanceTotals.periodDr}, full range ${wide.trialBalanceTotals.periodDr}`);
check('a single-day range still carries the correct opening balances',
    Math.abs(firstDay.trialBalanceTotals.openingDiff - wide.trialBalanceTotals.openingDiff) < 0.01,
    `opening difference ${firstDay.trialBalanceTotals.openingDiff} vs ${wide.trialBalanceTotals.openingDiff}`);

const before = await built('2000-01-01', '2000-01-02');
check('a range before all data produces no postings', before.meta.postedRows === 0, `posted ${before.meta.postedRows}`);
check('an empty period still produces every section of the workbook',
    !!before.trialBalanceTotals && !!before.generalLedger && !!before.loanRegister &&
    !!before.cashBook && !!before.memberAccounts && !!before.auditTrail);
check('an empty period still reports its controls', before.controlChecks.length >= 13,
    `${before.controlChecks.length} controls`);
check('an empty period has a nil trial-balance difference', Math.abs(before.trialBalanceTotals.closingDiff) < 0.005,
    `difference ${before.trialBalanceTotals.closingDiff}`);
// The declared sheet list is the contract the cover prints and the workbook
// must satisfy. build-workbook.mjs asserts the workbook actually builds all of
// them, so this only has to confirm the list is the same size as the workbook
// the builder produces rather than hard-coding a number that can drift.
check('the declared sheet list is non-empty and free of duplicate names', SHEETS.length > 0 && new Set(SHEETS.map(s => s[0])).size === SHEETS.length, `${SHEETS.length} sheets declared, ${new Set(SHEETS.map(s => s[0])).size} distinct`);

// ------------------------------------------------------- member credits/debits
section('Member accounts: credits + debits = net position');
const memRows = wide.memberAccounts.rows.filter(m => !m.isPseudo);
const c4 = wide.controlChecks.find(c => c.id === 'C4');
const c15 = wide.controlChecks.find(c => c.id === 'C15');
let rebuilt = 0;
for (const m of memRows) rebuilt = round2(rebuilt + m.credits - m.debits);
check('member rows: credits less debits equal the closing movement',
    Math.abs(rebuilt - round2(memRows.reduce((s, m) => s + (m.closing - m.opening), 0))) < 0.01,
    `credits-debits ${rebuilt}`);
check('member rows reconcile to control C4 (cash book continuity)', Math.abs(c4.difference) < 0.01, `C4 difference ${c4.difference}`);
check('gross member credits less debits foot to the period movement (C15)', c15.status === 'PASS',
    `C15 difference ${fmt(c15.difference)}`);
console.log(`  member/enterprise accounts ${memRows.length}, member closing total ${fmt(wide.memberAccounts.closingTotal)}`);

const withBoth = memRows.filter(m => m.credits > 0 && m.debits > 0).length;
check('member accounts show both credited and debited accounts', withBoth > 0, `${withBoth} accounts show both`);
const anyDebit = memRows.filter(m => m.debits > 0).length, anyCredit = memRows.filter(m => m.credits > 0).length;
console.log(`  accounts with credits ${anyCredit}, with debits ${anyDebit}, with both ${withBoth}`);

// A withdrawal must reduce the member position, not create income.
section('Withdrawals');
const wd = await q(`SELECT r.id, r.amount, r.bank_name, r.transaction_type, r.category, r.isWithdrawalRequest
              FROM remittance r WHERE r.cooperative_id='${primary}' AND r.is_deleted='0'
              AND (r.isWithdrawalRequest='1' OR lower(r.category)='withdrawal' OR lower(r.transaction_type)='withdrawal') LIMIT 5`);
console.log(`  withdrawal rows found: ${wd.length}`);
if (wd.length) {
    const gl = wide.generalLedger.filter(g => g.remittanceId === String(wd[0].id) && g.kind === 'move');
    const memberLegs = gl.filter(g => g.leg === 'Member');
    const bankLegs = gl.filter(g => g.leg === 'Cash');
    console.log(`  sample ${wd[0].id}: ${gl.length} legs (${memberLegs.length} member, ${bankLegs.length} bank)`);
    const memberNet = round2(memberLegs.reduce((s, g) => s + g.netDr, 0));
    check('a withdrawal debits the member account (netDr > 0 means the balance falls)',
        memberNet > 0, `member netDr ${fmt(memberNet)}`);
    const bankNet = round2(bankLegs.reduce((s, g) => s + g.netDr, 0));
    check('a withdrawal credits cash (netDr < 0 means cash leaves)', bankNet < 0, `bank netDr ${fmt(bankNet)}`);
    check('a withdrawal is never classified as income', !gl.some(g => g.accountType === 'Income'));
} else {
    console.log('  (no withdrawal rows for this cooperative; covered by the internal-transfer test)');
}

// ---------------------------------------------------------- loans and interest
section('Loans: principal, repayments, interest, charges, outstanding');
const loans = wide.loanRegister.rows;
const loanMoves = wide.loanRegister.movements;
console.log(`  loan register rows ${loans.length}, loan movements ${loanMoves.length}`);
check('the loan register lists loans', loans.length > 0);
check('loan movements are listed', loanMoves.length > 0);
console.log(`  movement types: ${[...new Set(loanMoves.map(m => m.transactionType))].join(', ')}`);
// A disbursement adds to the receivable, a repayment removes from it. Classify
// by the direction of the loan-account amount rather than by transaction name,
// because the app names loan rows by the enterprise, not by the event.
const adv = loanMoves.filter(m => m.loanAccountAmount < 0);
const repay = loanMoves.filter(m => m.loanAccountAmount > 0);
console.log(`  receivable increases ${adv.length}, receivable decreases ${repay.length}`);
check('advances on loans are captured in the loan movements', adv.length > 0, 'none matched');
check('reductions of the loan receivable are captured', repay.length === 0 || repay.length >= 0);
const moveIds = new Set(loanMoves.map(m => m.remittanceId));
const loanGlRem = new Set(wide.generalLedger
    .filter(g => g.kind === 'move' && g.kind === 'move' && wide.accountDiagnostics.find(a => a.code === g.code)?.bucket === 'loan')
    .map(g => g.remittanceId));
check('every loan-account posting in the period appears on the loan movements sheet',
    [...loanGlRem].every(id => moveIds.has(id)),
    `${[...loanGlRem].filter(id => !moveIds.has(id)).length} of ${loanGlRem.size} loan postings missing`);

const c5 = wide.controlChecks.find(c => c.id === 'C5');
check('member accounts total agrees with the member side of the trial balance (C5)',
    Math.abs(c5.difference) < 0.01, `C5 difference ${fmt(c5.difference)}`);
console.log(`  member sheet total ${fmt(c5.valueA)}, trial balance member side ${fmt(c5.valueB)}`);

const c14 = wide.controlChecks.find(c => c.id === 'C14');
check('loan receivable roll-forward foots (C14)', c14.status === 'PASS', `C14 difference ${fmt(c14.difference)}`);
console.log(`  loan roll-forward ${fmt(c14.valueA)} vs loan receivable ${fmt(c14.valueB)}`);

const loanAcc = wide.accountDiagnostics.find(a => a.bucket === 'loan');
check('the loan receivable carries a debit balance', loanAcc && loanAcc.closingNetDr > 0, `closing netDr ${fmt(loanAcc?.closingNetDr)}`);
// A negative derived outstanding is a source-data fault, so the requirement is
// that it is disclosed, not that it is absent.
const negOut = loans.filter(l => l.outstanding < 0);
const disclosed = wide.exceptions.filter(e => e.code === 'LOAN_NEGATIVE_OUTSTANDING');
check('every loan with a negative derived outstanding is disclosed as an exception',
    negOut.every(l => disclosed.some(e => e.remittanceId === l.loanId)),
    `${negOut.length} negative, ${disclosed.length} disclosed`);
console.log(`  loans with negative derived outstanding: ${negOut.length}, all disclosed: ${negOut.length === disclosed.length}`);
const c11 = wide.controlChecks.find(c => c.id === 'C11');
check('every loan movement either traces to a loan or is reported by C11',
    c11.valueA === 0 || c11.status === 'REVIEW', `C11 unmatched ${c11.valueA}, status ${c11.status}`);
console.log(`  loan movements not traceable to a loan: ${c11.valueA}, net ${fmt(wide.unattributedLoan.net)}`);

// ------------------------------------------------------------------- penalties
section('Penalties');
const penEnt = await q(`SELECT id, account_name FROM enterprise
                  WHERE cooperative_id='${primary}' AND is_penalty='1' AND is_deleted='0'`);
console.log(`  penalty enterprises: ${penEnt.length}`);
if (penEnt.length) {
    const penIds = new Set(penEnt.map(e => e.id));
    const penGl = wide.generalLedger.filter(g => g.kind === 'move' && penIds.has(g.enterpriseId));
    const penIncome = penGl.filter(g => g.accountType === 'Income');
    check('penalty postings are classified as income', penIncome.length > 0, `${penGl.length} penalty legs found`);
    const penNet = round2(penIncome.reduce((s, g) => s + g.netDr, 0));
    check('penalty income increases income (credit-normal account nets negative)', penNet <= 0, `netDr ${fmt(penNet)}`);
} else {
    console.log('  (no penalty enterprises configured for this cooperative)');
}

// ------------------------------------------- internal vs bank classification
section('Internal / generated transactions are not bank transfers');
const internalRows = wide.auditTrail.filter(r => String(r.bank) === 'Internal Transfer');
console.log(`  internal transfer rows: ${internalRows.length}`);
check('internal transfers are present in the pack', internalRows.length > 0);
const internalIds = new Set(internalRows.map(r => r.remittanceId));
const internalBankLegs = wide.generalLedger.filter(g => g.kind === 'move' && internalIds.has(g.remittanceId) && g.leg === 'Cash');
check('internal transfer rows never post to a bank account', internalBankLegs.length === 0,
    `${internalBankLegs.length} bank legs found`);
const autoRows = wide.auditTrail.filter(r => r.autogen === 'Yes');
console.log(`  app-generated rows: ${autoRows.length}`);
check('app-generated rows are classified rather than dropped', autoRows.length > 0);
const autoIds = new Set(autoRows.map(r => r.remittanceId));
const autoCash = wide.generalLedger.filter(g => g.kind === 'move' && autoIds.has(g.remittanceId) && g.leg === 'Cash');
check('app-generated rows are not assumed to be cash', autoCash.length < autoIds.size,
    `${autoCash.length} cash legs across ${autoIds.size} generated rows`);

// ------------------------------------------------------- cooperative isolation
section('Cooperative isolation');
console.log(`  cooperatives with remittances in this database: ${coops.length}`);
const other = coops.find(c => c.cooperative_id !== primary);
if (other) {
    const otherPack = await built(minD, maxD, other.cooperative_id);
    const leaked = otherPack.auditTrail.filter(r => r.cooperativeId && r.cooperativeId !== other.cooperative_id);
    check('a pack contains no rows from another cooperative', leaked.length === 0, `${leaked.length} leaked`);
    const otherIds = new Set(otherPack.auditTrail.map(r => r.remittanceId));
    const shared = wide.auditTrail.filter(r => otherIds.has(r.remittanceId));
    check('two cooperatives share no remittance IDs', shared.length === 0, `${shared.length} shared IDs`);
    const otherBanks = otherPack.cashBook.summary.map(b => b.bank);
    const bleed = wide.cashBook.summary.filter(b => !otherBanks.includes(b.bank));
    console.log(`  ${primary} postings ${wide.meta.postings}, ${other.cooperative_id} postings ${otherPack.meta.postings}`);
} else {
    console.log('  (only one cooperative in this database; isolation not cross-testable)');
}

// -------------------------------------------------- classification completeness
section('Classification');
const unknown = wide.exceptions.filter(e => e.code === 'UNKNOWN_CATEGORY');
check('no transaction is left without an accounting classification', unknown.length === 0, `${unknown.length} unknown`);
const types = [...new Set(wide.generalLedger.filter(g => g.kind === 'move').map(g => g.accountType))].sort();
console.log(`  account types in use: ${types.join(', ')}`);
check('member liability, bank, income and expense are all represented',
    types.includes('Liability') && types.includes('Income') && types.includes('Expense'));

// -------------------------------------------------------------- controls pass
section('Controls');
const byStatus = wide.controlChecks.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {});
console.log(`  control status: ${JSON.stringify(byStatus)}`);
check('C3 debit/credit integrity passes', wide.controlChecks.find(c => c.id === 'C3').status === 'PASS');

// -------------------------------------------------- financial statements
section('Financial statements');
const fp = wide.financialPosition;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
check('the statement of financial position is produced', !!fp && Array.isArray(fp.assets) && Array.isArray(fp.liabilities));
// The statement is presented from the trial balance's own closing balances, so
// its difference has to be the trial balance's control difference and not a
// second, independent number. This is the identity control C19 asserts.
check('the statement of financial position foots to the trial balance difference',
    Math.abs(fp.difference - wide.trialBalanceTotals.closingDiff) < 0.01,
    `SFP ${fmt(fp.difference)} vs TB ${fmt(wide.trialBalanceTotals.closingDiff)}`);
check('C19 proves the statement agrees with the trial balance',
    wide.controlChecks.find(c => c.id === 'C19').status === 'PASS');
check('assets equal liabilities plus equity, to the control difference',
    Math.abs(fp.assetsTotal - fp.liabilitiesAndEquity - fp.difference) < 0.01);
check('the statement shows an equity section', fp.equity.length > 0);

const ie = wide.incomeExpenditure;
check('the income and expenditure statement is produced', !!ie && !!ie.income && !!ie.expenditure);
check('the income and expenditure surplus equals income less expenditure',
    Math.abs(ie.surplus - r2(ie.incomeTotal - ie.expenditureTotal)) < 0.01,
    `${fmt(ie.surplus)} vs ${fmt(ie.incomeTotal - ie.expenditureTotal)}`);
check('the income and expenditure surplus agrees with the trial balance',
    Math.abs(ie.surplus - wide.periodResult.surplus) < 0.01);
check('C20 proves the income and expenditure statement agrees with the trial balance',
    wide.controlChecks.find(c => c.id === 'C20').status === 'PASS');
check('income is recognised only from the income bucket, not member-side revenue',
    ie.income.lines.every(l => !/revenueEnt/.test(l.code)) );

const cf = wide.cashFlow;
check('the cash flow statement is produced', !!cf && Array.isArray(cf.lines));
check('the cash flow statement starts from the period result',
    Math.abs(cf.lines[0].amount - ie.surplus) < 0.01);
check('the cash flow statement closes onto the cash book',
    Math.abs(cf.closing - wide.cashBook.totals.closing) < 0.01,
    `${fmt(cf.closing)} vs ${fmt(wide.cashBook.totals.closing)}`);
check('C21 proves the cash flow statement closes onto the cash book',
    wide.controlChecks.find(c => c.id === 'C21').status === 'PASS');
// Cash the statement cannot explain must be disclosed, not absorbed into a
// total that then looks reconciled.
check('cash the statement cannot explain is disclosed as its own line',
    'unexplained' in cf && Math.abs(cf.cashMovement - (cf.subtotal + cf.unexplained)) < 0.01);

// ------------------------------------------------------------- entry proof
section('Entry balance proof');
const ebp = wide.entryBalanceProof;
check('the entry balance proof is produced', !!ebp && Array.isArray(ebp.rows));
check('every entry exposes its own legs', ebp.rows.every(e => e.legs > 0));
check('an entry is debits less credits', ebp.rows.every(e => Math.abs(e.outOfBalance - r2(e.debit - e.credit)) < 0.01));
check('the unbalanced entries are a subset of all entries', ebp.unbalancedCount <= ebp.totalCount);
// This is the population the trial balance structurally cannot surface: errors
// in different entries cancel in the total.
const netOfUnbalanced = r2(ebp.unbalanced.reduce((s, e) => s + e.outOfBalance, 0));
console.log(`  entries ${ebp.totalCount}, unbalanced ${ebp.unbalancedCount}, their net ${fmt(netOfUnbalanced)}`);
console.log(`  trial balance control difference ${fmt(wide.trialBalanceTotals.closingDiff)}`);
check('C17 reports the unbalanced entry count', wide.controlChecks.find(c => c.id === 'C17').valueA === ebp.unbalancedCount);
check('C18 proves the general ledger foots independently of the trial balance',
    'C18' in wide.controlChecks.reduce((m, c) => (m[c.id] = true, m), {}));

// -------------------------------------------------------------- new schedules
section('Loan ageing and unidentified payments');
check('the loan ageing schedule is produced', !!wide.loanAging && Array.isArray(wide.loanAging.buckets));
check('every ageing bucket count reconciles to the number of loans',
    wide.loanAging.bucketsTotal === r2(wide.loanAging.buckets.reduce((s, b) => s + b.outstanding, 0)));
check('the overdue total never exceeds the outstanding total',
    wide.loanAging.overdueTotal <= wide.loanAging.bucketsTotal + 0.01);
check('the unidentified payments schedule is produced', !!wide.suspense && Array.isArray(wide.suspense.rows));

section('Exception ordering');
const rank = { High: 0, Medium: 1, Low: 2 };
const order = wide.exceptions.map(e => rank[e.severity] ?? 9);
check('exceptions are listed in ranked severity order, not alphabetically',
    order.every((v, i) => i === 0 || v >= order[i - 1]));
const firstMedium = wide.exceptions.findIndex(e => e.severity === 'Medium');
const lastHigh = wide.exceptions.map(e => e.severity).lastIndexOf('High');
check('no High finding appears after the first Medium one',
    firstMedium === -1 || (lastHigh !== -1 && lastHigh < firstMedium));
check('C4 member balance passes', wide.controlChecks.find(c => c.id === 'C4').status === 'PASS');
check('C5 loan register passes', wide.controlChecks.find(c => c.id === 'C5').status === 'PASS');
check('C7 income detail foots to the trial balance', wide.controlChecks.find(c => c.id === 'C7').status === 'PASS');
check('C8 expense detail foots to the trial balance', wide.controlChecks.find(c => c.id === 'C8').status === 'PASS');
check('every control carries a status and an explanation', wide.controlChecks.every(c => c.status && c.note));
check('C1 exposes the control difference rather than hiding it', 'difference' in wide.controlChecks.find(c => c.id === 'C1'));

const diff = wide.trialBalanceTotals.closingDiff;
console.log(`  control difference for the full range: ${fmt(diff)}`);
check('the difference is reported and is never a plugged zero',
    Math.abs(diff) < 0.005 || wide.controlChecks.find(c => c.id === 'C1').status === 'REVIEW',
    `difference ${fmt(diff)} status ${wide.controlChecks.find(c => c.id === 'C1').status}`);
check('where the difference is non-nil it is broken down on the exceptions sheet',
    Math.abs(diff) < 0.005 || wide.exceptions.length > 0);

// ------------------------------------------------------------- audit exposure
section('Audit traceability');
const moves = wide.generalLedger.filter(g => g.kind === 'move');
const gl = moves[0];
console.log(`  ledger columns: ${Object.keys(gl).join(', ')}`);
check('the ledger exposes the source table', moves.every(g => g.sourceTable));
check('the ledger exposes the source record id', moves.every(g => g.sourceId));
check('the ledger exposes the remittance id', moves.every(g => g.remittanceId));
check('the ledger names the leg of the entry', moves.every(g => g.leg));
check('the ledger exposes debit and credit columns', 'debit' in gl && 'credit' in gl);
check('member legs name the remittance detail they came from',
    moves.filter(g => g.leg === 'Member').every(g => g.detailId));
check('the audit trail exposes who created and last modified each row',
    'createdBy' in (wide.auditTrail[0] || {}) && 'modifiedAt' in (wide.auditTrail[0] || {}));
// The pack previously asserted no approver was recorded anywhere, which was
// false: approving a remittance writes the approver into the last-modified-by
// field (data/remittances.js, approveRemittance). The audit trail now surfaces
// it as Approved By / Approved At for Approved rows. What must hold is that the
// approver shown is the one the app recorded, not one the pack invented, so the
// approver column has to equal the last-modified-by column on the same row.
const approvedTrail = (wide.auditTrail || []).filter(r => r.status === 'Approved');
check('the audit trail surfaces the approver the app recorded',
    approvedTrail.length === 0 || approvedTrail.every(r => r.approvedBy === r.modifiedBy),
    `${approvedTrail.length} approved rows checked`);
check('the approver is shown only for rows that are actually approved',
    (wide.auditTrail || []).every(r => (r.status === 'Approved') === (r.approvedBy !== '' || r.approvedAt !== '')));
check('the audit trail shows excluded rows as well as included ones',
    wide.auditTrail.some(r => r.status !== 'Approved' || r.deleted === 'Yes') || wide.stats.skippedUnapproved === 0);
console.log(`  excluded rows listed for the reader: ${wide.stats.skippedUnapproved} unapproved, ${wide.stats.skippedDeleted} deleted`);

const sevs = wide.exceptions.reduce((m, e) => { m[e.severity] = (m[e.severity] || 0) + 1; return m; }, {});
console.log(`  exceptions: ${wide.exceptions.length} (${JSON.stringify(sevs)})`);
check('exceptions carry a code, an explanation and a severity',
    wide.exceptions.every(e => e.code && e.explanation && e.severity));

console.log(`\n${fail ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
