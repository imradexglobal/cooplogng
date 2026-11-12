import { getItem, putItem, deleteItem } from '../indexedDbService.js'

const STORE_NAME = 'app_settings'

export function getStatementDraftKey(cooperativeId, userId) {
    return `bank_statement_draft:${String(cooperativeId || '')}:${String(userId || 'unknown')}`
}

export async function loadStatementDraft(cooperativeId, userId) {
    const key = getStatementDraftKey(cooperativeId, userId)
    let indexedDraft = null
    let localDraft = null

    try {
        const item = await getItem(STORE_NAME, key)
        if (item && item.payload) indexedDraft = item.payload
    } catch (e) {
        console.warn('[BankStatementImport] Failed to load draft from IndexedDB:', e.message)
    }

    try {
        const raw = localStorage.getItem(key)
        if (raw) localDraft = JSON.parse(raw)
    } catch (_) {}

    if (!indexedDraft) return localDraft
    if (!localDraft) return indexedDraft

    const indexedUpdatedAt = Date.parse(indexedDraft.updated_at || '') || 0
    const localUpdatedAt = Date.parse(localDraft.updated_at || '') || 0
    return localUpdatedAt > indexedUpdatedAt ? localDraft : indexedDraft
}

export async function saveStatementDraft(cooperativeId, userId, draftData) {
    const key = getStatementDraftKey(cooperativeId, userId)
    const now = new Date().toISOString()
    const payload = {
        ...draftData,
        cooperative_id: String(cooperativeId || ''),
        user_id: String(userId || ''),
        updated_at: now
    }

    // Persist the quick recovery copy synchronously before the IndexedDB write completes.
    try {
        localStorage.setItem(key, JSON.stringify(payload))
    } catch (_) {}

    try {
        await putItem(STORE_NAME, {
            key,
            payload,
            updated_at: now
        })
    } catch (e) {
        console.warn('[BankStatementImport] Failed to save draft to IndexedDB:', e.message)
    }
}

export async function clearStatementDraft(cooperativeId, userId) {
    const key = getStatementDraftKey(cooperativeId, userId)
    try {
        await deleteItem(STORE_NAME, key).catch(() => {})
    } catch (_) {}
    try {
        localStorage.removeItem(key)
    } catch (_) {}
}
