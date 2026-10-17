import { getAllItems, getAllByIndex, getItem, clearAllStores, initIndexedDb, listStores } from '../indexedDbService.js'
import { TABLES, TABLE_COLUMNS } from './constants.js'
import { colType, safeVal } from './helpers.js'
import { upsertMany } from './mutationEngine.js'
// NOTE: sql.js (and its .wasm URL below) is intentionally NOT statically
// imported. The static import pulled the ~1MB SQL engine into the startup
// bundle even though the running app uses IndexedDB — it is only needed for
// backup export/import. It is dynamically imported on first use instead.
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/**
 * Reads backup rows from a store, optionally scoped to a single cooperative.
 * Tables that carry a cooperative_id are filtered to the active coop (using the
 * index when present, otherwise a full scan); the cooperatives table is matched
 * by its own id; global key/value stores are returned unfiltered. Soft-deleted
 * rows are kept so a restore preserves the original state.
 */
async function getRowsForCoop(table, cooperativeId) {
    if (!cooperativeId) return getAllItems(table);

    if (table === 'cooperatives') {
        const coop = await getItem('cooperatives', cooperativeId);
        return coop ? [coop] : [];
    }

    const cols = TABLE_COLUMNS[table] || [];
    if (!cols.includes('cooperative_id')) {
        // Global store (app_settings) — holds auth sessions and transient sync
        // context, not cooperative data. Exclude it from a scoped backup.
        return [];
    }

    try {
        const indexed = await getAllByIndex(table, 'cooperative_id', cooperativeId);
        if (indexed && indexed.length > 0) return indexed;
        // Empty (or key-type mismatch) — fall through to an exact scan.
    } catch (e) {
        // Store has no cooperative_id index (e.g. remittance_detail) — scan.
    }
    const all = await getAllItems(table);
    return all.filter(r => String(r.cooperative_id) === cooperativeId);
}

export async function exportDatabase(cooperativeId) {
    const SQL = await getSqlJs();
    const db = new SQL.Database();
    const scopeCoopId = cooperativeId != null && cooperativeId !== '' ? String(cooperativeId) : null;

    // Skip stores missing from stale on-device databases instead of aborting
    // the whole backup with "object store not found". The v6 schema upgrade
    // recreates them on next load; the skip list tells the user about it.
    let available = [];
    try {
        available = await listStores();
    } catch (e) {
        console.warn('[exportDatabase] Could not list stores, trying all tables:', e && e.message);
        available = TABLES.slice();
    }
    const present = new Set(available);
    const exported = [];
    const skipped = [];

    for (const table of TABLES) {
        if (!present.has(table)) {
            skipped.push(table);
            continue;
        }
        const rows = await getRowsForCoop(table, scopeCoopId);
        const cols = TABLE_COLUMNS[table];
        if (!cols || cols.length === 0) continue;

        const colDefs = cols.map(c => `"${c}" TEXT`);
        db.run(`CREATE TABLE IF NOT EXISTS "${table}" (${colDefs.join(', ')})`);

        if (rows.length === 0) { exported.push({ table, rows: 0 }); continue; }

        const placeholders = cols.map(() => '?').join(', ');
        const stmt = db.prepare(`INSERT INTO "${table}" VALUES (${placeholders})`);

        for (const row of rows) {
            const values = cols.map(c => safeVal(row[c]));
            stmt.run(values);
        }
        stmt.free();
        exported.push({ table, rows: rows.length });
    }

    const uint8 = db.export();
    db.close();
    return { buffer: uint8.buffer, exported, skipped };
}

const FORCE_STRING_COLS = new Set([
    'id', 'cooperative_id', 'member_id', 'enterprise_id', 'user_id', 
    'remittance_id', 'loan_id', 'admin_fee_id', 'reconciliation_summary_id', 
    'mobile', 'nok_mobile', 'account_number', 'registration_no', 
    'special_id', 'swift_code', 'password_hash', 'firebase_uid', 
    'device_id', 'ip_address'
]);

export async function importDatabase(arrayBuffer, currentCooperativeId) {
    const SQL = await getSqlJs();
    const uint8 = new Uint8Array(arrayBuffer);
    const db = new SQL.Database(uint8);

    // Validate that the backup belongs to the current cooperative
    try {
        let backupCoopId = null;
        try {
            const coopsResult = db.exec(`SELECT id FROM cooperatives LIMIT 1`);
            if (coopsResult.length > 0 && coopsResult[0].values.length > 0) {
                backupCoopId = String(coopsResult[0].values[0][0]);
            }
        } catch (e) {
            // cooperatives table might not exist
        }

        if (!backupCoopId) {
            try {
                const membersResult = db.exec(`SELECT cooperative_id FROM members LIMIT 1`);
                if (membersResult.length > 0 && membersResult[0].values.length > 0) {
                    backupCoopId = String(membersResult[0].values[0][0]);
                }
            } catch (e) {
                // members table might not exist
            }
        }

        if (backupCoopId && backupCoopId !== String(currentCooperativeId)) {
            throw new Error(`Cooperative ID mismatch. Backup belongs to cooperative "${backupCoopId}", but current session is for cooperative "${currentCooperativeId}".`);
        }
    } catch (validationErr) {
        db.close();
        throw validationErr;
    }

    const tables = [
        'enterprise', 'bank', 'members', 'users', 'remittance',
        'remittance_detail', 'loans', 'loan_guarantors', 'payment_advise',
        'transaction_types', 'bank_reconciliation_summary', 'membership_request'
    ];
    const stats = {};
    for (const t of tables) stats[t] = 0;

    for (const table of tables) {
        try {
            const results = db.exec(`SELECT * FROM "${table}"`);
            if (results.length === 0 || results[0].values.length === 0) continue;

            const colNames = results[0].columns;
            const rows = results[0].values.map(vals => {
                const row = {};
                colNames.forEach((col, i) => {
                    let val = vals[i];
                    if (typeof val === 'string') {
                        const isForceString = FORCE_STRING_COLS.has(col);
                        if (!isForceString) {
                            try { val = JSON.parse(val); } catch (e) { }
                        }
                    }
                    row[col] = val;
                });
                if (row.cooperative_id) row.cooperative_id = String(currentCooperativeId);
                row.is_synced = 0;
                return row;
            });

            await upsertMany(table, rows);
            stats[table] = rows.length;
        } catch (e) {
            console.warn(`[importDatabase] Skipping table "${table}":`, e);
        }
    }

    db.close();
    return stats;
}

export async function initDb() {
    await initIndexedDb()
}

let _sqlJsReady = null;
async function getSqlJs() {
    if (!_sqlJsReady) {
        // Dynamic import keeps sql.js out of the startup bundle (see note above).
        _sqlJsReady = import('sql.js').then(({ default: initSqlJs }) =>
            initSqlJs({ locateFile: file => sqlWasmUrl })
        );
    }
    return _sqlJsReady;
}
