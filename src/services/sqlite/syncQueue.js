import { getAllItems, getAllByIndex, getAllByIndexRange, getItem, putItem, putItemsBatch, deleteItem, deleteItemsBatch, clearStore } from '../indexedDbService.js'
import { runSql } from './sqlExecutor.js'
import { loadDoc } from './mutationEngine.js'

export const MAX_QUEUE_ATTEMPTS = 5;

// Firestore only hosts top-level collections (see firestore.rules + saveDoc's
// topLevelCollections). Child rows (details / loans / guarantors / advises)
// are embedded inside their parent document by loadDoc() and must NEVER be
// pushed as their own collection — the catch-all rule denies them and a
// single denied doc poisons its whole 200-write batch, leaving the queue
// stuck in "pending" forever. Child rows are therefore always routed to
// their parent push; orphans (parent missing locally) are healed to synced.
const CHILD_TO_PARENT = {
    remittance_detail: 'remittance',
    loans: 'remittance',
    loan_guarantors: 'remittance', // via loans.loan_id -> remittance_id
    payment_advise: 'members',
};
export const CHILD_QUEUE_COLLECTIONS = new Set(Object.keys(CHILD_TO_PARENT));

// Resolve the parent push target for a child row. Returns
// { collection, id } or null when the row is orphaned / unresolvable.
export async function resolveChildParent(collection, row) {
    try {
        if (!row) return null;
        if (collection === 'remittance_detail' || collection === 'loans') {
            if (row.remittance_id) return { collection: 'remittance', id: String(row.remittance_id) };
            return null;
        }
        if (collection === 'loan_guarantors') {
            const loanId = row.loan_id ? String(row.loan_id) : null;
            if (!loanId) return null;
            const loan = await getItem('loans', loanId).catch(() => null);
            if (loan && loan.remittance_id) return { collection: 'remittance', id: String(loan.remittance_id) };
            return null;
        }
        if (collection === 'payment_advise') {
            if (row.member_id) return { collection: 'members', id: String(row.member_id) };
            return null;
        }
    } catch { /* fall through to null */ }
    return null;
}

// Mark a child row synced locally (its data travels inside the parent doc,
// so its own flag must not re-trigger uploads once the parent is handled).
async function markChildHealed(collection, id) {
    try {
        await runSql(`UPDATE ${collection} SET is_synced = 1 WHERE id = ?`, [String(id)]);
    } catch { /* best-effort: table may not exist on old devices */ }
}

// Route one unsynced child row to its parent push. Returns true when the
// row was handled (parent enqueued or orphan healed) so callers skip the
// direct child enqueue.
async function routeChildToParent(collection, row, coopStr) {
    const parent = await resolveChildParent(collection, row);
    if (!parent) {
        await markChildHealed(collection, row.id);
        return true;
    }
    let parentRow = null;
    try { parentRow = await getItem(parent.collection, parent.id); } catch { parentRow = null; }
    if (!parentRow) {
        // Parent gone locally: nothing can carry this child to the cloud.
        await markChildHealed(collection, row.id);
        return true;
    }
    const parentSynced = parentRow.is_synced === 1 || parentRow.is_synced === '1' || parentRow.is_synced === true;
    if (parentSynced) {
        // Parent already in the cloud and this child carries no newer local
        // edit that isn't already reflected via the parent path (saveDoc
        // always marks the parent unsynced + queued alongside child edits).
        // Heal the stale flag instead of re-uploading the parent every cycle.
        await markChildHealed(collection, row.id);
        return true;
    }
    try {
        await runSql(`UPDATE ${parent.collection} SET is_synced = 0 WHERE id = ?`, [parent.id]);
    } catch {}
    try {
        await enqueueWrite(coopStr || parentRow.cooperative_id || row.cooperative_id, parent.collection, parent.id, 'update', null);
    } catch (e) {
        console.warn('[Sync] routeChildToParent enqueue failed:', parent.collection, e?.message);
    }
    return true;
}

