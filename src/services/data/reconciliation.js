import { generateId } from '../../utils/formatters.js'
import { queryRows, queryOne, saveDoc, enqueueWrite, loadDoc, runSql } from '../sqliteService.js'

function simpleHash(str) {
    let h1 = 0x811c9dc5
    let h2 = 0xdeadbeef
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 0x01000193)
        h2 = Math.imul(h2 ^ ch, 0x85ebca6b)
    }
    h1 = (h1 ^ h1 >>> 16) >>> 0
    h2 = (h2 ^ h2 >>> 13) >>> 0
    return `${h1.toString(16)}${h2.toString(16)}`
}

export async function getReconciliationTotals(cooperativeId, bankName, periodStart, periodEnd) {
    const rows = await queryRows(`
        SELECT id, amount 
        FROM remittance 
        WHERE cooperative_id = ? 
          AND bank_name = ? 
          AND is_deleted = 0 
          AND status = 'Approved'
          AND strftime('%Y-%m-%d', remittance_date) >= ? 
          AND strftime('%Y-%m-%d', remittance_date) <= ?
    `, [String(cooperativeId), bankName, String(periodStart), String(periodEnd)])
    let systemCr = 0, systemDr = 0
    const relevantIds = []
    for (const row of rows) {
        const amt = parseFloat(row.amount || 0)
        if (amt > 0) systemCr += amt
        else systemDr += Math.abs(amt)
        relevantIds.push(row.id)
    }
    relevantIds.sort()
    return { systemCr, systemDr, relevantIds, transactionCount: relevantIds.length }
}

export async function checkReconciliation(cooperativeId, bankName, periodStart, periodEnd, bankCr, bankDr) {
    const totals = await getReconciliationTotals(cooperativeId, bankName, periodStart, periodEnd)
    const bankCrNum = parseFloat(bankCr || 0)
    const bankDrNum = parseFloat(bankDr || 0)
    const crMils = Math.round((bankCrNum - totals.systemCr) * 1000)
    const drMils = Math.round((bankDrNum - totals.systemDr) * 1000)
    const diffCr = crMils / 1000
    const diffDr = drMils / 1000
    const balanced = Math.abs(crMils) <= 9 && Math.abs(drMils) <= 9
    const status = balanced ? 'Balanced' : 'Discrepancy'
    const hashInput = [
        bankCrNum.toFixed(2),
        bankDrNum.toFixed(2),
        totals.systemCr.toFixed(2),
        totals.systemDr.toFixed(2),
        totals.relevantIds.join(',')
    ].join('|')
    const checkHash = simpleHash(hashInput)
    return {
        status,
        diffCr,
        diffDr,
        systemCr: totals.systemCr,
        systemDr: totals.systemDr,
        transactionCount: totals.transactionCount,
        relevantIds: totals.relevantIds,
        checkHash,
        bankCr: bankCrNum,
        bankDr: bankDrNum,
        bankName,
        periodStart,
        periodEnd,
        cooperativeId: String(cooperativeId)
    }
}

export async function getReconciliationSummary(bankName, periodStart, periodEnd, cooperativeId) {
    const row = await queryOne(`
        SELECT * FROM bank_reconciliation_summary 
        WHERE cooperative_id = ? AND bank_name = ? 
          AND is_deleted = 0
          AND period_start = ? AND period_end = ?
        LIMIT 1
    `, [String(cooperativeId), bankName, periodStart, periodEnd])
    return row || null
}

export async function getReconciliationSummariesByOverlap(bankName, periodStart, periodEnd, cooperativeId) {
    const rows = await queryRows(`
        SELECT * FROM bank_reconciliation_summary 
        WHERE cooperative_id = ? AND bank_name = ? 
          AND is_deleted = 0
          AND period_start <= ? AND period_end >= ?
    `, [String(cooperativeId), bankName, periodEnd, periodStart])
    return rows
}

export async function getAllReconciliationSummaries(cooperativeId, bankName = null) {
    const coopId = String(cooperativeId)
    const params = [coopId]
    let sql = `
        SELECT * FROM bank_reconciliation_summary 
        WHERE cooperative_id = ? AND is_deleted = 0
    `
    if (bankName) {
        sql += ' AND bank_name = ?'
        params.push(bankName)
    }
    sql += ' ORDER BY created_at DESC'
    const summaries = await queryRows(sql, params)
    const countRows = await queryRows(`
        SELECT reconciliation_summary_id, COUNT(*) AS tx_count 
        FROM remittance 
        WHERE cooperative_id = ? 
        GROUP BY reconciliation_summary_id
    `, [coopId])
    const countMap = new Map()
    for (const cr of countRows) {
        if (cr.reconciliation_summary_id) {
            countMap.set(cr.reconciliation_summary_id, cr.tx_count || 0)
        }
    }
    return summaries.map(s => ({
        ...s,
        transactionCount: countMap.get(s.id) || 0
    }))
}

export async function getReconciliationHistory(cooperativeId, bankName = null) {
    return getAllReconciliationSummaries(cooperativeId, bankName)
}

