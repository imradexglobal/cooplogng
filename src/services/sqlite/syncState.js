import { getItem, putItem } from '../indexedDbService.js'

export const SYNC_COLLECTIONS = [
  'enterprise', 'bank', 'cooperatives', 'transaction_types',
  'members', 'users', 'remittance', 'notifications', 'feedback',
  'membership_request'
]

export async function isSynced(cooperativeId) {
    if (!cooperativeId) return false
    const state = await getItem('sync_state', String(cooperativeId))
    if (!state) return false
    if (state.is_full_sync_complete) return true
    const cols = state.collections || {}
    return SYNC_COLLECTIONS.every(name => cols[name] === 1)
}

// Every mutation below is a read-modify-write of ONE `sync_state` record, and
// IndexedDB gives no cross-transaction atomicity: a get followed by a put lets
// a concurrent writer read stale state and clobber the first writer's fields.
// markCollectionSynced/Unsynced (full sync), updateSyncMeta (delta cursors),
// and stampPushWatermarks (post-push) all target that same record, so a lost
// update silently reverts a cursor advance and re-pulls the overlap window
// forever. Serializing read+write through one promise chain closes the window.
let _stateWriteChain = Promise.resolve()

function _serializeStateWrite(fn) {
    const run = _stateWriteChain.then(fn, fn)
    // Keep the chain alive after a rejection so one failed write can't
    // deadlock every later sync_state mutation.
    _stateWriteChain = run.then(() => {}, () => {})
    return run
}

export async function markCollectionSynced(cooperativeId, collectionName) {
    return _serializeStateWrite(async () => {
        const existing = await getItem('sync_state', String(cooperativeId)) || {}
        const collections = { ...(existing.collections || {}), [collectionName]: 1 }
        await putItem('sync_state', { ...existing, cooperative_id: String(cooperativeId), collections })
    })
}

export async function markCollectionUnsynced(cooperativeId, collectionName) {
    return _serializeStateWrite(async () => {
        const existing = await getItem('sync_state', String(cooperativeId)) || {}
        const collections = { ...(existing.collections || {}), [collectionName]: 0 }
        await putItem('sync_state', { ...existing, cooperative_id: String(cooperativeId), collections })
    })
}

export async function getUnsyncedCollections(cooperativeId) {
    const state = await getItem('sync_state', String(cooperativeId))
    if (!state) return [...SYNC_COLLECTIONS]
    const collections = state.collections || {}
    return SYNC_COLLECTIONS.filter(name => collections[name] !== 1)
}

export async function updateSyncState(cooperativeId, updates) {
    return _serializeStateWrite(async () => {
        const existing = await getItem('sync_state', String(cooperativeId))
        const data = { ...(existing || {}), ...updates, cooperative_id: String(cooperativeId) }
        await putItem('sync_state', data)
    })
}

export const updateSyncMeta = updateSyncState
export const getSyncMeta = (cooperativeId) => getItem('sync_state', String(cooperativeId))
