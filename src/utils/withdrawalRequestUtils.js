export function createWithdrawalRequestReference(date = new Date()) {
  const stamp = date instanceof Date ? date : new Date(date)
  const day = stamp.toISOString().slice(0, 10).replaceAll('-', '')
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `WR-${day}-${suffix}`
}

export function calculateGuarantorCoverage(requestAmount, guarantors = []) {
  const requested = Math.max(0, Math.abs(Number(requestAmount) || 0))
  const covered = (Array.isArray(guarantors) ? guarantors : []).reduce(
    (sum, guarantor) => sum + Math.max(0, Number(guarantor?.amount ?? guarantor?.guarantee_amount) || 0),
    0
  )
  return {
    requested,
    covered,
    uncovered: Math.max(0, requested - covered),
    coveragePercent: requested > 0 ? Math.min(100, (covered / requested) * 100) : 0,
    isFullyCovered: requested === 0 || covered >= requested,
  }
}

export function appendRequestStatus(history, status, by, at = new Date().toISOString(), comment = '') {
  const entries = Array.isArray(history) ? history : []
  const last = entries[entries.length - 1]
  if (last?.status === status) return entries
  return [...entries, { status, by: String(by || ''), at: String(at), ...(comment ? { comment: String(comment) } : {}) }]
}
