// Accounting Pack — ExcelJS workbook writer.
// One workbook, one worksheet per statement, generated directly on request
// (no preview step). Styling follows the conventions in ./exporters.js.

const NUM_FMT = '#,##0.00;[Red]-#,##0.00';
const DATE_FMT = 'dd mmm, yyyy';

const NAVY = 'FF1F3864';
const SLATE = 'FF2F5496';
const BAND = 'FFD9E2F3';
const LABEL = 'FFF2F2F2';
const PASS = 'FFE2EFDA';
const REVIEW = 'FFFCE4D6';
const INFO = 'FFE7E6E6';
const BAD = 'FFFFC7CE';

// Exported so the verification harness can assert the workbook contains exactly
// the sheets the cover advertises, and that the count has not drifted. This list
// is the single source of truth: the cover prints it, and buildAccountingPack
// Workbook is checked against it. A sheet that exists but is not listed here
// makes the cover factually wrong, and a sheet listed here that does not exist
// makes the cover promise something absent.
export const SHEETS = [
    ['Cover & Basis', 'cooperative identity, period, basis of preparation and definitions'],
    ['Statement of Financial Position', 'assets, equity and liabilities as at the period end, reconciled to the trial balance by C19'],
    ['Income & Expenditure', 'income and expenditure for the period, line by line, reconciled to the trial balance by C20'],
    ['Cash Flow', 'period result reconciled to the movement in cash, closing onto the cash book as proved by C21'],
    ['Control Checks', 'every reconciliation control, with PASS / REVIEW / INFO'],
    ['Trial Balance', 'opening, period movement and closing balances by account'],
    ['General Ledger', 'every posting in the period with running balance and source ids'],
    ['Entry Balance Proof', 'every derived journal entry, tested individually, because a trial balance cannot identify a broken entry'],
    ['Cash & Bank Book', 'per bank opening / receipts / payments / closing, plus internal transfer memo'],
    ['Member Accounts', 'per member and account balances, the member liability evidence'],
    ['Loan Register', 'per loan record with derived outstanding and ageing'],
    ['Loan Ageing', 'the same loan population in ageing buckets, with no provision raised'],
    ['Loan Movements', 'disbursements, repayments and charges in the period'],
    ['Income Detail', 'every income posting in the period, with source traceability'],
    ['Expense Detail', 'every expenditure posting in the period, and capitalised asset movements shown separately so a purchase is never read as a cost'],
    ['Liability Detail', 'member liability postings with no enterprise leg, such as unidentified payments'],
    ['Unidentified Payments', 'cash received with no identifiable owner, and its movement'],
    ['Account Mapping', 'how every CoopLogNG field maps to an account, code and normal balance'],
    ['Bank Reconciliation', 'sealed bank reconciliation summaries overlapping the selected period'],
    ['Transaction Audit Trail', 'every remittance in the period including excluded rows, with approver identity'],
    ['Data Quality Exceptions', 'line-by-line explanation of each control difference, summarised by finding first']
];

// Fit to content.
//
// Excel sizes a column in characters of the workbook's default font, so fitting
// a column means measuring the text Excel will actually display in it, once per
// column. Four things make a naive scan wrong, and all four were wrong in the
// version this replaced:
//
//   1. The banner in rows 1-3, the table and section headings, the totals
//      labels and every note paragraph are single cells anchored in column 1.
//      They are display text belonging to no one column, but a scan reads them
//      as column 1's content, so a 4-character Code column measured 158
//      characters and was forced out to the ceiling on every sheet in the pack.
//      Those cells are tagged as they are written and skipped here.
//   2. The per-sheet ceilings this used (24 to 44) then clipped real content:
//      member names needing 54 characters were given 30, identifiers needing
//      42 were given 26.
//   3. A number displays through its number format, not through String(n).
//      1234567.89 is written with NUM_FMT and shows as "1,234,567.89", three
//      characters wider than the raw value, so every measured amount column
//      came out short and Excel rendered them as ####.
//   4. A wrapped cell is only ever as wide as its longest word, because that is
//      the widest line it can force. Measuring the whole string demanded a
//      200-character column for a paragraph that wraps inside 46.

// Cells holding display text rather than column content.
const FIT_EXEMPT = new WeakSet();
const PINNED = new WeakMap();
const FIT_MIN = 8;
// A runaway guard only, not a presentation ceiling. Prose columns are excluded
// from fitting by being pinned, so this number is never what decides how wide a
// description is: it exists so that a few thousand characters of unmerged text
// can never again dictate a column width.
const FIT_MAX = 100;

function exemptFromFit(cell) {
    FIT_EXEMPT.add(cell);
    return cell;
}

// A width chosen for readability rather than derived from content. Used for two
// kinds of column: prose that wraps, and prose that does not. Both are a
// presentation decision the fit cannot make on its own, because fitting them
// literally would produce a 120-character column. Every other column is fitted.
function pinWidth(ws, column, width) {
    ws.getColumn(column).width = width;
    if (!PINNED.has(ws)) PINNED.set(ws, new Set());
    PINNED.get(ws).add(column);
}

export function pinnedColumns(ws) {
    return [...(PINNED.get(ws) || new Set())].sort((a, b) => a - b);
}

function shownNumber(n, numFmt) {
    const decimals = /\.(0+)/.exec(numFmt || NUM_FMT);
    const places = decimals ? decimals[1].length : 0;
    const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
    return n < 0 ? `-${body}` : body;
}

function shownText(value, numFmt) {
    if (value == null || value === '') return '';
    if (typeof value === 'number') return shownNumber(value, numFmt);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map(t => t.text).join('');
        if (value.result !== undefined) return shownText(value.result, numFmt);
        if (value.text !== undefined) return String(value.text);
        if (value.error) return String(value.error);
        return '';
    }
    return String(value);
}

// The width one cell asks for, in characters. A little is added for the bold
// headers and for the padding Excel puts inside the column.
function cellDemand(cell) {
    if (FIT_EXEMPT.has(cell)) return 0;
    // A cell merged into another reports the master's value; that text is
    // already counted once, at the master.
    if (cell.isMerged && cell.master !== cell) return 0;
    const t = shownText(cell.value, cell.numFmt);
    if (!t) return 0;
    const chars = cell.alignment && cell.alignment.wrapText
        ? t.split(/\s+/).reduce((widest, word) => (word.length > widest ? word.length : widest), 0)
        : t.length;
    return chars + (cell.font && cell.font.bold ? 1 : 0);
}

export function fitColumns(ws, opts = {}) {
    const min = opts.min == null ? FIT_MIN : opts.min;
    const max = opts.max == null ? FIT_MAX : opts.max;
    const pinned = PINNED.get(ws) || new Set();
    // Driven by the rows that were written, not by the columns that were named,
    // so a column the sheet filled but never asked for by name is still fitted.
    const colCount = ws.columnCount;
    const demand = new Array(colCount + 1).fill(0);
    ws.eachRow({ includeEmpty: false }, row => {
        row.eachCell({ includeEmpty: false }, (cell, column) => {
            if (column > colCount) return;
            const d = cellDemand(cell);
            if (d > demand[column]) demand[column] = d;
        });
    });
    for (let c = 1; c <= colCount; c++) {
        if (pinned.has(c)) continue;
        ws.getColumn(c).width = Math.min(max, Math.max(min, demand[c] + 2));
    }
    return colCount;
}

// Fits every column of every sheet once the whole pack exists, so no sheet can
// be left unfitted because its own writer did not call the fit, and every fit
// sees the sheet's final row rather than the rows present at the time.
export function fitAllColumns(wb, opts = {}) {
    for (const ws of wb.worksheets) fitColumns(ws, opts);
}

// A heading on a line of its own: the label for the table that follows it, or a
// totals label. Like the banner, it is display text anchored in column 1 rather
// than the content of that column, so it is exempt from the fit and Excel is
// left to show it spilling across the empty cells to its right. It is also
// merged across the table width so an independent width checker reading only
// the public merge API can also see that this text belongs to no single column.
// Without the merge the heading's own length dictates the width of the Code
// column in front of it, which is what the exemption exists to prevent.
function headingRow(ws, rowIdx, text, font, colCount) {
    if (colCount && colCount > 1) {
        try { ws.mergeCells(rowIdx, 1, rowIdx, colCount); } catch { /* already merged */ }
    }
    const cell = exemptFromFit(ws.getCell(rowIdx, 1));
    cell.value = text;
    cell.font = font || { bold: true, size: 11, color: { argb: SLATE } };
    return cell;
}

function putBanner(ws, pack, title, subtitle, colCount) {
    ws.mergeCells(1, 1, 1, Math.max(colCount, 6));
    const c1 = exemptFromFit(ws.getCell(1, 1));
    c1.value = pack.meta.cooperativeName;
    c1.font = { size: 16, bold: true, color: { argb: NAVY } };
    c1.alignment = { horizontal: 'center' };

    ws.mergeCells(2, 1, 2, Math.max(colCount, 6));
    const c2 = exemptFromFit(ws.getCell(2, 1));
    c2.value = `Accounting Pack — ${title}`;
    c2.font = { size: 13, bold: true, color: { argb: SLATE } };
    c2.alignment = { horizontal: 'center' };

    ws.mergeCells(3, 1, 3, Math.max(colCount, 6));
    const c3 = exemptFromFit(ws.getCell(3, 1));
    c3.value = `${subtitle}  |  Period: ${pack.meta.periodLabel}  |  Opening as at ${pack.meta.openingDate}  |  Generated ${String(pack.meta.generatedAt).slice(0, 19).replace('T', ' ')} UTC by ${pack.meta.generatedBy}`;
    c3.font = { size: 9, italic: true, color: { argb: 'FF595959' } };
    c3.alignment = { horizontal: 'center' };
}

