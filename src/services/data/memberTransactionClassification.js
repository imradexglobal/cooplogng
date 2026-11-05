const truthy = value => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true'

/**
 * Resolve the header classification for a member remittance whose bank is
 * Internal Transfer. A header can be mapped safely only when all non-zero
 * details point to the same logical enterprise class. Mixed distributions
 * remain Internal Transfer because one header cannot represent two classes.
 */
export function classifyMemberInternalTransfer(details = [], enterpriseData = []) {
    const enterprises = new Map((enterpriseData || []).map(e => [String(e.id), e]))
    const nonZero = (details || []).filter(d => Math.abs(parseFloat(d.amount || 0)) > 0)
    if (!nonZero.length) return null

    const mapped = nonZero.map(detail => {
        const ent = enterprises.get(String(detail.enterprise_id || detail.item || ''))
        if (!ent) return { key: 'unknown', transaction_type: 'Internal Transfer', category: 'Transfer' }
        const accountType = String(ent.account_type || ent.type || '').toLowerCase()
        if (accountType === 'loan') {
            return { key: 'loan', transaction_type: 'Member Loan', category: 'Loan Asset' }
        }
        if (accountType === 'savings') {
            return { key: 'savings', transaction_type: 'Member Deposit', category: 'Member Liability' }
        }
        const isDueOrPenalty = truthy(ent.compulsory_due) || truthy(ent.is_penalty)
        const isIncome = isDueOrPenalty || truthy(ent.revenue) || accountType === 'revenue'
        if (isIncome) {
            const name = String(ent.account_name || ent.id || '').trim()
            return {
                key: `income:${name}`,
                transaction_type: name || 'Other Income',
                category: 'Operating Income'
            }
        }
        return { key: `other:${String(ent.id)}`, transaction_type: 'Internal Transfer', category: 'Transfer' }
    })

    const first = mapped[0]
    if (!first || mapped.some(item => item.key !== first.key)) return null
    return { transaction_type: first.transaction_type, category: first.category }
}
