const truthy = value => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true'

const OPENING_MEMBER_SAVINGS = { transaction_type: 'Opening Member Savings', category: 'Member Liability' }
const OPENING_MEMBER_LOAN = { transaction_type: 'Opening Member Loan', category: 'Loan Asset' }

export function isBroughtForwardNote(note = '') {
    const text = String(note || '').normalize('NFKC').toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    return /\bopening\s+(?:balance|balances|bal|bbf)\b/.test(text) ||
        /\b(?:balance|bal)\s+(?:brought\s+(?:forward|foward|fwd)|b\s*f|bfwd|forward|foward|fwd)\b/.test(text) ||
        /\b(?:brought|carried)\s+(?:forward|foward|fwd)\b/.test(text) ||
        /\b(?:bbf|bf|bfwd)\b/.test(text) ||
        /\bb\s*f\b/.test(text)
}

/**
 * Resolve the header classification for a member remittance whose bank is
 * Internal Transfer. Brought-forward notes are recognized first, but only
 * when the signed distribution reconciles to the remittance header. Ordinary
 * transfers keep the existing same-class mapping; mixed distributions remain
 * Internal Transfer because one header cannot represent two classes.
 */
export function classifyMemberInternalTransfer(details = [], enterpriseData = [], { description = '', amount } = {}) {
    const enterprises = new Map((enterpriseData || []).map(e => [String(e.id), e]))
    const activeDetails = (details || []).filter(d => !truthy(d.is_deleted))
    const nonZero = activeDetails.filter(d => Math.abs(parseFloat(d.amount || 0)) > 0)

    const headerAmount = parseFloat(amount)
    const distributionTotal = activeDetails.reduce((sum, detail) => sum + (parseFloat(detail.amount || 0) || 0), 0)
    if (isBroughtForwardNote(description) && Number.isFinite(headerAmount) &&
        Math.abs(distributionTotal - headerAmount) <= 0.01) {
        // A nil opening balance is explicitly treated as savings, even if its
        // zero-sum detail legs happen to reference loan accounts.
        if (Math.abs(headerAmount) < 0.005 || nonZero.length === 0) return { ...OPENING_MEMBER_SAVINGS }

        const memberAccountTypes = nonZero.map(detail => {
            const ent = enterprises.get(String(detail.enterprise_id || detail.item || ''))
            const accountType = String(ent?.account_type || ent?.type || '').toLowerCase()
            return ent && !truthy(ent.is_deleted) && ['loan', 'savings'].includes(accountType)
                ? accountType
                : ''
        })
        if (memberAccountTypes.every(Boolean)) {
            return memberAccountTypes.every(type => type === 'loan')
                ? { ...OPENING_MEMBER_LOAN }
                : { ...OPENING_MEMBER_SAVINGS }
        }
    }

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
