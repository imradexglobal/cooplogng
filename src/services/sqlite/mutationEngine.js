import {
    getAllItems, getAllByIndex, getItem, putItem, putItemsBatch,
    deleteAllByIndex, deleteByFilter, deleteItem, clearAllStores
} from '../indexedDbService.js'
import { TABLE_COLUMNS } from './constants.js'
import { filterColumns, serializeValue } from './helpers.js'
import { getDocById_Global } from './dataAccess.js'
import { enqueueWrite } from './syncQueue.js'
import { runSql } from './sqlExecutor.js'

export async function upsertRow(tableName, data) {
    let docToSave = { ...data }
    try {
        const raw = window.sessionStorage.getItem('cooplog-web-session')
        if (raw) {
            const session = JSON.parse(raw)
            if (session && session.role === 'member') {
                if (docToSave.created_by) docToSave.created_by = 'Self';
                if (docToSave.modified_by) docToSave.modified_by = 'Self';
            }
        }
    } catch (e) {}
    const filtered = filterColumns(tableName, docToSave)
    await putItem(tableName, filtered)
}

export async function wipeDatabase() {
    await clearAllStores()
}

export async function hardDeleteDoc(tableName, id) {
    await deleteItem(tableName, String(id))
    if (tableName === 'remittance') {
        await deleteAllByIndex('remittance_detail', 'remittance_id', String(id))
        await deleteAllByIndex('loans', 'remittance_id', String(id))
    } else if (tableName === 'members') {
        await deleteAllByIndex('payment_advise', 'member_id', String(id))
    } else if (tableName === 'loans') {
        await deleteAllByIndex('loan_guarantors', 'loan_id', String(id))
    }
}

export async function upsertMany(tableName, rows) {
    if (!rows || rows.length === 0) return
    let filteredRows = rows.map(row => filterColumns(tableName, row))
    try {
        const raw = window.sessionStorage.getItem('cooplog-web-session')
        if (raw) {
            const session = JSON.parse(raw)
            if (session && session.role === 'member') {
                filteredRows = filteredRows.map(row => {
                    const updated = { ...row }
                    if (updated.created_by) updated.created_by = 'Self';
                    if (updated.modified_by) updated.modified_by = 'Self';
                    return updated;
                })
            }
        }
    } catch (e) {}
    await putItemsBatch(tableName, filteredRows)
}

