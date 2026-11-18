import fs from 'node:fs';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

const targetPath = 'C:/Users/USER/Downloads/new.db';
const rollbackPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/new-before-unassigned-cleanup.db';
const preparedPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/new-without-unassigned-remittances.db';
const auditPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/unassigned-remittance-cleanup-audit.json';
const expectedCount = 4;

const SQL = await initSqlJs();
const sourceBytes = fs.readFileSync(targetPath);
const source = new SQL.Database(new Uint8Array(sourceBytes));
const db = new SQL.Database(new Uint8Array(sourceBytes));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const all = (database, query, params = []) => {
    const stmt = database.prepare(query);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
};
const scalar = (database, query) => all(database, query)[0] ?? {};
const tables = database => all(database, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => row.name);
const counts = database => Object.fromEntries(tables(database).map(name => [name, Number(scalar(database, `SELECT COUNT(*) AS n FROM ${quote(name)}`).n)]));
const schema = database => all(database, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name");
const rows = (database, table) => database.exec(`SELECT * FROM ${quote(table)} ORDER BY rowid`)[0]?.values ?? [];

if (fs.existsSync(rollbackPath)) throw new Error(`Rollback file already exists: ${rollbackPath}`);
const sourceHash = sha256(sourceBytes);
const beforeCounts = counts(source);

const orphanLegs = all(db, `
    SELECT r.id AS remittance_id, r.cooperative_id, r.member_id, r.amount AS header_amount,
           r.status, r.is_deleted AS remittance_is_deleted, r.transaction_type,
           r.category, r.remittance_date, r.description, r.bank_name,
           d.id AS detail_id, d.amount AS detail_amount, d.enterprise_id,
           e.id AS found_enterprise_id, e.is_deleted AS enterprise_is_deleted,
           m.id AS found_member_id
    FROM remittance r
    JOIN remittance_detail d ON d.remittance_id = r.id
    LEFT JOIN enterprise e ON e.id = d.enterprise_id
    LEFT JOIN members m ON m.id = r.member_id AND m.cooperative_id = r.cooperative_id
    WHERE CAST(COALESCE(r.is_deleted, 0) AS INTEGER) = 0
      AND r.status = 'Approved'
      AND CAST(COALESCE(r.amount, 0) AS REAL) <> 0
      AND CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
      AND CAST(COALESCE(d.amount, 0) AS REAL) <> 0
      AND m.id IS NOT NULL
      AND (e.id IS NULL OR CAST(COALESCE(e.is_deleted, 0) AS INTEGER) <> 0)
    ORDER BY r.id, d.id`);

const candidateIds = [...new Set(orphanLegs.map(row => String(row.remittance_id)))].sort();
if (candidateIds.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} unassigned remittances with nonzero details; found ${candidateIds.length}. No output was written.`);
}

const candidateRows = [];
for (const id of candidateIds) {
    const remittance = orphanLegs.find(row => String(row.remittance_id) === id);
    const details = all(db, `
        SELECT d.id, d.amount, d.enterprise_id, d.is_deleted,
               e.id AS found_enterprise_id, e.is_deleted AS enterprise_is_deleted
        FROM remittance_detail d
        LEFT JOIN enterprise e ON e.id = d.enterprise_id
        WHERE d.remittance_id = ?`, [id]);
    const validNonzero = details.filter(d => Number(d.is_deleted || 0) === 0
        && Number(d.amount || 0) !== 0
        && d.found_enterprise_id != null
        && Number(d.enterprise_is_deleted || 0) === 0);
    if (validNonzero.length) throw new Error(`Remittance ${id} also has assigned nonzero detail legs; refusing to delete its full remittance.`);

    const refs = {
        loans: Number(scalar(db, `SELECT COUNT(*) AS n FROM loans WHERE remittance_id = '${id.replaceAll("'", "''")}'`).n),
        children: Number(scalar(db, `SELECT COUNT(*) AS n FROM remittance WHERE parent_remittance_id = '${id.replaceAll("'", "''")}'`).n),
        loanIdRefs: Number(scalar(db, `SELECT COUNT(*) AS n FROM remittance WHERE loan_id = '${id.replaceAll("'", "''")}'`).n)
    };
    if (Object.values(refs).some(Boolean)) throw new Error(`Remittance ${id} has dependent loan/child records: ${JSON.stringify(refs)}.`);
    candidateRows.push({ ...remittance, details, refs });
}

const detailIds = orphanLegs.map(row => String(row.detail_id));
const deleteDetail = db.prepare('DELETE FROM remittance_detail WHERE id = ?');
for (const id of detailIds) {
    deleteDetail.run([id]);
    if (db.getRowsModified() !== 1) throw new Error(`Expected to remove one unassigned detail row ${id}.`);
}
deleteDetail.free();

