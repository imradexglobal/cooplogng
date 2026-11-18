import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { buildAccountingPack } from '../../src/services/reports/accountingPack.js';

const dbFile = process.argv[2] || 'C:/Users/USER/Downloads/aaa.db';
const from = process.argv[3] || '2026-01-01';
const to = process.argv[4] || '2026-11-17';
const SQL = await initSqlJs({ locateFile: f => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database(fs.readFileSync(dbFile));
const query = async (sql, bind = []) => {
  const stmt = db.prepare(sql); const rows = [];
  try { stmt.bind(bind); while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
  finally { stmt.free(); }
};
const cooperativeId = (await query('SELECT DISTINCT cooperative_id FROM remittance ORDER BY cooperative_id'))[0].cooperative_id;
const pack = await buildAccountingPack({ cooperativeId, startDate: from, endDate: to, cooperativeName: cooperativeId, generatedBy: 'balance-sheet-investigation', query });
const n = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const signedClosing = a => n((a.normal === 'CR' ? -1 : 1) * (Number(a.openingNet || 0) + Number(a.periodNet || 0)));
const byBucket = new Map();
for (const a of pack.accounts) {
  const row = byBucket.get(a.bucket) || { bucket: a.bucket, type: a.type, normal: a.normal, closing: 0, count: 0 };
  row.closing = n(row.closing + signedClosing(a)); row.count += 1; byBucket.set(a.bucket, row);
}
const fpAccountCodes = new Set([
  ...pack.financialPosition.assets.flatMap(g => g.lines.map(x => x.code)),
  ...pack.financialPosition.liabilities.flatMap(g => g.lines.map(x => x.code)),
  ...pack.financialPosition.equity.flatMap(g => g.lines.map(x => x.code)).filter(Boolean)
]);
const omitted = pack.accounts.filter(a => !fpAccountCodes.has(a.code) && !['income','expense'].includes(a.bucket)).map(a => ({ code:a.code, account:a.name, bucket:a.bucket, type:a.type, normal:a.normal, closing:signedClosing(a), opening:n((a.normal==='CR'?-1:1)*Number(a.openingNet||0)), period:n((a.normal==='CR'?-1:1)*Number(a.periodNet||0)) })).filter(x => Math.abs(x.closing) >= 0.01);
console.log(JSON.stringify({dbFile,cooperativeId,from,to,trialBalanceTotals:pack.trialBalanceTotals,financialPosition:pack.financialPosition,periodResult:pack.periodResult,controls:pack.controlChecks.filter(c=>['C1','C5','C6','C19','C20'].includes(c.id)),byBucket:[...byBucket.values()].sort((a,b)=>a.bucket.localeCompare(b.bucket)),omitted,topAccounts:pack.accounts.map(a=>({code:a.code,account:a.name,bucket:a.bucket,normal:a.normal,opening:signedClosing({...a,periodNet:0}),period:n((a.normal==='CR'?-1:1)*Number(a.periodNet||0)),closing:signedClosing(a)})).filter(x=>Math.abs(x.closing)>=0.01).sort((a,b)=>Math.abs(b.closing)-Math.abs(a.closing)).slice(0,100)}, null, 2));