export async function saveDoc(tableName, doc, skipEnqueue = false) {
    let mappedDoc = { ...doc }
    try {
        const raw = window.sessionStorage.getItem('cooplog-web-session')
        if (raw) {
            const session = JSON.parse(raw)
            if (session && session.role === 'member') {
                if (mappedDoc.created_by) mappedDoc.created_by = 'Self';
                if (mappedDoc.modified_by) mappedDoc.modified_by = 'Self';
            }
        }
    } catch (e) {}
    doc = mappedDoc
    const docToSave = { ...doc, is_synced: doc.is_synced !== undefined ? doc.is_synced : 0 }
    if (tableName === 'remittance') {
        await upsertRow('remittance', docToSave)
        if (doc.is_deleted === 1 || doc.is_deleted === true) {
            const idbDetails = await getAllByIndex('remittance_detail', 'remittance_id', doc.id)
            if (idbDetails.length > 0) {
                await putItemsBatch('remittance_detail', idbDetails.map(d => ({ ...d, is_deleted: 1, is_synced: 0 })))
            }
            const idbLoans = await getAllByIndex('loans', 'remittance_id', doc.id)
            if (idbLoans.length > 0) {
                await putItemsBatch('loans', idbLoans.map(l => ({ ...l, is_deleted: 1, is_synced: 0 })))
                for (const loan of idbLoans) {
                    const idbGuarantors = await getAllByIndex('loan_guarantors', 'loan_id', loan.id)
                    if (idbGuarantors.length > 0) {
                        await putItemsBatch('loan_guarantors', idbGuarantors.map(g => ({ ...g, is_deleted: 1, is_synced: 0 })))
                    }
                    const childRems = await getAllByIndex('remittance', 'loan_id', loan.id)
                    for (const childRem of childRems) {
                        if (childRem.autogen === 1 && (childRem.is_deleted === 0 || !childRem.is_deleted)) {
                            await saveDoc('remittance', { ...childRem, is_deleted: 1 })
                        }
                    }
                }
            }
            // Direct autogen children (dues/penalty autos link loan_id straight
            // to the parent remittance id — no loan bridge). Deleting the parent
            // cascades to them on every delete path (single, bulk, sync-applied).
            // Loan-charge children are unaffected: their loan_id is a loan id,
            // never a remittance id (distinct id formats).
            const directChildren = await getAllByIndex('remittance', 'loan_id', doc.id)
            for (const child of directChildren) {
                if (child.autogen === 1 && (child.is_deleted === 0 || !child.is_deleted)) {
                    await saveDoc('remittance', { ...child, is_deleted: 1 })
                }
            }
            if (doc.autogen === 1 && doc.loan_id) {
                const loan = await getDocById_Global('loans', doc.loan_id)
                if (loan && loan.remittance_id) {
                    const parentRem = await getDocById_Global('remittance', loan.remittance_id)
                    if (parentRem && (parentRem.is_deleted === 0 || !parentRem.is_deleted)) {
                        await saveDoc('remittance', { ...parentRem, is_deleted: 1 })
                    }
                } else {
                    // Dues/penalty-style child: loan_id points straight at the
                    // parent remittance (no loan bridge). Deleting the child
                    // deletes the parent, which cascades to all siblings via
                    // the direct-children block above. Terminates: the parent
                    // is already deleted when siblings recurse back here.
                    const parentRem = await getDocById_Global('remittance', doc.loan_id)
                    if (parentRem && (parentRem.is_deleted === 0 || !parentRem.is_deleted)) {
                        await saveDoc('remittance', { ...parentRem, is_deleted: 1 })
                    }
                }
            }
        } else {
            if (doc.details) {
                await deleteAllByIndex('remittance_detail', 'remittance_id', doc.id)
                const details = doc.details.map(d => ({
                    ...d,
                    remittance_id: doc.id,
                    cooperative_id: doc.cooperative_id,
                    id: d.id || `${doc.id}_${Math.random().toString(36).slice(2)}`,
                    created_by: d.created_by || doc.created_by || doc.modified_by || 'system',
                    created_at: d.created_at || doc.created_at || doc.modified_at || new Date().toISOString()
                }))
                await upsertMany('remittance_detail', details)
            }
            if (doc.loans && Array.isArray(doc.loans)) {
                // Delete old loans and their guarantors before recreating
                // (cleanupRemittanceFamily soft-deleted + enqueued sync already)
                const oldLoans = await getAllByIndex('loans', 'remittance_id', doc.id)
                for (const oldLoan of oldLoans) {
                    await deleteAllByIndex('loan_guarantors', 'loan_id', oldLoan.id)
                }
                await deleteAllByIndex('loans', 'remittance_id', doc.id)
                for (const loan of doc.loans) {
                    loan.remittance_id = doc.id
                    await saveDoc('loans', loan, true)
                }
            }
        }
    } else if (tableName === 'members') {
        await upsertRow('members', docToSave)
        if (doc.is_deleted === 1 || doc.is_deleted === true) {
            const idbAdvises = await getAllByIndex('payment_advise', 'member_id', doc.id)
            if (idbAdvises.length > 0) {
                await putItemsBatch('payment_advise', idbAdvises.map(a => ({ ...a, is_deleted: 1, is_synced: 0 })))
            }
        } else if (doc.payment_advise) {
            const existing = await getAllByIndex('payment_advise', 'member_id', doc.id)
            const existingMap = {}
            for (const e of existing) {
                if (!e.is_deleted) existingMap[String(e.enterprise_id)] = e
            }
            const now = new Date().toISOString()
            const merged = doc.payment_advise.map(a => {
                const entId = String(a.enterprise_id)
                const existingRow = existingMap[entId]
                return {
                    ...(existingRow || {}),
                    ...a,
                    id: existingRow?.id || a.id || `${doc.id}_${Math.random().toString(36).slice(2)}`,
                    member_id: String(doc.id),
                    cooperative_id: String(doc.cooperative_id),
                    enterprise_id: entId,
                    is_deleted: 0,
                    is_synced: existingRow ? 0 : 0,
                    created_by: String(existingRow?.created_by || a.created_by || doc.created_by || doc.modified_by || 'system'),
                    created_at: String(existingRow?.created_at || a.created_at || doc.created_at || doc.modified_at || now),
                    modified_at: now,
                    modified_by: String(a.modified_by || doc.modified_by || doc.created_by || 'system')
                }
            })
            await upsertMany('payment_advise', merged)
        }
    } else if (tableName === 'loans') {
        await upsertRow('loans', docToSave)
        if (doc.is_deleted === 1 || doc.is_deleted === true) {
            const idbGuarantors = await getAllByIndex('loan_guarantors', 'loan_id', doc.id)
            if (idbGuarantors.length > 0) {
                await putItemsBatch('loan_guarantors', idbGuarantors.map(g => ({ ...g, is_deleted: 1, is_synced: 0 })))
            }
            const childRems = await getAllByIndex('remittance', 'loan_id', doc.id)
            for (const cr of childRems) {
                if (cr.autogen === 1 && (cr.is_deleted === 0 || !cr.is_deleted)) {
                    await saveDoc('remittance', { ...cr, is_deleted: 1 }, true)
                }
            }
        } else if (doc.guarantors) {
            await deleteAllByIndex('loan_guarantors', 'loan_id', doc.id)
            const guarantors = doc.guarantors.map(g => ({
                ...g,
                loan_id: doc.id,
                cooperative_id: doc.cooperative_id,
                id: g.id || `${doc.id}_${Math.random().toString(36).slice(2)}`,
                is_synced: 0,
                created_by: g.created_by || doc.created_by || doc.modified_by || 'system',
                created_at: g.created_at || doc.created_at || doc.modified_at || new Date().toISOString()
            }))
            await upsertMany('loan_guarantors', guarantors)
        }
    } else {
        await upsertRow(tableName, docToSave)
    }

    if (!skipEnqueue) {
        const topLevelCollections = ['enterprise', 'bank', 'members', 'remittance', 'users', 'notifications', 'cooperatives', 'transaction_types', 'bank_reconciliation_summary', 'feedback', 'membership_request']
        
        let targetQueue = null;

        if (topLevelCollections.includes(tableName)) {
            const coopId = doc.cooperative_id || (tableName === 'cooperatives' ? doc.id : null)
            if (coopId) {
                targetQueue = { collection: tableName, id: doc.id, cooperativeId: coopId, op: (doc.is_deleted === 1 || doc.is_deleted === true) ? 'delete' : 'update', payload: doc }
            }
        } else if (tableName === 'remittance_detail' || tableName === 'loans') {
            if (doc.remittance_id && doc.cooperative_id) {
                targetQueue = { collection: 'remittance', id: doc.remittance_id, cooperativeId: doc.cooperative_id, op: 'update' }
            }
        } else if (tableName === 'loan_guarantors') {
            if (doc.loan_id) {
                const loan = await getDocById_Global('loans', doc.loan_id)
                if (loan && loan.remittance_id) {
                    targetQueue = { collection: 'remittance', id: loan.remittance_id, cooperativeId: loan.cooperative_id || doc.cooperative_id, op: 'update' }
                }
            }
        } else if (tableName === 'payment_advise') {
            if (doc.member_id && doc.cooperative_id) {
                targetQueue = { collection: 'members', id: doc.member_id, cooperativeId: doc.cooperative_id, op: 'update' }
            }
        }

        if (targetQueue) {
            let payload = targetQueue.payload;
            if (!payload) {
                payload = await loadDoc(targetQueue.collection, targetQueue.id, targetQueue.cooperativeId)
                if (payload) {
                    await runSql(`UPDATE ${targetQueue.collection} SET is_synced = 0 WHERE id = ?`, [targetQueue.id])
                }
            }
            if (payload) {
                await enqueueWrite(targetQueue.cooperativeId, targetQueue.collection, targetQueue.id, targetQueue.op, payload)
                // Immediate push (debounced, best-effort): offline or busy states
                // are swallowed; exponential backoff in the queue covers failures.
                try {
                    if (typeof navigator === 'undefined' || navigator.onLine) {
                        const { scheduleImmediatePush } = await import('../backgroundSyncService.js')
                        scheduleImmediatePush(targetQueue.cooperativeId)
                    }
                } catch {}
            }
        }
    }
}

