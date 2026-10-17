/**
 * syncService.js
 * Compatibility layer and push queue engine.
 * All background sync logic is now in backgroundSyncService.js.
 * - pushQueue: uploads local writes to Firestore when online
 * - prepareForFirestore: data conversion for cloud writes
 * - Thin wrapper around backgroundSyncService for backwards compatibility
 */

import { getDb, doc, setDoc, Timestamp, serverTimestamp, writeBatch } from '../firebase.js'
import { getAllItems } from './indexedDbService.js'
import {
    getPendingQueue,
    removeQueueItem,
    removeQueueItemsBatch,
    updateQueueStatus,
    runSql,
    hardDeleteDoc,
} from './sqliteService.js'
import { loadDoc } from './sqlite/mutationEngine.js'
import { reconcileUnsyncedQueue, healChildQueueItem, CHILD_QUEUE_COLLECTIONS } from './sqlite/syncQueue.js'
import { syncBus, SyncEvents } from './syncEventBus.js'
import { initializeBackgroundSync, triggerFullSync, setSyncSession } from './backgroundSyncService.js'

export const SyncStatus = {
    OFFLINE: 'offline',
    RECONNECTING: 'reconnecting',
    ONLINE: 'online',
    SYNCING: 'syncing',
    NEEDS_VERIFY: 'needs_verify',
}

const CURRENT_SCHEMA_VERSION = 11

// ─── Initialization ───────────────────────────────────────────────────────────

export async function initializeSyncService() {
    const { loadSavedSession, clearSavedSession, restoreSessionFromIndexedDB } = await import('./offlineAuthService.js')
    let session = loadSavedSession()

    if (!session) {
        session = await restoreSessionFromIndexedDB()
        if (!session) {
            syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'offline' })
            return
        }
    }

    // Set session for background sync
    setSyncSession(session)

    // Start the background sync engine (isolated from UI)
    await initializeBackgroundSync(session)
}

// ─── Hard Restore (User-initiated) ───────────────────────────────────────────

export async function performHardRestore(cooperativeId) {
    console.log('[Sync] Hard Restore: Pushing pending writes...')
    try {
        await pushQueue(cooperativeId)
    } catch (e) {
        console.warn('[Sync] Hard Restore: Failed to push some writes, continuing anyway.', e)
    }

    // Safety gate: user-initiated wipe still must not silently destroy
    // unpushable rows. Surface the counts; proceed only when clean or when the
    // user explicitly confirms via the settings UI (caller passes confirm).
    try {
        const { getQueueSnapshot } = await import('./sqliteService.js')
        const snap = await getQueueSnapshot(cooperativeId)
        if (snap.unresolved > 0) {
            const msg = `Hard restore blocked: ${snap.unresolved} unresolved local writes (pending=${snap.pending}, failed=${snap.failed}). Push or discard them from Sync Status first.`
            console.error('[Sync] ' + msg)
            throw new Error(msg)
        }
    } catch (e) {
        if (String(e.message || '').includes('unresolved local writes')) throw e
        console.warn('[Sync] Hard restore gate check failed:', e.message)
    }

    const { wipeDatabase } = await import('./sqliteService.js')
    await wipeDatabase()

    const { clearSavedSession } = await import('./offlineAuthService.js')
    clearSavedSession()

    window.location.href = window.location.origin + window.location.pathname
}

// ─── Initial full sync (triggered from login) ───────────────────────────────

// ─── Scope-aware login sync decision (replaces always-full-sync) ───────────
// Principle: a full sync is determined by a change in local data scope,
// not by login. See decision matrix in investigation report §5.
function toActorType(role, permissions = '') {
    const r = String(role || '').toLowerCase()
    const p = String(permissions || '').toLowerCase()
    if (r === 'member') return 'member'
    if (r === 'admin' || p.includes('admin')) return 'admin'
    return 'staff'
}

