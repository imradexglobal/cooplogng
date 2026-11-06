import { generateId } from '../../utils/formatters.js'
import { queryRows, saveDoc, getDocById_Global } from '../sqliteService.js'

export async function fetchEnterprises(cooperativeId, returnArray = false, includeDeleted = false) {
    const sql = includeDeleted
        ? `SELECT * FROM enterprise WHERE cooperative_id = ?`
        : `SELECT * FROM enterprise WHERE cooperative_id = ? AND is_deleted = 0`
    const rows = await queryRows(sql, [String(cooperativeId)])
    if (returnArray) return rows
    const map = {}
    for (const row of rows) {
        map[row.id] = row.account_name
    }
    return map
}

export async function addEnterprise(data, createdBy) {
    const now = new Date().toISOString()
    const id = generateId(String(data.cooperative_id))
    const accountType = data.account_type || 'Savings'
    const autoRem = String(accountType).toLowerCase() === 'savings' ? Math.max(0, Math.min(100, parseFloat(data.auto_rem) || 0)) : 0
    const doc = {
        id,
        cooperative_id: String(data.cooperative_id),
        account_name: data.account_name,
        account_type: accountType,
        parent_account: data.parent_account || null,
        loan_multiplier: data.loan_multiplier || 0,
        interest_rate: data.interest_rate || 0,
        interest_is_percent: data.interest_is_percent !== undefined ? data.interest_is_percent : 1,
        form_fee: data.form_fee || 0,
        form_fee_is_percent: data.form_fee_is_percent !== undefined ? data.form_fee_is_percent : 0,
        admin_charge: data.admin_charge || 0,
        admin_charge_is_percent: data.admin_charge_is_percent !== undefined ? data.admin_charge_is_percent : 0,
        compulsory_amount: data.compulsory_amount || 0,
        revenue: data.revenue || 0,
        compulsory_due: data.compulsory_due || 0,
        is_penalty: data.is_penalty || 0,
        auto_rem: autoRem,
        created_at: now,
        created_by: createdBy || 'system',
        modified_at: now,
        modified_by: createdBy || 'system',
        is_deleted: 0,
        is_synced: 0
    }
    await saveDoc('enterprise', doc)
    return { id }
}

export async function updateEnterprise(id, data, modifiedBy) {
    const existing = await getDocById_Global('enterprise', id)
    if (!existing) throw new Error('Enterprise not found')
    const now = new Date().toISOString()
    const doc = {
        ...existing,
        ...data,
        id: existing.id,
        modified_at: now,
        modified_by: modifiedBy || 'system',
        is_synced: 0
    }
    doc.auto_rem = String(doc.account_type || '').toLowerCase() === 'savings'
        ? Math.max(0, Math.min(100, parseFloat(doc.auto_rem) || 0))
        : 0
    delete doc.payment_advise
    await saveDoc('enterprise', doc)
}

export async function deleteEnterprise(id, modifiedBy) {
    const existing = await getDocById_Global('enterprise', id)
    if (!existing) throw new Error('Enterprise not found')
    const now = new Date().toISOString()
    await saveDoc('enterprise', {
        ...existing,
        is_deleted: 1,
        modified_at: now,
        modified_by: modifiedBy || 'system',
        is_synced: 0
    })
}
