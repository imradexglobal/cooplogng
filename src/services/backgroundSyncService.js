/**
 * backgroundSyncService.js
 * Isolated background synchronization engine.
 * - Runs delta sync and push queue independently of UI
 * - Updates IndexedDB silently
 * - Emits granular events via syncEventBus
 * - Never calls render(), never manipulates DOM, never triggers navigation
 * - Never calls window.location.reload() or window.location.href=
 */

import { syncBus, SyncEvents, createSyncPayload } from './syncEventBus.js'
import {
    getDb, collection, query, where, getDocs, doc, setDoc, updateDoc,
    getDoc, orderBy, limit, startAfter, Timestamp, serverTimestamp, arrayUnion
} from '../firebase.js'

// Page size for paged collection downloads (bounds memory + per-request time
// on slow mobile connections; previously a single unbounded getDocs).
const SYNC_PAGE_SIZE = 500

const CURRENT_SCHEMA_VERSION = 11

// Internal state (not exposed to UI)
let _session = null
let _sessionGen = 0 // generation token: stale async completions are discarded
let _syncTimer = null
let _isLooping = false
let _lastActivityTs = Date.now()
let _isPushing = false // legacy, kept for compat; push lock lives in syncService
let _isSyncing = false // Lock to prevent concurrent full syncs
let _pendingQueue = new Map() // Track pending items for conflict resolution
let _activityHandler = null
let _coordinator = 'IDLE' // IDLE|INITIALIZING|PUSHING|PULLING|FULL_SYNCING|SWITCHING_SCOPE|STOPPING|ERROR
let _deltaInFlight = null // shared delta pass: loop/refresh/login/online join it instead of re-running

export function getSyncSession() {
    return _session
}

export function getSyncGeneration() {
    return _sessionGen
}

export function getCoordinatorState() {
    return _coordinator
}

function setCoordinator(state) {
    _coordinator = state
}

// The generation token exists so async completions belonging to a *different*
// scope are discarded. Two independent entry points set the same session on
// login — `syncCooperativeData` (via setSyncSession, then triggerDeltaSync)
// and `initializeSyncService` (via initializeBackgroundSync) — so bumping
// unconditionally made each one abort the other's in-flight work, which is how
// the login-path delta sync died on its first collection with
// "Session changed during delta sync; aborting." Bump only when the identity
// actually changes; re-asserting the same session must not invalidate it.
function _sessionIdentity(s) {
    if (!s) return ''
    const coop = s.cooperative_id || s.cooperativeId || ''
    const user = s.user_id || s.userId || s.member_id || s.memberId || s.username || ''
    return `${coop}|${user}|${String(s.role || '').toLowerCase()}`
}

function _adoptSession(session) {
    const changed = _sessionIdentity(session) !== _sessionIdentity(_session)
    _session = session
    if (changed) {
        _sessionGen++
        // An in-flight delta pass belongs to the previous scope — do not let
        // the new session join it (its internal gen guard aborts it anyway).
        _deltaInFlight = null
    }
    return changed
}

export function setSyncSession(session) {
    return _adoptSession(session)
}

export function clearSyncSession() {
    _session = null
    _sessionGen++
    _deltaInFlight = null
}

// ─── Initialization ───────────────────────────────────────────────────────────

export async function initializeBackgroundSync(session) {
    _adoptSession(session)
    _lastActivityTs = Date.now()

    // Track activity for adaptive timing (single handler, removed on stop).
    if (_activityHandler) {
        window.removeEventListener('mousemove', _activityHandler)
        window.removeEventListener('keydown', _activityHandler)
        window.removeEventListener('scroll', _activityHandler)
    }
    _activityHandler = () => { _lastActivityTs = Date.now() }
    window.addEventListener('mousemove', _activityHandler, { passive: true })
    window.addEventListener('keydown', _activityHandler, { passive: true })
    window.addEventListener('scroll', _activityHandler, { passive: true })

    if (!session) return

    const cooperativeId = session.cooperative_id || session.cooperativeId
    if (!cooperativeId) return

    // Reset stuck processing items on startup
    try {
        const { resetProcessingQueueItems } = await import('./sqliteService.js')
        await resetProcessingQueueItems()
    } catch (e) {
        console.error('[BgSync] Failed to reset processing items on startup:', e)
    }

    // Check schema and start background loop
    await _checkSchemaAndSync()
}

// ─── Schema Check ─────────────────────────────────────────────────────────────

async function _checkSchemaAndSync() {
    const cooperativeId = _session.cooperative_id || _session.cooperativeId
    const { getSyncMeta, updateSyncMeta, runSql } = await import('./sqliteService.js')
    const meta = await getSyncMeta(cooperativeId)

    if (meta && meta.schema_version !== undefined && meta.schema_version !== CURRENT_SCHEMA_VERSION) {
        console.warn('[BgSync] Schema mismatch detected. Running recovery flow...')
        await _runSchemaRecoveryFlow()
    } else {
        syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'online' })
        _startBackgroundLoop()
    }
}

async function _runSchemaRecoveryFlow() {
    const cooperativeId = _session.cooperative_id || _session.cooperativeId
    const { pushQueue } = await import('./syncService.js')

    // Push pending writes first
    const pushSuccess = await pushQueue(cooperativeId)
    const { getPendingQueue, runSql, updateSyncMeta, initialSyncInternal } = await import('./sqliteService.js')
    const queue = await getPendingQueue(cooperativeId)

    if (!pushSuccess || queue.length > 0) {
        console.error('[BgSync] Recovery: Push failed or queue not empty. Preserving local cache.')
        return
    }

    // Clear cache
    const tables = ['remittance', 'remittance_detail', 'loans', 'loan_guarantors', 'members',
        'payment_advise', 'enterprise', 'bank', 'users', 'cooperatives', 'notifications', 'transaction_types', 'membership_request']
    for (const t of tables) {
        await runSql(`DELETE FROM ${t}`)
    }

    await updateSyncMeta(cooperativeId, {
        is_full_sync_complete: 0,
        last_sync_ts: 0,
        schema_version: CURRENT_SCHEMA_VERSION
    })

    // Full re-sync
    await _initialSyncInternal()
    _startBackgroundLoop()
}

// ─── Background Loop (adaptive scheduler) ─────────────────────────────────
// Push: immediate (debounced) after local writes; pull: 60s foreground,
// 5m idle, paused when hidden; offline: no Firestore attempts; failures use
// queue backoff (see syncQueue next_attempt_at). Single timer, cleaned on stop.
const PULL_FOREGROUND_MS = 60000
const PULL_IDLE_MS = 5 * 60 * 1000
const PULL_HIDDEN_MS = 10 * 60 * 1000
let _currentIntervalMs = 0
let _onlineHandler = null
let _offlineHandler = null
let _visibilityHandler = null
let _pushDebounceTimer = null

function _desiredPullInterval() {
    if (typeof document !== 'undefined' && document.hidden) return PULL_HIDDEN_MS
    if (Date.now() - _lastActivityTs > 60000) return PULL_IDLE_MS
    return PULL_FOREGROUND_MS
}

function _startBackgroundLoop() {
    _stopLoopTimerOnly()
    _currentIntervalMs = _desiredPullInterval()

    const runLoop = async () => {
        if (_isLooping || !navigator.onLine || !_session) return
        if (_coordinator === 'FULL_SYNCING' || _coordinator === 'SWITCHING_SCOPE' || _coordinator === 'STOPPING') return
        _isLooping = true
        const myGen = _sessionGen
        try {
            const cooperativeId = _session.cooperative_id || _session.cooperativeId
            // Push first so deltas never overwrite unsynced local state.
            const { pushQueue } = await import('./syncService.js')
            await pushQueue(cooperativeId)
            if (myGen !== _sessionGen) return
            await _runDeltaShared()
        } catch (e) {
            console.error('[BgSync] Loop error:', e)
        } finally {
            _isLooping = false
            _notifyIdle()
            _adjustLoopTiming()
        }
    }

    _syncTimer = setInterval(runLoop, _currentIntervalMs)
    _ensureNetVisibilityHandlers()
    // Initial catch-up shortly after start (not instant to avoid blocking paint).
    setTimeout(() => { if (!!_session && navigator.onLine) runLoop() }, 2000)
}