// Heal a legacy/poison queue row that targets a child collection directly
// (written by older app versions or by the pre-fix reconciler). Converts it
// to a parent push and drops the child row so pushQueue never attempts a
// Firestore write that the security rules will always deny.
export async function healChildQueueItem(item) {
    try {
        const row = await getItem(item.collection_name, String(item.document_id)).catch(() => null);
        if (!row) {
            await deleteItem('sync_queue', item.id).catch(() => {});
            return true;
        }
        const coopStr = item.cooperative_id || row.cooperative_id || null;
        await routeChildToParent(item.collection_name, row, coopStr ? String(coopStr) : null);
    } catch (e) {
        console.warn('[Sync] healChildQueueItem failed:', item.collection_name, e?.message);
    }
    try {
        await deleteItem('sync_queue', item.id).catch(() => {});
    } catch {}
    return true;
}

// Self-healing: rows flagged unsynced (is_synced = 0 — e.g. after an offline
// .db import, a data migration, or a download-path correction) that have no
// queue entry yet are enqueued for upload. The push engine only reads the
// queue, so without this such rows would never reach the cloud.
const RECONCILE_COLLECTIONS = [
    'remittance', 'remittance_detail', 'loans', 'loan_guarantors', 'members',
    'payment_advise', 'enterprise', 'bank', 'users', 'transaction_types',
    'bank_reconciliation_summary', 'cooperatives', 'notifications', 'feedback',
    'membership_request'
];
export async function reconcileUnsyncedQueue(cooperativeId) {
    const coopStr = cooperativeId != null ? String(cooperativeId) : null;
    let queued;
    try {
        const all = await getAllItems('sync_queue');
        queued = new Set(
            all.filter(q => q.status === 'pending' || q.status === 'processing')
                .map(q => `${q.collection_name}:${String(q.document_id)}`)
        );
    } catch { queued = new Set(); }

    const parentQueued = new Set();
    for (const key of queued) {
        const [col] = key.split(':');
        if (!CHILD_TO_PARENT[col]) parentQueued.add(key);
    }

    let added = 0;
    let healed = 0;
    let skippedParentQueued = 0;

    for (const col of RECONCILE_COLLECTIONS) {
        let rows = [];
        try { rows = await getAllItems(col); } catch { continue; }
        for (const r of rows) {
            if (!r || r.id === undefined || r.id === null) continue;
            if (coopStr && r.cooperative_id && String(r.cooperative_id) !== coopStr) continue;
            if (r.is_synced === 1 || r.is_synced === '1' || r.is_synced === true) continue;
            if (CHILD_TO_PARENT[col]) {
                let targetCol = CHILD_TO_PARENT[col];
                let parentId = null;
                if (col === 'remittance_detail' || col === 'loans') {
                    parentId = r.remittance_id;
                } else if (col === 'payment_advise') {
                    parentId = r.member_id;
                } else if (col === 'loan_guarantors') {
                    const loanId = r.loan_id;
                    if (loanId) {
                        const loanKey = `loans:${String(loanId)}`;
                        if (parentQueued.has(loanKey)) {
                            skippedParentQueued++;
                            continue;
                        }
                        const loanRow = await getItem('loans', String(loanId)).catch(() => null);
                        if (loanRow && loanRow.remittance_id) {
                            parentId = loanRow.remittance_id;
                            targetCol = 'remittance';
                        }
                    }
                }
                if (parentId) {
                    const parentKey = `${targetCol}:${String(parentId)}`;
                    if (parentQueued.has(parentKey)) {
                        skippedParentQueued++;
                        continue;
                    }
                }
                try {
                    await routeChildToParent(col, r, coopStr || r.cooperative_id);
                    healed++;
                } catch (e) {
                    console.warn('[Sync] reconcile child-route failed:', col, e?.message);
                }
                continue;
            }
            const key = `${col}:${String(r.id)}`;
            if (queued.has(key)) continue;
            try {
                await enqueueWrite(coopStr || r.cooperative_id, col, String(r.id), 'update', null);
                queued.add(key);
                added++;
                if (added >= 5000) {
                    console.log('[Sync] reconcileUnsyncedQueue: cap reached, rest next run');
                    return added;
                }
            } catch (e) {
                console.warn('[Sync] reconcile enqueue failed:', col, e?.message);
            }
        }
    }
    if (skippedParentQueued > 0) console.log(`[Sync] reconcileUnsyncedQueue: skipped ${skippedParentQueued} child rows (parent already queued)`);
    if (healed > 0) console.log(`[Sync] reconcileUnsyncedQueue: routed ${healed} child rows to parent pushes`);
    if (added > 0) console.log(`[Sync] reconcileUnsyncedQueue: enqueued ${added} unsynced rows`);
    return added;
}