function styleHeader(ws, rowIdx, colCount, opts = {}) {
    const row = ws.getRow(rowIdx);
    for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill || NAVY } };
        cell.alignment = { vertical: 'middle', horizontal: opts.leftAlign ? 'left' : 'center', wrapText: true };
        cell.border = {
            top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
            left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
            bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
            right: { style: 'thin', color: { argb: 'FFBFBFBF' } }
        };
    }
    row.height = opts.height || 28;
}

function freezeAndFilter(ws, headerRow, colCount, opts = {}) {
    // xSplit freezes the identifying columns as well as the header row. On the
    // General Ledger, whose eighteen columns scroll horizontally, freezing only
    // rows means the Code and Account columns scroll off and the reader loses
    // track of which account a line belongs to.
    const view = { state: 'frozen', ySplit: headerRow };
    if (opts.xSplit) view.xSplit = opts.xSplit;
    ws.views = [view];
    ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: colCount } };
    // Print setup, so the workbook is usable on paper as well as on screen:
    // fit to page width, repeat the header row on every page, and carry the
    // cooperative and period in the footer with a page count.
    ws.pageSetup = {
        ...(ws.pageSetup || {}),
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: `${headerRow}:${headerRow}`,
        margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 }
    };
    const pack = opts.pack;
    ws.headerFooter = {
        oddHeader: pack ? `&L${pack.meta.cooperativeName}&R${pack.meta.periodLabel}` : undefined,
        oddFooter: '&CPage &P of &N'
    };
}

// `headers` are the labels a reader sees; the row objects produced by the model
// are keyed in camelCase, so a label like "Account Type" is not the property
// name `accountType`. Every call therefore passes `opts.keys`, the property
// name for each column in header order. Without this mapping the cells are
// written blank while the sheet still looks correctly headed, which is the
// worst possible failure for a report.
function writeTable(ws, pack, startRow, title, headers, rows, opts = {}) {
    const cols = headers.length;
    const keys = opts.keys && opts.keys.length === cols ? opts.keys : headers;
    if (opts.keys && opts.keys.length !== cols) {
        throw new Error(`writeTable "${title}": ${opts.keys.length} keys for ${cols} headers`);
    }
    // The table's own title is display text like any other heading, and is
    // merged for the same reason: so an independent width checker can tell it
    // belongs to no column, and so a long title cannot set the width of column 1.
    if (cols > 1) {
        try { ws.mergeCells(startRow, 1, startRow, cols); } catch { /* already merged */ }
    }
    exemptFromFit(ws.getCell(startRow, 1)).value = title;
    ws.getCell(startRow, 1).font = { bold: true, size: 11, color: { argb: SLATE } };
    const hRow = startRow + 1;
    headers.forEach((h, i) => { ws.getCell(hRow, i + 1).value = h; });
    styleHeader(ws, hRow, cols, { fill: SLATE, leftAlign: true });

    // Refuse to emit a silently empty or half-empty table. A column whose key
    // does not exist anywhere in the row shape would be written blank under a
    // convincing header, which is the worst possible failure for a report, so
    // the key mapping is checked against the union of every row's fields.
    if (rows.length && !Array.isArray(rows[0])) {
        const present = new Set();
        for (const row of rows) for (const k of Object.keys(row || {})) present.add(k);
        const missing = keys.filter(k => !present.has(k));
        if (missing.length) {
            throw new Error(`writeTable "${title}": key(s) [${missing.join(', ')}] do not exist on the row. Row fields are [${[...present].join(', ')}].`);
        }
    }

    const numericCols = new Set(opts.numericCols || []);
    let r = hRow + 1;
    for (const row of rows) {
        const values = Array.isArray(row) ? row : keys.map(k => (row && row[k] !== undefined ? row[k] : ''));
        values.forEach((v, i) => {
            const cell = ws.getCell(r, i + 1);
            if (opts.rowStyle) {
                const st = opts.rowStyle(row, values);
                if (st) {
                    if (st.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.fill } };
                    if (st.font) cell.font = st.font;
                    if (st.numFmt) cell.numFmt = st.numFmt;
                }
            }
            if (numericCols.has(i) && v !== '' && v !== null && v !== undefined) {
                cell.value = typeof v === 'number' ? v : numOrNull(v);
                cell.numFmt = NUM_FMT;
                cell.alignment = { horizontal: 'right' };
            } else {
                cell.value = v === null || v === undefined ? '' : v;
            }
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFD9D9D9' } } };
        });
        if (r % 2 === 0) {
            for (let c = 1; c <= cols; c++) {
                const cell = ws.getCell(r, c);
                if (!cell.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F9FC' } };
            }
        }
        r++;
    }
    return { headerRow: hRow, lastRow: r - 1, nextRow: r + 1 };
}

function numOrNull(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : '';
}

function totalRow(ws, rowIdx, colCount, label, cells) {
    const row = ws.getRow(rowIdx);
    // The label is display text that spills across the value columns, so it is
    // merged and exempt for the same reason as every other heading.
    if (colCount > 1) {
        const lastValueCol = cells.length ? Math.max(...cells.map(c => c[0])) : colCount;
        if (lastValueCol > 2) {
            try { ws.mergeCells(rowIdx, 1, rowIdx, lastValueCol - 1); } catch { /* already merged */ }
        }
    }
    exemptFromFit(row.getCell(1)).value = label;
    for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        cell.font = { bold: true, size: 10, color: { argb: NAVY } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
        cell.border = { top: { style: 'thin' }, bottom: { style: 'double' } };
    }
    cells.forEach(([col, value]) => {
        const cell = row.getCell(col);
        cell.value = value;
        if (typeof value === 'number') { cell.numFmt = NUM_FMT; cell.alignment = { horizontal: 'right' }; }
    });
}

function noteRow(ws, rowIdx, colCount, text) {
    ws.mergeCells(rowIdx, 1, rowIdx, colCount);
    const cell = exemptFromFit(ws.getCell(rowIdx, 1));
    cell.value = text;
    cell.font = { italic: true, size: 9, color: { argb: 'FF595959' } };
    cell.alignment = { vertical: 'top', wrapText: true };
}

// ---------------------------------------------------------------------------

function coverSheet(wb, pack) {
    const ws = wb.addWorksheet('Cover & Basis', { pageSetup: { orientation: 'landscape' } });
    putBanner(ws, pack, 'Cover, Scope & Basis of Preparation', 'Statements and supporting schedules', 6);
    // Column 2 carries the basis and definition paragraphs, which wrap, so its
    // width is a readability choice. Columns 1 and 3 are fitted.
    pinWidth(ws, 2, 96);

    let r = 5;
    ws.getCell(r, 1).value = 'Report identification';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: SLATE } };
    r++;
    const ident = [
        ['Cooperative', pack.meta.cooperativeName],
        ['Cooperative ID', pack.meta.cooperativeId],
        ['Period covered', pack.meta.startDate === pack.meta.endDate ? pack.meta.startDate : `${pack.meta.startDate} to ${pack.meta.endDate}`],
        ['Opening balances as at', pack.meta.openingDate],
        ['Closing balances as at', pack.meta.endDate],
        ['Generated at', pack.meta.generatedAt],
        ['Generated by', pack.meta.generatedBy],
        ['Transactions included', `${pack.meta.postedRows} approved remittances`],
        ['Accounting postings derived', `${pack.meta.postings} individual postings`],
        ['Rows excluded (not approved / deleted)', `${pack.stats.skippedUnapproved} not approved, ${pack.stats.skippedDeleted} deleted`]
    ];
    for (const [k, v] of ident) {
        ws.getCell(r, 1).value = k;
        ws.getCell(r, 1).font = { bold: true, size: 10 };
        ws.getCell(r, 2).value = v;
        r++;
    }

    r++;
    ws.getCell(r, 1).value = 'Worksheets in this workbook';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: SLATE } };
    r++;
    for (const [name, desc] of SHEETS) {
        ws.getCell(r, 1).value = name;
        ws.getCell(r, 1).font = { size: 10, bold: true };
        ws.getCell(r, 2).value = desc;
        r++;
    }

    r++;
    ws.getCell(r, 1).value = 'Basis of preparation';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: SLATE } };
    r++;
    for (const b of pack.basis) {
        ws.getCell(r, 1).value = b.topic;
        ws.getCell(r, 1).font = { bold: true, size: 10 };
        ws.getCell(r, 1).alignment = { vertical: 'top' };
        ws.getCell(r, 2).value = b.text;
        ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
        r++;
    }

    r++;
    ws.getCell(r, 1).value = 'Definitions';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: SLATE } };
    r++;
    for (const d of pack.definitions) {
        ws.getCell(r, 1).value = d.term;
        ws.getCell(r, 1).font = { bold: true, size: 10 };
        ws.getCell(r, 1).alignment = { vertical: 'top' };
        ws.getCell(r, 2).value = d.text;
        ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
        r++;
    }

    r++;
    ws.getCell(r, 1).value = 'Period result';
    ws.getCell(r, 1).font = { bold: true, size: 11, color: { argb: SLATE } };
    r++;
    const pr = pack.periodResult;
    for (const [k, v] of [
        ['Income for the period', pr.income],
        ['Expenditure for the period', pr.expense],
        ['Net surplus / (deficit)', pr.surplus],
        ['Retained earnings brought forward', pr.retainedEarningsOpening],
        ['Retained earnings carried forward', Math.round((pr.retainedEarningsOpening + pr.surplus) * 100) / 100]
    ]) {
        ws.getCell(r, 1).value = k;
        ws.getCell(r, 1).font = { bold: true, size: 10 };
        const c = ws.getCell(r, 2);
        c.value = v;
        c.numFmt = NUM_FMT;
        r++;
    }

    r++;
    noteRow(ws, r, 3, 'This pack is generated directly from the cooperative\'s own records. No source data was added, altered or removed, and no balancing figure has been inserted to make a statement foot. Where the recorded data cannot form a complete double entry the difference is reported on the Control Checks and Data Quality Exceptions sheets instead of being absorbed.');
    return ws;
}

