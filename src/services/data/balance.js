import { getRemittances, queryRows, getLocalDateString } from '../sqliteService.js'

// Cutoff key for "balance up to this entry" previews.
//
// Total order: remittance_date -> created_at -> id. This is the same order the
// history table and the DB page use, so "Opening" always matches the rows
// shown above the selected entry. A backdated record therefore takes its
// Opening from its own date position, not from the moment it was typed in.
//
// `date` is optional: older callers that only pass { ts, id } keep the exact
// creation-order behaviour they had before.
function normalizeCutoff(limit) {
    if (!limit || typeof limit !== 'object') return null
    return {
        date: String(limit.date || ''),
        ts: String(limit.ts || ''),
        id: String(limit.id || '')
    }
}
// Signed comparison against the cutoff: <0 before, 0 at, >0 after.
function compareCutoff(rem, key) {
    if (key.date) {
        const remDate = getLocalDateString(rem.remittance_date || rem.created_at)
        const dc = remDate.localeCompare(key.date)
        if (dc !== 0) return dc
    }
    const tc = String(rem.created_at || '').localeCompare(key.ts)
    if (tc !== 0) return tc
    return String(rem.id).localeCompare(key.id)
}
// true when rem is at/after the cutoff (caller decides inclusive/exclusive
// via the `strict` flag: balance preview excludes the entry itself).
function pastCutoff(rem, key, strict) {
    if (!key) return false
    const c = compareCutoff(rem, key)
    return strict ? c > 0 : c >= 0
}

export async function buildAccountBalance(cooperativeId, user = null, limitRid = null, preloaded = null) {
    // Optional preloaded rows (same content as a fresh fetch) so callers that
    // already loaded remittances/enterprises don't pay for them twice.
    const remittances = (preloaded && preloaded.remittances !== undefined)
        ? preloaded.remittances
        : await getRemittances(cooperativeId, user)
    const enterpriseRows = (preloaded && preloaded.enterprises !== undefined)
        ? preloaded.enterprises
        : await queryRows(
            'SELECT * FROM enterprise WHERE cooperative_id = ? AND is_deleted = 0',
            [String(cooperativeId)]
        )
    const entMap = {}
    const entRevenueMap = {}
    // Dues & penalties count toward member networth even when the enterprise
    // is also flagged as revenue (collections there are member obligations,
    // not pure cooperative income). Pure-revenue enterprises stay excluded.
    const entDuePenaltyMap = {}
    const _isDuePenalty = (ent) => {
        if (!ent) return false
        const due = ent.compulsory_due == 1 || ent.compulsory_due === '1' || ent.compulsory_due === 'true' || ent.compulsory_due === true
        const pen = ent.is_penalty == 1 || ent.is_penalty === '1' || ent.is_penalty === 'true' || ent.is_penalty === true
        return !!(due || pen)
    }
    for (const ent of enterpriseRows) {
        entMap[ent.id] = ent.account_name
        entRevenueMap[ent.id] = (ent.revenue == 1 || ent.revenue === '1' || ent.revenue === 'true' || ent.revenue === true)
        entDuePenaltyMap[ent.id] = _isDuePenalty(ent)
    }
    const balances = {}
    const isMemberQuery = user && user.memberId && user.memberId !== '0000000000'
    const cutoff = normalizeCutoff(limitRid)
    for (const rem of remittances) {
        if (rem.status !== 'Approved') continue
        if (isMemberQuery && rem.member_id !== user.memberId) continue
        if (pastCutoff(rem, cutoff, false)) continue
        const details = rem.details || []
        for (const d of details) {
            const eid = d.enterprise_id || d.item || ''
            if (isMemberQuery && entRevenueMap[eid] && !entDuePenaltyMap[eid]) continue
            if (!balances[eid]) balances[eid] = 0
            balances[eid] += parseFloat(d.amount || 0)
        }
    }
    const accountBalance = Object.entries(balances).map(([id, sum_of_amount]) => ({
        id,
        account_name: entMap[id] || 'Unknown',
        sum_of_amount
    }))
    return { accountBalance }
}

export async function buildMemberLedger(cooperativeId, memberId, user = null, limitRid = null) {
    const remittances = await getRemittances(cooperativeId, user)
    const enterpriseRows = await queryRows(
        'SELECT * FROM enterprise WHERE cooperative_id = ? AND is_deleted = 0',
        [String(cooperativeId)]
    )
    const entMap = {}
    const entRevenueMap = {}
    // Same due/penalty rule as buildAccountBalance above: dues & penalties
    // count toward networth even when flagged revenue; pure revenue stays out.
    const entDuePenaltyMap = {}
    for (const ent of enterpriseRows) {
        entMap[ent.id] = ent.account_name
        entRevenueMap[ent.id] = (ent.revenue == 1 || ent.revenue === '1' || ent.revenue === 'true' || ent.revenue === true)
        const _due = ent.compulsory_due == 1 || ent.compulsory_due === '1' || ent.compulsory_due === 'true' || ent.compulsory_due === true
        const _pen = ent.is_penalty == 1 || ent.is_penalty === '1' || ent.is_penalty === 'true' || ent.is_penalty === true
        entDuePenaltyMap[ent.id] = !!(_due || _pen)
    }
    const memberRemits = remittances.filter(r => r.member_id === memberId && r.status === 'Approved')
    let runningTotal = 0
    const ledgerEntries = []
    const cutoff = normalizeCutoff(limitRid)
    for (const rem of memberRemits) {
        if (pastCutoff(rem, cutoff, true)) continue
        const details = rem.details || []
        for (const d of details) {
            const eid = d.enterprise_id || d.item || ''
            if (entRevenueMap[eid] && !entDuePenaltyMap[eid]) continue
            const amount = parseFloat(d.amount || 0)
            runningTotal += amount
            ledgerEntries.push({
                id: d.id,
                remittance_id: rem.id,
                remittance_date: rem.remittance_date,
                enterprise_id: eid,
                enterprise_name: entMap[eid] || 'Unknown',
                amount,
                running_balance: runningTotal,
                description: rem.description || '',
                status: rem.status
            })
        }
    }
    return { ledgerEntries, totalNetworth: runningTotal }
}
