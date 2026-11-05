import { deleteItem, getItem, putItem } from './indexedDbService.js'

const DRAFT_STORE = 'bulk_remittance_draft'

export function getBulkRemittanceDraftId({ cooperativeId, userId }) {
    return `bulk-varied:${String(cooperativeId || '')}:${String(userId || 'unknown')}`
}

export async function loadBulkRemittanceDraft(key) {
    if (!key) return null
    return getItem(DRAFT_STORE, key).catch(() => null)
}

export async function saveBulkRemittanceDraft(key, draft) {
    if (!key) return
    await putItem(DRAFT_STORE, {
        id: key,
        cooperative_id: String(draft.cooperative_id || ''),
        user_id: String(draft.user_id || ''),
        direction: 'deposit_varied',
        payload: draft.payload || {},
        updated_at: new Date().toISOString()
    })
}

export async function clearBulkRemittanceDraft(key) {
    if (!key) return
    await deleteItem(DRAFT_STORE, key).catch(() => {})
}