// Queue state machine: pending -> processing -> (deleted on ack)
//   transient failure -> pending (retry, attempt++ , next_attempt_at for backoff)
//   permanent failure  -> failed (quarantined, inspectable, never auto-deleted)
// A newer local edit revives a failed row back to pending.
function isPermanentError(msg) {
    const m = String(msg || '').toLowerCase();
    return m.includes('permission-denied') || m.includes('permission denied') ||
        // Firestore JS SDK surfaces rules denials as "Missing or insufficient
        // permissions." — without this the queue treats denied writes as
        // transient and retries them forever under "pending" (see stuck-pending
        // incident: child-table rows denied by the catch-all rule).
        m.includes('insufficient permissions') || m.includes('missing or insufficient') ||
        m.includes('permission_denied') ||
        m.includes('missing cooperative_id') || m.includes('unauthenticated') ||
        m.includes('invalid-argument') || m.includes('not-found') && m.includes('no document');
}

// OPTION A: queue stores identity + operation only. Push always reloads the
// latest full canonical document from IndexedDB via loadDoc(). The `payload`
// argument is accepted for backwards compatibility but intentionally NOT used
// as the source of truth, so a later partial can never downgrade a full doc.
export async function enqueueWrite(cooperativeId, collection, docId, operation, payload) {
    const all = await getAllItems('sync_queue');
    const docIdStr = String(docId);
    const coopStr = cooperativeId != null ? String(cooperativeId) : null;
    const existing = all.find(q =>
        q.collection_name === collection &&
        q.document_id === docIdStr &&
        (q.status === 'pending' || q.status === 'processing' || q.status === 'failed')
    );
    const now = new Date().toISOString();
    // Normalize delete operations: any op on a deleted doc becomes 'delete'.
    let op = operation;
    try {
        if (payload && typeof payload === 'object' && (payload.is_deleted === 1 || payload.is_deleted === true)) {
            op = 'delete';
        }
    } catch {}
    if (existing) {
        existing.operation_type = op;
        // Identity-only: never persist caller partials. Clear legacy payload so
        // push is forced to reload from IndexedDB. Keep field for compat.
        existing.merged_document = null;
        if (coopStr) existing.cooperative_id = coopStr;
        existing.updated_at = now;
        // Revive failed rows on newer edit (last valid local state wins).
        if (existing.status === 'failed') {
            existing.status = 'pending';
            existing.attempt_count = 0;
            existing.last_error = null;
            existing.next_attempt_at = null;
        } else if (existing.status === 'processing') {
            // A local edit racing an in-flight push: keep processing row but
            // ensure a follow-up pending row exists via hasPendingWrites guard
            // in push cleanup (is_synced only marked when no pending remains).
            existing.updated_at = now;
        }
        await putItem('sync_queue', existing);
    } else {
        const nextId = all.length > 0 ? Math.max(...all.map(q => q.id || 0)) + 1 : 1;
        const newRow = {
            id: nextId,
            entity: collection,
            entity_id: docIdStr,
            collection_name: collection,
            document_id: docIdStr,
            operation_type: op,
            merged_document: null,
            cooperative_id: coopStr,
            status: 'pending',
            attempt_count: 0,
            last_error: null,
            next_attempt_at: null,
            created_at: now,
            updated_at: now
        };
        await putItem('sync_queue', newRow);
    }
}