function _stopLoopTimerOnly() {
    if (_syncTimer) {
        clearInterval(_syncTimer)
        _syncTimer = null
    }
    _currentIntervalMs = 0
}

function _ensureNetVisibilityHandlers() {
    if (!_onlineHandler) {
        _onlineHandler = () => {
            console.log('[BgSync] Online. Catch-up sync...')
            syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'reconnecting' })
            if (_session && !_isLooping) {
                _isLooping = true
                const myGen = _sessionGen
                Promise.resolve()
                    .then(async () => {
                        const { pushQueue } = await import('./syncService.js')
                        await pushQueue(_session.cooperative_id || _session.cooperativeId)
                        if (myGen === _sessionGen) await _runDeltaShared()
                    })
                    .catch(e => console.warn('[BgSync] Online catch-up failed:', e.message))
                    .finally(() => {
                        _isLooping = false
                        syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'online' })
                    })
            }
        }
        window.addEventListener('online', _onlineHandler)
    }
    if (!_offlineHandler) {
        _offlineHandler = () => {
            console.log('[BgSync] Offline.')
            syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'offline' })
        }
        window.addEventListener('offline', _offlineHandler)
    }
    if (!_visibilityHandler && typeof document !== 'undefined') {
        _visibilityHandler = () => _adjustLoopTiming()
        document.addEventListener('visibilitychange', _visibilityHandler)
    }
}

function _adjustLoopTiming() {
    if (!_syncTimer) return
    const want = _desiredPullInterval()
    if (want !== _currentIntervalMs) {
        _stopLoopTimerOnly()
        _currentIntervalMs = want
        _syncTimer = setInterval(async () => {
            if (!_isLooping && navigator.onLine && _session &&
                _coordinator !== 'FULL_SYNCING' && _coordinator !== 'SWITCHING_SCOPE' && _coordinator !== 'STOPPING') {
                _isLooping = true
                const myGen = _sessionGen
                try {
                    const { pushQueue } = await import('./syncService.js')
                    await pushQueue(_session.cooperative_id || _session.cooperativeId)
                    if (myGen === _sessionGen) await _runDeltaShared()
                } catch (e) {
                    console.error('[BgSync] Loop error:', e)
                } finally {
                    _isLooping = false
                    _adjustLoopTiming()
                }
            }
        }, want)
    }
}

// Debounced immediate push after local writes (call from data layer).
export function scheduleImmediatePush(cooperativeId, delayMs = 500) {
    if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer)
    _pushDebounceTimer = setTimeout(async () => {
        _pushDebounceTimer = null
        if (!navigator.onLine || !_session) return
        if (_isSyncing || _coordinator === 'FULL_SYNCING' || _coordinator === 'SWITCHING_SCOPE') return
        try {
            const { pushQueue } = await import('./syncService.js')
            await pushQueue(cooperativeId || _session?.cooperative_id || _session?.cooperativeId)
        } catch (e) {
            console.warn('[BgSync] Immediate push failed (backoff will retry):', e.message)
        }
    }, delayMs)
}

// ─── Delta Sync (isolated from UI) ───────────────────────────────────────────

// Single in-flight delta pass shared by every trigger (background loop,
// refresh bootstrap, login, online event, manual catch-up). Callers that fire
// while a pass is already running join it instead of starting a second,
// duplicate set of Firestore queries. Invalidated on session change so a new
// scope never inherits the previous session's pass.
function _runDeltaShared() {
    if (!_deltaInFlight) {
        const run = _deltaSync()
        _deltaInFlight = run
        const done = () => { if (_deltaInFlight === run) _deltaInFlight = null }
        run.then(done, done)
    }
    return _deltaInFlight
}