async function loadSyncContext(cooperativeId) {
    try {
        const { getAppSetting } = await import('./sqliteService.js')
        const raw = await getAppSetting('sync_context')
        if (raw) {
            try { return JSON.parse(raw) } catch { /* fall through to sync_state */ }
        }
    } catch {}

    // `sync_context` is written only after a full sync succeeds, so it can be
    // absent while `sync_state` still holds a valid watermark and cursors (a
    // partially failed first sync, a cleared app_settings store, or a build
    // predating that write). Deriving the context from `sync_state` keeps the
    // decision below from seeing a spurious `prev=none` and falling through to
    // DELTA_ONLY on no evidence.
    if (cooperativeId) {
        try {
            const { getSyncMeta } = await import('./sqliteService.js')
            const state = await getSyncMeta(String(cooperativeId))
            if (state && (state.is_full_sync_complete || state.collection_cursors || state.last_sync_ts)) {
                const scope = state.last_sync_scope || ''
                const isMemberScope = scope.startsWith('member:')
                return {
                    cooperative_id: String(cooperativeId),
                    dataset_scope: scope,
                    principal_type: isMemberScope ? 'member' : (scope ? 'admin' : ''),
                    principal_id: isMemberScope ? scope.slice('member:'.length) : '',
                    // Derived, not authoritative: tells the caller a previous
                    // sync exists without claiming a full sync completed.
                    derived_from: 'sync_state',
                    schema_version: state.schema_version
                }
            }
        } catch {}
    }
    return null
}

async function dbHasUsableData() {
    try {
        const { queryRows, getSyncMeta } = await import('./sqliteService.js')
        // Any main-table rows OR a completed sync meta counts as existing DB.
        const counts = await Promise.allSettled([
            queryRows('SELECT id FROM members LIMIT 1'),
            queryRows('SELECT id FROM remittance LIMIT 1'),
            queryRows('SELECT id FROM enterprise LIMIT 1')
        ])
        if (counts.some(r => r.status === 'fulfilled' && r.value && r.value.length > 0)) return true
        return false
    } catch {
        return false
    }
}

