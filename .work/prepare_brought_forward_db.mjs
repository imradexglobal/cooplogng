import fs from 'node:fs';
import crypto from 'node:crypto';
import initSqlJs from 'sql.js';

const sourcePath = 'C:/Users/USER/Downloads/cooperative_backup_2026-11-17T20-47.db';
const preparedPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/prepared-new.db';
const auditPath = 'C:/Users/USER/Documents/Imradex_Project/cooplogng/.work/brought-forward-migration-audit.json';
const openingDate = '2025-12-31';
const expectedCandidateCount = 332;

const sql = await initSqlJs();
const sourceBytes = fs.readFileSync(sourcePath);
const sourceDb = new sql.Database(new Uint8Array(sourceBytes));
const db = new sql.Database(new Uint8Array(sourceBytes));

const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const scalar = (database, query, params = []) => {
    const stmt = database.prepare(query);
    stmt.bind(params);
    const value = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return value;
};
const all = (database, query, params = []) => {
    const stmt = database.prepare(query);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
};
const countTables = database => Object.fromEntries(all(database,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map(({ name }) => [name, Number(scalar(database, `SELECT COUNT(*) AS n FROM ${quote(name)}`).n)]));
const schemaRows = database => all(database,
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name");
const rowSet = (database, table) => {
    try { return database.exec(`SELECT * FROM ${quote(table)} ORDER BY rowid`)[0]?.values ?? []; }
    catch { return database.exec(`SELECT * FROM ${quote(table)}`)[0]?.values ?? []; }
};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const candidates = all(db, `
    SELECT id, remittance_date, transaction_type, category, amount, bank_name,
           description, status, is_deleted
    FROM remittance
    WHERE date(remittance_date) = ?
      AND (
        lower(COALESCE(description, '')) LIKE '%bf%'
        OR lower(COALESCE(description, '')) LIKE '%b/f%'
        OR lower(COALESCE(description, '')) LIKE '%brought forward%'
        OR lower(COALESCE(description, '')) LIKE '%balance_end of 2025%'
      )
    ORDER BY id`, [openingDate]);

if (candidates.length !== expectedCandidateCount) {
    throw new Error(`Expected ${expectedCandidateCount} explicit year-end brought-forward rows; found ${candidates.length}. No output was written.`);
}

const changes = [];
for (const row of candidates) {
    const description = String(row.description || '');
    let transactionType;
    let category;
    let mappingReason;

    if (/^Bank\/General Asset$/i.test(String(row.transaction_type || ''))
        && /Bank Balance_end of 2025/i.test(description)
        && String(row.bank_name || '') !== 'Internal Transfer') {
        transactionType = 'Opening Bank Balance';
        category = 'Equity';
        mappingReason = 'year-end bank balance -> app Opening Bank Balance / Equity';
        const details = Number(scalar(db,
            'SELECT COUNT(*) AS n FROM remittance_detail WHERE remittance_id = ?', [row.id]).n);
        if (details !== 0) throw new Error(`Bank opening row ${row.id} unexpectedly has ${details} detail rows.`);
    } else if (row.transaction_type === 'Member Deposit') {
        transactionType = 'Opening Member Savings';
        category = 'Member Liability';
        mappingReason = 'legacy Member Deposit brought forward -> app Opening Member Savings';
    } else if (row.transaction_type === 'Member Loan') {
        transactionType = 'Opening Member Loan';
        category = 'Loan Asset';
        mappingReason = 'legacy Member Loan brought forward -> app Opening Member Loan';
    } else if (row.transaction_type === 'Internal Transfer') {
        const detailKinds = all(db, `
            SELECT DISTINCT e.account_type
            FROM remittance_detail d
            LEFT JOIN enterprise e ON e.id = d.enterprise_id
            WHERE d.remittance_id = ? AND CAST(COALESCE(d.is_deleted, 0) AS INTEGER) = 0
              AND e.account_type IN ('Savings', 'Loan')`, [row.id])
            .map(({ account_type }) => String(account_type));
        // The legacy generic transfer rows can carry several member-account
        // detail legs. The current app uses either special opening-member type
        // as the conversion marker and posts each detail to its own enterprise
        // account with an offsetting Opening Balance Equity leg. Use the loan
        // type only for loan-only detail sets; mixed/savings/unknown sets use
        // the savings marker. The underlying detail rows are left untouched.
        const loanOnly = detailKinds.includes('Loan') && !detailKinds.includes('Savings');
        transactionType = loanOnly ? 'Opening Member Loan' : 'Opening Member Savings';
        category = loanOnly ? 'Loan Asset' : 'Member Liability';
        mappingReason = loanOnly
            ? 'legacy generic B/F with loan-only detail -> app Opening Member Loan'
            : 'legacy generic B/F with savings, mixed, or unresolved detail -> app Opening Member Savings';
    } else {
        throw new Error(`Unclassified brought-forward candidate ${row.id}: ${row.transaction_type} / ${row.category} / ${description}`);
    }

    changes.push({
        id: String(row.id), oldType: row.transaction_type, oldCategory: row.category,
        newType: transactionType, newCategory: category,
        description, mappingReason
    });
}

const update = db.prepare('UPDATE remittance SET transaction_type = ?, category = ? WHERE id = ?');
for (const change of changes) {
    update.run([change.newType, change.newCategory, change.id]);
    if (db.getRowsModified() !== 1) throw new Error(`Expected to update exactly one remittance for ${change.id}.`);
}
update.free();

const preparedBytes = db.export();
fs.writeFileSync(preparedPath, preparedBytes);

const reopened = new sql.Database(fs.readFileSync(preparedPath));
const integrity = scalar(reopened, 'PRAGMA integrity_check');
if (String(integrity.integrity_check).toLowerCase() !== 'ok') {
    throw new Error(`Prepared database integrity check failed: ${JSON.stringify(integrity)}`);
}
const foreignKeyIssues = reopened.exec('PRAGMA foreign_key_check')[0]?.values ?? [];
if (foreignKeyIssues.length) throw new Error(`Foreign key check returned ${foreignKeyIssues.length} issue(s).`);

const sourceTables = countTables(sourceDb);
const preparedTables = countTables(reopened);
if (JSON.stringify(sourceTables) !== JSON.stringify(preparedTables)) {
    throw new Error('Table row counts changed; refusing to use prepared database.');
}
if (JSON.stringify(schemaRows(sourceDb)) !== JSON.stringify(schemaRows(reopened))) {
    throw new Error('Database schema changed; refusing to use prepared database.');
}

// Verify every row in every table is identical except for transaction_type and
// category on the selected remittance IDs.
const changedIds = new Map(changes.map(change => [change.id, change]));
for (const table of Object.keys(sourceTables)) {
    const beforeRows = rowSet(sourceDb, table);
    const afterRows = rowSet(reopened, table);
    if (beforeRows.length !== afterRows.length) throw new Error(`Row count changed in ${table}.`);
    if (table !== 'remittance') {
        if (JSON.stringify(beforeRows) !== JSON.stringify(afterRows)) throw new Error(`Unexpected data change in ${table}.`);
        continue;
    }
    const columns = sourceDb.exec(`PRAGMA table_info(${quote(table)})`)[0].values.map(column => column[1]);
    const idIndex = columns.indexOf('id');
    const typeIndex = columns.indexOf('transaction_type');
    const categoryIndex = columns.indexOf('category');
    for (let i = 0; i < beforeRows.length; i += 1) {
        const before = beforeRows[i];
        const after = afterRows[i];
        if (String(before[idIndex]) !== String(after[idIndex])) throw new Error('Remittance row ordering/identity changed.');
        const change = changedIds.get(String(before[idIndex]));
        for (let j = 0; j < before.length; j += 1) {
            const expected = change && j === typeIndex ? change.newType
                : change && j === categoryIndex ? change.newCategory
                    : before[j];
            if (after[j] !== expected) throw new Error(`Unexpected remittance field change for ${before[idIndex]}, column ${columns[j]}.`);
        }
    }
}

const typeCounts = {};
for (const change of changes) typeCounts[change.newType] = (typeCounts[change.newType] || 0) + 1;
const audit = {
    sourcePath,
    preparedPath,
    openingDate,
    sourceSha256: sha256(sourceBytes),
    preparedSha256: sha256(preparedBytes),
    changedRows: changes.length,
    typeCounts,
    tableCounts: preparedTables,
    sourceIntegrity: scalar(sourceDb, 'PRAGMA integrity_check'),
    preparedIntegrity: integrity,
    foreignKeyIssues: foreignKeyIssues.length,
    verification: 'All table schemas and row counts preserved; every database value is unchanged except transaction_type/category on the listed brought-forward remittance IDs.',
    changes
};
fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8');
console.log(JSON.stringify({
    preparedPath,
    auditPath,
    changedRows: changes.length,
    typeCounts,
    remittanceRows: preparedTables.remittance,
    detailRows: preparedTables.remittance_detail,
    integrity: integrity.integrity_check,
    foreignKeyIssues: foreignKeyIssues.length,
    sourceSha256: audit.sourceSha256,
    preparedSha256: audit.preparedSha256
}, null, 2));