export async function saveReconciliationSummary(checkResult, createdBy) {
    if (!checkResult || typeof checkResult !== 'object') {
        throw new Error('Invalid check result passed to saveReconciliationSummary')
    }
    const cooperativeId = String(checkResult.cooperativeId)
    const bankName = checkResult.bankName
    const periodStart = checkResult.periodStart
    const periodEnd = checkResult.periodEnd
    const now = new Date().toISOString()

    const fresh = await checkReconciliation(
        cooperativeId,
        bankName,
        periodStart,
        periodEnd,
        checkResult.bankCr,
        checkResult.bankDr
    )
    if (fresh.checkHash !== checkResult.checkHash) {
        throw new Error('Underlying data changed since last check; please re-check before sealing.')
    }

    const existing = await queryOne(`
        SELECT id FROM bank_reconciliation_summary 
        WHERE cooperative_id = ? AND bank_name = ? 
          AND period_start = ? AND period_end = ? AND is_deleted = 0
    `, [cooperativeId, bankName, periodStart, periodEnd])
    if (existing) throw new Error('This exact date range has already been reconciled.')

    const periodMonth = String(periodStart).slice(0, 7)
    const id = generateId(cooperativeId)
    const doc = {
        id,
        cooperative_id: cooperativeId,
        bank_name: bankName,
        period_month: periodMonth,
        period_start: periodStart,
        period_end: periodEnd,
        bank_total_cr: fresh.bankCr,
        bank_total_dr: fresh.bankDr,
        system_total_cr: fresh.systemCr,
        system_total_dr: fresh.systemDr,
        status: 'Sealed',
        created_at: now,
        created_by: createdBy,
        modified_at: now,
        modified_by: createdBy,
        is_deleted: 0,
        is_synced: 0
    }
    await saveDoc('bank_reconciliation_summary', doc)
    await enqueueWrite(cooperativeId, 'bank_reconciliation_summary', id, 'set', doc)

    const relevantIds = fresh.relevantIds
    if (relevantIds.length > 0) {
        const placeholders = relevantIds.map(() => '?').join(',')
        const bindParams = [id, now, createdBy, 0, cooperativeId, ...relevantIds]
        await runSql(
            `UPDATE remittance SET reconciliation_summary_id = ?, modified_at = ?, modified_by = ?, is_synced = ? WHERE cooperative_id = ? AND id IN (${placeholders})`,
            bindParams
        )
        for (const remId of relevantIds) {
            await enqueueWrite(cooperativeId, 'remittance', remId, 'update', null)
        }
    }
    return id
}

export async function unsealReconciliation(summaryId, modifiedBy) {
    const summary = await queryOne('SELECT * FROM bank_reconciliation_summary WHERE id = ?', [summaryId])
    if (!summary) throw new Error('Reconciliation summary not found')
    const cooperativeId = String(summary.cooperative_id)
    const now = new Date().toISOString()

    await saveDoc('bank_reconciliation_summary', {
        ...summary,
        status: 'Unsealed',
        is_deleted: 1,
        modified_at: now,
        modified_by: modifiedBy,
        is_synced: 0
    })
    await enqueueWrite(cooperativeId, 'bank_reconciliation_summary', summaryId, 'delete', { id: summaryId })

    const affected = await queryRows(
        'SELECT id FROM remittance WHERE cooperative_id = ? AND reconciliation_summary_id = ?',
        [cooperativeId, summaryId]
    )
    if (affected.length > 0) {
        await runSql(
            `UPDATE remittance SET reconciliation_summary_id = NULL, modified_at = ?, modified_by = ?, is_synced = 0 WHERE reconciliation_summary_id = ? AND cooperative_id = ?`,
            [now, modifiedBy, summaryId, cooperativeId]
        )
        for (const r of affected) {
            await enqueueWrite(cooperativeId, 'remittance', r.id, 'update', null)
        }
    }
    return true
}

export async function getReconciliationDrillDown(cooperativeId, bankName, periodStart, periodEnd) {
    const rows = await queryRows(`
        SELECT r.id, r.amount, r.remittance_date, r.bank_name, r.transaction_type, r.category, 
               r.status, r.description, r.member_id, r.reconciliation_summary_id, r.loan_id,
               m.first_name, m.middle_name, m.last_name, m.registration_no
        FROM remittance r
        LEFT JOIN members m ON m.id = r.member_id AND m.is_deleted = 0
        WHERE r.cooperative_id = ? AND r.bank_name = ? AND r.is_deleted = 0
          AND r.status = 'Approved'
          AND strftime('%Y-%m-%d', r.remittance_date) >= ? 
          AND strftime('%Y-%m-%d', r.remittance_date) <= ?
        ORDER BY r.remittance_date ASC
    `, [String(cooperativeId), bankName, String(periodStart), String(periodEnd)])
    return rows.map(r => {
        const amt = parseFloat(r.amount || 0)
        const parts = [r.first_name, r.middle_name, r.last_name].filter(x => x && String(x).trim())
        let memberName = parts.join(' ')
        if (!memberName && r.registration_no) memberName = r.registration_no
        if (!memberName) memberName = 'Cooperative'
        return {
            ...r,
            crDr: amt > 0 ? 'CR' : 'DR',
            memberName
        }
    })
}