export async function syncCooperativeData(cooperativeId, role, memberId, permissions = [], username = null, registrationNo = '', forceFull = false) {
    const session = {
        cooperative_id: cooperativeId,
        role,
        user_id: memberId,
        member_id: memberId,
        permissions: permissions,
        username: username,
        registration_no: registrationNo
    }

    // Explicit operator/BG force always wins (e.g. settings "Resync").
    if (forceFull) {
        console.log('[Sync] Explicit forceFull requested.')
        setSyncSession(session)
        const { triggerFullResync } = await import('./backgroundSyncService.js')
        return triggerFullResync(session)
    }

    const actorType = toActorType(role, permissions)
    const actorId = String(memberId || username || '')
    const coopStr = String(cooperativeId)
    const prev = await loadSyncContext(coopStr)
    // `prev` is only trusted as "a previous sync exists" when it came from
    // app_settings; a context derived from sync_state still needs the rows
    // themselves to be present, otherwise the tables were cleared underneath
    // us and a delta would leave the dashboard empty.
    const hasDb = prev && !prev.derived_from ? true : await dbHasUsableData()

    const prevCoop = prev?.cooperative_id ? String(prev.cooperative_id) : null
    const sameCoop = prevCoop ? prevCoop === coopStr : false
    const prevScope = prev?.dataset_scope || ''
    const prevIsMemberScope = prevScope.startsWith('member:')
    const prevMemberId = prevIsMemberScope ? prevScope.slice('member:'.length) : (prev?.principal_id || '')
    const currScope = actorType === 'member' ? `member:${actorId}` : 'cooperative'

    let action = 'DELTA_ONLY'
    if (!hasDb) {
        // No local rows: nothing to delta against, whether or not sync_state
        // still holds cursors from an earlier sync. A delta here would repopulate
        // only the overlap window and leave the rest of the dashboard empty.
        action = actorType === 'member' ? 'FULL_MEMBER_SYNC' : 'FULL_COOP_SYNC'
    } else if (!sameCoop && prevCoop) {
        action = 'SAFE_SCOPE_SWITCH'
    } else if (actorType !== 'member' && !prevIsMemberScope) {
        action = 'DELTA_ONLY' // Case 3: admin/staff same coop
    } else if (actorType !== 'member' && prevIsMemberScope) {
        action = 'EXPAND_SYNC' // Member -> Admin/Staff same coop
    } else if (actorType === 'member' && !prevIsMemberScope) {
        action = 'SECURE_PRUNE_MEMBER_DELTA' // Admin/Staff -> Member same coop (Rule 5, secured)
    } else if (actorType === 'member' && prevIsMemberScope) {
        action = prevMemberId && prevMemberId === actorId ? 'DELTA_ONLY' : 'MEMBER_SCOPE_RESYNC'
    }

    console.log(`[Sync] Login decision: action=${action} prev=${prevCoop || 'none'}:${prevScope || 'none'} curr=${coopStr}:${currScope}`)

    const bg = await import('./backgroundSyncService.js')
    setSyncSession(session)

    switch (action) {
        case 'FULL_COOP_SYNC':
        case 'FULL_MEMBER_SYNC':
            await bg.triggerFullSync(session, true, { allowWipeWithUnresolved: false })
            return { action }
        case 'SAFE_SCOPE_SWITCH': {
            const res = await bg.triggerFullResync(session)
            if (res.blocked) {
                console.error('[Sync] Scope switch blocked with unresolved writes.')
            }
            return { action, ...res }
        }
        case 'SECURE_PRUNE_MEMBER_DELTA': {
            try {
                await bg.pruneForMemberScope(coopStr, session)
            } catch (e) {
                console.warn('[Sync] Secure prune failed, falling back to member resync:', e.message)
                return bg.triggerFullSync(session, true, { allowWipeWithUnresolved: false })
            }
            await pushQueue(coopStr).catch(() => {})
            await bg.triggerDeltaSync(session).catch(() => {})
            return { action }
        }
        case 'MEMBER_SCOPE_RESYNC': {
            try {
                await bg.pruneForMemberScope(coopStr, session)
            } catch (e) {
                console.warn('[Sync] Member prune failed:', e.message)
            }
            // Non-destructive fill (no wipe): fetch missing scope rows.
            await bg.triggerFullSync(session, false)
            return { action }
        }
        case 'EXPAND_SYNC': {
            // Keep valid member rows; fill missing cooperative collections.
            await pushQueue(coopStr).catch(() => {})
            await bg.triggerFullSync(session, false)
            return { action }
        }
        case 'DELTA_ONLY':
        default: {
            await pushQueue(coopStr).catch(() => {})
            // Delta catch-up runs via background loop; trigger one now.
            bg.triggerDeltaSync(session).catch(() => {})
            return { action }
        }
    }
}

// ─── Push Queue ───────────────────────────────────────────────────────────────