export async function updateQueueStatus(itemId, status, errorMsg = null) {
    const existing = await getItem('sync_queue', itemId)
    if (!existing) return
    const now = new Date().toISOString()
    if (status === 'failed' || errorMsg) {
        const msg = String(errorMsg || 'Unknown error');
        existing.attempt_count = (existing.attempt_count || 0) + 1
        existing.last_error = msg
        existing.last_attempt_at = now
        existing.updated_at = now
        // Permanent errors quarantine immediately; transient errors retry with
        // backoff until MAX_QUEUE_ATTEMPTS, then quarantine (never auto-delete).
        if (isPermanentError(msg) || existing.attempt_count >= MAX_QUEUE_ATTEMPTS) {
            existing.status = 'failed'
            existing.next_attempt_at = null
        } else {
            existing.status = 'pending'
            const backoffMs = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, existing.attempt_count - 1))
            existing.next_attempt_at = new Date(Date.now() + backoffMs).toISOString()
        }
    } else {
        existing.status = status
        existing.updated_at = now
        if (status === 'pending') {
            existing.next_attempt_at = null
            existing.last_error = null
        } else if (status !== 'processing') {
            existing.last_error = null
        }
    }
    await putItem('sync_queue', existing)
}

export async function hasPendingWrites(collection, docId, excludeItemId = null) {
    const all = await getAllItems('sync_queue')
    return all.some(q =>
        q.collection_name === collection &&
        q.document_id === String(docId) &&
        q.id !== excludeItemId &&
        (q.status === 'pending' || q.status === 'processing')
    )
}

export async function getQueueSnapshot(cooperativeId) {
    const all = await getAllItems('sync_queue')
    const scoped = cooperativeId != null
        ? all.filter(q => !q.cooperative_id || String(q.cooperative_id) === String(cooperativeId))
        : all
    let pending = 0, processing = 0, failed = 0, retryScheduled = 0
    for (const q of scoped) {
        if (q.status === 'processing') processing++
        else if (q.status === 'failed') failed++
        else if (q.status === 'pending') {
            pending++
            if (q.next_attempt_at && new Date(q.next_attempt_at).getTime() > Date.now()) retryScheduled++
        }
    }
    return { pending, processing, failed, retryScheduled, total: scoped.length, unresolved: pending + processing + failed }
}

export async function checkDbExists() {
    try {
        const all = await getAllItems('app_settings')
        return all.length > 0
    } catch (e) {
        return false
    }
}

export async function getSyncQueueSummary() {
    const all = await getAllItems('sync_queue')
    let pending = 0, failed = 0, completed = 0, processing = 0
    for (const q of all) {
        if (q.status === 'completed') completed++
        else if (q.status === 'processing') processing++
        else if (q.status === 'failed' || (q.attempt_count || 0) >= 5) failed++
        else if (q.status === 'pending') pending++
    }
    return { pending, failed, completed, processing, total: all.length }
}

export async function getSyncQueueDetails(limit = null) {
    const all = await getAllItems('sync_queue')
    all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    // No limit (null/undefined/0) returns everything; a positive limit caps it.
    if (!limit || limit <= 0) return all
    return all.slice(0, limit)
}

export async function restartAllSyncItems() {
    const all = await getAllItems('sync_queue')
    const updated = []
    for (const q of all) {
        // Reset everything in the queue (pending, failed, processing) to pending status and 0 attempts
        q.status = 'pending'
        q.attempt_count = 0
        q.last_error = null
        updated.push(q)
    }
    if (updated.length > 0) {
        for (const q of updated) await putItem('sync_queue', q)
        console.log(`[Sync] Restarted all ${updated.length} sync queue items to pending status.`)
    }
}

export async function resetProcessingQueueItems() {
    const all = await getAllItems('sync_queue')
    const updated = []
    for (const q of all) {
        if (q.status === 'processing') {
            q.status = 'pending'
            q.attempt_count = 0
            q.last_error = null
            updated.push(q)
        }
    }
    if (updated.length > 0) {
        for (const q of updated) await putItem('sync_queue', q)
        console.log(`[Sync] Reset ${updated.length} stuck processing queue items to pending status.`)
    }
}

export async function clearSyncQueueLogs() {
    const all = await getAllItems('sync_queue')
    for (const q of all) {
        if (q.status === 'completed' || q.status === 'failed' || (q.attempt_count || 0) >= 5) {
            await deleteItem('sync_queue', q.id)
        }
    }
}

