const truthyFlag = value => value === true || value === 1 || value === '1' || value === 'true'

/**
 * Calculate presentation-only advice amounts from raw advice and enterprise settings.
 * Raw advice rows are never mutated. Multiple active raw rows for one member/account
 * are summed before category rules are applied.
 */
export function calculateAdviceByEnterprise(enterprises = [], adviceRows = [], balances = []) {
    const rawByEnterprise = new Map()
    for (const row of adviceRows || []) {
        if (truthyFlag(row?.is_deleted) || !row?.enterprise_id) continue
        const key = String(row.enterprise_id)
        rawByEnterprise.set(key, (rawByEnterprise.get(key) || 0) + (Number(row.amount) || 0))
    }

    const balanceByEnterprise = new Map()
    for (const row of balances || []) {
        if (row?.id != null) balanceByEnterprise.set(String(row.id), Number(row.sum_of_amount) || 0)
    }

    const result = {}
    for (const enterprise of enterprises || []) {
        const id = String(enterprise?.id ?? '')
        if (!id) continue
        const raw = rawByEnterprise.get(id) || 0
        const compulsoryAmount = Math.max(0, Number(enterprise.compulsory_amount) || 0)
        const type = String(enterprise.account_type || enterprise.type || '').trim().toLowerCase()

        // Precedence is intentional: Penalty > Compulsory Due > Revenue > Loan > raw.
        if (truthyFlag(enterprise.is_penalty)) result[id] = 0
        else if (truthyFlag(enterprise.compulsory_due)) result[id] = compulsoryAmount
        else if (truthyFlag(enterprise.revenue)) result[id] = compulsoryAmount
        // Cooplog records loan receivables as negative account balances; cap
        // advice against the outstanding magnitude, not the signed ledger value.
        else if (type === 'loan') result[id] = Math.min(Math.max(0, raw), Math.abs(balanceByEnterprise.get(id) || 0))
        else result[id] = raw
    }
    return result
}
