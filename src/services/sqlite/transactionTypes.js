import { DEFAULT_TRANSACTION_TYPES } from '../../utils/constants.js'
import { generateId } from '../../utils/formatters.js'
import { getAllItems, getAllByIndex } from '../indexedDbService.js'
import { getDocById } from './dataAccess.js'
import { saveDoc } from './mutationEngine.js'

function getDefaultTypesAsDocs() {
    return DEFAULT_TRANSACTION_TYPES.map((tt, i) => ({
        id: `default_${i}`,
        transaction_type: tt.name,
        classification: tt.classification,
        is_system_default: 1,
        is_active: 1,
        is_locked: tt.is_locked || 0,
    }))
}

export async function initializeDefaultTransactionTypes() {
    return { created: 0 }
}

async function getCustomTypes(cooperativeId) {
    let types
    try {
        types = await getAllByIndex('transaction_types', 'cooperative_id', String(cooperativeId))
        if (!types || types.length === 0) {
            const all = await getAllItems('transaction_types')
            if (all.length > 0) {
                types = all.filter(t => t.cooperative_id === String(cooperativeId))
            }
        }
    } catch (e) {
        const all = await getAllItems('transaction_types')
        types = all.filter(t => t.cooperative_id === String(cooperativeId))
    }
    return types.filter(t => !t.is_deleted)
}

export async function getTransactionTypes(cooperativeId) {
    const defaults = getDefaultTypesAsDocs()
    const custom = await getCustomTypes(cooperativeId)
    // Built-ins are code-owned, not cooperative-owned records. Ignore legacy
    // stored copies so they cannot replace built-in classification or locks.
    const defaultNames = new Set(defaults.map(t => String(t.transaction_type || '').trim().toLowerCase()))
    const customOnly = custom.filter(t => !defaultNames.has(String(t.transaction_type || '').trim().toLowerCase()))
    const merged = [
        ...defaults,
        ...customOnly
    ]
    return merged.sort((a, b) => String(a.transaction_type).localeCompare(String(b.transaction_type)))
}

export async function isTransactionTypeUsed(cooperativeId, transactionTypeId) {
    if (String(transactionTypeId).startsWith('default_')) return false
    const tt = await getDocById(cooperativeId, 'transaction_types', transactionTypeId)
    if (!tt) return false
    const name = tt.transaction_type
    let rems
    try {
        rems = await getAllByIndex('remittance', 'cooperative_id', String(cooperativeId))
        if (!rems || rems.length === 0) {
            const all = await getAllItems('remittance')
            if (all.length > 0) {
                rems = all.filter(r => r.cooperative_id === String(cooperativeId))
            }
        }
    } catch (e) {
        const all = await getAllItems('remittance')
        rems = all.filter(r => r.cooperative_id === String(cooperativeId))
    }
    return rems.some(r => !r.is_deleted && r.transaction_type === name)
}

export async function migrateExistingRemittancesToAddCategory(cooperativeId) {
    let rems
    try {
        rems = await getAllByIndex('remittance', 'cooperative_id', String(cooperativeId))
        if (!rems || rems.length === 0) {
            const all = await getAllItems('remittance')
            if (all.length > 0) {
                rems = all.filter(r => r.cooperative_id === String(cooperativeId))
            }
        }
    } catch (e) {
        const all = await getAllItems('remittance')
        rems = all.filter(r => r.cooperative_id === String(cooperativeId))
    }
    const uncategorized = rems.filter(r => !r.is_deleted && !r.category)
    if (uncategorized.length === 0) return { migrated: 0 }
    const allTypes = await getTransactionTypes(cooperativeId)
    const typeMap = new Map()
    allTypes.forEach(tt => typeMap.set(tt.transaction_type.toLowerCase(), tt.classification))
    let migrated = 0
    for (const rem of uncategorized) {
        if (rem.transaction_type) {
            const classification = typeMap.get(rem.transaction_type.toLowerCase())
            if (classification) {
                rem.category = classification
                migrated++
            }
        }
    }
    return { migrated }
}

export async function migrateTransactionClassifications() {
    return { migrated: 0 }
}

export async function createTransactionType(cooperativeId, name, classification, userId = 'system') {
    const existingTypes = await getTransactionTypes(cooperativeId)
    const duplicate = existingTypes.find(t => t.transaction_type?.toLowerCase() === name.toLowerCase())
    if (duplicate) throw new Error('A transaction type with this name already exists')

    const id = generateId(String(cooperativeId))
    const now = new Date().toISOString()
    const doc = {
        id,
        cooperative_id: cooperativeId,
        transaction_type: name,
        classification,
        is_system_default: 0,
        is_active: 1,
        created_by: userId,
        created_at: now,
        modified_by: userId,
        modified_at: now,
        is_deleted: 0,
        is_synced: 0,
        sync_at: now
    }
    await saveDoc('transaction_types', doc)
    return doc
}

export async function updateTransactionType(cooperativeId, id, data, userId = 'system') {
    if (String(id).startsWith('default_')) throw new Error('System default transaction types cannot be modified')
    const existing = await getDocById(cooperativeId, 'transaction_types', id)
    if (!existing) throw new Error('Transaction type not found')
    if (existing.is_system_default === 1) throw new Error('System default transaction types cannot be modified')
    if (await isTransactionTypeUsed(cooperativeId, id)) throw new Error('Transaction type is already used and cannot be modified')
    const now = new Date().toISOString()
    const updateData = { ...data, modified_by: userId, modified_at: now, is_synced: 0, sync_at: now }
    await saveDoc('transaction_types', { ...existing, ...updateData })
    return await getDocById(cooperativeId, 'transaction_types', id)
}

export async function deleteTransactionType(cooperativeId, id, userId = 'system') {
    if (String(id).startsWith('default_')) throw new Error('System default transaction types cannot be deleted')
    const existing = await getDocById(cooperativeId, 'transaction_types', id)
    if (!existing) throw new Error('Transaction type not found')
    if (existing.is_system_default === 1) throw new Error('System default transaction types cannot be deleted')
    if (await isTransactionTypeUsed(cooperativeId, id)) throw new Error('Transaction type is already used and cannot be deleted')
    const now = new Date().toISOString()
    await saveDoc('transaction_types', {
        ...existing,
        is_deleted: 1,
        deleted_at: now,
        deleted_by: userId,
        is_synced: 0,
        sync_at: now
    })
}