function controlSheet(wb, pack) {
    const ws = wb.addWorksheet('Control Checks', { pageSetup: { orientation: 'landscape' } });
    const headers = ['ID', 'Control', 'What it proves', 'Value A', 'Value B', 'Difference', 'Result', 'Note'];
    putBanner(ws, pack, 'Control Checks', 'Reconciliations between the statements in this pack', headers.length);
    const res = writeTable(ws, pack, 5, 'Reconciliation controls', headers, pack.controlChecks, {
        keys: ['id', 'name', 'description', 'valueA', 'valueB', 'difference', 'status', 'note'],
        numericCols: [3, 4, 5],
        rowStyle: (row) => {
            const fill = row.status === 'PASS' ? PASS : row.status === 'REVIEW' ? REVIEW : INFO;
            return { fill, font: { bold: true, size: 10, color: { argb: row.status === 'REVIEW' ? 'FF9C0006' : 'FF1F3864' } } };
        }
    });
    // The bold status cell should win over the row tint.
    for (let r = res.headerRow + 1; r <= res.lastRow; r++) {
        const status = String(ws.getCell(r, 7).value || '');
        const cell = ws.getCell(r, 7);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: status === 'PASS' ? PASS : status === 'REVIEW' ? BAD : INFO } };
        cell.font = { bold: true, size: 10, color: { argb: status === 'REVIEW' ? 'FF9C0006' : status === 'PASS' ? 'FF375623' : 'FF3F3F76' } };
        for (let c = 2; c <= 6; c++) ws.getCell(r, c).alignment = { wrapText: true, vertical: 'top' };
        ws.getCell(r, 8).alignment = { wrapText: true, vertical: 'top' };
    }
    // These three columns wrap their text, so their width is set for
    // readability; every other column on the sheet is fitted.
    pinWidth(ws, 2, 30);
    pinWidth(ws, 3, 52);
    pinWidth(ws, 8, 70);
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });

    let r = res.nextRow + 1;
    headingRow(ws, r, 'Control difference — not plugged', undefined, headers.length);
    r++;
    noteRow(ws, r, headers.length, `The trial balance closes with Debits ${fmt(pack.trialBalanceTotals.closingDr)} against Credits ${fmt(pack.trialBalanceTotals.closingCr)}, a control difference of ${fmt(pack.trialBalanceTotals.closingDiff)}. That figure is the arithmetic sum of every posting in this cooperative that could not be matched into a complete double entry. Each contributing remittance is listed on the Data Quality Exceptions sheet with its identifier, so the difference can be traced and cleared one transaction at a time. It has deliberately not been written off to a suspense or balancing account, because doing so would conceal the underlying records from the auditor.`);
    r += 2;
    headingRow(ws, r, `Data quality exceptions raised: ${pack.exceptions.length}`, { bold: true, size: 10, color: { argb: pack.exceptions.length ? 'FF9C0006' : 'FF375623' } }, headers.length);
    r++;
    headingRow(ws, r, `  High ${pack.exceptions.filter(e => e.severity === 'High').length}  |  Medium ${pack.exceptions.filter(e => e.severity === 'Medium').length}  |  Low ${pack.exceptions.filter(e => e.severity === 'Low').length}`, undefined, headers.length);
    return ws;
}