export async function loadDocLight(tableName, id, cooperativeId) {
    if (tableName === 'cooperatives') {
        return getItem('cooperatives', String(id))
    }
    const doc = await getItem(tableName, String(id))
    if (doc && doc.cooperative_id !== String(cooperativeId)) return null
    return doc || null
}

export async function loadDoc(tableName, id, cooperativeId) {
    let doc
    if (tableName === 'cooperatives') {
        doc = await getItem('cooperatives', String(id))
    } else {
        doc = await getItem(tableName, String(id))
        if (doc && doc.cooperative_id !== String(cooperativeId)) {
            doc = null
        }
    }
    if (!doc) return null

    if (tableName === 'remittance') {
        let details = []
        try {
            details = await getAllByIndex('remittance_detail', 'remittance_id', id)
        } catch (e) { details = [] }
        doc.details = details.filter(d => !d.is_deleted)

        let loans = []
        try {
            loans = await getAllByIndex('loans', 'remittance_id', id)
        } catch (e) { loans = [] }
        loans = loans.filter(l => !l.is_deleted)
        for (const loan of loans) {
            let guarantors = []
            try {
                guarantors = await getAllByIndex('loan_guarantors', 'loan_id', loan.id)
            } catch (e) { guarantors = [] }
            loan.guarantors = guarantors.filter(g => !g.is_deleted)
        }
        doc.loans = loans
    } else if (tableName === 'members') {
        let advises = []
        try {
            advises = await getAllByIndex('payment_advise', 'member_id', id)
        } catch (e) { advises = [] }
        doc.payment_advise = advises.filter(a => !a.is_deleted)
    } else if (tableName === 'loans') {
        let guarantors = []
        try {
            guarantors = await getAllByIndex('loan_guarantors', 'loan_id', id)
        } catch (e) { guarantors = [] }
        doc.guarantors = guarantors.filter(g => !g.is_deleted)
    }
    return doc
}