export async function clearAllSyncQueueItems() {
    console.log('[Sync] clearAllSyncQueueItems: start')
    const ENTITY_TABLES = [
        'cooperatives', 'users', 'members', 'loans', 'loan_guarantors',
        'remittance', 'remittance_detail', 'bank', 'enterprise',
        'transaction_types', 'payment_advise', 'notifications',
        'bank_reconciliation_summary', 'feedback', 'membership_request'
    ]
    for (const table of ENTITY_TABLES) {
        try {
            console.log(`[Sync] Marking is_synced=1 on ${table}...`)
            const all = await getAllItems(table)
            const unsynced = all.filter(r => r.is_synced === 0 || r.is_synced === '0')
            if (unsynced.length > 0) {
                for (const r of unsynced) r.is_synced = 1
                await putItemsBatch(table, unsynced)
            }
            console.log(`[Sync] ${table} done (${unsynced.length} rows)`)
        } catch (e) {
            console.warn(`[Sync] ${table} failed:`, e.message)
        }
    }
    console.log('[Sync] clearAllSyncQueueItems: clearing sync_queue store...')
    await clearStore('sync_queue')
    console.log('[Sync] clearAllSyncQueueItems: done')
}

export async function resetSyncQueueAndMarkUnsynced(cooperativeId) {
    const allQueue = await getAllItems('sync_queue')
    if (allQueue.length === 0) {
        // Even if the queue is empty, run scanAndEnqueueUnsynced to pick up any unsynced items
        return await scanAndEnqueueUnsynced(cooperativeId)
    }

    // For each item in the queue, mark is_synced = 0 in its respective table
    for (const item of allQueue) {
        try {
            const table = item.collection_name
            const docId = item.document_id
            if (table && docId) {
                // Set is_synced = 0 in the corresponding entity table so it's recognized as unsynced
                await runSql(`UPDATE ${table} SET is_synced = 0 WHERE id = ?`, [docId])
            }
        } catch (err) {
            console.warn(`[Sync] Failed to set is_synced = 0 for ${item.collection_name}/${item.document_id}:`, err.message)
        }
    }

    // Delete all items from the sync queue
    for (const item of allQueue) {
        await deleteItem('sync_queue', item.id)
    }

    // Re-scan and enqueue all unsynced items fresh
    const totalEnqueued = await scanAndEnqueueUnsynced(cooperativeId)
    return totalEnqueued
}

export async function scanAndEnqueueUnsynced(cooperativeId) {
    const mainEntities = [
        { table: 'cooperatives', entity: 'cooperatives', isCoopTable: true },
        { table: 'enterprise', entity: 'enterprise' },
        { table: 'bank', entity: 'bank' },
        { table: 'members', entity: 'members' },
        { table: 'users', entity: 'users' },
        { table: 'remittance', entity: 'remittance' },
        { table: 'transaction_types', entity: 'transaction_types' },
        { table: 'bank_reconciliation_summary', entity: 'bank_reconciliation_summary' },
        { table: 'feedback', entity: 'feedback' },
        { table: 'notifications', entity: 'notifications' }
    ]
    let total = 0
    for (const { table, entity, isCoopTable } of mainEntities) {
        let rows
        if (isCoopTable) {
            const item = await getItem(table, String(cooperativeId))
            rows = item && (!item.is_synced) ? [item] : []
        } else {
            let items
            try {
                items = await getAllByIndex(table, 'cooperative_id', String(cooperativeId))
                if (!items || items.length === 0) {
                    const all = await getAllItems(table)
                    if (all.length > 0) {
                        items = all.filter(r => r.cooperative_id === String(cooperativeId))
                    }
                }
            } catch (e) {
                const all = await getAllItems(table)
                items = all.filter(r => r.cooperative_id === String(cooperativeId))
            }
            rows = items.filter(r => !r.is_synced)
        }
        for (const row of rows) {
            const fullDoc = await loadDoc(table, row.id, cooperativeId) || row
            await enqueueWrite(cooperativeId, entity, row.id, 'update', fullDoc)
            total++
        }
    }
    return total
}