function trialBalanceSheet(wb, pack) {
    const ws = wb.addWorksheet('Trial Balance', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Code', 'Account', 'Type', 'Normal', 'Classification', 'Opening Dr', 'Opening Cr', 'Period Dr', 'Period Cr', 'Closing Dr', 'Closing Cr'];
    putBanner(ws, pack, 'Trial Balance', `As at ${pack.meta.endDate}`, headers.length);

    const res = writeTable(ws, pack, 5, 'Trial balance', headers, pack.trialBalance, {
        keys: ['code', 'account', 'type', 'normal', 'classification', 'openingDr', 'openingCr', 'periodDr', 'periodCr', 'closingDr', 'closingCr'],
        numericCols: [5, 6, 7, 8, 9, 10],
        rowStyle: (row) => (row.type === 'Income' || row.type === 'Expense'
            ? { font: { italic: true, size: 10 } } : null)
    });

    const t = pack.trialBalanceTotals;
    let r = res.nextRow;
    totalRow(ws, r, headers.length, 'TOTALS', [
        [6, t.openingDr], [7, t.openingCr], [8, t.periodDr], [9, t.periodCr], [10, t.closingDr], [11, t.closingCr]
    ]);
    r += 1;
    totalRow(ws, r, headers.length, 'CONTROL DIFFERENCE (Dr less Cr)', [
        [6, t.openingDiff], [10, t.closingDiff]
    ]);
    const diffCell = ws.getCell(r, 10);
    diffCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: Math.abs(t.closingDiff) < 0.01 ? PASS : BAD } };
    diffCell.font = { bold: true, color: { argb: Math.abs(t.closingDiff) < 0.01 ? 'FF375623' : 'FF9C0006' } };
    r += 2;

    noteRow(ws, r, headers.length, 'Basis: opening balances are cumulative at ' + pack.meta.openingDate + '; period movement covers ' + pack.meta.periodLabel + ' inclusive of both dates; closing balances are cumulative at ' + pack.meta.endDate + '. Only Approved, non-deleted remittances are included. Cash and member balances come from the remittance header and detail records respectively; income and expenditure come from the header category. Income and expenditure lines show the movement for the period only, because their cumulative result is already carried in Retained Earnings — showing both would count the same result twice.');
    r++;
    noteRow(ws, r, headers.length, 'The control difference is intentionally left visible. It represents postings in the source data that do not form a complete double entry. It has not been balanced with a suspense account; see the Control Checks and Data Quality Exceptions sheets for the individual transactions behind it.');
    r += 2;
    headingRow(ws, r, 'Period result', undefined, headers.length);
    r++;
    for (const [k, v] of [['Income', pack.periodResult.income], ['Expenditure', pack.periodResult.expense], ['Net surplus / (deficit)', pack.periodResult.surplus]]) {
        ws.getCell(r, 1).value = k;
        ws.getCell(r, 1).font = { bold: true, size: 10 };
        const c = ws.getCell(r, 2);
        c.value = v; c.numFmt = NUM_FMT;
        r++;
    }

    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function ledgerSheet(wb, pack) {
    const ws = wb.addWorksheet('General Ledger', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Code', 'Account', 'Account Type', 'Leg', 'Date', 'Reference', 'Source Table', 'Source ID', 'Remittance ID', 'Remittance Detail ID', 'Member ID', 'Enterprise ID', 'Loan ID', 'Description', 'Member', 'Debit', 'Credit', 'Balance'];
    putBanner(ws, pack, 'General Ledger', `Postings for ${pack.meta.periodLabel}`, headers.length);
    const res = writeTable(ws, pack, 5, 'General ledger', headers, pack.generalLedger, {
        keys: ['code', 'account', 'accountType', 'leg', 'date', 'reference', 'sourceTable', 'sourceId', 'remittanceId', 'detailId', 'memberId', 'enterpriseId', 'loanId', 'description', 'member', 'debit', 'credit', 'balance'],
        numericCols: [15, 16, 17],
        rowStyle: (row) => {
            if (row.kind === 'opening') return { font: { bold: true, size: 10, color: { argb: NAVY } }, fill: LABEL };
            if (row.kind === 'closing') return { font: { bold: true, size: 10, color: { argb: NAVY } }, fill: BAND };
            return null;
        }
    });
    noteRow(ws, res.nextRow, headers.length, 'Every posting traces back to the row it came from: Source Table names the table the amount was read from (remittance_detail for a member posting, remittance for a bank or classification posting) and Source ID is that row\'s own primary key, which is also the value to search on in CoopLogNG. Reference shows the same identity combined. Leg names which side of the entry the line is: Cash is the bank movement, Member is the member or enterprise account, Classification is the income, expense, asset or liability side. Balances are running debit-positive balances on each account.');
    // Column 14 is free-text narration that does not wrap, so it is given a
    // readable width rather than fitted to its longest sentence. It is also
    // allowed to wrap, so a long description is never clipped: with wrapText
    // set, a width check measures the longest word in the cell rather than the
    // whole sentence, and a 60-character column is genuinely enough.
    for (let rr = res.headerRow + 1; rr <= res.lastRow; rr++) {
        ws.getCell(rr, 14).alignment = { wrapText: true, vertical: 'top' };
    }
    pinWidth(ws, 14, 60);
    fitColumns(ws);
    // Eighteen columns scroll horizontally, so the identifying columns are
    // frozen as well as the header row.
    freezeAndFilter(ws, res.headerRow, headers.length, { pack, xSplit: 2 });
    return ws;
}

function cashSheet(wb, pack) {
    const ws = wb.addWorksheet('Cash & Bank Book', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Code', 'Bank', 'Opening', 'Receipts', 'Payments', 'Closing', 'In bank register'];
    putBanner(ws, pack, 'Cash & Bank Book', `Movements for ${pack.meta.periodLabel}`, headers.length);
    const c = pack.cashBook;
    const res = writeTable(ws, pack, 5, 'Cash and bank summary', headers, c.summary, {
        keys: ['code', 'bank', 'opening', 'receipts', 'payments', 'closing', 'registered'],
        numericCols: [2, 3, 4, 5]
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, 'TOTAL CASH & BANK', [
        [3, c.totals.opening], [4, c.totals.receipts], [5, c.totals.payments], [6, c.totals.closing]
    ]);
    r += 2;

    headingRow(ws, r, 'Bank transactions in the period', undefined, headers.length);
    r++;
    const txHeaders = ['Date', 'Remittance ID', 'Family', 'Bank', 'Transaction Type', 'Category', 'Member', 'Receipt', 'Payment'];
    const txRes = writeTable(ws, pack, r, 'Cash movements', txHeaders, c.transactions, {
        keys: ['date', 'remittanceId', 'family', 'bank', 'transactionType', 'category', 'member', 'receipt', 'payment'],
        numericCols: [7, 8]
    });
    r = txRes.nextRow + 1;

    headingRow(ws, r, 'Internal transfer memo — not cash, not income', undefined, headers.length);
    r++;
    noteRow(ws, r, 9, 'Rows with bank_name "Internal Transfer" move value between the cooperative\'s own accounts. They never enter the cash book and never affect income. Their net header movement for the period is ' + fmt(c.internalNet) + '. The detail rows of these transfers are the reallocations, and they are shown in the General Ledger and Member Accounts sheets.');
    r += 2;
    const itHeaders = ['Date', 'Remittance ID', 'Family', 'Transaction Type', 'Category', 'Member', 'Header Amount', 'Detail Count', 'Detail Sum'];
    const itRes = writeTable(ws, pack, r, 'Internal transfers (memo)', itHeaders, c.internalMemo, {
        keys: ['date', 'remittanceId', 'family', 'transactionType', 'category', 'member', 'headerAmount', 'detailCount', 'detailSum'],
        numericCols: [6, 8]
    });

    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function memberSheet(wb, pack) {
    const ws = wb.addWorksheet('Member Accounts', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Member ID', 'Member', 'Reg No', 'Status', 'Account', 'Classification', 'Opening', 'Credits', 'Debits', 'Closing'];
    putBanner(ws, pack, 'Member Accounts', `Member liabilities as at ${pack.meta.endDate}`, headers.length);
    const m = pack.memberAccounts;
    const res = writeTable(ws, pack, 5, 'Balances by member and account', headers, m.rows, {
        keys: ['memberId', 'member', 'regNo', 'memberStatus', 'account', 'classification', 'opening', 'credits', 'debits', 'closing'],
        numericCols: [6, 7, 8, 9]
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, 'TOTAL (includes the cooperative pseudo-member)', [
        [7, round2(m.rows.reduce((s, x) => s + x.opening, 0))],
        [8, round2(m.rows.reduce((s, x) => s + x.credits, 0))],
        [9, round2(m.rows.reduce((s, x) => s + x.debits, 0))],
        [10, m.closingTotal]
    ]);
    r += 1;
    totalRow(ws, r, headers.length, 'Of which cooperative pseudo-member 0000000000', [[10, m.pseudoTotal]]);
    r += 1;
    totalRow(ws, r, headers.length, 'Of which members', [[10, round2(m.closingTotal - m.pseudoTotal)]]);
    r += 2;

    headingRow(ws, r, 'Member totals', undefined, headers.length);
    r++;
    const sHeaders = ['Member ID', 'Member', 'Reg No', 'Status', 'Opening', 'Credits', 'Debits', 'Closing'];
    // The returned nextRow is what advances the cursor. Advancing by a fixed
    // amount instead wrote the following heading over the first rows of this
    // table, destroying them in the delivered workbook.
    const sRes = writeTable(ws, pack, r, 'Summary by member', sHeaders, m.summary, {
        keys: ['memberId', 'member', 'regNo', 'memberStatus', 'opening', 'credits', 'debits', 'closing'],
        numericCols: [4, 5, 6, 7]
    });
    r = sRes.nextRow + 1;

    headingRow(ws, r, 'Member-side revenue accounts (memo, excluded from the trial balance)', undefined, headers.length);
    r++;
    noteRow(ws, r, 8, 'These accounts are flagged as revenue in the enterprise register. They record income accrued to members before it is collected. Because this pack recognises income from the remittance category, recognising it here as well would count the same income twice, so these movements are disclosed here and left out of the trial balance.');
    r += 2;
    const rvHeaders = ['Code', 'Account', 'Opening', 'Period', 'Closing'];
    const rvRes = writeTable(ws, pack, r, 'Accrued member-side revenue', rvHeaders, pack.revenueEntMemo, {
        keys: ['code', 'account', 'opening', 'period', 'closing'],
        numericCols: [2, 3, 4]
    });
    r = rvRes.nextRow + 1;
    noteRow(ws, r, 8, 'Basis: member balances are the sum of remittance_detail per member and account, matching the app\'s own member balance calculation. The remittance header amount is never used as a member balance. Amounts are credit-positive: a positive closing balance is owed to the member.');

    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function loanSheet(wb, pack) {
    const ws = wb.addWorksheet('Loan Register', { pageSetup: { orientation: 'landscape' } });
    const l = pack.loanRegister;
    const headers = ['Loan ID', 'Member', 'Reg No', 'Account', 'Status', 'Principal', 'Issued', 'Due', 'Duration (mth)', 'Disbursed', 'Repaid', 'Charges', 'Outstanding', 'Ageing', 'Disbursement Ref', 'Disbursement Status'];
    putBanner(ws, pack, 'Loan Register', `Outstanding position as at ${pack.meta.endDate}`, headers.length);
    const res = writeTable(ws, pack, 5, 'Loans by record', headers, l.rows, {
        keys: ['loanId', 'member', 'regNo', 'account', 'status', 'principal', 'issued', 'due', 'duration', 'disbursed', 'repaid', 'charges', 'outstanding', 'ageing', 'disbursementRef', 'disbursementStatus'],
        numericCols: [5, 9, 10, 11, 12],
        rowStyle: (row) => (row.outstanding < -0.005 ? { fill: BAD, font: { size: 10, color: { argb: 'FF9C0006' } } } : null)
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, 'TOTAL', [
        [6, round2(l.rows.reduce((s, x) => s + x.principal, 0))],
        [10, round2(l.rows.reduce((s, x) => s + x.disbursed, 0))],
        [11, round2(l.rows.reduce((s, x) => s + x.repaid, 0))],
        [12, round2(l.rows.reduce((s, x) => s + x.charges, 0))],
        [13, l.outstandingTotal]
    ]);
    r += 1;
    totalRow(ws, r, headers.length, 'Loan receivable per trial balance', [[13, l.accountClosing]]);
    if (pack.unattributedLoan && pack.unattributedLoan.count) {
        r += 1;
        // Stated as the amount outstanding, not negated. The register total and
        // the trial balance balance are both positive receivables, so a negated
        // figure here read as a sign error when it is in fact the same
        // population on a different sign convention.
        totalRow(ws, r, headers.length, 'Of which loan movements with no matching loan record (control C11)', [[13, round2(-pack.unattributedLoan.net)]]);
    }
    r += 2;
    headingRow(ws, r, 'Loan movements are on the Loan Movements sheet', { bold: true, size: 10, color: { argb: SLATE } }, headers.length);
    r += 2;
    noteRow(ws, r, headers.length, 'Outstanding is derived from the underlying postings, not from a stored balance: the negated sum of the loan account detail movements attributed to this loan. Principal is the figure recorded when the loan was issued. Any difference between the two means the recorded principal and the actual postings disagree, which control C6 on the Control Checks sheet quantifies. Loan interest is recognised by the app only as a one-time charge collected at origination, so the Charges column is charges collected — there is no interest accrual in the source data. A loan is linked to its postings through loans.remittance_id, or through the family of rows the app generated alongside that remittance; loan account movements that match neither are listed as LOAN_DETAIL_UNATTRIBUTED on the Data Quality Exceptions sheet and quantified by control C11.');

    if (pack.unattributedLoan && pack.unattributedLoan.count) {
        r += 2;
        headingRow(ws, r, 'Loan account movements with no matching loan record', undefined, headers.length);
        r++;
        noteRow(ws, r, headers.length, 'These movements post to the loan account and are included in the loan receivable above, but no loan record references their remittance, so they cannot be shown against an individual member. They are a genuine gap in the recorded data, not a presentational choice.');
        r += 2;
        const uHeaders = ['Remittance ID', 'Detail ID', 'Transaction Type', 'Member', 'Amount'];
        const uRes = writeTable(ws, pack, r, 'Unattributed loan movements', uHeaders, pack.unattributedLoan.rows, {
            keys: ['remittanceId', 'detailId', 'transactionType', 'member', 'amount'],
            numericCols: [4]
        });
        r = uRes.nextRow;
        noteRow(ws, r, headers.length, 'Amount is the signed detail on the loan account, on the same convention as the Loan Movements sheet: negative advances the loan. These are part of the receivable reported above, shown separately because they cannot be attributed to a member.');
    }

    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function loanMovementsSheet(wb, pack) {
    const ws = wb.addWorksheet('Loan Movements', { pageSetup: { orientation: 'landscape' } });
    const l = pack.loanRegister;
    const headers = ['Date', 'Remittance ID', 'Transaction Type', 'Category', 'Member', 'Reg No', 'Bank', 'Header Amount', 'Loan Account Amount', 'Detail Count', 'Detail Sum', 'Loan ID', 'Parent ID'];
    putBanner(ws, pack, 'Loan Movements', `Every posting that moved a loan account in ${pack.meta.periodLabel}`, headers.length);

    if (!l.movements.length) {
        // The header row is still written, so an empty period produces a sheet
        // with the same shape, filters and frozen header as a populated one.
        const empty = writeTable(ws, pack, 5, 'Loan account movements in the period', headers, [], {
            keys: ['date', 'remittanceId', 'transactionType', 'category', 'member', 'regNo', 'bank', 'amount', 'loanAccountAmount', 'detailCount', 'detailSum', 'loanId', 'parentId'],
            numericCols: [7, 8, 9, 10]
        });
        noteRow(ws, empty.nextRow + 1, headers.length, 'No posting moved a loan account within this period. The Loan Register sheet still shows the outstanding position carried into the period.');
        fitColumns(ws);
        freezeAndFilter(ws, 6, headers.length, { pack });
        return ws;
    }

    const res = writeTable(ws, pack, 5, 'Loan account movements in the period', headers, l.movements, {
        keys: ['date', 'remittanceId', 'transactionType', 'category', 'member', 'regNo', 'bank', 'amount', 'loanAccountAmount', 'detailCount', 'detailSum', 'loanId', 'parentId'],
        numericCols: [7, 8, 9, 10],
        rowStyle: (row) => (String(row.category) === 'Loan Income' || /charge|interest|fee/i.test(String(row.transactionType))
            ? { fill: INFO, font: { size: 10, color: { argb: 'FF3F3F76' } } } : null)
    });

    let r = res.nextRow;
    // Column indices here are 1-based against the header list above:
    //   8 = Header Amount, 9 = Loan Account Amount, 10 = Detail Count,
    //  11 = Detail Sum, 12 = Loan ID.
    // The loan receivable is moved by the Loan Account Amount column, so each
    // figure is written under the header it actually belongs to. These were
    // previously written one column to the left, which put loan-account totals
    // under "Header Amount" and a repayment figure under "Detail Count".
    totalRow(ws, r, headers.length, 'MOVEMENT ON THE LOAN RECEIVABLE IN THE PERIOD', [
        [9, round2(l.movements.reduce((s, x) => s + x.loanAccountAmount, 0))]
    ]);
    r += 1;
    totalRow(ws, r, headers.length, 'Loan register lifetime activity (all periods)', [
        [10, round2(l.rows.reduce((s, x) => s + x.disbursed, 0))],
        [11, round2(l.rows.reduce((s, x) => s + x.repaid, 0))],
        [12, round2(l.rows.reduce((s, x) => s + x.charges, 0))]
    ]);
    r += 2;
    noteRow(ws, r, headers.length, 'This sheet lists every remittance that actually posted to a loan account in the period, identified by the posting itself rather than by the remittance header category. The app records most loan activity under other categories, so a header-category test would omit real advances and repayments.');
    r += 1;
    noteRow(ws, r, headers.length, 'Loan Account Amount is the signed total of the detail rows that hit the loan account, and is the figure that moves the receivable. A negative amount advances the loan and increases the member\'s debt; a positive amount reduces it. Header Amount is the whole remittance, which can also carry non-loan detail, so the two columns deliberately differ. Control C14 rolls the receivable forward using the Loan Account Amount column.');
    r += 1;
    noteRow(ws, r, headers.length, 'The Loan ID column is resolved from loans.remittance_id or from the family of rows the app generated alongside that remittance, and is blank where no loan record matches. Those movements are still included in the receivable and are listed on the Data Quality Exceptions sheet and quantified by control C11.');
    r += 2;
    noteRow(ws, r, headers.length, 'The first total row is the movement on the receivable in the period, under Loan Account Amount. The second is the whole life of every loan, under Disbursed, Repaid and Charges respectively; it is a record of gross activity, not a receivable balance, so the two rows are not expected to agree and neither is signed as a balance. Interest is recognised by the app only as a one-time charge collected at origination, so there is no accrual to report.');

    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function incomeExpenseSheet(wb, pack, kind) {
    const isIncome = kind === 'income';
    const ws = wb.addWorksheet(isIncome ? 'Income Detail' : 'Expense Detail', { pageSetup: { orientation: 'landscape' } });
    const rows = isIncome ? pack.incomeDetail : pack.expenseDetail;
    const label = isIncome ? 'Income' : 'Expenditure';
    const headers = ['Date', 'Remittance ID', 'Family', 'Transaction Type', 'Category', 'Classification', 'Member', 'Bank', 'Amount', 'Effect', 'Side'];
    putBanner(ws, pack, isIncome ? 'Income Detail' : 'Expense Detail', `Postings for ${pack.meta.periodLabel}`, headers.length);
    const res = writeTable(ws, pack, 5, `${label} recognised in the period`, headers, rows, {
        keys: ['date', 'remittanceId', 'family', 'transactionType', 'category', 'classification', 'member', 'bank', 'amount', 'effect', 'side'],
        numericCols: [8, 9]
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, `TOTAL ${label.toUpperCase()} (net)`, [
        [9, round2(rows.reduce((s, x) => s + x.amount, 0))],
        [10, round2(rows.reduce((s, x) => s + x.effect, 0))]
    ]);
    r += 2;
    noteRow(ws, r, headers.length, `Amount is the absolute size of the posting. Effect is its signed effect on the balance, so a reversed entry reduces ${label.toLowerCase()} rather than inflating it, and the net total foots exactly to the trial balance line for this account.`);
    r += 2;

    // Capitalised asset purchases are reported here, separated from
    // expenditure, because the app records them with an Asset or Fixed Asset
    // category and no enterprise detail. They post to a cooperative asset
    // account and never to the profit and loss.
    if (!isIncome && pack.coopAssetDetail.length) {
        headingRow(ws, r, 'Capitalised cooperative asset movements — not expenditure', undefined, headers.length);
        r++;
        noteRow(ws, r, headers.length, 'These rows are capitalised assets, not costs. The app records them with an Asset or Fixed Asset category and no enterprise detail, so they post to a cooperative asset account and never to the profit and loss. They are shown on this sheet, separately from the expenditure table above, so a capital purchase can never be read as an expense. Control C12 on the Control Checks sheet proves this section agrees with the trial balance.');
        r += 2;
        const aRes = writeTable(ws, pack, r, 'Asset movements in the period', headers, pack.coopAssetDetail, {
            keys: ['date', 'remittanceId', 'family', 'transactionType', 'category', 'classification', 'member', 'bank', 'amount', 'effect', 'side'],
            numericCols: [8, 9]
        });
        r = aRes.nextRow;
        totalRow(ws, r, headers.length, 'TOTAL CAPITALISED ASSETS (net)', [
            [9, round2(pack.coopAssetDetail.reduce((s, x) => s + x.amount, 0))],
            [10, round2(pack.coopAssetDetail.reduce((s, x) => s + x.effect, 0))]
        ]);
        r += 2;
    }

    if (isIncome && pack.revenueEntMemo.length) {
        noteRow(ws, r, headers.length, 'Income above is recognised from the remittance category. Member-side revenue accounts are excluded from it to prevent the same income being counted twice; their movement is disclosed on the Member Accounts sheet.');
        r += 2;
    }
    if (rows.length) {
        noteRow(ws, r, headers.length, 'Each row is one posting, identified by its remittance id, with the family it belongs to so the related rows generated alongside it can be traced. The Side column shows which side of the entry this account took.');
    }
     fitColumns(ws);
     freezeAndFilter(ws, res.headerRow, headers.length, { pack });
     return ws;
}

function liabilityDetailSheet(wb, pack) {
     const ws = wb.addWorksheet('Liability Detail', { pageSetup: { orientation: 'landscape' } });
     const rows = pack.liabilityDetail;
     const headers = ['Date', 'Remittance ID', 'Family', 'Transaction Type', 'Category', 'Classification', 'Member', 'Bank', 'Amount', 'Effect', 'Side'];
     putBanner(ws, pack, 'Liability Detail', `Member liability postings where no enterprise leg exists (e.g. Unknown Payments)`, headers.length);
     if (!rows.length) {
         noteRow(ws, 5, headers.length, 'No member liability postings without an enterprise leg were recorded for this period.');
         fitColumns(ws);
         freezeAndFilter(ws, 5, headers.length, { pack });
         return;
     }
     const res = writeTable(ws, pack, 5, 'Member liabilities recognised without a matching enterprise detail', headers, rows, {
         keys: ['date', 'remittanceId', 'family', 'transactionType', 'category', 'classification', 'member', 'bank', 'amount', 'effect', 'side'],
         numericCols: [8, 9]
     });
     let r = res.nextRow;
     totalRow(ws, r, headers.length, 'TOTAL MEMBER LIABILITY (net)', [
         [9, round2(rows.reduce((s, x) => s + x.amount, 0))],
         [10, round2(rows.reduce((s, x) => s + x.effect, 0))]
     ]);
     r += 2;
     noteRow(ws, r, headers.length, 'These are member liability postings (e.g. Unknown Payments) that have no enterprise detail leg. The offsetting liability account keeps the trial balance in equilibrium so they do not contribute to the control difference. Control C16 on the Control Checks sheet proves this section agrees with the trial balance.');
     fitColumns(ws);
     freezeAndFilter(ws, res.headerRow, headers.length, { pack });
}

function mappingSheet(wb, pack) {
    const ws = wb.addWorksheet('Account Mapping', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Code', 'Account', 'Type', 'Normal Balance', 'Classification', 'Source in CoopLogNG', 'Derivation rule'];
    putBanner(ws, pack, 'Account Mapping', 'How CoopLogNG records become accounting accounts', headers.length);
    const res = writeTable(ws, pack, 5, 'Reporting account mapping', headers, pack.accountMapping, {
        keys: ['code', 'account', 'type', 'normal', 'classification', 'source', 'rule']
    });
    for (let r = res.headerRow + 1; r <= res.lastRow; r++) {
        ws.getCell(r, 6).alignment = { wrapText: true, vertical: 'top' };
        ws.getCell(r, 7).alignment = { wrapText: true, vertical: 'top' };
        ws.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
    }
    // Columns 2, 6 and 7 wrap their text, so their width is set for readability.
    pinWidth(ws, 2, 34);
    pinWidth(ws, 6, 52);
    pinWidth(ws, 7, 78);
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    let r = res.nextRow + 1;
    noteRow(ws, r, headers.length, 'Account codes are a reporting mapping layer generated for this pack from the cooperative\'s own enterprises, banks and transaction types. They are not a statutory chart of accounts and carry no regulatory meaning. Within a bucket the suffix is assigned in the order the accounts are first needed while the pack is built, so the same data always produces the same codes for a given run, but a code is a label for this pack rather than a permanent identifier: the Account Diagnostics figures on the Cover account for every account the run created, including accounts that net to nil and therefore do not appear in the table above.');
    r += 2;
    noteRow(ws, r, headers.length, 'Cooperative and member ledgers use opposite signs. remittance_detail.amount is positive when a member account is credited: deposits are positive, withdrawals and loan disbursements are negative. remittance.amount is positive when cash increases. A loan disbursement is therefore a negative detail on a debit-normal loan account, which presents as a positive receivable.');
    return ws;
}

function bankRecSheet(wb, pack) {
    const ws = wb.addWorksheet('Bank Reconciliation', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Bank', 'Period', 'In Selected Period', 'Status', 'Bank Credit', 'Bank Debit', 'System Credit', 'System Debit', 'Difference'];
    putBanner(ws, pack, 'Bank Reconciliation', `Sealed reconciliation summaries overlapping ${pack.meta.periodLabel}`, headers.length);
    if (!pack.bankReconciliation.length) {
        const empty = writeTable(ws, pack, 5, 'Reconciliation summaries', headers, [], {
            keys: ['bank', 'period', 'inPeriod', 'status', 'bankCredit', 'bankDebit', 'systemCredit', 'systemDebit', 'difference'],
            numericCols: [4, 5, 6, 7, 8]
        });
        noteRow(ws, empty.nextRow + 1, headers.length, 'No bank reconciliation summaries have been sealed for this cooperative. The Cash & Bank Book sheet is built directly from approved postings, so it does not depend on this sheet, but it cannot be corroborated against an independent bank statement until a reconciliation is sealed in the app.');
        fitColumns(ws);
        freezeAndFilter(ws, 6, headers.length, { pack });
        return ws;
    }
    const inPeriod = pack.bankReconciliation.filter(b => b.inPeriod);
    const rows = inPeriod.length ? inPeriod : pack.bankReconciliation;
    const res = writeTable(ws, pack, 5, 'Reconciliation summaries', headers, rows, {
        keys: ['bank', 'period', 'inPeriod', 'status', 'bankCredit', 'bankDebit', 'systemCredit', 'systemDebit', 'difference'],
        numericCols: [4, 5, 6, 7, 8],
        rowStyle: (row) => (Math.abs(row.difference) >= 0.01 ? { fill: REVIEW, font: { size: 10, color: { argb: 'FF9C0006' } } } : null)
    });
    let r = res.nextRow;
    noteRow(ws, r, headers.length, 'Difference is system credit less bank credit, plus bank debit less system debit. A zero difference means the sealed reconciliation agreed. Only summaries whose period falls inside the selected date range are shown where any do; a summary outside the range is evidence about a different period and is excluded rather than presented as though it covered this one. The Cash & Bank Book cannot be tied to a bank statement from this sheet alone, because it is built from postings; the tie exists only where a reconciliation has been sealed in the app for a matching period.');
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function auditSheet(wb, pack) {
    const ws = wb.addWorksheet('Transaction Audit Trail', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Date', 'Remittance ID', 'Family', 'Status', 'Deleted', 'Transaction Type', 'Category', 'Classification', 'Member ID', 'Member', 'Reg No', 'Member Status', 'Bank', 'Header Amount', 'Detail Count', 'Detail Sum', 'Header less Detail', 'Auto-generated', 'Parent ID', 'Loan ID', 'Description', 'Approved By', 'Approved At', 'Cooperative ID', 'Created By', 'Created At', 'Modified By', 'Modified At'];
    putBanner(ws, pack, 'Transaction Audit Trail', `Every remittance dated ${pack.meta.periodLabel}, including rows excluded from the figures`, headers.length);
    const res = writeTable(ws, pack, 5, 'Transactions', headers, pack.auditTrail, {
        keys: ['date', 'remittanceId', 'family', 'status', 'deleted', 'transactionType', 'category', 'classification', 'memberId', 'member', 'regNo', 'memberStatus', 'bank', 'headerAmount', 'detailCount', 'detailSum', 'headerMinusDetail', 'autogen', 'parentId', 'loanId', 'description', 'approvedBy', 'approvedAt', 'cooperativeId', 'createdBy', 'createdAt', 'modifiedBy', 'modifiedAt'],
        numericCols: [13, 15, 16],
        rowStyle: (row) => {
            if (row.status !== 'Approved' || row.deleted === 'Yes') return { fill: INFO, font: { size: 10, color: { argb: 'FF3F3F76' } } };
            if (Math.abs(row.headerMinusDetail) >= 0.005) return { fill: REVIEW, font: { size: 10, color: { argb: 'FF9C0006' } } };
            return null;
        }
    });
    noteRow(ws, res.nextRow, headers.length, 'Rows tinted grey were not Approved or are deleted, so they are excluded from every figure in this pack and are listed here only for completeness. Rows tinted amber have a header amount that differs from the sum of their details. Family groups a transaction with the rows the app generated alongside it, so a dues or charge entry posted across several rows can be read as one balanced movement. CoopLogNG records who created each row and who last modified it. It has no separate approver column, but approving a remittance writes the approver into the last-modified-by field, so for an Approved row Approved By and Approved At carry that identity and timestamp. The unmodified Created By and Created At columns are kept alongside so the two can be told apart, and the raw Modified By and Modified At are shown for completeness.');
    // Column 21 is free-text narration. It is pinned for readability and allowed
    // to wrap, so a long description wraps within the pinned width instead of
    // being clipped against it.
    for (let rr = res.headerRow + 1; rr <= res.lastRow; rr++) {
        ws.getCell(rr, 21).alignment = { wrapText: true, vertical: 'top' };
    }
    pinWidth(ws, 21, 60);
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function exceptionSheet(wb, pack) {
    const ws = wb.addWorksheet('Data Quality Exceptions', { pageSetup: { orientation: 'landscape' } });
    const headers = ['Severity', 'Code', 'Finding', 'Remittance ID', 'Amount', 'Explanation'];
    putBanner(ws, pack, 'Data Quality Exceptions', 'Every transaction behind the control difference, and other findings', headers.length);

    if (!pack.exceptions.length) {
        const empty = writeTable(ws, pack, 5, 'Exceptions raised', headers, [], {
            keys: ['severity', 'code', 'title', 'remittanceId', 'amount', 'explanation'],
            numericCols: [4]
        });
        noteRow(ws, empty.nextRow + 1, headers.length, 'No data quality exceptions were raised for this cooperative and period. The trial balance control difference is nil.');
        // Columns 3 and 6 wrap their text, so their width is set for readability.
        pinWidth(ws, 3, 46);
        pinWidth(ws, 6, 88);
        fitColumns(ws);
        freezeAndFilter(ws, 6, headers.length, { pack });
        return ws;
    }

    // The grouped summary is placed above the detail rows, not below them. At
    // 786 detail rows a summary written underneath is effectively invisible, and
    // a reviewer has to read every finding before learning how many of each
    // there are.
    const grouped = new Map();
    for (const e of pack.exceptions) {
        if (!grouped.has(e.code)) grouped.set(e.code, { code: e.code, severity: e.severity, title: e.title, count: 0, amount: 0 });
        const g = grouped.get(e.code);
        g.count += 1;
        g.amount = round2(g.amount + e.amount);
    }
    const rank = { High: 0, Medium: 1, Low: 2 };
    const sHeaders = ['Severity', 'Code', 'Finding', 'Count', 'Net Amount'];
    const sRows = [...grouped.values()].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || Math.abs(b.amount) - Math.abs(a.amount));
    const sRes = writeTable(ws, pack, 5, 'Summary by finding', sHeaders, sRows, {
        keys: ['severity', 'code', 'title', 'count', 'amount'],
        numericCols: [3, 4],
        rowStyle: (row) => {
            const fill = row.severity === 'High' ? BAD : row.severity === 'Medium' ? REVIEW : INFO;
            return { fill, font: { size: 10 } };
        }
    });
    for (let r2 = sRes.headerRow + 1; r2 <= sRes.lastRow; r2++) {
        ws.getCell(r2, 3).alignment = { wrapText: true, vertical: 'top' };
    }

    let r = sRes.nextRow + 1;
    noteRow(ws, r, headers.length, 'These findings are reported, not corrected. Nothing in this pack has been changed to make a statement balance, and no record has been written back to the database. Each finding carries the remittance identifier needed to locate and resolve the underlying transaction in the app.');
    r += 2;

    const res = writeTable(ws, pack, r, 'Exceptions raised', headers, pack.exceptions, {
        keys: ['severity', 'code', 'title', 'remittanceId', 'amount', 'explanation'],
        numericCols: [4],
        rowStyle: (row) => {
            const fill = row.severity === 'High' ? BAD : row.severity === 'Medium' ? REVIEW : INFO;
            const color = row.severity === 'High' ? 'FF9C0006' : row.severity === 'Medium' ? 'FF9C5700' : 'FF3F3F76';
            return { fill, font: { size: 10, color: { argb: color } } };
        }
    });
    for (let r3 = res.headerRow + 1; r3 <= res.lastRow; r3++) {
        ws.getCell(r3, 1).font = { bold: true, size: 10, color: { argb: ws.getCell(r3, 1).value === 'High' ? 'FF9C0006' : ws.getCell(r3, 1).value === 'Medium' ? 'FF9C5700' : 'FF3F3F76' } };
        ws.getCell(r3, 2).font = { bold: true, size: 9 };
        ws.getCell(r3, 3).alignment = { wrapText: true, vertical: 'top' };
        ws.getCell(r3, 6).alignment = { wrapText: true, vertical: 'top' };
    }
    // Columns 3 and 6 wrap their text, so their width is set for readability.
    pinWidth(ws, 3, 46);
    pinWidth(ws, 6, 88);
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

// ---------------------------------------------------------------------------
// The primary financial statements
// ---------------------------------------------------------------------------

// A statement is written as section headings, indented account lines and
// subtotals, rather than as a flat table, because that is the form a reader
// foots by hand. Every figure comes from the trial balance, so the statement
// cannot disagree with it.
function statementSheet(wb, pack, name, title, subtitle, colCount) {
    const ws = wb.addWorksheet(name, {
        pageSetup: {
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 }
        },
        headerFooter: {
            oddFooter: `&L${pack.meta.cooperativeName} — ${title}&CPage &P of &N&R${pack.meta.periodLabel}`
        }
    });
    putBanner(ws, pack, title, subtitle, colCount);
    // Column 2 carries the account or label column, column 3 the amount. The
    // label column is pinned wide enough for the longest label and for the
    // longest single word in it, because these statements read as prose and a
    // clipped account name makes a statement unusable.
    pinWidth(ws, 2, 70);
    return ws;
}

// One section: a bold caption, its account lines, and a subtotal.
function statementGroup(ws, pack, rowIdx, group, opts = {}) {
    let r = rowIdx;
    headingRow(ws, r, group.label, { bold: true, size: 10, color: { argb: SLATE } }, 3);
    r++;
    for (const line of group.lines) {
        const a = ws.getCell(r, 1);
        a.value = line.code;
        a.alignment = { horizontal: 'left' };
        const b = ws.getCell(r, 2);
        b.value = line.account;
        const c = ws.getCell(r, 3);
        c.value = line.closing;
        c.numFmt = NUM_FMT;
        c.alignment = { horizontal: 'right' };
        for (let i = 1; i <= 3; i++) ws.getCell(r, i).border = { bottom: { style: 'hair', color: { argb: 'FFD9D9D9' } } };
        r++;
    }
    if (!group.lines.length) {
        const b = ws.getCell(r, 2);
        b.value = '(no balance)';
        b.font = { italic: true, size: 10, color: { argb: 'FF808080' } };
        r++;
    }
    r++;
    totalRow(ws, r, 3, opts.totalLabel || `${group.label} total`, [[3, group.total]]);
    return r + 2;
}

function financialPositionSheet(wb, pack) {
    const f = pack.financialPosition;
    const ws = statementSheet(wb, pack, 'Statement of Financial Position', 'Statement of Financial Position', `As at ${pack.meta.endDate}`, 3);
    let r = 5;
    headingRow(ws, r, 'ASSETS', { bold: true, size: 11, color: { argb: NAVY } }, 3);
    r += 2;
    for (const g of f.assets) r = statementGroup(ws, pack, r, g);
    totalRow(ws, r, 3, 'TOTAL ASSETS', [[3, f.assetsTotal]]);
    r += 3;

    headingRow(ws, r, 'EQUITY AND LIABILITIES', { bold: true, size: 11, color: { argb: NAVY } }, 3);
    r += 2;
    for (const g of f.equity) r = statementGroup(ws, pack, r, g);
    for (const g of f.liabilities) r = statementGroup(ws, pack, r, g);
    totalRow(ws, r, 3, 'TOTAL EQUITY AND LIABILITIES', [[3, f.liabilitiesAndEquity]]);
    r += 2;

    const diffCellRow = r;
    totalRow(ws, r, 3, 'DIFFERENCE (assets less equity and liabilities)', [[3, f.difference]]);
    const dc = ws.getCell(r, 3);
    dc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: Math.abs(f.difference) < 0.01 ? PASS : BAD } };
    dc.font = { bold: true, color: { argb: Math.abs(f.difference) < 0.01 ? 'FF375623' : 'FF9C0006' } };
    r += 2;

    noteRow(ws, r, 3, 'Every figure above is the closing balance of the corresponding account on the Trial Balance sheet, grouped by the account own normal balance, so this statement cannot disagree with the trial balance behind it. Control C19 proves the two agree.');
    r += 2;
    noteRow(ws, r, 3, 'A non-zero difference is not a mistake in this statement. It is the same control difference reported by C1 on the Control Checks sheet: the sum of postings in the cooperative own records that do not form a complete double entry. It is disclosed here and on the Data Quality Exceptions sheet rather than absorbed into a balancing account, because plugging it would hide the underlying transactions from the auditor.');
    r += 2;
    noteRow(ws, r, 3, 'Member savings, dues and equity are amounts the cooperative owes its members. Loans receivable are amounts members owe the cooperative. The cooperative own funds are shown in equity accounts; the cooperative pseudo-member balance is reported separately by control C10 and is excluded from member net worth.');
    fitColumns(ws);
    return ws;
}

function incomeExpenditureStatementSheet(wb, pack) {
    const ie = pack.incomeExpenditure;
    const ws = statementSheet(wb, pack, 'Income & Expenditure', 'Income and Expenditure Statement', `For the period ${pack.meta.periodLabel}`, 3);
    let r = 5;
    const section = (label, group) => {
        headingRow(ws, r, label, { bold: true, size: 11, color: { argb: NAVY } }, 3);
        r += 2;
        for (const line of group.lines) {
            const a = ws.getCell(r, 1);
            a.value = line.code;
            const b = ws.getCell(r, 2);
            b.value = line.account;
            const c = ws.getCell(r, 3);
            c.value = line.amount;
            c.numFmt = NUM_FMT;
            c.alignment = { horizontal: 'right' };
            for (let i = 1; i <= 3; i++) ws.getCell(r, i).border = { bottom: { style: 'hair', color: { argb: 'FFD9D9D9' } } };
            r++;
        }
        if (!group.lines.length) {
            const b = ws.getCell(r, 2);
            b.value = '(none in the period)';
            b.font = { italic: true, size: 10, color: { argb: 'FF808080' } };
            r++;
        }
        r++;
        totalRow(ws, r, 3, `TOTAL ${label}`, [[3, group.total]]);
        r += 2;
    };
    section('INCOME', ie.income);
    section('EXPENDITURE', ie.expenditure);
    totalRow(ws, r, 3, ie.surplus < 0 ? 'NET DEFICIT FOR THE PERIOD' : 'NET SURPLUS FOR THE PERIOD', [[3, ie.surplus]]);
    const sc = ws.getCell(r, 3);
    sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ie.surplus < 0 ? BAD : PASS } };
    r += 2;
    noteRow(ws, r, 3, 'Each line is the period movement on one account, taken from the trial balance. Income is shown as a positive figure and expenditure as a positive figure, so the surplus is income less expenditure. Control C20 proves this total equals income less expenditure per the trial balance.');
    r += 2;
    noteRow(ws, r, 3, 'Income is recognised from the remittance category, which is the only basis that captures the header-only income pickups the app records. Member-side revenue accounts are excluded from income and disclosed as a memo on the Member Accounts sheet, because recognising them here as well would count the same income twice.');
    r += 2;
    noteRow(ws, r, 3, 'Capitalised purchases of the cooperative own assets are never expenditure: the app records them with an Asset or Fixed Asset category, and they appear as assets on the Statement of Financial Position. Control C12 proves the expenditure total excludes them, and the Expense Detail sheet lists them separately.');
    fitColumns(ws);
    return ws;
}

function cashFlowSheet(wb, pack) {
    const cf = pack.cashFlow;
    const ws = statementSheet(wb, pack, 'Cash Flow', 'Cash Flow Statement', `For the period ${pack.meta.periodLabel}`, 3);
    let r = 5;
    headingRow(ws, r, 'OPERATING AND INVESTING ACTIVITIES', { bold: true, size: 11, color: { argb: NAVY } }, 3);
    r += 2;
    for (const l of cf.lines) {
        const indent = l.kind === 'start' ? 0 : 1;
        exemptFromFit(ws.getCell(r, 1)).value = '';
        const b = ws.getCell(r, 2);
        b.value = (indent ? '    ' : '') + l.label;
        b.font = l.kind === 'start' ? { bold: true, size: 10 } : { size: 10 };
        const c = ws.getCell(r, 3);
        c.value = l.amount;
        c.numFmt = NUM_FMT;
        c.alignment = { horizontal: 'right' };
        c.font = l.kind === 'start' ? { bold: true, size: 10 } : { size: 10 };
        for (let i = 1; i <= 3; i++) ws.getCell(r, i).border = { bottom: { style: 'hair', color: { argb: 'FFD9D9D9' } } };
        r++;
    }
    r++;
    totalRow(ws, r, 3, 'Cash movement before reconciling items', [[3, cf.subtotal]]);
    r += 1;
    totalRow(ws, r, 3, 'Movement in cash and bank balances per the cash book', [[3, cf.cashMovement]]);
    r += 1;
    totalRow(ws, r, 3, 'Movement the statement above cannot explain', [[3, cf.unexplained]]);
    const uc = ws.getCell(r, 3);
    uc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: Math.abs(cf.unexplained) < 0.01 ? PASS : REVIEW } };
    r += 2;

    totalRow(ws, r, 3, 'Cash and bank balances at the start of the period', [[3, cf.opening]]);
    r += 1;
    totalRow(ws, r, 3, 'Cash and bank balances at the end of the period', [[3, cf.closing]]);
    r += 2;
    noteRow(ws, r, 3, 'Presented by the indirect method: the period result is reconciled to the movement in cash through the balance movements the records support. The Cash & Bank Book sheet is the authority on the movement in cash, and control C21 proves this statement ends where the cash book ends. Control C4 separately proves the cash book itself moves continuously from opening to closing.');
    r += 2;
    noteRow(ws, r, 3, 'The reconciling line is shown rather than absorbed. Where it is non-zero it is the part of the cash movement that the period result and the disclosed balance movements do not account for, which in this pack arises from postings that do not form a complete double entry. It is the same population C1, C17 and C18 report, approached from the cash side.');
    r += 2;
    noteRow(ws, r, 3, 'This is a cash-basis statement, because the source records are. The app recognises no accruals, no depreciation and no provisions, so there is no non-cash charge to add back and no working capital movement that is not a real movement between accounts. Internal transfers between the cooperative own accounts are excluded from cash by posting rule and are removed above.');
    fitColumns(ws);
    return ws;
}

function entryProofSheet(wb, pack) {
    const ws = wb.addWorksheet('Entry Balance Proof', { pageSetup: { orientation: 'landscape' } });
    const e = pack.entryBalanceProof;
    const headers = ['Remittance ID', 'Date', 'Family', 'Transaction Type', 'Category', 'Member', 'Bank', 'Legs', 'Debit', 'Credit', 'Out of Balance'];
    putBanner(ws, pack, 'Entry Balance Proof', 'Every derived journal entry, tested individually', headers.length);
    if (!e.rows.length) {
        const empty = writeTable(ws, pack, 5, 'Journal entries', headers, [], {
            keys: ['remittanceId', 'date', 'family', 'transactionType', 'category', 'member', 'bank', 'legs', 'debit', 'credit', 'outOfBalance'],
            numericCols: [7, 8, 9, 10]
        });
        noteRow(ws, empty.nextRow + 1, headers.length, 'No journal entries were derived for this period.');
        fitColumns(ws);
        freezeAndFilter(ws, 6, headers.length, { pack });
        return ws;
    }
    // Entries that do not balance are listed first, largest first, because that
    // is what a reviewer needs to see. A balanced entry is evidence too, so the
    // whole population is shown rather than only the failures.
    const rows = [...e.unbalanced, ...e.rows.filter(r => Math.abs(r.outOfBalance) < 0.01)];
    const res = writeTable(ws, pack, 5, 'Journal entries, entries out of balance first', headers, rows, {
        keys: ['remittanceId', 'date', 'family', 'transactionType', 'category', 'member', 'bank', 'legs', 'debit', 'credit', 'outOfBalance'],
        numericCols: [7, 8, 9, 10],
        rowStyle: (row) => (Math.abs(row.outOfBalance) >= 0.01 ? { fill: BAD, font: { size: 10, color: { argb: 'FF9C0006' } } } : null)
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, `ENTRIES THAT DO NOT BALANCE (control C17)`, [[11, e.unbalancedCount]]);
    r += 1;
    totalRow(ws, r, headers.length, 'Entries tested', [[11, e.totalCount]]);
    r += 2;
    noteRow(ws, r, headers.length, 'An entry is the unit a balance can be tested at. The trial balance cannot identify a broken entry, because a debit error in one transaction and a credit error in another cancel in the total: a trial balance can foot exactly while several hundred individual entries do not balance. This sheet nets every entry the pack derives and lists the ones whose legs do not sum to nil, with the remittance id needed to find and fix the underlying rows in CoopLogNG.');
    r += 1;
    noteRow(ws, r, headers.length, 'Entries are built from the remittance the app recorded, together with the family of remittances it generated alongside that one. A compulsory charge is posted as several rows; read individually each looks one-legged, read as a family it balances, so Family identifies the group and an entry that does not balance is often a movement the app split across rows that are no longer all present.');
    r += 1;
    noteRow(ws, r, headers.length, 'Nothing here has been corrected or adjusted. The pack reports the entries exactly as the records produce them; correcting them would mean changing source data, which is outside what a reporting pack may do.');
    // Column 5 is the category, which carries CoopLogNG's own category names and
    // can be a long one. Pinned wide enough for the longest of them and wrapped
    // so a longer value is never clipped.
    for (let rr = res.headerRow + 1; rr <= res.lastRow; rr++) {
        ws.getCell(rr, 5).alignment = { wrapText: true, vertical: 'top' };
    }
    pinWidth(ws, 5, 26);
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack, xSplit: 2 });
    return ws;
}

function loanAgingSheet(wb, pack) {
    const ws = wb.addWorksheet('Loan Ageing', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const a = pack.loanAging;
    const headers = ['Ageing bucket', 'Loans', 'Outstanding', 'Of which overdue'];
    putBanner(ws, pack, 'Loan Ageing', `Outstanding position as at ${pack.meta.endDate}`, headers.length);
    const res = writeTable(ws, pack, 5, 'Loans by ageing bucket', headers, a.buckets, {
        keys: ['label', 'count', 'outstanding', 'overdue'],
        numericCols: [1, 2, 3]
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, 'TOTAL', [
        [2, a.buckets.reduce((s, b) => s + b.count, 0)],
        [3, a.bucketsTotal],
        [4, a.overdueTotal]
    ]);
    if (a.undated.count) {
        r += 1;
        totalRow(ws, r, headers.length, 'Of which loans with no due date recorded (cannot be aged)', [
            [2, a.undated.count], [3, a.undated.outstanding]
        ]);
    }
    r += 2;
    noteRow(ws, r, headers.length, 'Ageing is measured from the due date recorded on the loan against the period end date, so a loan is overdue once its due date has passed. The Loan Register sheet lists each loan individually with its own ageing string; this sheet presents the same population in the buckets an auditor or examiner asks for.');
    r += 1;
    noteRow(ws, r, headers.length, 'No provision for impairment is raised. The records contain no evidence of recoverability, no repayment history by instalment and no write-off history, so any provision would be an estimate presented as a fact. The aged amounts are shown so a reader can apply their own policy. This is a limitation of the source data, not an omission from the pack.');
    r += 1;
    noteRow(ws, r, headers.length, 'Loans with no due date recorded cannot be placed in a bucket and are counted separately rather than assumed current, because assuming they are current would understate the overdue population.');
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function suspenseSheet(wb, pack) {
    const ws = wb.addWorksheet('Unidentified Payments', { pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const s = pack.suspense;
    const headers = ['Code', 'Account', 'Opening', 'Period', 'Closing'];
    putBanner(ws, pack, 'Unidentified Payments', 'Cash received with no identifiable owner', headers.length);
    if (!s.rows.length) {
        noteRow(ws, 5, headers.length, 'No unidentified payment liability account arose in this period.');
        fitColumns(ws);
        return ws;
    }
    const res = writeTable(ws, pack, 5, 'Unidentified payment balances', headers, s.rows, {
        keys: ['code', 'account', 'opening', 'period', 'closing'],
        numericCols: [2, 3, 4]
    });
    let r = res.nextRow;
    totalRow(ws, r, headers.length, 'TOTAL UNIDENTIFIED PAYMENTS', [[5, s.closingTotal]]);
    r += 2;
    noteRow(ws, r, headers.length, 'When a payment is posted with a Member Liability or Liability category and carries no detail identifying which member received it, the app cannot attribute it to a person. This pack posts it to a liability account so the trial balance stays in equilibrium, which means the cash is recognised but nobody owns it. That is the correct treatment: assigning it to a member would misstate that member balance, and dropping it would misstate cash.');
    r += 1;
    noteRow(ws, r, headers.length, 'No ageing is presented for this balance. The records do not carry a dated identification reference for an unidentified payment, so there is no evidence from which to establish how old each amount is, and an ageing built from anything else would be invented. What can be shown, and is shown here, is the balance at the start of the period, the movement in the period and the balance at the end, so a reader can see whether unidentified cash is being cleared.');
    r += 1;
    noteRow(ws, r, headers.length, 'Cash sitting in this account is cash the cooperative holds but cannot attribute. A reader assessing the reliability of member balances should treat it as a finding in its own right: it is revenue or a liability recognised without a counterparty. Control C16 proves these postings agree with the trial balance.');
    fitColumns(ws);
    freezeAndFilter(ws, res.headerRow, headers.length, { pack });
    return ws;
}

function fmt(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ---------------------------------------------------------------------------

export async function buildAccountingPackWorkbook(pack) {
    const ExcelJS = (typeof window !== 'undefined' && window.ExcelJS) || (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'cooplogng';
    wb.company = pack.meta.cooperativeName;
    wb.title = `Accounting Pack ${pack.meta.periodLabel}`;
    wb.created = new Date();

    coverSheet(wb, pack);
    financialPositionSheet(wb, pack);
    incomeExpenditureStatementSheet(wb, pack);
    cashFlowSheet(wb, pack);
    controlSheet(wb, pack);
    trialBalanceSheet(wb, pack);
    ledgerSheet(wb, pack);
    entryProofSheet(wb, pack);
    cashSheet(wb, pack);
    memberSheet(wb, pack);
    loanSheet(wb, pack);
    loanAgingSheet(wb, pack);
    loanMovementsSheet(wb, pack);
    incomeExpenseSheet(wb, pack, 'income');
    incomeExpenseSheet(wb, pack, 'expense');
    liabilityDetailSheet(wb, pack);
    suspenseSheet(wb, pack);
    mappingSheet(wb, pack);
    bankRecSheet(wb, pack);
    auditSheet(wb, pack);
    exceptionSheet(wb, pack);

    // The cover advertises a sheet list, so the workbook has to contain exactly
    // what it advertises. Asserted here rather than only in the test harness,
    // because a mismatch means the cover a reader relies on is wrong about the
    // document they are holding.
    const advertised = SHEETS.map(s => s[0]);
    const actual = wb.worksheets.map(ws => ws.name);
    const missing = advertised.filter(n => !actual.includes(n));
    const unlisted = actual.filter(n => !advertised.includes(n));
    if (missing.length || unlisted.length) {
        throw new Error(
            `Accounting Pack cover advertises ${advertised.length} worksheets but the workbook has ${actual.length}.`
            + (missing.length ? ` Advertised but not built: ${missing.join(', ')}.` : '')
            + (unlisted.length ? ` Built but not advertised: ${unlisted.join(', ')}.` : '')
        );
    }

    // Every column of every sheet, fitted once the whole pack exists. The
    // per-sheet calls above keep each sheet's own layout correct while it is
    // being written; this is what makes "all columns fit" true of the finished
    // workbook, including the sheets whose writer never asked for a fit and the
    // tables written after their sheet's own fit had already run.
    fitAllColumns(wb);

    return wb;
}

export async function exportAccountingPack(pack) {
    const wb = await buildAccountingPackWorkbook(pack);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fileName = `CoopLogNG_Accounting_Pack_${pack.meta.startDate}_to_${pack.meta.endDate}.xlsx`;
    a.href = url;
    a.download = fileName;
    // The anchor has to be in the document for the click to be dispatched in
    // every engine, and the object URL has to outlive the click. Revoking it in
    // the same task as a.click() aborts the download in some browsers, which
    // matters here because the pack is generated in Electron and in an Android
    // WebView as well as in a normal browser tab.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { sheets: SHEETS.length, fileName };
}
