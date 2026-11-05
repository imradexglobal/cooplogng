import ExcelJS from 'exceljs'
import fs from 'fs'
import path from 'path'
import initSqlJs from 'sql.js'

const xlsxPath = 'C:/Users/User/Documents/Radio Project/Coperators  Ledger account as at 31.12.25.xlsx'
const dbPath = 'C:/Users/User/Downloads/cooperative_backup_2026-11-05T04-56.db'
const backupPath = 'C:/Users/User/Downloads/cooperative_backup_2026-11-05T04-56.before-opening-2025-12-31.db'
const reportPath = path.resolve('.work/outputs/opening-balance-import-report.json')
const coopId = 'RACDA'
const actor = 'RACDA'
const description = 'Balance Brought Foward from 2025'
const remittanceDate = '2025-12-31'
const stamp = '2025-12-31T00:00:00.000Z'
const eps = 0.005

const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const cleanNumeric = value => {
  if (value && typeof value === 'object' && 'result' in value) value = value.result
  if (value === null || value === undefined || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
const round2 = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100
const sqlValue = value => value === null || value === undefined ? null : String(value)

if (!fs.existsSync(xlsxPath)) throw new Error(`Workbook not found: ${xlsxPath}`)
if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`)

const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile(xlsxPath)
const ws = wb.worksheets[0]
const sourceRows = []
for (let rowNo = 3; rowNo <= ws.rowCount; rowNo++) {
  const row = ws.getRow(rowNo)
  const unwrap = value => value && typeof value === 'object' && 'result' in value ? value.result : value
  const name = unwrap(row.getCell(2).value)
  const reg = unwrap(row.getCell(3).value)
  const loanRaw = row.getCell(21).value
  const savingsRaw = row.getCell(33).value
  const loanFormulaNoCache = !!(loanRaw && typeof loanRaw === 'object' && loanRaw.formula && !('result' in loanRaw))
  const savingsFormulaNoCache = !!(savingsRaw && typeof savingsRaw === 'object' && savingsRaw.formula && !('result' in savingsRaw))
  const loan = round2(loanFormulaNoCache ? 0 : cleanNumeric(loanRaw))
  const savings = round2(savingsFormulaNoCache ? 0 : cleanNumeric(savingsRaw))
  if (!norm(name)) continue
  if (Math.abs(loan) < eps && Math.abs(savings) < eps) continue
  if (Math.abs(loan) < eps) sourceRows.push({ rowNo, name: String(name), reg: reg ?? '', loan: 0, savings, loanFormulaNoCache, savingsFormulaNoCache })
  else sourceRows.push({ rowNo, name: String(name), reg: reg ?? '', loan, savings, loanFormulaNoCache, savingsFormulaNoCache })
}

const SQL = await initSqlJs({ locateFile: file => `./node_modules/sql.js/dist/${file}` })
const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
const query = (sql, params = []) => {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  return rows
}
const exec = (sql, params = []) => {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  stmt.step()
  stmt.free()
}
const scalar = (sql, params = []) => query(sql, params)[0]?.value

const members = query(`SELECT * FROM members WHERE cooperative_id = ? AND COALESCE(is_deleted, '0') NOT IN ('1', 'true')`, [coopId])
const enterprises = query(`SELECT * FROM enterprise WHERE cooperative_id = ? AND COALESCE(is_deleted, '0') NOT IN ('1', 'true')`, [coopId])
const savingsEnt = enterprises.find(e => norm(e.account_type) === 'savings' && norm(e.account_name) === 'ordinary savings') || enterprises.find(e => norm(e.account_type) === 'savings')
const loanEnt = enterprises.find(e => norm(e.account_type) === 'loan' && norm(e.account_name) === 'ordinary loan') || enterprises.find(e => norm(e.account_type) === 'loan')
if (!savingsEnt || !loanEnt) throw new Error('Could not resolve Ordinary Savings and Ordinary Loan enterprises')

const byReg = new Map()
const byName = new Map()
const addName = (key, member) => { if (!key) return; if (!byName.has(key)) byName.set(key, []); byName.get(key).push(member) }
for (const member of members) {
  const reg = norm(member.registration_no)
  if (reg) byReg.set(reg, member)
  const pieces = [member.prefix, member.first_name, member.middle_name, member.last_name].filter(Boolean)
  addName(norm(pieces.join(' ')), member)
  addName(norm(pieces.filter((_, i) => i !== 0).join(' ')), member)
  addName(norm([member.first_name, member.last_name].filter(Boolean).join(' ')), member)
  addName(norm([member.last_name, member.first_name].filter(Boolean).join(' ')), member)
  addName(norm(member.last_name), member)
}

const matched = []
const unmatched = []
const ambiguous = []
for (const row of sourceRows) {
  let member = byReg.get(norm(row.reg))
  let method = member ? 'registration_no' : null
  if (!member) {
    const candidates = byName.get(norm(row.name)) || []
    const unique = [...new Map(candidates.map(m => [m.id, m])).values()]
    if (unique.length === 1) { member = unique[0]; method = 'normalized_name' }
    else if (unique.length > 1) { ambiguous.push({ ...row, candidates: unique.map(m => ({ id: m.id, registration_no: m.registration_no, first_name: m.first_name, last_name: m.last_name })) }); continue }
  }
  if (!member) { unmatched.push(row); continue }
  matched.push({ ...row, member, method })
}
if (ambiguous.length || unmatched.length) {
  throw new Error(`Member matching failed: ${ambiguous.length} ambiguous, ${unmatched.length} unmatched. Details in report would be incomplete.`)
}

// Preserve the exact pre-import database. A previous failed preflight may already
// have created this backup; it is reusable only if the live DB is still identical.
const liveBytes = fs.readFileSync(dbPath)
if (fs.existsSync(backupPath)) {
  const oldBackup = fs.readFileSync(backupPath)
  if (!oldBackup.equals(liveBytes)) throw new Error(`Existing backup is not identical to the current database: ${backupPath}`)
} else {
  fs.copyFileSync(dbPath, backupPath)
}

const priorOpeningIds = query(`SELECT id FROM remittance WHERE cooperative_id = ? AND description = ? AND remittance_date LIKE '2025-12-31%' AND is_deleted = 0`, [coopId, description])
if (priorOpeningIds.length) throw new Error(`Found ${priorOpeningIds.length} existing opening-balance rows with the same description/date; refusing duplicate append.`)

const remittanceCols = ['id','cooperative_id','member_id','amount','bank_name','description','transaction_type','category','status','remittance_date','created_by','created_at','modified_by','modified_at','is_deleted','is_synced','sync_at','deleted_at','reconciliation_summary_id','autogen','loan_id','isWithdrawalRequest','isLoanRequest','parent_remittance_id']
const detailCols = ['id','cooperative_id','remittance_id','enterprise_id','amount','auto_description','loan_info','created_by','created_at','modified_by','modified_at','is_synced','is_deleted','sync_at','deleted_at']
const insert = (table, cols, values) => {
  const placeholders = cols.map(() => '?').join(',')
  exec(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, values)
}

const created = []
let seq = 0
for (const row of matched) {
  const entries = []
  const savings = round2(row.savings)
  const loanDetail = round2(-row.loan)
  if (Math.abs(savings) >= eps) entries.push({ kind: 'SAV', amount: savings, type: 'Member Deposit', category: 'Member Liability', enterpriseId: savingsEnt.id })
  if (Math.abs(loanDetail) >= eps) entries.push({ kind: 'LOAN', amount: loanDetail, type: 'Member Loan', category: 'Loan Asset', enterpriseId: loanEnt.id })
  for (const entry of entries) {
    seq++
    const base = `${coopId}-20251231-BBF-${String(row.member.registration_no || row.member.id).replace(/[^A-Za-z0-9_-]/g, '')}-${entry.kind}`
    const id = `${base}-${seq}`
    const detailId = `${id}-D`
    insert('remittance', remittanceCols, [id, coopId, row.member.id, entry.amount, 'Opening Balance', description, entry.type, entry.category, 'Approved', remittanceDate, actor, stamp, actor, stamp, '0', '0', stamp, null, null, '0', null, '0', '0', null])
    insert('remittance_detail', detailCols, [detailId, coopId, id, entry.enterpriseId, entry.amount, '', null, actor, stamp, actor, stamp, '0', '0', stamp, null])
    created.push({ id, detailId, memberId: row.member.id, registrationNo: row.member.registration_no, name: row.name, type: entry.type, amount: entry.amount, sourceLoan: row.loan, sourceSavings: row.savings, sourceRow: row.rowNo })
  }
}

// Rebuild stored member balance fields for every affected member using the app's balance rule:
// Approved, live remittance details summed by enterprise; revenue enterprises excluded (none of the two member enterprises are revenue).
const affected = [...new Map(matched.map(x => [x.member.id, x.member])).values()]
for (const member of affected) {
  const rows = query(`
    SELECT rd.enterprise_id, SUM(CAST(rd.amount AS REAL)) AS sum_amount
    FROM remittance_detail rd JOIN remittance r ON r.id = rd.remittance_id
    WHERE r.cooperative_id = ? AND r.member_id = ? AND r.status = 'Approved'
      AND COALESCE(r.is_deleted, '0') NOT IN ('1', 'true')
      AND COALESCE(rd.is_deleted, '0') NOT IN ('1', 'true')
    GROUP BY rd.enterprise_id`, [coopId, member.id])
  const accountBalance = rows.map(r => {
    const ent = enterprises.find(e => String(e.id) === String(r.enterprise_id))
    return { id: r.enterprise_id, account_name: ent?.account_name || 'Unknown', sum_of_amount: round2(Number(r.sum_amount || 0)), is_synced: 1 }
  }).filter(x => Math.abs(x.sum_of_amount) >= eps)
  const total = round2(accountBalance.reduce((sum, x) => sum + x.sum_of_amount, 0))
  exec(`UPDATE members SET account_balance = ?, account_balance_total = ?, modified_at = ?, modified_by = ?, is_synced = '0' WHERE id = ? AND cooperative_id = ?`, [JSON.stringify(accountBalance), String(total), stamp, actor, member.id, coopId])
}

const out = db.export()
fs.writeFileSync(dbPath, Buffer.from(out))
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
const report = {
  sourceWorkbook: xlsxPath,
  database: dbPath,
  backup: backupPath,
  cooperativeId: coopId,
  description,
  remittanceDate,
  createdAt: stamp,
  modifiedAt: stamp,
  actor,
  rounding: 'two decimals; absolute values below 0.01 treated as zero',
  sourceRows: sourceRows.length,
  matchedMembers: affected.length,
  remittancesAppended: created.length,
  detailsAppended: created.length,
  savingsEnterprise: { id: savingsEnt.id, account_name: savingsEnt.account_name },
  loanEnterprise: { id: loanEnt.id, account_name: loanEnt.account_name },
  formulaCellsTreatedAsZero: { loan: sourceRows.filter(r => r.loanFormulaNoCache).length, savings: sourceRows.filter(r => r.savingsFormulaNoCache).length },
  totalSavingsAppended: round2(created.filter(x => x.type === 'Member Deposit').reduce((s, x) => s + x.amount, 0)),
  totalLoanDetailAppended: round2(created.filter(x => x.type === 'Member Loan').reduce((s, x) => s + x.amount, 0)),
  rows: created
}
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

// Independent validation against the written file.
const check = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
const checkQ = (sql, params = []) => { const st = check.prepare(sql); st.bind(params); const out=[]; while(st.step()) out.push(st.getAsObject()); st.free(); return out }
const validation = {
  openingRows: checkQ(`SELECT COUNT(*) AS n FROM remittance WHERE cooperative_id = ? AND description = ? AND remittance_date = ? AND is_deleted = 0`, [coopId, description, remittanceDate])[0].n,
  openingDetails: checkQ(`SELECT COUNT(*) AS n FROM remittance_detail WHERE cooperative_id = ? AND remittance_id IN (SELECT id FROM remittance WHERE cooperative_id = ? AND description = ? AND remittance_date = ? AND is_deleted = 0) AND is_deleted = 0`, [coopId, coopId, description, remittanceDate])[0].n,
  approvedOpeningRows: checkQ(`SELECT COUNT(*) AS n FROM remittance WHERE cooperative_id = ? AND description = ? AND remittance_date = ? AND status = 'Approved' AND is_deleted = 0`, [coopId, description, remittanceDate])[0].n,
  duplicateIds: checkQ(`SELECT id, COUNT(*) AS n FROM remittance GROUP BY id HAVING COUNT(*) > 1`).length,
  databaseBytes: fs.statSync(dbPath).size,
  backupBytes: fs.statSync(backupPath).size
}
report.validation = validation
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...validation, matchedMembers: affected.length, remittancesAppended: created.length, totalSavingsAppended: report.totalSavingsAppended, totalLoanDetailAppended: report.totalLoanDetailAppended, reportPath, backupPath }, null, 2))