const deleteRemittance = db.prepare('DELETE FROM remittance WHERE id = ?');
for (const id of candidateIds) {
    deleteRemittance.run([id]);
    if (db.getRowsModified() !== 1) throw new Error(`Expected to remove one unassigned remittance ${id}.`);
}
deleteRemittance.free();

const preparedBytes = db.export();
fs.writeFileSync(preparedPath, preparedBytes);
const checkDb = new SQL.Database(new Uint8Array(fs.readFileSync(preparedPath)));
const integrity = scalar(checkDb, 'PRAGMA integrity_check').integrity_check;
if (String(integrity).toLowerCase() !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
const fk = checkDb.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
if (fk.length) throw new Error(`SQLite foreign key check found ${fk.length} issue(s).`);
if (JSON.stringify(schema(source)) !== JSON.stringify(schema(checkDb))) throw new Error('Database schema changed.');

const afterCounts = counts(checkDb);
for (const table of Object.keys(beforeCounts)) {
    const removeCount = table === 'remittance' ? candidateIds.length : table === 'remittance_detail' ? detailIds.length : 0;
    if (afterCounts[table] !== beforeCounts[table] - removeCount) throw new Error(`Unexpected ${table} count: ${afterCounts[table]}.`);
    if (table !== 'remittance' && table !== 'remittance_detail') {
        if (JSON.stringify(rows(source, table)) !== JSON.stringify(rows(checkDb, table))) throw new Error(`Unexpected changes in table ${table}.`);
        continue;
    }
    const remove = new Set(table === 'remittance' ? candidateIds : detailIds);
    const columns = source.exec(`PRAGMA table_info(${quote(table)})`)[0].values.map(column => column[1]);
    const idIndex = columns.indexOf('id');
    const unchanged = rows(source, table).filter(row => !remove.has(String(row[idIndex])));
    if (JSON.stringify(unchanged) !== JSON.stringify(rows(checkDb, table))) throw new Error(`Unexpected edits in ${table}.`);
}

const remaining = all(checkDb, `
    SELECT COUNT(*) AS n
    FROM remittance r JOIN remittance_detail d ON d.remittance_id = r.id
    LEFT JOIN enterprise e ON e.id = d.enterprise_id
    LEFT JOIN members m ON m.id = r.member_id AND m.cooperative_id = r.cooperative_id
    WHERE CAST(COALESCE(r.is_deleted, 0) AS INTEGER) = 0
      AND r.status = 'Approved'
      AND CAST(COALESCE(r.amount, 0) AS REAL) <> 0
      AND CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
      AND CAST(COALESCE(d.amount, 0) AS REAL) <> 0
      AND m.id IS NOT NULL
      AND (e.id IS NULL OR CAST(COALESCE(e.is_deleted, 0) AS INTEGER) <> 0)`);
if (Number(remaining[0]?.n || 0)) throw new Error(`${remaining[0].n} qualifying unassigned remittance detail rows remain.`);

const audit = {
    targetPath,
    rollbackPath,
    preparedPath,
    sourceSha256: sourceHash,
    preparedSha256: sha256(preparedBytes),
    deletedRemittanceCount: candidateIds.length,
    deletedDetailRowCount: detailIds.length,
    remittances: candidateRows.map(row => ({
        id: row.remittance_id,
        date: row.remittance_date,
        memberId: row.member_id,
        headerAmount: row.header_amount,
        description: row.description,
        transactionType: row.transaction_type,
        category: row.category,
        removedDetails: row.details.map(detail => ({ id: detail.id, enterpriseId: detail.enterprise_id, amount: detail.amount })),
        dependentReferences: row.refs
    })),
    tableCountsBefore: beforeCounts,
    tableCountsAfter: afterCounts,
    integrity,
    foreignKeyIssues: fk.length,
    verification: 'Deleted only approved, nonzero-header member remittances whose active nonzero detail legs had no valid enterprise assignment; all other records and schema preserved.'
};
fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8');
fs.writeFileSync(rollbackPath, sourceBytes);
if (sha256(fs.readFileSync(rollbackPath)) !== sourceHash) throw new Error('Rollback copy hash mismatch.');
console.log(JSON.stringify({
    preparedPath,
    rollbackPath,
    auditPath,
    sourceSha256: sourceHash,
    preparedSha256: audit.preparedSha256,
    deletedRemittanceCount: candidateIds.length,
    deletedDetailRowCount: detailIds.length,
    remittancesBefore: beforeCounts.remittance,
    remittancesAfter: afterCounts.remittance,
    detailsBefore: beforeCounts.remittance_detail,
    detailsAfter: afterCounts.remittance_detail,
    integrity,
    foreignKeyIssues: fk.length
}, null, 2));