async function _deltaSync() {
    const cooperativeId = _session.cooperative_id || _session.cooperativeId
    if (!cooperativeId) return

    const { getSyncMeta, updateSyncMeta, queryRows, getPendingQueue, saveMany, getUnsyncedCollections, markCollectionSynced, markCollectionUnsynced } = await import('./sqliteService.js')

    let meta = await getSyncMeta(cooperativeId)

    // If a different-scope user last synced, reset so we re-download everything for this scope
    const currentScope = _getSessionScopeId()
    if (meta && meta.last_sync_scope && currentScope && meta.last_sync_scope !== currentScope) {
        console.log(`[BgSync] Sync scope changed from "${meta.last_sync_scope}" to "${currentScope}". Triggering fresh full sync.`)
        await updateSyncMeta(cooperativeId, {
            is_full_sync_complete: 0,
            collections: null,
            last_sync_ts: 0,
            last_sync_scope: currentScope
        })
        meta = null
    }

    if (!meta?.is_full_sync_complete) {
        const unsynced = await getUnsyncedCollections(cooperativeId)
        if (unsynced.length === 0) {
            // Every collection is already flagged synced but the completion bit
            // was never set (crash between the last markCollectionSynced and the
            // final updateSyncMeta). Falling through to `return` here — as this
            // path used to — leaves `is_full_sync_complete` at 0 forever, so
            // delta sync re-enters this branch on every poll and never fetches
            // anything again. Promote to complete, anchoring the watermark to the
            // cursors already on disk (server-anchored), never to the local clock.
            const stored = (meta?.collection_cursors && typeof meta.collection_cursors === 'object') ? meta.collection_cursors : {}
            let cursorMax = 0
            for (const entry of Object.values(stored)) {
                const ts = Number(entry?.cursorSyncAt) || 0
                if (ts > cursorMax) cursorMax = ts
            }
            await updateSyncMeta(cooperativeId, {
                is_full_sync_complete: 1,
                last_sync_ts: Math.max(meta?.last_sync_ts || 0, cursorMax),
                schema_version: CURRENT_SCHEMA_VERSION,
                last_sync_scope: meta?.last_sync_scope || _getSessionScopeId()
            })
            console.log('[BgSync] Promoted incomplete sync to complete from stored cursors; resuming delta.')
            meta = await getSyncMeta(cooperativeId).catch(() => null)
        } else {
            console.log(`[BgSync] Resuming incomplete sync. Collections remaining: ${unsynced.join(', ')}`)
            const resumeCursors = { ...((meta?.collection_cursors && typeof meta.collection_cursors === 'object') ? meta.collection_cursors : {}) }
            let resumeObsMax = 0
            for (const col of unsynced) {
                try {
                    await markCollectionUnsynced(cooperativeId, col)
                    const docs = await _fetchCollection(col, cooperativeId, 0)
                    if (docs.length > 0) {
                        await saveMany(col, docs)
                        _noteServerTimes(docs)
                        let colMax = 0
                        docs.forEach(d => {
                            const ts = _syncAtMs(d)
                            if (ts > colMax) colMax = ts
                        })
                        if (colMax > resumeObsMax) resumeObsMax = colMax
                        // Seed the per-collection cursor (timestamp + sort
                        // position of the newest doc) so the first delta after
                        // resume is server-anchored (same fix as full sync).
                        const derived = _deriveCursorPair(docs)
                        if (derived) {
                            resumeCursors[col] = { cursorSyncAt: derived.ts, lastDocId: derived.id, updatedAt: Date.now() }
                        } else {
                            const prevCursor = Number(resumeCursors[col]?.cursorSyncAt) || 0
                            const newCursor = Math.max(prevCursor, colMax)
                            if (newCursor > 0) resumeCursors[col] = { cursorSyncAt: newCursor, updatedAt: Date.now() }
                        }
                    }
                    await markCollectionSynced(cooperativeId, col)
                    console.log(`[BgSync] Synced incomplete collection: ${col} (${docs.length} docs)`)
                } catch (err) {
                    console.error(`[BgSync] Failed to sync incomplete collection ${col}:`, err)
                }
            }
            const remaining = await getUnsyncedCollections(cooperativeId)
            if (remaining.length === 0) {
                // Server-anchored watermark: max observed doc time (or the
                // pre-existing value), never the local clock.
                const prevTs = meta?.last_sync_ts || 0
                await updateSyncMeta(cooperativeId, {
                    is_full_sync_complete: 1,
                    last_sync_ts: Math.max(prevTs, resumeObsMax),
                    collection_cursors: resumeCursors,
                    schema_version: CURRENT_SCHEMA_VERSION,
                    last_sync_scope: _getSessionScopeId()
                })
                syncBus.emit(SyncEvents.SYNC_COMPLETED, createSyncPayload(SyncEvents.SYNC_COMPLETED, {
                    count: 0, cooperativeId, isInitial: true
                }))
                console.log('[BgSync] Incomplete sync fully resumed.')
            }
            return
        }
    }

    const lastSyncTs = meta.last_sync_ts || 0
    const myGen = _sessionGen
    const storedCursors = (meta.collection_cursors && typeof meta.collection_cursors === 'object') ? meta.collection_cursors : {}

    try {
        const collections = ['enterprise', 'bank', 'members', 'remittance', 'users', 'notifications', 'cooperatives', 'transaction_types', 'feedback', 'membership_request']
        let updateCount = 0
        const failedCols = []
        const nextCursors = { ...storedCursors }
        // Highest server-anchored timestamp observed this cycle. The global
        // watermark advances ONLY to this value — never to Date.now(), whose
        // clock may run ahead of Firestore and permanently hide updates.
        let cycleObsMax = 0

        const pendingQueue = await getPendingQueue(cooperativeId)
        const pendingIds = new Set(pendingQueue.map(item => `${item.collection_name}_${item.document_id}`))

        for (const col of collections) {
            // Stale-session guard per collection.
            if (myGen !== _sessionGen) {
                console.warn('[BgSync] Session changed during delta sync; aborting.')
                return
            }
            try {
                // Mode selection per collection (legacy behaviour is kept
                // exactly when no position-anchored pair is stored):
                //  - valid (cursorSyncAt, lastDocId) pair → fetch strictly after
                //    that (sync_at, __name__) position: zero re-reads of rows we
                //    already have, no overlap window needed (same-ms batch ties
                //    are covered by the id part of the pair).
                //  - notifications with an empty local table → full scan (0).
                //  - otherwise → legacy floor: min(cursor, global watermark)
                //    minus overlap + idempotent upsert, as before.
                const colState = nextCursors[col]
                const colCursorTs = Number(colState?.cursorSyncAt) || 0
                const prevCursor = colCursorTs
                const prevLastDocId = typeof colState?.lastDocId === 'string' ? colState.lastDocId : ''
                let since = 0
                let cursorPair = null

                if (col === 'notifications') {
                    const existingCount = await queryRows('SELECT COUNT(*) as count FROM notifications')
                    if (existingCount[0]?.count === 0) {
                        since = 0
                    } else if (_isValidCursorPair(colState)) {
                        cursorPair = { ts: colCursorTs, id: prevLastDocId }
                    } else {
                        since = _deltaSinceTs(colCursorTs, lastSyncTs)
                    }
                } else if (_isValidCursorPair(colState)) {
                    cursorPair = { ts: colCursorTs, id: prevLastDocId }
                } else {
                    since = _deltaSinceTs(colCursorTs, lastSyncTs)
                }

                const startCol = Date.now()
                const docs = await _fetchCollection(col, cooperativeId, since, cursorPair)
                const timeCol = Date.now() - startCol

                if (docs.length > 0) {
                    console.log(`[BgSync] Delta Sync: Downloaded ${docs.length} records for ${col} in ${timeCol}ms (mode ${cursorPair ? 'cursor' : 'window'}, since ${new Date(since).toISOString()})`)
                    _noteServerTimes(docs)
                    let colObsMax = 0
                    docs.forEach(d => {
                        const ts = _syncAtMs(d)
                        if (ts > colObsMax) colObsMax = ts
                    })
                    if (colObsMax > cycleObsMax) cycleObsMax = colObsMax

                    const safeDocs = docs.filter(doc => !pendingIds.has(`${col}_${doc.id}`))
                    const skippedCount = docs.length - safeDocs.length
                    if (skippedCount > 0) {
                        console.log(`[BgSync] Skipped ${skippedCount} items in ${col} to preserve unsynced local changes.`)
                    }

                    if (safeDocs.length > 0) {
                        // Re-persist only what this cycle actually learned.
                        // The legacy window floor re-delivers the overlap every
                        // cycle — writing those rows again each poll is pure
                        // write amplification. The cursor only advances after a
                        // successful saveMany, and a failed collection keeps its
                        // old cursor, so anything at or below the stored position
                        // is already on disk. Docs with no server sync_at can't
                        // be placed relative to the cursor (legacy rows, forced
                        // since=0 paths) so they still save. Same-ms docs whose
                        // id sorts AFTER the stored pair are new (they were not
                        // in any earlier page) and do save.
                        const toSave = prevCursor > 0
                            ? safeDocs.filter(d => {
                                const t = _syncAtMs(d)
                                if (t === 0) return true
                                if (t !== prevCursor) return t > prevCursor
                                return !!prevLastDocId && String(d.id) > prevLastDocId
                            })
                            : safeDocs
                        if (toSave.length > 0) {
                            const savedCount = await saveMany(col, toSave)
                            if (savedCount > 0 || toSave.length > 0) {
                                console.log(`[BgSync] Delta Sync: Saved ${savedCount} records for ${col} to IndexedDB`)
                            }
                        }
                        // Emit/count only genuinely-new rows (at or beyond the
                        // pre-cycle cursor position) so re-deliveries save
                        // silently without churning the UI.
                        const freshDocs = prevCursor > 0
                            ? safeDocs.filter(d => {
                                const t = _docTimeMs(d)
                                if (t > prevCursor) return true
                                if (t < prevCursor) return false
                                return _syncAtMs(d) === prevCursor && !!prevLastDocId && String(d.id) > prevLastDocId
                            })
                            : safeDocs
                        updateCount += freshDocs.length
                        _emitGranularUpdates(col, freshDocs)
                    }
                    // Advance this collection's cursor ONLY from observed
                    // server timestamps after successful fetch+persist, paired
                    // with the sort position (last doc id at the max sync_at)
                    // so the next cycle can startAfter it instead of re-reading
                    // an overlap window. Fetch order is ascending
                    // (sync_at, __name__), so the derived pair is the exact
                    // high-water mark of everything downloaded. Failures — and
                    // empty/timestamp-less results — keep the old cursor for
                    // retry instead of poisoning it with a local-clock value.
                    const pair = _deriveCursorPair(docs)
                    if (pair) {
                        nextCursors[col] = { cursorSyncAt: pair.ts, lastDocId: pair.id, updatedAt: Date.now() }
                    }
                } else {
                    // No docs: leave the cursor untouched. Advancing it from
                    // the local clock would permanently hide cloud rows whose
                    // server timestamps fall behind this device's clock.
                }
            } catch (colErr) {
                console.error(`[BgSync] Failed to sync collection ${col}:`, colErr)
                failedCols.push(col)
            }
        }

        if (myGen !== _sessionGen) {
            console.warn('[BgSync] Session changed during delta sync; discarding cursor update.')
            return
        }
        // Persist per-collection cursors every cycle. Advance the global
        // watermark ONLY to observed server timestamps when every collection
        // succeeded; otherwise keep it so failed collections are retried
        // within the overlap window.
        const metaUpdate = { collection_cursors: nextCursors }
        if (failedCols.length === 0) {
            if (cycleObsMax > 0) metaUpdate.last_sync_ts = Math.max(lastSyncTs, cycleObsMax)
        } else {
            console.warn(`[BgSync] ${failedCols.length} collections failed (${failedCols.join(', ')}); global watermark held for retry (healthy collections keep advancing their own cursor pairs, so only these collections retry). If this repeats every cycle, open the Firestore console and check for missing composite indexes on them: cooperative_id == + sync_at range + __name__ ordering.`)
        }
        await updateSyncMeta(cooperativeId, metaUpdate)

        if (updateCount > 0) {
            console.log(`[BgSync] Delta Sync: Complete. Synced ${updateCount} total records.`)
            syncBus.emit(SyncEvents.SYNC_COMPLETED, createSyncPayload(SyncEvents.SYNC_COMPLETED, {
                count: updateCount,
                cooperativeId
            }))
        }
    } catch (err) {
        console.error('[BgSync] Delta sync failed:', err)
        syncBus.emit(SyncEvents.SYNC_FAILED, createSyncPayload(SyncEvents.SYNC_FAILED, {
            error: err.message,
            cooperativeId
        }))
    }
}

// ─── Emit granular events for changed records ─────────────────────────────────