const withTimeout = (promise, ms, description = 'Operation') => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${description} timed out after ${ms}ms`)), ms))
    ]);
};

let _isPushing = false
let _reconcileRanThisSession = false

const FIRESTORE_BATCH_SIZE = 500
const PUSH_CONCURRENCY = 8
const BATCH_RATE_LIMIT_MS = 50

function _concurrencyPool(items, concurrency, fn) {
    const results = new Array(items.length)
    let idx = 0
    async function worker() {
        while (idx < items.length) {
            const i = idx++
            results[i] = await fn(items[i], i)
        }
    }
    return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker())).then(() => results)
}

export async function pushQueue(cooperativeId) {
    if (_isPushing) return true
    _isPushing = true

    try {
        if (!_reconcileRanThisSession) {
            try { await reconcileUnsyncedQueue(cooperativeId) } catch (e) {
                console.warn('[Sync] reconcileUnsyncedQueue skipped:', e?.message)
            }
            _reconcileRanThisSession = true
        }

        const queue = await getPendingQueue(cooperativeId)
        if (queue.length === 0) return true

        console.log(`[Sync] Pushing ${queue.length} items (concurrency=${PUSH_CONCURRENCY}, batchSize=${FIRESTORE_BATCH_SIZE})...`)
        let successCount = 0
        let failCount = 0
        let healedCount = 0
        const pushedCols = new Set()
        const db = getDb()

        const nonChildItems = []
        for (const item of queue) {
            if (CHILD_QUEUE_COLLECTIONS.has(item.collection_name)) {
                try { await healChildQueueItem(item) } catch (e) {
                    console.warn('[Sync] Child queue heal failed:', item.collection_name, e?.message)
                }
                healedCount++
                continue
            }
            nonChildItems.push(item)
        }

        const coopForDoc = item => item.cooperative_id || cooperativeId
        const loadResults = await _concurrencyPool(nonChildItems, PUSH_CONCURRENCY, (item) =>
            loadDoc(item.collection_name, item.document_id, coopForDoc(item)).then(doc => ({ ok: true, value: doc })).catch(e => ({ ok: false, error: e }))
        )

        const cleanupPushed = async (acked) => {
            const toRemove = []
            const toHardDelete = []
            const toMarkSynced = []

            for (const { item, payload } of acked) {
                toRemove.push(item.id)
                if (payload.is_deleted === 1 || payload.is_deleted === true) {
                    toHardDelete.push({ table: item.collection_name, id: item.document_id })
                } else {
                    toMarkSynced.push({ table: item.collection_name, id: item.document_id })
                }
            }

            if (toRemove.length > 0) {
                await removeQueueItemsBatch(toRemove)
            }

            for (const { table, id } of toHardDelete) {
                try { await hardDeleteDoc(table, id) } catch (e) { /* ignore */ }
            }

            if (toMarkSynced.length > 0) {
                const remaining = await getAllItems('sync_queue')
                const remainingKeys = new Set(
                    remaining.filter(q => q.status === 'pending' || q.status === 'processing')
                        .map(q => `${q.collection_name}:${q.document_id}`)
                )
                const { getServerNowMs } = await import('./backgroundSyncService.js')
                const ts = new Date(getServerNowMs()).toISOString()
                const byTable = {}
                for (const { table, id } of toMarkSynced) {
                    if (!remainingKeys.has(`${table}:${id}`)) {
                        if (!byTable[table]) byTable[table] = []
                        byTable[table].push(id)
                        pushedCols.add(table)
                    }
                }
                for (const [table, ids] of Object.entries(byTable)) {
                    try {
                        const placeholders = ids.map(() => '?').join(',')
                        await runSql(`UPDATE ${table} SET is_synced = 1, sync_at = ? WHERE id IN (${placeholders})`, [ts, ...ids])
                    } catch (e) { /* ignore */ }
                }
            } else if (toHardDelete.length > 0) {
                for (const { table } of toHardDelete) pushedCols.add(table)
            }
        }

        const processChunk = async (chunk, chunkLoadResults) => {
            const fbBatch = writeBatch(db)
            const staged = []

            for (let i = 0; i < chunk.length; i++) {
                const item = chunk[i]
                try {
                    await updateQueueStatus(item.id, 'processing')

                    const lr = chunkLoadResults[i]
                    const payload = lr.ok ? lr.value : null

                    if (item.operation_type === 'delete' && payload) {
                        payload.is_deleted = 1
                    }

                    if (!payload || Object.keys(payload).length === 0) {
                        await removeQueueItem(item.id)
                        continue
                    }

                    const requiredCoopId = payload.cooperative_id ||
                        (item.collection_name === 'cooperatives' ? payload.id : null)
                    if (!requiredCoopId) {
                        await updateQueueStatus(item.id, 'failed', 'Missing cooperative_id')
                        failCount++
                        continue
                    }

                    const docRef = doc(db, item.collection_name, item.document_id)
                    const firestorePayload = {
                        ...prepareForFirestore(payload),
                        sync_at: serverTimestamp()
                    }

                    if (item.operation_type === 'set' || item.operation_type === 'add') {
                        fbBatch.set(docRef, firestorePayload)
                    } else {
                        fbBatch.set(docRef, firestorePayload, { merge: true })
                    }

                    staged.push({ item, payload })
                } catch (err) {
                    console.error(`[Sync] Prep failed for ${item.collection_name}/${item.document_id}:`, err.message)
                    await updateQueueStatus(item.id, 'failed', err.message)
                    failCount++
                }
            }

            if (staged.length === 0) return

            try {
                await withTimeout(fbBatch.commit(), 60000, `batch of ${staged.length} writes`)
                await cleanupPushed(staged)
                successCount += staged.length
            } catch (batchErr) {
                console.warn(`[Sync] Batch commit failed (${staged.length} items), falling back to individual writes:`, batchErr.message)
                const succeeded = []
                for (const { item, payload } of staged) {
                    try {
                        const docRef = doc(db, item.collection_name, item.document_id)
                        const fp = { ...prepareForFirestore(payload), sync_at: serverTimestamp() }
                        if (item.operation_type === 'set' || item.operation_type === 'add') {
                            await withTimeout(setDoc(docRef, fp), 30000, `setDoc ${item.collection_name}/${item.document_id}`)
                        } else {
                            await withTimeout(setDoc(docRef, fp, { merge: true }), 30000, `mergeDoc ${item.collection_name}/${item.document_id}`)
                        }
                        succeeded.push({ item, payload })
                    } catch (indErr) {
                        console.error(`[Sync] Individual write failed for ${item.collection_name}/${item.document_id}:`, indErr.message)
                        await updateQueueStatus(item.id, 'failed', indErr.message)
                        failCount++
                    }
                }
                await cleanupPushed(succeeded)
                successCount += succeeded.length
            }
        }

        const allLoadResults = new Map()
        nonChildItems.forEach((item, i) => allLoadResults.set(item.id, i))

        const chunks = []
        for (let i = 0; i < nonChildItems.length; i += FIRESTORE_BATCH_SIZE) {
            chunks.push(nonChildItems.slice(i, i + FIRESTORE_BATCH_SIZE))
        }

        const chunkPairs = []
        for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci]
            const chunkLoadResults = chunk.map((item) => {
                const origIdx = allLoadResults.get(item.id)
                return loadResults[origIdx]
            })
            chunkPairs.push({ chunk, chunkLoadResults })
        }

        for (let i = 0; i < chunkPairs.length; i += PUSH_CONCURRENCY) {
            const slice = chunkPairs.slice(i, i + PUSH_CONCURRENCY)
            await Promise.allSettled(slice.map(({ chunk, chunkLoadResults }) => processChunk(chunk, chunkLoadResults)))
            if (i + PUSH_CONCURRENCY < chunkPairs.length) {
                await new Promise(r => setTimeout(r, BATCH_RATE_LIMIT_MS))
            }
        }

        if (pushedCols.size > 0) {
            try {
                const { stampPushWatermarks } = await import('./backgroundSyncService.js')
                await stampPushWatermarks(cooperativeId, [...pushedCols])
            } catch (e) {
                console.warn('[Sync] Push watermark stamp skipped:', e?.message)
            }
        }

        console.log(`[Sync] Push complete: ${successCount} succeeded, ${failCount} failed, ${healedCount} child rows rerouted to parent, out of ${queue.length} total.`)
        return failCount === 0
    } finally {
        _isPushing = false
    }
}

// ─── Firestore Helpers (kept for use by pushQueue and dataService) ──────────

export function normalizeFromFirestore(obj) {
    if (!obj || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) {
        return obj.map(item => normalizeFromFirestore(item))
    }
    const data = { ...obj }
    for (const [key, val] of Object.entries(data)) {
        if (!val) continue
        if (typeof val === 'object') {
            if (typeof val.toDate === 'function') {
                data[key] = val.toDate().toISOString()
            } else if (val.seconds !== undefined && val.nanoseconds !== undefined) {
                data[key] = new Date(Number(val.seconds) * 1000 + Math.round(val.nanoseconds / 1000000)).toISOString()
            } else if (val.type === 'firestore/timestamp/1.0' && val.seconds !== undefined) {
                data[key] = new Date(Number(val.seconds) * 1000).toISOString()
            } else {
                data[key] = normalizeFromFirestore(val)
            }
        } else if (Array.isArray(val) && (key === 'recipient_id' || key === 'viewed' || key === 'account_manager')) {
            data[key] = val.join(',')
        }
    }
    if (data.id && !Array.isArray(obj)) {
        data.is_synced = 1
    }
    return data
}

export function prepareForFirestore(obj) {
    if (!obj || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) {
        return obj.map(item => prepareForFirestore(item))
    }
    const payload = { ...obj }
    // Safety net: always (re)compute `_lower` search fields so old queued
    // docs and direct callers can't push un-normalized identifiers.
    try {
        if (payload.username !== undefined) {
            const k = String(payload.username ?? '').trim().toLowerCase();
            if (k && !payload.username_lower) payload.username_lower = k;
        }
        if (payload.email !== undefined && payload.email) {
            const k = String(payload.email).trim().toLowerCase();
            if (k && !payload.email_lower) payload.email_lower = k;
        }
        if (payload.special_id !== undefined && payload.special_id !== null) {
            const k = String(payload.special_id).trim().toLowerCase();
            if (!payload.special_id_lower) payload.special_id_lower = k;
        }
        if (payload.registration_no !== undefined && payload.registration_no !== null && payload.registration_no !== '') {
            const k = String(payload.registration_no).trim().toLowerCase();
            if (k && !payload.registration_no_str) payload.registration_no_str = k;
        }
    } catch { /* never block sync on normalization */ }
    const dateFields = [
        'created_at', 'modified_at', 'deleted_at',
        'remittance_date', 'issued_date', 'due_date',
        'expiry_date', 'date_joined', 'last_attempt_at', 'sync_at',
        'coop_first_month', 'dob', 'last_login'
    ]
    const jsonFields = ['account_balance', 'payment_advise', 'data', 'details', 'loans']

    for (const [key, val] of Object.entries(payload)) {
        if (!val) continue
        if (jsonFields.includes(key) && typeof val === 'string') {
            try {
                payload[key] = JSON.parse(val)
                payload[key] = prepareForFirestore(payload[key])
                continue
            } catch (e) {
                console.warn(`[Sync] Failed to parse JSON field ${key}:`, e.message)
            }
        }
        if (dateFields.includes(key) && val) {
            try {
                if (typeof val === 'string' || val instanceof Date) {
                    const date = new Date(val)
                    if (!isNaN(date.getTime())) {
                        payload[key] = Timestamp.fromDate(date)
                        continue
                    }
                }
            } catch (e) {}
        }
        if (typeof val === 'object' && val.seconds !== undefined && val.nanoseconds !== undefined) {
            try {
                payload[key] = new Timestamp(val.seconds, val.nanoseconds)
                continue
            } catch (e) {}
        }
        if ((key === 'recipient_id' || key === 'viewed' || key === 'account_manager') && typeof val === 'string') {
            payload[key] = val.split(',').map(s => s.trim()).filter(Boolean)
            continue
        }
        if (typeof val === 'object' && !(val instanceof Timestamp)) {
            payload[key] = prepareForFirestore(val)
        }
    }
    return payload
}
