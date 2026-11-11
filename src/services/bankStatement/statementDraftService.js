import { getItem, putItem, deleteItem } from '../indexedDbService.js'

const STORE_NAME = 'app_settings'

export function getStatementDraftKey(cooperativeId, userId) {
    return `bank_statement_draft:${String(cooperativeId || '')}:${String(userId || 'unknown')}`
}

export async function loadStatementDraft(cooperativeId, userId) {
    const key = getStatementDraftKey(cooperativeId, userId)
    try {
        const item = await getItem(STORE_NAME, key)
        if (item && item.payload) {
            return item.payload
        }
    } catch (e) {
        console.warn('[BankStatementImport] Failed to load draft from IndexedDB:', e.message)
    }

    // LocalStorage fallback
    try {
        const raw = localStorage.getItem(key)
        if (raw) return JSON.parse(raw)
    } catch (_) {}
    return null
}

export async function saveStatementDraft(cooperativeId, userId, draftData) {
    const key = getStatementDraftKey(cooperativeId, userId)
    const payload = {
        ...draftData,
        cooperative_id: String(cooperativeId || ''),
        user_id: String(userId || ''),
        updated_at: new Date().toISOString()
    }

    try {
        await putItem(STORE_NAME, {
            key,
            payload,
            updated_at: new Date().toISOString()
        })
    } catch (e) {
        console.warn('[BankStatementImport] Failed to save draft to IndexedDB:', e.message)
    }

    try {
        localStorage.setItem(key, JSON.stringify(payload))
    } catch (_) {}
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