export async function bulkEnqueueUnsynced(cooperativeId) {
    const coopStr = cooperativeId != null ? String(cooperativeId) : null;
    const mainEntities = [
        { table: 'cooperatives', entity: 'cooperatives', isCoopTable: true },
        { table: 'enterprise', entity: 'enterprise' },
        { table: 'bank', entity: 'bank' },
        { table: 'members', entity: 'members' },
        { table: 'users', entity: 'users' },
        { table: 'remittance', entity: 'remittance' },
        { table: 'transaction_types', entity: 'transaction_types' },
        { table: 'bank_reconciliation_summary', entity: 'bank_reconciliation_summary' },
        { table: 'feedback', entity: 'feedback' },
        { table: 'notifications', entity: 'notifications' }
    ]

    const existingQueue = await getAllItems('sync_queue');
    const existingSet = new Set(
        existingQueue
            .filter(q => q.status === 'pending' || q.status === 'processing' || q.status === 'failed')
            .map(q => `${q.collection_name}:${q.document_id}`)
    );
    let nextId = existingQueue.length > 0 ? Math.max(...existingQueue.map(q => q.id || 0)) + 1 : 1;
    const now = new Date().toISOString();
    const newItems = [];

    for (const { table, entity, isCoopTable } of mainEntities) {
        let rows;
        if (isCoopTable) {
            const item = await getItem(table, String(cooperativeId));
            rows = item && (!item.is_synced) ? [item] : [];
        } else {
            let items;
            try {
                items = await getAllByIndex(table, 'cooperative_id', String(cooperativeId));
                if (!items || items.length === 0) {
                    const all = await getAllItems(table);
                    if (all.length > 0) items = all.filter(r => r.cooperative_id === String(cooperativeId));
                }
            } catch {
                const all = await getAllItems(table);
                items = all.filter(r => r.cooperative_id === String(cooperativeId));
            }
            rows = (items || []).filter(r => !r.is_synced);
        }
        for (const row of rows) {
            const docIdStr = String(row.id);
            const key = `${entity}:${docIdStr}`;
            if (existingSet.has(key)) continue;
            existingSet.add(key);
            const op = (row.is_deleted === 1 || row.is_deleted === true) ? 'delete' : 'update';
            newItems.push({
                id: nextId++,
                entity: entity,
                entity_id: docIdStr,
                collection_name: entity,
                document_id: docIdStr,
                operation_type: op,
                merged_document: null,
                cooperative_id: coopStr,
                status: 'pending',
                attempt_count: 0,
                last_error: null,
                next_attempt_at: null,
                created_at: now,
                updated_at: now
            });
        }
    }

    if (newItems.length > 0) {
        await putItemsBatch('sync_queue', newItems);
    }
    return newItems.length;
}

export async function getPendingQueue(cooperativeId) {
    const pendingItems = await getAllByIndexRange('sync_queue', 'status', 'pending')
    const nowTs = Date.now()
    const scoped = cooperativeId != null
        ? pendingItems.filter(q => !q.cooperative_id || String(q.cooperative_id) === String(cooperativeId))
        : pendingItems
    const eligible = scoped.filter(q => {
        if ((q.attempt_count || 0) >= MAX_QUEUE_ATTEMPTS) return false
        if (q.next_attempt_at && new Date(q.next_attempt_at).getTime() > nowTs) return false
        return true
    })
    const latest = {}
    for (const q of eligible) {
        const key = `${q.collection_name}|${q.document_id}`
        if (!latest[key] || String(q.created_at || '') > String(latest[key].created_at || '')) {
            latest[key] = q
        }
    }
    return Object.values(latest).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
}

export async function removeQueueItem(itemId) {
    await deleteItem('sync_queue', itemId)
}

export async function removeQueueItemsBatch(itemIds) {
    if (!itemIds || itemIds.length === 0) return
    await deleteItemsBatch('sync_queue', itemIds)
}

export async function incrementQueueRetry(itemId, errorMsg) {
    const existing = await getItem('sync_queue', itemId)
    if (!existing) return
    existing.attempt_count = (existing.attempt_count || 0) + 1
    existing.last_error = String(errorMsg)
    existing.last_attempt_at = new Date().toISOString()
    await putItem('sync_queue', existing)
}
