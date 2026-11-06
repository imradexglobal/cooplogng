/**
 * Experimental Ledger — data layer.
 *
 * READ-ONLY by design. Everything here reads through the existing data /
 * sqlite services (unchanged contracts) and derives presentation rows locally.
 * No writes, no mutations of existing records, no shared page state.
 *
 * Accounting rules mirrored from the existing implementation:
 *  - Only remittances with status 'Approved' post to balances.
 *  - Soft-deleted rows (is_deleted) never reach this module (the service
 *    filters them).
 *  - amount >= 0 is a credit, amount < 0 is a debit.
 *  - Opening balance = posted activity strictly before the selected From date.
 *  - Closing = opening + credits - debits over the selected period.
 *  - Reversals are ordinary approved records whose description starts with
 *    'REVERSAL:' (the existing app has no reversal status), so they post like
 *    any other entry and are only *flagged* for traceability.
 */

import { fetchRemittances } from '../../services/data/remittances.js'
import { fetchEnterprises } from '../../services/data/enterprises.js'
import { fetchAllMembers } from '../../services/data/members.js'
import { syncBus, SyncEvents } from '../../services/syncEventBus.js'
import { dayKey, monthKey, num, shortRef, toSet } from './format.js'

export const INTERNAL_ACCOUNT_ID = '__xp_internal__'
export const ALL = 'all'

let _cache = null
let _syncHooked = false

function hookSyncInvalidation() {
  if (_syncHooked) return
  _syncHooked = true
  const invalidate = () => {
    _cache = null
  }
  try {
    syncBus.on(SyncEvents.REMITTANCE_ADDED, invalidate)
    syncBus.on(SyncEvents.REMITTANCE_UPDATED, invalidate)
    syncBus.on(SyncEvents.REMITTANCE_DELETED, invalidate)
  } catch {
    /* sync bus unavailable — the Refresh button still forces a reload */
  }
}

export function invalidateLedgerCache() {
  _cache = null
}

/**
 * Loads remittances (RBAC-filtered by the existing service), enterprises and
 * members, then flattens them into ledger rows.
 */