function _emitGranularUpdates(collection, docs) {
    for (const doc of docs) {
        const isDeleted = doc.is_deleted === 1 || doc.is_deleted === true
        switch (collection) {
            case 'members':
                syncBus.emit(
                    isDeleted ? SyncEvents.MEMBER_DELETED : SyncEvents.MEMBER_UPDATED,
                    createSyncPayload(SyncEvents.MEMBER_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'remittance':
                syncBus.emit(
                    isDeleted ? SyncEvents.REMITTANCE_DELETED : SyncEvents.REMITTANCE_UPDATED,
                    createSyncPayload(SyncEvents.REMITTANCE_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'enterprise':
                syncBus.emit(
                    isDeleted ? SyncEvents.ENTERPRISE_DELETED : SyncEvents.ENTERPRISE_UPDATED,
                    createSyncPayload(SyncEvents.ENTERPRISE_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'notifications':
                syncBus.emit(
                    SyncEvents.NOTIFICATION_ADDED,
                    createSyncPayload(SyncEvents.NOTIFICATION_ADDED, { id: doc.id, data: doc })
                )
                break
            case 'users':
                syncBus.emit(
                    SyncEvents.USER_UPDATED,
                    createSyncPayload(SyncEvents.USER_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'bank':
                syncBus.emit(
                    SyncEvents.BANK_UPDATED,
                    createSyncPayload(SyncEvents.BANK_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'cooperatives':
                syncBus.emit(
                    SyncEvents.COOPERATIVE_UPDATED,
                    createSyncPayload(SyncEvents.COOPERATIVE_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'transaction_types':
                syncBus.emit(
                    SyncEvents.TRANSACTION_TYPE_UPDATED,
                    createSyncPayload(SyncEvents.TRANSACTION_TYPE_UPDATED, { id: doc.id, data: doc })
                )
                break
            case 'feedback':
                syncBus.emit(
                    SyncEvents.SYNC_COMPLETED,
                    createSyncPayload(SyncEvents.SYNC_COMPLETED, { id: doc.id, data: doc })
                )
                break
        }
    }
}

// ─── Initial Full Sync ────────────────────────────────────────────────────────

async function _initialSyncInternal(forceFull = false, options = {}) {
    if (_isSyncing) {
        console.log('[BgSync] Initial sync already in progress, skipping duplicate.')
        return false
    }
    if (_coordinator !== 'IDLE' && !options.fromCoordinator) {
        console.log(`[BgSync] Coordinator busy (${_coordinator}), deferring initial sync.`)
        return false
    }
    _isSyncing = true
    const prevCoordinator = _coordinator
    setCoordinator('FULL_SYNCING')
    const myGen = _sessionGen
    const cooperativeId = _session?.cooperative_id || _session?.cooperativeId
    if (!cooperativeId) { _isSyncing = false; setCoordinator(prevCoordinator === 'FULL_SYNCING' ? 'IDLE' : prevCoordinator); return false }

    syncBus.emit(SyncEvents.SYNC_STARTED, createSyncPayload(SyncEvents.SYNC_STARTED, { cooperativeId }))

    const { runSql, saveMany, getAllForCoop, queryRows, updateSyncMeta, getSyncMeta, markCollectionSynced, markCollectionUnsynced } = await import('./sqliteService.js')

    try {
        console.log(`[BgSync] Starting initial sync. forceFull=${forceFull}`);

        // SAFETY GATE: never wipe with unresolved writes unless explicitly allowed.
        // triggerFullResync performs push+verify first and passes allowWipeWithUnresolved
        // only after its own recovery decision. Direct forceFull callers must not
        // destroy pending/failed rows silently.
        if (forceFull && !options.allowWipeWithUnresolved) {
            try {
                const { getQueueSnapshot, getPendingQueue } = await import('./sqliteService.js')
                const snap = await getQueueSnapshot(cooperativeId)
                if (snap.unresolved > 0) {
                    const { pushQueue } = await import('./syncService.js')
                    await pushQueue(cooperativeId)
                    const after = await getQueueSnapshot(cooperativeId)
                    if (after.unresolved > 0) {
                        console.error(`[BgSync] Refusing destructive full sync with ${after.unresolved} unresolved queue rows (pending=${after.pending}, failed=${after.failed}). Preserving local data.`)
                        syncBus.emit(SyncEvents.SYNC_FAILED, createSyncPayload(SyncEvents.SYNC_FAILED, {
                            error: `Unresolved local writes (${after.unresolved}). Resolve or discard from Sync Status before full resync.`,
                            cooperativeId, type: 'UNRESOLVED_QUEUE'
                        }))
                        return false
                    }
                }
            } catch (gateErr) {
                if (gateErr?.message?.includes('Unresolved local writes')) throw gateErr
                console.warn('[BgSync] Queue safety gate check failed, proceeding cautiously:', gateErr?.message)
            }
        }
        
        // If forceFull is requested, mark all collections as unsynced (0) first so the UI turns yellow/red.
        if (forceFull) {
            console.log('[BgSync] forceFull is true. Resetting all collections to unsynced state.');
            const collectionsList = ['enterprise', 'bank', 'cooperatives', 'transaction_types', 'members', 'users', 'remittance', 'notifications', 'feedback'];
            for (const col of collectionsList) {
                await markCollectionUnsynced(cooperativeId, col);
            }
            // Trigger a status update event so UI can render the yellow dots immediately
            syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'syncing' });
        }

        // If DB was previously synced but is now empty (cleared storage), skip the delete phase
        if (forceFull) {
            const existingMeta = await getSyncMeta(cooperativeId)
            if (existingMeta?.is_full_sync_complete) {
                const countResult = await queryRows('SELECT COUNT(*) as cnt FROM members')
                const isEmpty = !countResult || countResult[0]?.cnt === 0
                if (isEmpty) {
                    console.log('[BgSync] DB is empty despite full sync flag. Skipping delete, re-populating directly.')
                    forceFull = false
                }
            }
        }

        if (forceFull) {
            console.log('[BgSync] forceFull is true. Clearing local cache tables.');
            const tables = ['enterprise', 'bank', 'members', 'remittance', 'remittance_detail', 'loans',
                'loan_guarantors', 'users', 'notifications', 'payment_advise', 'cooperatives', 'transaction_types', 'membership_request']
            for (const t of tables) {
                await runSql(`DELETE FROM ${t} WHERE cooperative_id = ? OR id = ?`, [String(cooperativeId), String(cooperativeId)])
            }
        }

        // Per-collection isolation: one slow/failing collection no longer aborts
        // the whole sync (previously a single timeout failed everything and the
        // forceFull wipe above left empty tables = blank dashboard). On failure
        // the collection keeps its previous rows, stays marked unsynced, and is
        // retried by delta sync later. Success-path results are unchanged.
        const failedCollections = [];
        const counts = {};
        // Server-anchored seeds for the delta watermarks, collected from the
        // docs actually downloaded. Seeding cursors here (instead of leaving
        // them empty with a Date.now() global watermark) is what lets the
        // first delta after a full sync catch cloud updates.
        const seedCursors = {};
        let seedObsMax = 0;
        async function syncOne(name, fetchFn, afterSaveFn) {
            await markCollectionUnsynced(cooperativeId, name);
            console.log(`[BgSync] Fetching ${name}...`);
            const tStart = Date.now();
            let docs = [];
            try {
                docs = await fetchFn();
            } catch (err) {
                console.error(`[BgSync] ${name} download failed, keeping previous rows:`, err?.message || err);
                failedCollections.push(name);
                return;
            }
            console.log(`[BgSync] Fetched ${docs.length} ${name} in ${Date.now() - tStart}ms`);
            try {
                await saveMany(name, docs);
            } catch (err) {
                console.error(`[BgSync] ${name} save failed:`, err?.message || err);
                failedCollections.push(name);
                return;
            }
            _noteServerTimes(docs);
            let seedMax = 0;
            docs.forEach(d => {
                const ts = _syncAtMs(d);
                if (ts > seedMax) seedMax = ts;
            });
            if (seedMax > 0) {
                // Pair the timestamp with the sort position of the newest doc
                // (ascending fetch order ⇒ last doc at max sync_at) so delta
                // can startAfter it and never re-reads these rows.
                const derived = _deriveCursorPair(docs)
                seedCursors[name] = (derived && derived.ts === seedMax)
                    ? { cursorSyncAt: seedMax, lastDocId: derived.id, updatedAt: Date.now() }
                    : { cursorSyncAt: seedMax, updatedAt: Date.now() }
                if (seedMax > seedObsMax) seedObsMax = seedMax
            }
            await markCollectionSynced(cooperativeId, name);
            counts[name] = docs.length;
            if (afterSaveFn) await afterSaveFn(docs);
        }

        await syncOne('enterprise', () => _fetchCollection('enterprise', cooperativeId, 0));
        await syncOne('bank', () => _fetchCollection('bank', cooperativeId, 0));
        await syncOne('cooperatives', () => _fetchCollection('cooperatives', cooperativeId, 0));
        await syncOne('transaction_types', () => _fetchCollection('transaction_types', cooperativeId, 0));
        await syncOne('members', () => _fetchCollection('members', cooperativeId, 0));

        const { isAdmin, isStaff } = _getSyncScope(_session);
        if (isAdmin || isStaff) {
            await syncOne('users', () => _fetchCollection('users', cooperativeId, 0));
        } else {
            await markCollectionSynced(cooperativeId, 'users');
        }

        await syncOne('remittance', () => _fetchCollection('remittance', cooperativeId, 0));
        await syncOne('notifications', () => _fetchCollection('notifications', cooperativeId, 0));
        await syncOne('feedback', () => _fetchCollection('feedback', cooperativeId, 0));
        await syncOne('membership_request', () => _fetchCollection('membership_request', cooperativeId, 0));

        if (failedCollections.length > 0) {
            throw new Error(`Collections failed: ${failedCollections.join(', ')} (kept previous rows; will retry)`);
        }

        // Stale-session guard: do not apply results into a newer scope.
        if (myGen !== _sessionGen) {
            console.warn('[BgSync] Session changed during initial sync; discarding results.')
            return false
        }
        // Merge seeded cursors over any pre-existing ones (e.g. a member-scope
        // 'users' cursor when non-admin skips that collection below) and anchor
        // the global watermark to observed server timestamps — never to the
        // local clock. Collections that came back empty keep no cursor, so the
        // next delta polls them from the global watermark (cheap while empty).
        const prevMeta = await getSyncMeta(cooperativeId).catch(() => null)
        const prevCursors = (prevMeta?.collection_cursors && typeof prevMeta.collection_cursors === 'object') ? prevMeta.collection_cursors : {}
        await updateSyncMeta(cooperativeId, {
            is_full_sync_complete: 1,
            last_sync_ts: Math.max(prevMeta?.last_sync_ts || 0, seedObsMax),
            collection_cursors: { ...prevCursors, ...seedCursors },
            schema_version: CURRENT_SCHEMA_VERSION,
            last_sync_scope: _getSessionScopeId()
        })

        const { setAppSetting } = await import('./sqliteService.js')
        const currentUser = _session.username || _session.user_id || _session.member_id
        if (currentUser) {
            await setAppSetting('last_synced_user', currentUser)
        }
        try {
            await setAppSetting('sync_context', JSON.stringify({
                cooperative_id: String(cooperativeId),
                dataset_scope: _getSessionScopeId(),
                principal_type: _getSyncScope(_session).isMember ? 'member' : (_getSyncScope(_session).isAdmin ? 'admin' : 'staff'),
                principal_id: String(_session.user_id || _session.member_id || _session.userId || _session.memberId || _session.username || ''),
                last_successful_sync: Date.now(),
                schema_version: CURRENT_SCHEMA_VERSION
            }))
        } catch (e) {
            // Not fatal: the login decision falls back to sync_state cursors
            // when this key is missing. Still surface it — a silent failure here
            // is what made a populated DB look like a first-ever login.
            console.warn('[BgSync] Failed to persist sync_context; login scope will be inferred from sync_state:', e?.message)
        }

        syncBus.emit(SyncEvents.BULK_MEMBERS_LOADED, createSyncPayload(SyncEvents.BULK_MEMBERS_LOADED, {
            count: counts.members || 0,
            cooperativeId
        }))
        syncBus.emit(SyncEvents.BULK_REMITTANCES_LOADED, createSyncPayload(SyncEvents.BULK_REMITTANCES_LOADED, {
            count: counts.remittance || 0,
            cooperativeId
        }))
        syncBus.emit(SyncEvents.SYNC_COMPLETED, createSyncPayload(SyncEvents.SYNC_COMPLETED, {
            count: (counts.enterprise || 0) + (counts.bank || 0) + (counts.members || 0) + (counts.remittance || 0),
            cooperativeId,
            isInitial: true
        }))
        console.log('[BgSync] Initial Sync Completed Successfully!');
        return true
    } catch (err) {
        console.error('[BgSync] Initial sync failed:', err)
        syncBus.emit(SyncEvents.SYNC_FAILED, createSyncPayload(SyncEvents.SYNC_FAILED, {
            error: err.message,
            cooperativeId
        }))
        return false
    } finally {
        _isSyncing = false
        if (_coordinator === 'FULL_SYNCING') setCoordinator('IDLE')
    }
}

// ─── Firestore Helpers ────────────────────────────────────────────────────────

function _getSessionScopeId() {
    if (!_session) return ''
    const { isAdmin, isStaff, isMember } = _getSyncScope(_session)
    if (isAdmin || isStaff) return 'admin-staff'
    if (isMember) {
        const uid = (_session.user_id || _session.userId || _session.member_id || _session.memberId || _session.id || '').toString()
        return 'member:' + uid
    }
    return ''
}

function _getSyncScope(session) {
    const role = (session.role || '').toLowerCase()
    const perms = (session.permissions || '').toLowerCase()
    const isAdmin = perms.includes('admin') || role === 'admin'
    const isStaff = role === 'staff' || role === 'user' || perms.includes('staff') || perms.includes('user') || isAdmin
    const isMember = role === 'member'
    return { isAdmin, isStaff, isMember }
}

function _normalizeFromFirestore(obj) {
    if (!obj || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) {
        return obj.map(item => _normalizeFromFirestore(item))
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
                data[key] = _normalizeFromFirestore(val)
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

const withTimeout = (promise, ms, description = 'Operation') => {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${description} timed out after ${ms}ms`)), ms))
    ]);
};

// Overlap window subtracted from every delta watermark — LEGACY time-window
// mode only. The delta filter compares against cloud `sync_at` (Firestore
// serverTimestamp), so time-based watermarks must be server-anchored:
// re-querying a small window covers same-ms ties (batched pushes share one
// commit timestamp), docs updated mid-pagination (query pages by __name__,
// filters sync_at client-side), and index lag. Collections carrying a
// position-anchored (cursorSyncAt, lastDocId) pair bypass this window entirely
// via startAfter — the id half of the pair covers same-ms ties with zero
// re-reads; _isValidCursorPair falls back to this window when no pair exists.
const DELTA_OVERLAP_MS = 5 * 60 * 1000

// Best-effort server-anchored timestamp for a downloaded doc. sync_at is set
// by Firestore on push; modified_at/created_at are fallbacks for legacy docs
// that predate sync_at. Returns 0 when no usable timestamp exists.
function _docTimeMs(d) {
    if (!d) return 0
    const t = _syncAtMs(d)
    if (t > 0) return t
    const m = d.modified_at ? new Date(d.modified_at).getTime() : NaN
    if (Number.isFinite(m) && m > 0) return m
    const c = d.created_at ? new Date(d.created_at).getTime() : NaN
    if (Number.isFinite(c) && c > 0) return c
    return 0
}

// Authoritative server timestamp only (Firestore serverTimestamp written on
// push). ONLY this may advance download watermarks — client-written
// modified_at/created_at can carry a bad PC clock and must never move them.
function _syncAtMs(d) {
    if (!d) return 0
    const t = d.sync_at ? new Date(d.sync_at).getTime() : NaN
    return (Number.isFinite(t) && t > 0) ? t : 0
}

// ─── Server clock tracking ──────────────────────────────────────────────────
// Every downloaded sync_at is a sample of (serverNow - localNow): doc sync_at
// values can never be in the future relative to the server, so each sample is
// a SAFE lower bound of the true offset. Keeping the max of recent samples
// gives a server-time estimate that can never run AHEAD of Firestore, which
// is the property watermarks and push stamps need (under-estimating only
// causes harmless re-delivery, never data loss).
let _serverOffsetMs = 0 // serverNow ≈ Date.now() + this; ≤ true offset
const OFFSET_SAMPLE_BOUND_MS = 24 * 60 * 60 * 1000

export function noteServerTimestamp(tsMs) {
    if (!Number.isFinite(tsMs) || tsMs <= 0) return
    const sample = tsMs - Date.now()
    if (Math.abs(sample) > OFFSET_SAMPLE_BOUND_MS) return // garbage guard
    if (sample > _serverOffsetMs) _serverOffsetMs = sample
}

function _noteServerTimes(docs) {
    if (!docs) return
    for (const d of docs) {
        const t = _syncAtMs(d)
        if (t > 0) noteServerTimestamp(t)
    }
}

export function getServerNowMs() {
    return Date.now() + _serverOffsetMs
}

// Called after a successful push. Advances ONLY the per-collection cursors of
// the collections just pushed — never the global last_sync_ts. The delta
// floor is min(cursor, last_sync_ts) − overlap, so keeping last_sync_ts low
// preserves full coverage while the cursor records "uploaded at server time".
// Safe because the estimate never exceeds true server time. Collections whose
// cursors are position-anchored pairs are left untouched (see loop below).
export async function stampPushWatermarks(cooperativeId, collectionNames) {
    if (!cooperativeId || !collectionNames || collectionNames.length === 0) return
    try {
        const { getSyncMeta, updateSyncMeta } = await import('./sqliteService.js')
        const srvNow = getServerNowMs()
        const meta = await getSyncMeta(cooperativeId).catch(() => null)
        const stored = (meta?.collection_cursors && typeof meta.collection_cursors === 'object') ? meta.collection_cursors : {}
        const next = { ...stored }
        for (const col of collectionNames) {
            const existing = next[col]
            // Position-anchored pairs (cursorSyncAt + lastDocId) describe rows
            // actually downloaded — only a successful pull may move them, or the
            // next delta would startAfter a position we never observed. Legacy
            // time-only stamps keep their old behaviour: in time-window mode the
            // delta floor still takes min(cursor, last_sync_ts) − overlap, which
            // is what makes this stamp safe there.
            if (existing && typeof existing.lastDocId === 'string' && existing.lastDocId) continue
            const prev = Number(existing?.cursorSyncAt) || 0
            if (srvNow > prev) next[col] = { cursorSyncAt: srvNow, updatedAt: Date.now() }
        }
        await updateSyncMeta(cooperativeId, { collection_cursors: next })
    } catch (e) {
        console.warn('[BgSync] stampPushWatermarks failed (watermarks converge on next pull):', e?.message)
    }
}

// Conservative delta floor from server-anchored watermarks: the MINIMUM of
// the per-collection cursor and the global watermark, minus overlap. Using
// the minimum (never the maximum, never Date.now()) means a fast local clock
// or a cursor that ran ahead can never permanently hide a cloud update — the
// query becomes a superset and idempotent upsert dedups the overlap.
// Self-heal: a stored anchor ABOVE the server clock (+tolerance) proves a fast
// PC clock poisoned it in the past. Ignoring it drops the floor back to a
// safe value (or 0 = full re-pull once) instead of silently missing cloud
// rows forever with zero console errors.
function _deltaSinceTs(colCursorTs, lastSyncTs) {
    const ceiling = getServerNowMs() + 5 * 60 * 1000
    const anchors = []
    if (Number.isFinite(colCursorTs) && colCursorTs > 0 && colCursorTs <= ceiling) anchors.push(colCursorTs)
    if (Number.isFinite(lastSyncTs) && lastSyncTs > 0 && lastSyncTs <= ceiling) anchors.push(lastSyncTs)
    if (anchors.length === 0) return 0
    return Math.max(0, Math.min(...anchors) - DELTA_OVERLAP_MS)
}

// Position-anchored cursor: (cursorSyncAt, lastDocId) is the exact sort
// position of the newest downloaded doc under (sync_at, __name__). When both
// parts exist and the timestamp is not ahead of the server clock, delta fetches
// startAfter the pair and skip every already-seen row — no overlap re-reads.
// Records without lastDocId (legacy installs, time-only push stamps) and
// poisoned timestamps (fast local clock) fall back to the legacy time-window
// floor in _deltaSinceTs, preserving the previous behaviour exactly.
function _isValidCursorPair(state) {
    const ts = Number(state?.cursorSyncAt) || 0
    const id = typeof state?.lastDocId === 'string' ? state.lastDocId : ''
    if (!id || !(ts > 0)) return false
    return ts <= getServerNowMs() + 5 * 60 * 1000 // same ceiling as _deltaSinceTs
}

// Derive (max sync_at, last doc id at that sync_at) from docs fetched in
// ascending (sync_at, __name__) order. Returns null when nothing usable exists
// (empty results or no doc carries a server sync_at).
function _deriveCursorPair(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return null
    let maxTs = 0
    let maxId = ''
    for (const d of docs) {
        const t = _syncAtMs(d)
        if (t <= 0) continue
        if (t >= maxTs) {
            maxTs = t
            maxId = d && d.id != null ? String(d.id) : ''
        }
    }
    if (!(maxTs > 0) || !maxId) return null
    return { ts: maxTs, id: maxId }
}

// Single-doc collections (cooperatives, member-scoped members) previously did
// one network getDoc per delta cycle even when nothing changed (the since
// filter ran only after the read). When the fetch is an anchored delta read
// (threshold > 0), a short TTL cache serves the previous read instead — the
// same exists/cooperative_id/since checks still run on the cached copy, so
// results are identical whenever the doc is unchanged (the common case) and at
// most TTL-stale when it changed. Full/unanchored fetches (threshold = 0:
// initial sync, resume) always hit the network.
const SINGLE_DOC_TTL_MS = { cooperatives: 5 * 60 * 1000, members: 2 * 60 * 1000 }
const _singleDocCache = new Map() // `${col}/${id}` -> { exists, data, fetchedAt }

async function _resolveSingleDoc(colName, docId, db, allowCache) {
    const key = `${colName}/${docId}`
    if (allowCache) {
        const hit = _singleDocCache.get(key)
        if (hit && Date.now() - hit.fetchedAt < SINGLE_DOC_TTL_MS[colName]) return hit
    }
    const MAX_RETRIES = 2
    const RETRY_DELAYS_MS = [3000, 6000]
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const d = await withTimeout(getDoc(doc(db, colName, docId)), 20000, `getDoc ${colName}/${docId}`)
            const entry = d.exists()
                ? { exists: true, data: _normalizeFromFirestore({ id: d.id, ...d.data() }), fetchedAt: Date.now() }
                : { exists: false, data: null, fetchedAt: Date.now() }
            try { _singleDocCache.set(key, entry) } catch { /* cache is best-effort */ }
            return entry
        } catch (err) {
            if (attempt === MAX_RETRIES) {
                console.error(`[BgSync] fetchCollection failed for ${colName} after ${attempt + 1} attempt(s):`, err)
                throw err
            }
            console.warn(`[BgSync] fetchCollection attempt ${attempt + 1} failed for ${colName}, retrying in ${RETRY_DELAYS_MS[attempt]}ms:`, err.message)
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
        }
    }
}

async function _fetchCollection(collectionName, cooperativeId, sinceTs = 0, cursor = null) {
    const db = getDb()
    const coopStr = String(cooperativeId)
    const MAX_RETRIES = 2
    const RETRY_DELAYS_MS = [3000, 6000]
    // Threshold the single-doc paths filter against: the position-anchored
    // cursor's timestamp in cursor mode, the legacy time window otherwise.
    const docThreshold = cursor ? cursor.ts : sinceTs

    if (collectionName === 'cooperatives') {
        const entry = await _resolveSingleDoc('cooperatives', coopStr, db, docThreshold > 0)
        if (!entry.exists) return []
        const data = entry.data
        if (docThreshold > 0) {
            const syncAt = data.sync_at ? new Date(data.sync_at).getTime() : 0
            if (syncAt <= docThreshold) return []
        }
        return [data]
    }

    let constraints = [where('cooperative_id', '==', coopStr)]

    if (collectionName === 'notifications' && _session) {
        const userId = (_session.user_id || _session.userId || _session.member_id || _session.memberId || '').toString().toLowerCase()
        const username = (_session.username || '').toString().toLowerCase()
        const role = (_session.role || '').toLowerCase()
        const regNo = (_session.registration_no || _session.registrationNo || '').toString().toLowerCase()
        const pool = [userId, username, role, regNo, 'all'].filter(v => v && v !== 'null' && v !== 'undefined')

        const { isAdmin, isStaff } = _getSyncScope(_session)
        if (!isAdmin && !isStaff) {
            constraints.push(where('recipient_id', 'array-contains-any', pool))
        }
    }

    if (collectionName === 'remittance' && _session) {
        const { isAdmin, isStaff, isMember } = _getSyncScope(_session)
        if (isMember) {
            const userId = (_session.user_id || _session.userId || _session.member_id || _session.memberId || '').toString()
            constraints.push(where('member_id', '==', userId))
        }
    }

    if (collectionName === 'members' && _session) {
        const { isMember } = _getSyncScope(_session)
        if (isMember) {
            // Members need only their own row. A direct doc read (1 read) replaces
            // the previous `where('member_id', ...)` query, which matched nothing
            // because member documents don't carry a member_id field.
            const userId = (_session.user_id || _session.userId || _session.member_id || _session.memberId || '').toString()
            if (!userId) return []
            const entry = await _resolveSingleDoc('members', userId, db, docThreshold > 0)
            if (!entry.exists) return []
            const data = entry.data
            if (String(data.cooperative_id) !== coopStr) return []
            if (docThreshold > 0) {
                const syncAt = data.sync_at ? new Date(data.sync_at).getTime() : 0
                if (syncAt <= docThreshold) return []
            }
            return [data]
        }
    }

    if (cursor) {
        // Position-anchored delta: rows strictly after (cursorSyncAt, lastDocId)
        // in (sync_at, __name__) order. `>=` on sync_at keeps same-ms docs whose
        // id sorts after the stored pair — those have not been seen yet.
        constraints.push(where('sync_at', '>=', Timestamp.fromMillis(cursor.ts)))
    } else if (sinceTs > 0) {
        constraints.push(where('sync_at', '>', Timestamp.fromMillis(sinceTs)))
    }

    // Paged download: same rows as one unbounded getDocs, but bounded memory
    // and per-request time. Firestore REQUIRES the first orderBy to be the
    // range-filtered field (sync_at) — ordering by __name__ alone makes every
    // sinceTs>0 query invalid, so deltas silently failed while full syncs
    // (sinceTs=0, no range filter) worked. Requires composite indexes (see
    // firestore.indexes.json); failures are handled per-collection by the caller.
    // NOTE: keep orderBy('sync_at'), orderBy('__name__') in sync with the
    // (cooperative_id, sync_at, __name__) index family (+member variants).
    const ordering = [orderBy('sync_at'), orderBy('__name__')]

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
          let docs = []
          let lastSnap = null
          for (;;) {
              let pageQ
              if (lastSnap) {
                  pageQ = query(collection(db, collectionName), ...constraints, ...ordering, startAfter(lastSnap), limit(SYNC_PAGE_SIZE))
              } else if (cursor) {
                  // Resume from the stored (sync_at, __name__) position — rows
                  // at or before it were downloaded by earlier cycles.
                  pageQ = query(collection(db, collectionName), ...constraints, ...ordering, startAfter(Timestamp.fromMillis(cursor.ts), cursor.id), limit(SYNC_PAGE_SIZE))
              } else {
                  pageQ = query(collection(db, collectionName), ...constraints, ...ordering, limit(SYNC_PAGE_SIZE))
              }
              const snap = await withTimeout(getDocs(pageQ), 45000, `getDocs ${collectionName} page`)
              if (snap.empty) break
              snap.forEach(d => {
                  const data = { id: d.id, ...d.data() }
                  docs.push(_normalizeFromFirestore(data))
              })
              if (snap.size < SYNC_PAGE_SIZE) break
              lastSnap = snap.docs[snap.docs.length - 1]
          }
          if (sinceTs > 0 && !cursor) {
              // Legacy window mode only: cursor mode is already bounded by the
              // server-side `>= cursorSyncAt` range filter.
              docs = docs.filter(d => {
                  const syncAt = d.sync_at ? new Date(d.sync_at).getTime() : 0
                  return syncAt > sinceTs
              })
          }
          return docs
      } catch (err) {
          const isLast = attempt === MAX_RETRIES
          if (isLast) {
              console.error(`[BgSync] fetchCollection failed for ${collectionName} after ${attempt + 1} attempt(s):`, err)
              throw err
          }
          console.warn(`[BgSync] fetchCollection attempt ${attempt + 1} failed for ${collectionName}, retrying in ${RETRY_DELAYS_MS[attempt]}ms:`, err.message)
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
      }
    }
}

// ─── Scope pruning (Rule 5 secured, Rule 6 member-switch) ────────────────
// Removes rows outside the current member's authorized scope from the shared
// IndexedDB so a member login on the same device cannot read prior coop data
// via DevTools, global reads, or exports. Shared static tables
// (enterprise/bank/transaction_types/cooperatives) are kept.
export async function pruneForMemberScope(cooperativeId, session) {
    const coopStr = String(cooperativeId)
    const memberId = String(session.member_id || session.user_id || session.memberId || session.userId || '')
    if (!memberId) throw new Error('pruneForMemberScope: missing member id')
    const username = String(session.username || '').toLowerCase()
    const role = String(session.role || '').toLowerCase()
    const regNo = String(session.registration_no || session.registrationNo || '').toLowerCase()
    const { runSql, queryRows, getItem } = await import('./sqliteService.js')
    const { deleteAllByIndex, getAllByIndex } = await import('./indexedDbService.js')

    // Members: keep only self.
    await runSql('DELETE FROM members WHERE cooperative_id = ? AND id != ?', [coopStr, memberId]).catch(() => {})
    // Remittances: keep only self, cascade children.
    let victimRems = []
    try {
        victimRems = await queryRows('SELECT id FROM remittance WHERE cooperative_id = ? AND member_id != ?', [coopStr, memberId])
    } catch { victimRems = [] }
    await runSql('DELETE FROM remittance WHERE cooperative_id = ? AND member_id != ?', [coopStr, memberId]).catch(() => {})
    for (const r of victimRems) {
        const rid = String(r.id)
        try { await deleteAllByIndex('remittance_detail', 'remittance_id', rid) } catch {}
        try {
            const loans = await getAllByIndex('loans', 'remittance_id', rid).catch(() => [])
            for (const l of loans || []) {
                try { await deleteAllByIndex('loan_guarantors', 'loan_id', String(l.id)) } catch {}
            }
            await deleteAllByIndex('loans', 'remittance_id', rid)
        } catch {}
    }
    // Users table is coop-scope: members must not retain it.
    await runSql('DELETE FROM users WHERE cooperative_id = ?', [coopStr]).catch(() => {})
    // Payment advise: keep only self.
    await runSql('DELETE FROM payment_advise WHERE cooperative_id = ? AND member_id != ?', [coopStr, memberId]).catch(() => {})
    // Notifications: keep only addressed to self/all/role.
    try {
        const notifs = await queryRows('SELECT id, recipient_id FROM notifications WHERE cooperative_id = ?', [coopStr])
        const pool = new Set([memberId.toLowerCase(), username, role, regNo, 'all'].filter(v => v && v !== 'null' && v !== 'undefined'))
        for (const n of notifs) {
            const recips = String(n.recipient_id || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
            const keep = recips.length === 0 || recips.some(r => pool.has(r))
            if (!keep) {
                await runSql('DELETE FROM notifications WHERE id = ?', [String(n.id)]).catch(() => {})
            }
        }
    } catch {}
    // Queue: drop rows for docs that are no longer in scope (they would fail
    // cooperative/member checks server-side). Keep failed quarantine for review
    // only if the doc still exists locally.
    try {
        const { getAllItems, deleteItem } = await import('./indexedDbService.js')
        const q = await getAllItems('sync_queue')
        for (const item of q) {
            if (item.status === 'failed') continue
            if (item.collection_name === 'members' && String(item.document_id) !== memberId) {
                const stillThere = await getItem('members', String(item.document_id)).catch(() => null)
                if (!stillThere) await deleteItem('sync_queue', item.id).catch(() => {})
            }
            if (item.collection_name === 'users') {
                await deleteItem('sync_queue', item.id).catch(() => {})
            }
        }
    } catch {}
    // Record new scope immediately so a crash before pull cannot leak.
    try {
        const { updateSyncMeta, setAppSetting } = await import('./sqliteService.js')
        await updateSyncMeta(coopStr, { last_sync_scope: `member:${memberId}` })
        await setAppSetting('sync_context', JSON.stringify({
            cooperative_id: coopStr,
            dataset_scope: `member:${memberId}`,
            principal_type: 'member',
            principal_id: memberId,
            last_successful_sync: Date.now(),
            schema_version: CURRENT_SCHEMA_VERSION
        }))
    } catch (e) {
        // The scope is already recorded in sync_state above, which is the
        // authoritative fallback, so this only degrades login-scope inference.
        console.warn('[BgSync] pruneForMemberScope: failed to persist sync_context:', e?.message)
    }
    console.log(`[BgSync] Pruned local scope to member:${memberId} for coop ${coopStr}`)
}

// ─── External Sync Triggers ───────────────────────────────────────────────────

export async function triggerFullSync(session, forceFull = true, options = {}) {
    _adoptSession(session)
    await _initialSyncInternal(forceFull, { ...options, fromCoordinator: true })
}

export async function triggerFullResync(session) {
    _adoptSession(session)
    const cooperativeId = session.cooperative_id || session.cooperativeId
    const result = { pushed: 0, error: null, blocked: false }

    // Step 1: Push any pending local changes to Firestore first
    try {
        const { getQueueSnapshot } = await import('./sqliteService.js')
        const { pushQueue } = await import('./syncService.js')
        const snap = await getQueueSnapshot(cooperativeId)
        if (snap.unresolved > 0) {
            console.log(`[BgSync] Full resync: pushing ${snap.unresolved} unresolved local changes first...`)
            await pushQueue(cooperativeId)
            const after = await getQueueSnapshot(cooperativeId)
            result.pushed = snap.unresolved - (after.pending + after.processing)
            if (after.unresolved > 0) {
                // Do NOT silently wipe. Caller (login decision engine) decides
                // BLOCK_AND_RECOVER vs proceeding; default here is to block the
                // destructive path and let the caller surface recovery UI.
                console.error(`[BgSync] Full resync BLOCKED: ${after.unresolved} unresolved rows remain (pending=${after.pending}, failed=${after.failed}).`)
                result.error = `${after.unresolved} unresolved local writes. Resolve from Sync Status before resync.`
                result.blocked = true
                result.remaining = after
                return result
            }
        }
    } catch (err) {
        if (err?.message?.includes('Unresolved local writes')) {
            result.error = err.message
            result.blocked = true
            return result
        }
        console.warn('[BgSync] Full resync: push check failed:', err.message)
        result.error = err.message
        result.blocked = true
        return result
    }

    // Step 2: Clear local cache and re-download everything from Firestore
    setCoordinator('SWITCHING_SCOPE')
    try {
        await _initialSyncInternal(true, { allowWipeWithUnresolved: true, fromCoordinator: true })
    } finally {
        if (_coordinator === 'SWITCHING_SCOPE') setCoordinator('IDLE')
    }

    return result
}

export async function triggerDeltaSync(session) {
    if (_isSyncing || _coordinator === 'FULL_SYNCING' || _coordinator === 'SWITCHING_SCOPE') {
        console.log('[BgSync] Delta deferred: full/resync in progress.')
        return
    }
    // Adopt BEFORE the coordinator check would matter but note the ordering:
    // _deltaSync captures _sessionGen itself, so it always compares against the
    // generation this call established. Adopting the same session twice (login
    // path + init path) no longer invalidates the work.
    _adoptSession(session)
    await _runDeltaShared()
}

// ─── Online/Offline Monitor ───────────────────────────────────────────────────

export function startBgSyncMonitor(session) {
    _adoptSession(session)

    window.addEventListener('online', () => {
        console.log('[BgSync] Online. Triggering background sync...')
        syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'reconnecting' })
        _runDeltaShared().finally(() => {
            syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'online' })
        })
    })

    window.addEventListener('offline', () => {
        console.log('[BgSync] Offline.')
        syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'offline' })
    })

    if (navigator.onLine) {
        syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'online' })
    } else {
        syncBus.emit(SyncEvents.SYNC_STATUS_CHANGED, { status: 'offline' })
    }

    // Auth revalidation in background
    _startAuthRevalidationLoop()
}

function _startAuthRevalidationLoop() {
    setInterval(async () => {
        if (!navigator.onLine || !_session) return
        try {
            const { loadOfflineSession, revalidateOnline, touchSession } = await import('./offlineAuthService.js')
            const local = await loadOfflineSession(
                _session.cooperative_id || _session.cooperativeId,
                _session.user_id || _session.userId || _session.member_id || _session.memberId
            )
            if (!local) return

            const now = Date.now()
            // 10-min sliding sessions: revalidate when idle-verified long ago
            // or when expiry is near (active users are kept warm by recordActivity).
            const revalidateAfterMs = 8 * 60 * 1000
            const expirySoonMs = 2 * 60 * 1000
            const age = now - (local.last_verified_ts || 0)

            if (age > revalidateAfterMs || now > ((local.session_expires_ts || 0) - expirySoonMs)) {
                const result = await revalidateOnline(local)
                if (result.valid) {
                    await touchSession(
                        _session.cooperative_id || _session.cooperativeId,
                        _session.user_id || _session.userId || _session.member_id || _session.memberId
                    )
                } else if (!result.networkError) {
                    console.warn('[BgSync] Session invalid:', result.reason)
                    syncBus.emit(SyncEvents.SYNC_FAILED, {
                        type: SyncEvents.SYNC_FAILED,
                        data: { error: result.reason || 'Session expired', type: 'AUTH_EXPIRED', code: result.code || 'AUTH', reason: result.reason || 'Session expired' },
                        timestamp: Date.now()
                    })
                }
            }
        } catch (e) {
            console.warn('[BgSync] Auth revalidation error:', e.message)
        }
    }, 60 * 1000) // Check every minute (sessions expire after 10 min idle)
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _pauseCount = 0
let _idleResolve = null

function _notifyIdle() {
    if (!_isLooping && _idleResolve) {
        const r = _idleResolve
        _idleResolve = null
        r()
    }
}

export function waitForSyncIdle(timeoutMs = 30000) {
    if (!_isLooping && _coordinator !== 'FULL_SYNCING' && _coordinator !== 'PUSHING' && _coordinator !== 'PULLING') {
        return Promise.resolve()
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => { _idleResolve = null; resolve() }, timeoutMs)
        _idleResolve = () => { clearTimeout(timer); resolve() }
    })
}

export function pauseBackgroundSync() {
    _pauseCount++
    if (_pauseCount === 1) {
        _stopLoopTimerOnly()
        if (_pushDebounceTimer) {
            clearTimeout(_pushDebounceTimer)
            _pushDebounceTimer = null
        }
        console.log('[BgSync] Paused')
    }
}

export function resumeBackgroundSync() {
    if (_pauseCount > 0) _pauseCount--
    if (_pauseCount === 0 && _session) {
        _startBackgroundLoop()
        console.log('[BgSync] Resumed')
    }
}

export function isBackgroundSyncPaused() {
    return _pauseCount > 0
}

export function stopBackgroundSync() {
    setCoordinator('STOPPING')
    _stopLoopTimerOnly()
    if (_pushDebounceTimer) {
        clearTimeout(_pushDebounceTimer)
        _pushDebounceTimer = null
    }
    if (_activityHandler) {
        window.removeEventListener('mousemove', _activityHandler)
        window.removeEventListener('keydown', _activityHandler)
        window.removeEventListener('scroll', _activityHandler)
        _activityHandler = null
    }
    if (_onlineHandler) {
        window.removeEventListener('online', _onlineHandler)
        _onlineHandler = null
    }
    if (_offlineHandler) {
        window.removeEventListener('offline', _offlineHandler)
        _offlineHandler = null
    }
    if (_visibilityHandler && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', _visibilityHandler)
        _visibilityHandler = null
    }
    _isLooping = false
    _isSyncing = false
    _session = null
    _sessionGen++
    setCoordinator('IDLE')
}