export async function saveMany(tableName, docs) {
    if (!docs || docs.length === 0) return 0
    const cols = TABLE_COLUMNS[tableName] || null
    // Filter columns once per doc (same rule as before)
    const filteredDocs = docs.map(doc => {
        const keys = cols || Object.keys(doc)
        const filtered = {}
        for (const col of keys) {
            if (doc[col] !== undefined) filtered[col] = doc[col]
        }
        return { doc, filtered }
    })

    let changedCount = 0

    // ── Deletes first (rare path, kept per-doc, unchanged logic) ──
    const liveDocs = []
    for (const { doc, filtered } of filteredDocs) {
        if (doc.is_deleted === 1 || doc.is_deleted === true) {
            await deleteItem(tableName, String(doc.id))
            if (tableName === 'remittance') {
                await deleteAllByIndex('remittance_detail', 'remittance_id', String(doc.id))
                const deadLoans = await getAllByIndex('loans', 'remittance_id', String(doc.id))
                for (const dl of deadLoans) {
                    await deleteAllByIndex('loan_guarantors', 'loan_id', String(dl.id))
                    const childRems = await getAllByIndex('remittance', 'loan_id', String(dl.id))
                    for (const cr of childRems) {
                        if (cr.autogen === 1) await deleteItem('remittance', String(cr.id))
                    }
                }
                await deleteAllByIndex('loans', 'remittance_id', String(doc.id))
                const directChildRems = await getAllByIndex('remittance', 'loan_id', String(doc.id))
                for (const dcr of directChildRems) {
                    if (dcr.autogen === 1) await deleteItem('remittance', String(dcr.id))
                }
            } else if (tableName === 'members') {
                await deleteAllByIndex('payment_advise', 'member_id', String(doc.id))
            } else if (tableName === 'loans') {
                await deleteAllByIndex('loan_guarantors', 'loan_id', String(doc.id))
            }
            changedCount++
        } else {
            liveDocs.push({ doc, filtered })
        }
    }
    if (liveDocs.length === 0) return changedCount

    // ── Bulk read current state once (was: getItem per doc + getAllItems
    // per doc for dedup = O(N) transactions and O(N^2) for members) ──
    const currentById = new Map()
    try {
        const existingRows = await getAllItems(tableName)
        for (const row of existingRows) {
            currentById.set(String(row.id), row)
        }
    } catch (e) {
        // fall through with empty map (all docs treated as new)
    }
    // Apply the deletes above to the in-memory view so later docs in this
    // batch see post-delete state, exactly like the old sequential loop.
    for (const { doc } of filteredDocs) {
        if (doc.is_deleted === 1 || doc.is_deleted === true) {
            currentById.delete(String(doc.id))
        }
    }

    const colsForCompare = cols || Object.keys(liveDocs[0].doc)
    const toWrite = []
    const dupIdsToDelete = new Set()
    const dupKeyOf = (table, d) => {
        if (table === 'members' && d.cooperative_id && d.mobile) {
            return `m|${String(d.cooperative_id)}|${String(d.mobile)}`
        }
        if (table === 'bank' && d.cooperative_id && d.bank_name) {
            return `b|${String(d.cooperative_id)}|${String(d.bank_name)}`
        }
        if (table === 'users' && d.cooperative_id && d.username) {
            return `u|${String(d.cooperative_id)}|${String(d.username)}`
        }
        return null
    }
    // Seed dedup map from current rows (same predicate as the old per-doc scan)
    const dupMap = new Map()
    // Members additionally dedup on non-blank special_id_lower (case-insensitive).
    // Blanks never collide — mirrors the form + data-layer guard.
    const specialDupKeyOf = (d) => {
        if (!d.cooperative_id) return null
        const raw = d.special_id_lower !== undefined && d.special_id_lower !== null
            ? String(d.special_id_lower)
            : String(d.special_id || '')
        const k = raw.trim().toLowerCase()
        return k ? `ms|${String(d.cooperative_id)}|${k}` : null
    }
    const specialDupMap = new Map()
    if (['members', 'bank', 'users'].includes(tableName)) {
        for (const row of currentById.values()) {
            const k = dupKeyOf(tableName, {
                cooperative_id: row.cooperative_id,
                mobile: row.mobile, bank_name: row.bank_name, username: row.username,
            })
            if (k) dupMap.set(k, String(row.id))
            if (tableName === 'members') {
                const sk = specialDupKeyOf(row)
                if (sk) specialDupMap.set(sk, String(row.id))
            }
        }
    }

    for (const { doc, filtered } of liveDocs) {
        const id = String(doc.id)
        const current = currentById.get(id)
        // Skip identical rows (same as old allMatch continue)
        if (current) {
            let allMatch = true
            for (const col of colsForCompare) {
                if (filtered[col] !== undefined && current[col] !== filtered[col]) {
                    allMatch = false
                    break
                }
            }
            if (allMatch) continue
        }
        // Dedup against current view (existing rows + earlier batch placements,
        // minus rows already scheduled for delete) — last write wins, as before.
        const dk = dupKeyOf(tableName, doc)
        if (dk) {
            const dupId = dupMap.get(dk)
            if (dupId && dupId !== id) {
                dupIdsToDelete.add(dupId)
                currentById.delete(dupId)
            }
            dupMap.set(dk, id)
        }
        if (tableName === 'members') {
            const sk = specialDupKeyOf(doc)
            if (sk) {
                const dupId = specialDupMap.get(sk)
                if (dupId && dupId !== id) {
                    dupIdsToDelete.add(dupId)
                    currentById.delete(dupId)
                }
                specialDupMap.set(sk, id)
            }
        }
        // A re-placed id cancels its pending delete (old code deleted then put)
        dupIdsToDelete.delete(id)
        currentById.set(id, filtered)
        toWrite.push({ doc, filtered })
    }

    if (dupIdsToDelete.size > 0) {
        await Promise.all([...dupIdsToDelete].map(dupId => deleteItem(tableName, dupId)))
    }
    if (toWrite.length > 0) {
        await putItemsBatch(tableName, toWrite.map(w => w.filtered))
    }

    // ── Child rows per written doc (unchanged logic, same order) ──
    for (const { doc } of toWrite) {
            if (tableName === 'remittance') {
                if (doc.is_deleted === 1 || doc.is_deleted === true) {
                    const idbDetails = await getAllByIndex('remittance_detail', 'remittance_id', doc.id)
                    if (idbDetails.length > 0) {
                        await putItemsBatch('remittance_detail', idbDetails.map(d => ({ ...d, is_deleted: 1, is_synced: 1 })))
                    }
                    const idbLoans = await getAllByIndex('loans', 'remittance_id', doc.id)
                    if (idbLoans.length > 0) {
                        await putItemsBatch('loans', idbLoans.map(l => ({ ...l, is_deleted: 1, is_synced: 1 })))
                        for (const loan of idbLoans) {
                            const idbGuarantors = await getAllByIndex('loan_guarantors', 'loan_id', loan.id)
                            if (idbGuarantors.length > 0) {
                                await putItemsBatch('loan_guarantors', idbGuarantors.map(g => ({ ...g, is_deleted: 1, is_synced: 1 })))
                            }
                            const childRems = await getAllByIndex('remittance', 'loan_id', loan.id)
                            for (const cr of childRems) {
                                if (cr.autogen === 1 && (cr.is_deleted === 0 || !cr.is_deleted)) {
                                    await saveDoc('remittance', { ...cr, is_deleted: 1 }, true)
                                }
                            }
                        }
                    }
                    const directChildRems = await getAllByIndex('remittance', 'loan_id', doc.id)
                    for (const dcr of directChildRems) {
                        if (dcr.autogen === 1 && (dcr.is_deleted === 0 || !dcr.is_deleted)) {
                            await saveDoc('remittance', { ...dcr, is_deleted: 1 }, true)
                        }
                    }
                } else {
                    if (doc.details) {
                        await deleteAllByIndex('remittance_detail', 'remittance_id', doc.id)
                        const details = doc.details.map(d => ({
                            ...d,
                            remittance_id: doc.id,
                            cooperative_id: doc.cooperative_id,
                            id: d.id || `${doc.id}_${Math.random().toString(36).slice(2)}`,
                            is_synced: 1,
                            created_by: d.created_by || doc.created_by || doc.modified_by || 'system',
                            created_at: d.created_at || doc.created_at || doc.modified_at || new Date().toISOString()
                        }))
                        await upsertMany('remittance_detail', details)
                    }
                    if (doc.loans && Array.isArray(doc.loans)) {
                        // Delete old loans and their guarantors before recreating
                        const oldLoans = await getAllByIndex('loans', 'remittance_id', doc.id)
                        for (const oldLoan of oldLoans) {
                            await deleteAllByIndex('loan_guarantors', 'loan_id', oldLoan.id)
                        }
                        await deleteAllByIndex('loans', 'remittance_id', doc.id)
                        for (const loan of doc.loans) {
                            loan.remittance_id = doc.id
                            loan.is_synced = 1
                            await saveDoc('loans', loan, true)
                        }
                    }
                }
            } else if (tableName === 'members') {
                if (doc.is_deleted === 1 || doc.is_deleted === true) {
                    const idbAdvises = await getAllByIndex('payment_advise', 'member_id', doc.id)
                    if (idbAdvises.length > 0) {
                        await putItemsBatch('payment_advise', idbAdvises.map(a => ({ ...a, is_deleted: 1, is_synced: 1 })))
                    }
                } else if (doc.payment_advise) {
                    await deleteAllByIndex('payment_advise', 'member_id', doc.id)
                    const advises = doc.payment_advise.map(a => ({
                        ...a,
                        member_id: String(doc.id),
                        cooperative_id: String(doc.cooperative_id),
                        id: a.id || `${doc.id}_${Math.random().toString(36).slice(2)}`,
                        is_synced: 1,
                        created_by: String(a.created_by || doc.created_by || doc.modified_by || 'system'),
                        created_at: String(a.created_at || doc.created_at || doc.modified_at || new Date().toISOString())
                    }))
                    await upsertMany('payment_advise', advises)
                }
            } else if (tableName === 'loans') {
                if (doc.is_deleted === 1 || doc.is_deleted === true) {
                    const idbGuarantors = await getAllByIndex('loan_guarantors', 'loan_id', doc.id)
                    if (idbGuarantors.length > 0) {
                        await putItemsBatch('loan_guarantors', idbGuarantors.map(g => ({ ...g, is_deleted: 1, is_synced: 1 })))
                    }
                } else if (doc.guarantors) {
                    await deleteAllByIndex('loan_guarantors', 'loan_id', doc.id)
                    const guarantors = doc.guarantors.map(g => ({
                        ...g,
                        loan_id: doc.id,
                        cooperative_id: doc.cooperative_id,
                        id: g.id || `${doc.id}_${Math.random().toString(36).slice(2)}`,
                        is_synced: 1,
                        created_by: g.created_by || doc.created_by || doc.modified_by || 'system',
                        created_at: g.created_at || doc.created_at || doc.modified_at || new Date().toISOString()
                    }))
                    await upsertMany('loan_guarantors', guarantors)
                }
            }
            changedCount++
        }
    return changedCount
}