export async function loadLedgerDataset(user) {
  hookSyncInvalidation()
  const key = `${user.cooperativeId}|${user.username || ''}|${user.isAdmin ? 1 : 0}`
  if (_cache && _cache.key === key) return _cache.data

  const isAdmin = !!(user.isAdmin || user.role === 'admin')
  const [remittances, enterprises, members] = await Promise.all([
    fetchRemittances(user.cooperativeId, user),
    fetchEnterprises(user.cooperativeId, true, false),
    fetchAllMembers(user.cooperativeId, user.username || null, isAdmin),
  ])

  const entMap = {}
  for (const e of enterprises) {
    entMap[String(e.id)] = e
  }

  const memberMap = {}
  for (const m of members) {
    memberMap[String(m.id)] = m
  }

  const memberNameOf = (memberId) => {
    const id = String(memberId || '')
    if (!id || id === '0000000000') return 'Cooperative (internal)'
    const m = memberMap[id]
    if (!m) return id
    return (
      m.name ||
      [m.prefix, m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ').trim() ||
      m.mobile ||
      id
    )
  }

  const rows = []
  for (const rem of remittances) {
    const details = Array.isArray(rem.details) && rem.details.length > 0 ? rem.details : null
    const date = dayKey(rem.remittance_date || rem.created_at)
    const createdAt = String(rem.created_at || '')
    const isReversal = String(rem.description || '').trim().toUpperCase().startsWith('REVERSAL:')
    const status = rem.status || 'Pending'
    const memberId = String(rem.member_id || '')
    const memberName = memberNameOf(memberId)
    const common = {
      remittanceId: rem.id,
      ref: String(rem.id),
      shortRef: shortRef(rem.id),
      date,
      createdAt,
      transactionType: rem.transaction_type || '',
      category: rem.category || '',
      status,
      memberId,
      memberName,
      bankName: rem.bank_name || '',
      description: rem.description || '',
      isReversal,
      isAutogen: num(rem.autogen) === 1,
      isLoanRequest: !!rem.isLoanRequest,
      isWithdrawalRequest: !!rem.isWithdrawalRequest,
      loanId: rem.loan_id || '',
      parentId: rem.parent_remittance_id || '',
      approvedBy: rem.approved_by || '',
      approvedAt: rem.approved_at || '',
      createdBy: rem.created_by || '',
      rem,
    }

    if (details && details.length > 0) {
      details.forEach((d, idx) => {
        const amount = num(d.amount)
        const entId = String(d.enterprise_id || d.item || '')
        const ent = entMap[entId]
        const detailNote = d.auto_description || d.notes || ''
        rows.push({
          ...common,
          uid: `${rem.id}#${idx}`,
          detailId: d.id || `${rem.id}#${idx}`,
          accountId: entId || INTERNAL_ACCOUNT_ID,
          accountName: ent ? ent.account_name || entId : entId || 'Unassigned',
          accountType: ent ? ent.account_type || '' : '',
          amount,
          credit: amount > 0 ? amount : 0,
          debit: amount < 0 ? Math.abs(amount) : 0,
          displayDescription: detailNote && detailNote !== (rem.description || '')
            ? `${rem.description || detailNote}${rem.description ? ` — ${detailNote}` : ''}`
            : rem.description || detailNote || rem.transaction_type || '',
          hasDetail: true,
        })
      })
    } else {
      // Header-only records (e.g. automatic "Loan Charges" income pickups)
      // carry no detail rows but are still approved, posted entries.
      const amount = num(rem.amount)
      const internalName = `Internal · ${rem.category || rem.transaction_type || 'General'}`
      rows.push({
        ...common,
        uid: `${rem.id}#h`,
        detailId: rem.id,
        accountId: INTERNAL_ACCOUNT_ID,
        accountName: internalName,
        accountType: 'Internal',
        amount,
        credit: amount > 0 ? amount : 0,
        debit: amount < 0 ? Math.abs(amount) : 0,
        displayDescription: rem.description || rem.transaction_type || '',
        hasDetail: false,
      })
    }
  }

  const data = { remittances, enterprises, entMap, members, memberMap, rows, user }
  _cache = { key, data }
  return data
}

/** Chronological entry order: date -> created_at -> id (same as the app). */
export function compareChrono(a, b) {
  const d = String(a.date).localeCompare(String(b.date))
  if (d !== 0) return d
  const c = String(a.createdAt).localeCompare(String(b.createdAt))
  if (c !== 0) return c
  return String(a.ref).localeCompare(String(b.ref)) || String(a.uid).localeCompare(String(b.uid))
}

/** Rows belonging to the selected account + member (date-independent). */
export function scopeRows(rows, filters) {
  return rows.filter((r) => {
    if (filters.accountId !== ALL && r.accountId !== filters.accountId) return false
    if (filters.memberId !== ALL && r.memberId !== filters.memberId) return false
    return true
  })
}

function withinDates(date, from, to) {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

/**
 * Full ledger computation for the selected scope.
 *
 * @param rows      every row in the dataset
 * @param filters   { accountId, memberId, dateFrom, dateTo, txType, status,
 *                   refSearch, descSearch }
 * @returns opening, credits, debits, closing, pendingCount/Amount,
 *          ordered (balance-annotated, posted + non-posted in period),
 *          display (ordered + table-only filters applied), totalsByMonth,
 *          balanceSeries, accountOptions, postedCount
 */
export function computeLedger(rows, filters) {
  const scoped = scopeRows(rows, filters)
  const from = filters.dateFrom || ''
  const to = filters.dateTo || ''

  let opening = 0
  for (const r of scoped) {
    // With no lower date bound, the selected period begins at the start of
    // available history, so nothing belongs in the opening balance.
    if (!from) continue
    if (r.status !== 'Approved') continue
    if (from && r.date >= from) continue
    if (to && r.date > to) continue
    opening += r.amount
  }

  // Everything dated inside the selected period (all statuses).
  const period = scoped.filter((r) => withinDates(r.date, from, to))

  // Balance walks the posted entries in chronological order; non-posted rows
  // are interleaved but never move the balance.
  const ordered = [...period].sort(compareChrono)
  let balance = opening
  let credits = 0
  let debits = 0
  let pendingCount = 0
  let pendingAmount = 0
  let declinedCount = 0

  for (const r of ordered) {
    r.openingBalance = opening
    if (r.status === 'Approved') {
      balance += r.amount
      if (r.amount >= 0) credits += r.amount
      else debits += Math.abs(r.amount)
      r.balance = balance
      r.balanceBefore = balance - r.amount
      r.posted = true
    } else {
      r.balance = balance
      r.balanceBefore = balance
      r.posted = false
      if (r.status === 'Pending') {
        pendingCount += 1
        pendingAmount += Math.abs(r.amount)
      } else {
        declinedCount += 1
      }
    }
  }

  const closing = opening + credits - debits

  // ---- table-only filters (do NOT affect balances or the summary cards) ----
  const typeFilter = filters.txType && filters.txType !== ALL ? String(filters.txType) : ''
  const statusFilter = filters.status && filters.status !== ALL ? String(filters.status) : ''
  const refTerm = String(filters.refSearch || '').trim().toLowerCase()
  const descTerm = String(filters.descSearch || '').trim().toLowerCase()

  // A reference is a direct transaction lookup, so search the full scoped
  // history even when the summary/table date range is limited to a period.
  // Calculate historical balances for those out-of-period rows separately;
  // period totals and charts above remain unchanged.
  let displayRows = ordered
  if (refTerm) {
    let historicalBalance = 0
    displayRows = [...scoped].sort(compareChrono).map((r) => {
      const balanceBefore = historicalBalance
      const posted = r.status === 'Approved'
      if (posted) historicalBalance += r.amount
      return {
        ...r,
        openingBalance: 0,
        balanceBefore,
        balance: historicalBalance,
        posted,
      }
    })
  }

  const normalizeRef = (value) => String(value || '').toLowerCase().replace(/[\s-]/g, '')
  const normalizedRefTerm = normalizeRef(refTerm)
  const display = displayRows.filter((r) => {
    if (typeFilter && r.transactionType !== typeFilter) return false
    if (statusFilter && r.status !== statusFilter) return false
    if (refTerm) {
      const hay = `${r.ref} ${r.shortRef}`.toLowerCase()
      const normalizedHay = normalizeRef(hay)
      if (!hay.includes(refTerm) && !normalizedHay.includes(normalizedRefTerm)) return false
    }
    if (descTerm) {
      const hay = `${r.displayDescription} ${r.transactionType} ${r.category} ${r.accountName}`.toLowerCase()
      if (!hay.includes(descTerm)) return false
    }
    return true
  })

  const totalsByMonth = buildMonthlyTotals(ordered)
  const balanceSeries = buildBalanceSeries(ordered, opening)

  return {
    opening,
    credits,
    debits,
    closing,
    pendingCount,
    pendingAmount,
    declinedCount,
    postedCount: ordered.filter((r) => r.posted).length,
    ordered,
    display,
    totalsByMonth,
    balanceSeries,
    hasTableFilters: !!(typeFilter || statusFilter || refTerm || descTerm),
  }
}

function buildMonthlyTotals(orderedRows) {
  const map = new Map()
  for (const r of orderedRows) {
    if (!r.posted) continue
    const key = monthKey(r.date)
    if (!key) continue
    let bucket = map.get(key)
    if (!bucket) {
      bucket = { month: key, credits: 0, debits: 0, count: 0 }
      map.set(key, bucket)
    }
    bucket.count += 1
    if (r.amount >= 0) bucket.credits += r.amount
    else bucket.debits += Math.abs(r.amount)
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month))
}

function buildBalanceSeries(orderedRows, opening) {
  const byMonth = new Map()
  for (const r of orderedRows) {
    if (!r.posted) continue
    const key = monthKey(r.date)
    if (!key) continue
    let b = byMonth.get(key)
    if (!b) {
      b = { month: key, closing: 0 }
      byMonth.set(key, b)
    }
    b.closing += r.amount
  }
  let running = opening
  return [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((b) => {
      running += b.closing
      return { month: b.month, closing: running }
    })
}

/** Distinct transaction types present in the dataset (for the Type filter). */
export function transactionTypes(rows) {
  const set = new Set()
  for (const r of rows) if (r.transactionType) set.add(r.transactionType)
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** Accounts (enterprises + internal pseudo account) present in the dataset. */
export function accountOptions(dataset) {
  const present = new Set(dataset.rows.map((r) => r.accountId))
  const options = []
  for (const e of dataset.enterprises) {
    const id = String(e.id)
    if (!present.has(id)) continue
    options.push({
      id,
      name: e.account_name || id,
      type: e.account_type || '',
      group: groupFor(e.account_type),
    })
  }
  if (present.has(INTERNAL_ACCOUNT_ID)) {
    options.push({
      id: INTERNAL_ACCOUNT_ID,
      name: 'Internal / unassigned',
      type: 'Internal',
      group: 'Other',
    })
  }
  options.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  return options
}

function groupFor(accountType) {
  const t = String(accountType || '').toLowerCase()
  if (t.includes('loan')) return 'Loans'
  if (t.includes('saving') || t.includes('thrift') || t.includes('share')) return 'Savings & shares'
  if (t.includes('revenue') || t.includes('income')) return 'Income'
  if (t.includes('asset') || t.includes('expense') || t.includes('liability')) return 'Other'
  return 'Other'
}

/** Monthly credit/debit figures for a given scope (used by exports). */
export function exportRows(dataset, filters) {
  const result = computeLedger(dataset.rows, filters)
  return { rows: result.display, result }
}

export function defaultFilters() {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  return {
    accountId: ALL,
    memberId: ALL,
    txType: ALL,
    status: ALL,
    dateFrom: dayKey(from),
    dateTo: dayKey(now),
    refSearch: '',
    descSearch: '',
  }
}

export { toSet }
