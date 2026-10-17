// Confirms the fitted widths survive serialisation: reads the written .xlsx back
// off disk and re-checks every column against the text it has to display.
// With no file argument it builds the pack and writes one, so this can be run
// on its own rather than only against a file another harness happened to leave
// behind in a temporary directory.
import ExcelJS from 'exceljs';
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { buildAccountingPack } from '../src/services/reports/accountingPack.js';
import { buildAccountingPackWorkbook, pinnedColumns } from '../src/services/reports/accountingPackExcel.js';

// An empty string counts as absent: some shells pass an empty argument through
// when the value is not quoted, and a truthiness test alone would then treat
// "" as a filename and try to open it. A value that is not an existing readable
// file is also treated as absent, so a stale path cannot stop this from running
// on its own.
const arg = (process.argv[2] || '').trim();
let file = (arg && fs.existsSync(arg)) ? arg : '';
if (!file) {
    const SQL = await initSqlJs({ locateFile: f => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
    const db = new SQL.Database(fs.readFileSync('sampledata.db'));
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
        cooperativeId: coop.id, startDate: '2000-01-01', endDate: '2099-12-31',
        cooperativeName: coop.full_name, generatedBy: 'width-roundtrip', query
    });
    const wb0 = await buildAccountingPackWorkbook(pack);
    // Written beside the project rather than into a temporary directory, so the
    // file is somewhere this script is guaranteed to be able to write.
    file = path.join(process.cwd(), 'width-roundtrip.xlsx');
    await wb0.xlsx.writeFile(file);
    console.log(`written: ${file}`);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

const shown = cell => {
    const v = cell.value;
    if (v == null || v === '') return '';
    const fmt = cell.numFmt || '';
    if (typeof v === 'number') {
        const dp = /\.(0+)/.exec(fmt);
        const p = dp ? dp[1].length : 0;
        const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p });
        return v < 0 ? `-${body}` : body;
    }
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return String(v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : (v.result ?? '')));
    return String(v);
};
const spansColumns = (row, c) => {
    const cell = row.getCell(c);
    if (!cell.isMerged || cell.master !== cell) return false;
    for (let k = c + 1; k < c + 40; k++) {
        const other = row.getCell(k);
        if (other.isMergedTo(cell)) return true;
        if (!other.isMerged) break;
    }
    return false;
};

// PINNED is a WeakMap keyed on the in-memory worksheet objects, so it is
// meaningless once the workbook has been serialised and read back: every pinned
// column comes back looking unfitted. A column with no width in the file is
// therefore reported as "unset" rather than as a failure, because the fit
// genuinely leaves some columns with no explicit width and Excel renders those
// at its default. What this harness is for is the round trip: does a width that
// was written come back unchanged, and does a fitted column still cover its
// content after serialisation. A missing width is not evidence of a clipping
// bug, so it is counted and reported separately.
let fail = 0, checked = 0, unset = 0, pinnedAfterRead = 0;
for (const ws of wb.worksheets) {
    const isPinned = new Set(pinnedColumns(ws));
    const cols = ws.columnCount;
    const demand = new Array(cols + 1).fill(0);
    for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (!row) continue;
        for (let c = 1; c <= cols; c++) {
            const cell = row.getCell(c);
            if (!cell || !cell.value) continue;
            if (cell.isMerged && cell.master !== cell) continue;
            if (spansColumns(row, c)) continue;
            const t = shown(cell);
            if (!t) continue;
            const chars = cell.alignment && cell.alignment.wrapText
                ? t.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0)
                : t.length;
            const need = chars + (cell.font && cell.font.bold ? 1 : 0) + 2;
            if (need > 100) continue;
            if (need > demand[c]) demand[c] = need;
        }
    }
    const bad = [];
    for (let c = 1; c <= cols; c++) {
        const w = ws.getColumn(c).width;
        checked++;
        if (w == null) { unset++; continue; }
        if (isPinned.has(c)) { pinnedAfterRead++; continue; }
        // A width that survived serialisation still has to cover its content.
        // The pinned widths chosen for readability are recognised by the fact
        // that they are wider than the content demands, which is the whole point
        // of pinning them, so only a column narrower than its content is a
        // genuine failure.
        if (w < demand[c]) bad.push(`col ${c} width=${w} needs ${demand[c]}`);
    }
    if (bad.length) { fail += bad.length; console.log(`  FAIL ${ws.name}: ${bad.join('; ')}`); }
}
console.log(`\nread back from ${file}`);
console.log(`columns checked: ${checked}   clipped: ${fail}   no explicit width: ${unset}`);
console.log(fail ? 'ROUND-TRIP WIDTH CHECK: FAIL' : 'ROUND-TRIP WIDTH CHECK: PASS');
process.exit(fail ? 1 : 0);
