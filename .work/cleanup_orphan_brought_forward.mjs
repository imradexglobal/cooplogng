import fs from 'node:fs';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

const targetPath = 'C:/Users/USER/Downloads/new.db';
const backupPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/new-before-orphan-cleanup.db';
const preparedPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/new-orphan-cleaned.db';
const auditPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/orphan-cleanup-audit.json';
const openingDate = '2025-12-31';
const expectedOrphanDetailCount = 113;
const expectedRemittanceCount = 113;

const SQL = await initSqlJs();
const sourceBytes = fs.readFileSync(targetPath);
const sourceDb = new SQL.Database(new Uint8Array(sourceBytes));
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
const scalar = (database, query, params = []) => all(database, query, params)[0] ?? {};
const schemaRows = database => all(database,
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name");
const tableNames = database => all(database,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => row.name);
const tableCounts = database => Object.fromEntries(tableNames(database).map(name => [
    name,
    Number(scalar(database, `SELECT COUNT(*) AS n FROM ${quote(name)}`).n)
]));
const rowSet = (database, table) => {
    try { return database.exec(`SELECT * FROM ${quote(table)} ORDER BY rowid`)[0]?.values ?? []; }
    catch { return database.exec(`SELECT * FROM ${quote(table)}`)[0]?.values ?? []; }
};
const bfWhere = `date(r.remittance_date) = ?
    AND r.transaction_type IN ('Opening Member Savings', 'Opening Member Loan')
    AND (
        lower(COALESCE(r.description, '')) LIKE '%bf%'
        OR lower(COALESCE(r.description, '')) LIKE '%b/f%'
        OR lower(COALESCE(r.description, '')) LIKE '%brought forward%'
        OR lower(COALESCE(r.description, '')) LIKE '%opening bal%'
    )`;

if (fs.existsSync(backupPath)) throw new Error(`Refusing to overwrite existing rollback file: ${backupPath}`);
const sourceHash = sha256(sourceBytes);
const sourceCounts = tableCounts(sourceDb);

const orphanDetails = all(db, `
    SELECT d.id AS detail_id, d.remittance_id, d.enterprise_id, d.amount,
           r.member_id, r.transaction_type, r.amount AS header_amount, r.description,
           e.id AS matched_enterprise_id, e.is_deleted AS enterprise_is_deleted
    FROM remittance r
    JOIN remittance_detail d ON d.remittance_id = r.id
    LEFT JOIN enterprise e ON e.id = d.enterprise_id
    WHERE ${bfWhere}
      AND CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
      AND (e.id IS NULL OR CAST(COALESCE(e.is_deleted, 0) AS INTEGER) <> 0)
    ORDER BY r.id, d.id`, [openingDate]);
if (orphanDetails.length !== expectedOrphanDetailCount) {
    throw new Error(`Expected ${expectedOrphanDetailCount} orphan detail rows, found ${orphanDetails.length}. No output was written.`);
}

const affectedIds = [...new Set(orphanDetails.map(row => String(row.remittance_id)))].sort();
const preDeleteRemittances = all(db, `
    SELECT r.id, r.member_id, r.cooperative_id, r.transaction_type, r.category,
           r.amount, r.description, r.status, r.is_deleted,
           m.id AS matched_member_id,
           (SELECT COUNT(*) FROM loans l WHERE l.remittance_id = r.id) AS linked_loans,
           (SELECT COUNT(*) FROM remittance c WHERE c.parent_remittance_id = r.id) AS child_remittances,
           (SELECT COUNT(*) FROM remittance c WHERE c.loan_id = r.id) AS loan_id_references
    FROM remittance r
    LEFT JOIN members m ON m.id = r.member_id AND m.cooperative_id = r.cooperative_id
    WHERE r.id IN (${affectedIds.map(() => '?').join(',')})
    ORDER BY r.id`, affectedIds);
if (preDeleteRemittances.length !== affectedIds.length) throw new Error('An affected parent remittance is missing.');
for (const row of preDeleteRemittances) {
    if (row.matched_member_id == null || Number(row.amount) === 0) {
        throw new Error(`Affected entry ${row.id} does not meet the member/nonzero-header deletion rule.`);
    }
    if (Number(row.linked_loans) || Number(row.child_remittances) || Number(row.loan_id_references)) {
        throw new Error(`Affected remittance ${row.id} has linked loan/child records; refusing to delete it blindly.`);
    }
}

const detailIds = orphanDetails.map(row => String(row.detail_id));
const removeDetails = db.prepare('DELETE FROM remittance_detail WHERE id = ?');
for (const id of detailIds) {
    removeDetails.run([id]);
    if (db.getRowsModified() !== 1) throw new Error(`Expected to remove exactly one orphan detail row (${id}).`);
}
removeDetails.free();

// Per instruction, a non-zero member brought-forward transaction whose
// remaining detail legs net to zero is removed in full, along with all of its
// detail rows. Amount comparisons use cents tolerance.
const zeroNetRemittances = all(db, `
    SELECT r.id, r.member_id, r.cooperative_id, r.transaction_type, r.category,
           r.amount AS header_amount, r.description,
           COUNT(CASE WHEN CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0 THEN d.id END) AS remaining_active_detail_count,
           ROUND(SUM(CASE WHEN CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
                          THEN CAST(COALESCE(d.amount, 0) AS REAL) ELSE 0 END), 2) AS remaining_detail_total,
           m.id AS matched_member_id,
           (SELECT COUNT(*) FROM loans l WHERE l.remittance_id = r.id) AS linked_loans,
           (SELECT COUNT(*) FROM remittance c WHERE c.parent_remittance_id = r.id) AS child_remittances,
           (SELECT COUNT(*) FROM remittance c WHERE c.loan_id = r.id) AS loan_id_references
    FROM remittance r
    LEFT JOIN remittance_detail d ON d.remittance_id = r.id
    LEFT JOIN members m ON m.id = r.member_id AND m.cooperative_id = r.cooperative_id
    WHERE ${bfWhere}
    GROUP BY r.id
    HAVING matched_member_id IS NOT NULL
       AND CAST(COALESCE(r.amount, 0) AS REAL) <> 0
       AND ABS(COALESCE(remaining_detail_total, 0)) < 0.005
    ORDER BY r.id`, [openingDate]);
if (zeroNetRemittances.length !== expectedRemittanceCount) {
    throw new Error(`Expected ${expectedRemittanceCount} zero-net member brought-forward remittances, found ${zeroNetRemittances.length}. No output was written.`);
}
for (const row of zeroNetRemittances) {
    if (Number(row.linked_loans) || Number(row.child_remittances) || Number(row.loan_id_references)) {
        throw new Error(`Zero-net remittance ${row.id} has linked loan/child records; refusing to delete it blindly.`);
    }
}

const deletedIds = zeroNetRemittances.map(row => String(row.id));
if (deletedIds.some(id => !affectedIds.includes(id))) {
    throw new Error('At least one zero-net remittance did not originate from an orphaned brought-forward detail.');
}
const delParent = db.prepare('DELETE FROM remittance WHERE id = ?');
for (const id of deletedIds) {
    delParent.run([id]);
    if (db.getRowsModified() !== 1) throw new Error(`Expected to remove exactly one remittance (${id}).`);
}
delParent.free();

const preparedBytes = db.export();
fs.writeFileSync(preparedPath, preparedBytes);
const preparedDb = new SQL.Database(new Uint8Array(fs.readFileSync(preparedPath)));
const integrity = scalar(preparedDb, 'PRAGMA integrity_check').integrity_check;
if (String(integrity).toLowerCase() !== 'ok') throw new Error(`Prepared cleanup database integrity failed: ${integrity}`);
const foreignKeyIssues = preparedDb.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
if (foreignKeyIssues.length) throw new Error(`Prepared cleanup database has ${foreignKeyIssues.length} foreign-key issue(s).`);
if (JSON.stringify(schemaRows(sourceDb)) !== JSON.stringify(schemaRows(preparedDb))) throw new Error('Database schema changed.');

const afterCounts = tableCounts(preparedDb);
for (const table of Object.keys(sourceCounts)) {
    const expected = sourceCounts[table]
        - (table === 'remittance' ? deletedIds.length : 0)
        - (table === 'remittance_detail' ? detailIds.length : 0);
    if (afterCounts[table] !== expected) throw new Error(`Unexpected row count for ${table}: expected ${expected}, got ${afterCounts[table]}.`);
    const beforeRows = rowSet(sourceDb, table);
    const afterRows = rowSet(preparedDb, table);
    if (table !== 'remittance' && table !== 'remittance_detail') {
        if (JSON.stringify(beforeRows) !== JSON.stringify(afterRows)) throw new Error(`Unexpected data changes in ${table}.`);
        continue;
    }
    const removed = new Set(table === 'remittance' ? deletedIds : detailIds);
    const pk = table === 'remittance' ? 'id' : 'id';
    const columns = sourceDb.exec(`PRAGMA table_info(${quote(table)})`)[0].values.map(column => column[1]);
    const pkIndex = columns.indexOf(pk);
    const expectedRows = beforeRows.filter(row => !removed.has(String(row[pkIndex])));
    if (JSON.stringify(expectedRows) !== JSON.stringify(afterRows)) throw new Error(`Unexpected field edits or deletions in ${table}.`);
}

const remainingIssues = all(preparedDb, `
    SELECT r.id, r.amount, r.description,
           COUNT(CASE WHEN CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0 THEN d.id END) AS active_details,
           ROUND(SUM(CASE WHEN CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
                          THEN CAST(COALESCE(d.amount, 0) AS REAL) ELSE 0 END), 2) AS detail_total
    FROM remittance r
    LEFT JOIN remittance_detail d ON d.remittance_id = r.id
    LEFT JOIN members m ON m.id = r.member_id AND m.cooperative_id = r.cooperative_id
    WHERE ${bfWhere}
      AND m.id IS NOT NULL
      AND CAST(COALESCE(r.amount, 0) AS REAL) <> 0
    GROUP BY r.id
    HAVING ABS(COALESCE(detail_total, 0)) < 0.005`, [openingDate]);
if (remainingIssues.length) throw new Error(`${remainingIssues.length} nonzero member brought-forward entries still have zero-net details.`);

const remainingOrphans = all(preparedDb, `
    SELECT d.id
    FROM remittance r JOIN remittance_detail d ON d.remittance_id = r.id
    LEFT JOIN enterprise e ON e.id = d.enterprise_id
    WHERE ${bfWhere}
      AND CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
      AND (e.id IS NULL OR CAST(COALESCE(e.is_deleted, 0) AS INTEGER) <> 0)`, [openingDate]);
if (remainingOrphans.length) throw new Error(`${remainingOrphans.length} orphan brought-forward details remain.`);

const audit = {
    targetPath,
    rollbackCopyPath: backupPath,
    preparedPath,
    openingDate,
    sourceSha256: sourceHash,
    preparedSha256: sha256(preparedBytes),
    removedOrphanDetailCount: detailIds.length,
    removedRemittanceCount: deletedIds.length,
    removedOrphanDetailRows: orphanDetails.map(row => ({ detailId: row.detail_id, remittanceId: row.remittance_id, enterpriseId: row.enterprise_id, amount: row.amount })),
    removedRemittances: zeroNetRemittances.map(row => ({
        id: row.id,
        memberId: row.member_id,
        transactionType: row.transaction_type,
        headerAmount: row.header_amount,
        description: row.description,
        remainingDetailCountAfterOrphanRemoval: row.remaining_active_detail_count,
        remainingDetailTotalAfterOrphanRemoval: row.remaining_detail_total
    })),
    tableCountsBefore: sourceCounts,
    tableCountsAfter: afterCounts,
    integrity,
    foreignKeyIssues: foreignKeyIssues.length,
    verification: 'Only the listed orphan brought-forward detail rows and their listed zero-net nonzero-member-header remittances were removed. All remaining table rows and schema are byte-value equivalent.'
};
fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8');

// Keep the pre-cleanup database so the user can roll this exact deletion back.
fs.writeFileSync(backupPath, sourceBytes);
if (sha256(fs.readFileSync(backupPath)) !== sourceHash) throw new Error('Rollback copy hash mismatch.');
console.log(JSON.stringify({
    preparedPath,
    backupPath,
    auditPath,
    sourceSha256: sourceHash,
    preparedSha256: audit.preparedSha256,
    removedOrphanDetailCount: detailIds.length,
    removedRemittanceCount: deletedIds.length,
    remittanceRowsBefore: sourceCounts.remittance,
    remittanceRowsAfter: afterCounts.remittance,
    remittanceDetailRowsBefore: sourceCounts.remittance_detail,
    remittanceDetailRowsAfter: afterCounts.remittance_detail,
    integrity,
    foreignKeyIssues: foreignKeyIssues.length
}, null, 2));
