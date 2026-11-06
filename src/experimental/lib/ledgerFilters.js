export const LEDGER_ALL = 'all'

/**
 * These generated internal reallocations are settlement mechanics, not member
 * activity to present as separate transactions. Keep the charge child visible.
 */
export function isDuesSettlementTransfer(remittance) {
  return Number(remittance?.autogen) === 1 &&
    /^auto dues transfer\b/i.test(String(remittance?.description || '').trim())
}

export function shouldHideDuesSettlementTransfer(row, filters) {
  const memberId = String(filters?.memberId || LEDGER_ALL)
  return memberId !== LEDGER_ALL && row?.isDuesSettlementTransfer === true
}

export function isExternalBankOrCashTransaction(row) {
  const bankName = String(row?.bankName || '').trim().toLowerCase()
  const transactionType = String(row?.transactionType || '').trim().toLowerCase()
  if (!bankName) return false
  if (bankName === 'internal transfer' || bankName === 'internal') return false
  if (transactionType === 'internal transfer') return false
  return true
}

/** Rows belonging to the selected account and member, excluding member-only noise. */
export function scopeRows(rows, filters = {}) {
  return rows.filter((row) => {
    const accountId = String(filters.accountId || LEDGER_ALL)
    const memberId = String(filters.memberId || LEDGER_ALL)
    if (accountId !== LEDGER_ALL && row.accountId !== accountId) return false
    if (memberId !== LEDGER_ALL && row.memberId !== memberId) return false
    // The unfiltered General Ledger represents cooperative cash/bank activity,
    // not member account reallocations or unassigned/non-cash postings.
    if (memberId === LEDGER_ALL && !isExternalBankOrCashTransaction(row)) return false
    if (shouldHideDuesSettlementTransfer(row, filters)) return false
    return true
  })
}
