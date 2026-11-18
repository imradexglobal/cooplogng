import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { buildAccountingPack } from '../../src/services/reports/accountingPack.js';

const dbFile = process.argv[2];
const from = process.argv[3] || '2026-01-01';
const to = process.argv[4] || '2026-11-17';
if (!dbFile) throw new Error('Usage: node analyze_backup_control_difference.mjs <db> [from] [to]');
const SQL = await initSqlJs({ locateFile: f => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database(fs.readFileSync(dbFile));
const query = async (sql, bind = []) => {
  const stmt = db.prepare(sql); const rows = [];
  try { stmt.bind(bind); while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
  finally { stmt.free(); }
};
const coops = await query('SELECT DISTINCT cooperative_id FROM remittance ORDER BY cooperative_id');
const cooperativeId = coops[0].cooperative_id;
const pack = await buildAccountingPack({ cooperativeId, startDate: from, endDate: to, cooperativeName: cooperativeId, generatedBy: 'read-only-analysis', query });
console.log(JSON.stringify({
  dbFile, cooperativeId, from, to,
  totals: pack.trialBalanceTotals,
  controls: pack.controlChecks,
  exceptions: pack.exceptions,
  exceptionSummary: pack.exceptions.reduce((a,e) => { const k=e.code; a[k]=(a[k]||0)+1; return a; }, {}),
  exceptionAmountSummary: pack.exceptions.reduce((a,e) => { const k=e.code; a[k]=(a[k]||0)+(Number(e.amount)||0); return a; }, {}),
  entryBalanceProof: pack.entryBalanceProof,
  meta: pack.meta
}, null, 2));
