/**
 * Experimental Loan Management — data layer.
 *
 * READ-ONLY except for the explicit approval/decline calls the page makes
 * through the existing services (never from here).
 *
 * Business rules mirrored from the existing implementation:
 *  - loans rows are created when a loan request is submitted (status
 *    'Pending'), flipped to 'Active' on approval, 'Declined' on decline.
 *  - a loan is disbursed by the negative remittance_detail line on the loan
 *    account; repayments are positive lines on the same member + account.
 *  - charges (interest / form fee / admin charge) are posted once at
 *    origination as 'Loan Charges' lines linked by loan_id; the monthly
 *    instalment is principal ÷ duration.
 *  - outstanding balance is the signed sum of approved lines on the
 *    member + loan account, attributed to the most recent loan of that pair
 *    (the existing getMemberLoans rule).
 *  - 'Overdue' / 'Completed' are never written by the app; here they are
 *    derived for display only, using the same due-date ageing the reports use.
 */

import { fetchMemberLoans, fetchRemittances } from '../../services/data/remittances.js'
import { fetchEnterprises } from '../../services/data/enterprises.js'
import { fetchAllMembers } from '../../services/data/members.js'
import { dayKey, num, shortRef, todayInput } from './format.js'

export const ALL = 'all'

let _cache = null

export function invalidateLoanCache() {
  _cache = null
}

function policyCharges(ent, principal) {
  const out = { interest: 0, formFee: 0, adminCharge: 0, total: 0, lines: [] }
  if (!ent) return out
  const add = (name, raw, isPercent, key) => {
    if (raw === undefined || raw === null || raw === '') return
    const base = Math.abs(parseFloat(raw) || 0)
    if (!base) return
    const value = isPercent ? (base / 100) * principal : base
    if (value <= 0) return
    out[key] = value
    out.total += value
    out.lines.push({ name, value, rate: isPercent ? `${base}% of principal` : 'fixed' })
  }
  add('Interest', ent.interest_rate, truthy(ent.interest_is_percent), 'interest')
  add('Form Fee', ent.form_fee, truthy(ent.form_fee_is_percent), 'formFee')
  add('Admin Charge', ent.admin_charge, truthy(ent.admin_charge_is_percent), 'adminCharge')
  return out
}

function truthy(v) {
  return v === 1 || v === '1' || v === true || v === 'true'
}

function memberNameOf(memberMap, memberId) {
  const id = String(memberId || '')
  const m = memberMap[id]
  if (!m) return id || 'Unknown'
  return (
    m.name ||
    [m.prefix, m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ').trim() ||
    m.mobile ||
    id
  )
}

function accessFilter(user) {
  const role = String(user.role || '').toLowerCase()
  const username = String(user.username || '').trim().toLowerCase()
  const isAdmin =
    !!user.isAdmin ||
    role === 'admin' ||
    String(user.permissions || '').toLowerCase().includes('admin') ||
    username === 'admin' ||
    username === String(user.coopShortName || '').toLowerCase()

  if (isAdmin) return () => true

  const targetMemberId = user.memberId && user.memberId !== '0000000000' ? String(user.memberId) : null
  if (role === 'member' || targetMemberId) {
    const id = targetMemberId || String(user.memberId || '')
    return (loan) => String(loan.member_id) === id
  }

  const raw = user.enterprises || user.enterprise_rights || ''
  const entIds = Array.isArray(raw)
    ? raw.map(String)
    : String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
  if (entIds.length === 0) return () => true
  if (entIds.some((id) => id.toLowerCase() === 'all')) return () => true
  return (loan) => entIds.includes(String(loan.enterprise_id))
}

/**
 * @param {object} user displayUser passed by the host app
 * @returns {{loans:Array, remMap:object, entMap:object, memberMap:object,
 *            enterprises:Array, members:Array, movements:Map, user:object}}
 */
export async function loadLoanDataset(user) {
  const key = `${user.cooperativeId}|${user.username || ''}|${user.isAdmin ? 1 : 0}`
  if (_cache && _cache.key === key) return _cache.data

  const [rawLoans, remittances, enterprises, members] = await Promise.all([
    fetchMemberLoans(user.cooperativeId, null),
    fetchRemittances(user.cooperativeId, user),
    fetchEnterprises(user.cooperativeId, true, false),
    fetchAllMembers(user.cooperativeId, user.username || null, !!user.isAdmin),
  ])

  const entMap = {}
  for (const e of enterprises) entMap[String(e.id)] = e
  const memberMap = {}
  for (const m of members) memberMap[String(m.id)] = m
  const remMap = {}
  for (const r of remittances) remMap[String(r.id)] = r

  // member|enterprise -> posted movement lines (used for repayments)
  const movements = new Map()
  for (const rem of remittances) {
    if (rem.status !== 'Approved') continue
    const date = dayKey(rem.remittance_date || rem.created_at)
    for (const d of rem.details || []) {
      const k = `${String(rem.member_id)}|${String(d.enterprise_id || d.item || '')}`
      if (!movements.has(k)) movements.set(k, [])
      movements.get(k).push({
        date,
        amount: num(d.amount),
        ref: String(rem.id),
        shortRef: shortRef(rem.id),
        description: rem.description || '',
        transactionType: rem.transaction_type || '',
      })
    }
  }
  for (const list of movements.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref))
  }

  const allowed = accessFilter(user)
  const loans = (rawLoans || []).filter(allowed)

  const data = {
    rawLoans: loans,
    remMap,
    entMap,
    memberMap,
    enterprises,
    members,
    movements,
    user,
  }
  data.loans = buildLoans(data)
  _cache = { key, data }
  return data
}

/** Groups loans by member + account so balances can be attributed correctly. */
function groupKey(loan) {
  return `${String(loan.member_id)}|${String(loan.enterprise_id)}`
}

function buildLoans(dataset) {
  const { rawLoans, remMap, entMap, memberMap, movements } = dataset

  const groups = new Map()
  for (const loan of rawLoans) {
    const k = groupKey(loan)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(loan)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => String(b.issued_date || '').localeCompare(String(a.issued_date || '')))
  }

  const today = todayInput()
  const result = []

  for (const raw of rawLoans) {
    const ent = entMap[String(raw.enterprise_id)] || null
    const rem = remMap[String(raw.remittance_id)] || null
    const principal = Math.abs(num(raw.principal_amount))
    const duration = Math.max(0, num(raw.duration_months))
    const recordedCharges = Math.max(0, num(raw.admin_fees))
    const policy = policyCharges(ent, principal)
    const interest = recordedCharges > 0 ? recordedCharges : policy.total
    const interestSource = recordedCharges > 0 ? 'recorded' : policy.total > 0 ? 'policy' : 'none'

    const outstandingSigned = num(raw.outstanding_balance)
    const owed = outstandingSigned < 0 ? Math.abs(outstandingSigned) : 0
    const surplus = outstandingSigned > 0 ? outstandingSigned : 0
    const repaid = Math.max(0, principal + recordedCharges - owed)

    const rawStatus = String(raw.status || 'Pending')
    let statusDisplay = rawStatus
    if (rawStatus === 'Active') {
      if (owed <= 0.005) statusDisplay = 'Completed'
      else if (raw.due_date && dayKey(raw.due_date) < today) statusDisplay = 'Overdue'
      else statusDisplay = 'Active'
    }

    let repaymentState = 'none'
    if (repaid <= 0.005) repaymentState = 'none'
    else if (owed <= 0.005) repaymentState = 'complete'
    else repaymentState = 'partial'
    if (statusDisplay === 'Overdue' && repaymentState !== 'complete') repaymentState = 'overdue'

    const appliedDate = dayKey(raw.created_at || (rem && rem.created_at) || raw.issued_date)
    const instalment = duration > 0 ? principal / duration : 0

    const loan = {
      id: String(raw.id),
      ref: String(raw.id),
      shortRef: shortRef(raw.id),
      memberId: String(raw.member_id),
      memberName: memberNameOf(memberMap, raw.member_id),
      memberReg: (memberMap[String(raw.member_id)] || {}).registration_no || '',
      accountId: String(raw.enterprise_id),
      accountName: raw.enterprise_name || (ent ? ent.account_name : '') || '',
      accountType: ent ? ent.account_type || '' : '',
      principal,
      durationMonths: duration,
      appliedDate,
      issuedDate: dayKey(raw.issued_date),
      dueDate: dayKey(raw.due_date),
      statusRaw: rawStatus,
      statusDisplay,
      repaymentState,
      recordedCharges,
      policyCharges: policy,
      interest,
      interestSource,
      totalPayable: principal + interest,
      repaid,
      owed,
      surplus,
      outstanding: owed,
      progress: principal + recordedCharges > 0 ? (repaid / (principal + recordedCharges)) * 100 : 0,
      instalment,
      notes: raw.notes || '',
      approvedAt: raw.approved_at || (rem && rem.approved_at) || '',
      approvedBy: raw.approved_by || (rem && rem.approved_by) || '',
      remittanceId: String(raw.remittance_id || ''),
      rem,
      raw,
      guarantors: (raw.guarantors || []).map((g) => ({
        id: String(g.id || ''),
        memberId: String(g.member_id || ''),
        memberName: memberNameOf(memberMap, g.member_id),
        amount: num(g.guarantee_amount),
        approval: g.guarantor_approval,
        approvalState:
          g.guarantor_approval === 1 || g.guarantor_approval === '1' || g.guarantor_approval === true
            ? 'approved'
            : g.guarantor_approval === 0 || g.guarantor_approval === '0' || g.guarantor_approval === false
            ? 'rejected'
            : 'pending',
      })),
    }

    // Repayment window: from this loan's issue until the next loan on the
    // same member + account (or today), so lines are not double counted.
    const group = groups.get(groupKey(raw)) || []
    const idx = group.findIndex((l) => String(l.id) === String(raw.id))
    const next = idx >= 0 ? group[idx + 1] : null
    const windowStart = loan.issuedDate || '0000-00-00'
    const windowEnd = next && next.issued_date ? dayKey(next.issued_date) : '9999-99-99'
    const moves = movements.get(groupKey(raw)) || []
    loan.repayments = moves.filter(
      (m) => m.amount > 0 && m.date >= windowStart && m.date < windowEnd
    )
    loan.repaymentTotal = loan.repayments.reduce((s, m) => s + m.amount, 0)

    result.push(loan)
  }

  result.sort((a, b) => {
    const d = String(b.appliedDate || '').localeCompare(String(a.appliedDate || ''))
    if (d !== 0) return d
    return String(b.ref).localeCompare(String(a.ref))
  })

  return result
}

/** Summary cards over the filtered loan set. */
export function computeLoanSummary(loans) {
  const summary = {
    disbursed: 0,
    outstanding: 0,
    repayments: 0,
    pending: 0,
    approved: 0,
    overdueCount: 0,
    overdueAmount: 0,
    declined: 0,
    completed: 0,
    count: loans.length,
  }
  for (const l of loans) {
    if (l.statusRaw === 'Pending') summary.pending += 1
    if (l.statusRaw === 'Declined') summary.declined += 1
    if (l.statusRaw === 'Active') {
      summary.approved += 1
      summary.disbursed += l.principal
      summary.outstanding += l.outstanding
      summary.repayments += l.repaid
      if (l.statusDisplay === 'Completed') summary.completed += 1
      if (l.statusDisplay === 'Overdue') {
        summary.overdueCount += 1
        summary.overdueAmount += l.outstanding
      }
    }
  }
  return summary
}

/**
 * Filters applied by the Loan page UI.
 * @param {Array} loans normalized loans
 * @param {object} filters page filter state
 */
export function filterLoans(loans, filters) {
  const term = String(filters.memberSearch || '').trim().toLowerCase()
  const refTerm = String(filters.refSearch || '').trim().toLowerCase()

  return loans.filter((l) => {
    if (filters.status !== ALL && l.statusDisplay !== filters.status) return false
    if (filters.accountId !== ALL && l.accountId !== filters.accountId) return false
    if (filters.repayment !== ALL) {
      if (filters.repayment === 'overdue') {
        if (l.statusDisplay !== 'Overdue') return false
      } else if (l.repaymentState !== filters.repayment) return false
    }
    if (term) {
      const hay = `${l.memberName} ${l.memberReg} ${l.memberId}`.toLowerCase()
      if (!hay.includes(term)) return false
    }
    if (refTerm) {
      const hay = `${l.ref} ${l.shortRef} ${l.remittanceId}`.toLowerCase()
      if (!hay.includes(refTerm)) return false
    }
    if (filters.appliedFrom && (!l.appliedDate || l.appliedDate < filters.appliedFrom)) return false
    if (filters.appliedTo && (!l.appliedDate || l.appliedDate > filters.appliedTo)) return false
    if (filters.disbursedFrom && (!l.issuedDate || l.issuedDate < filters.disbursedFrom)) return false
    if (filters.disbursedTo && (!l.issuedDate || l.issuedDate > filters.disbursedTo)) return false
    return true
  })
}

/** Loan types (enterprises of type loan + any account referenced by a loan). */
export function loanTypeOptions(dataset) {
  const present = new Set(dataset.rawLoans.map((l) => String(l.enterprise_id)))
  return dataset.enterprises
    .filter((e) => present.has(String(e.id)))
    .map((e) => ({ id: String(e.id), name: e.account_name || String(e.id), type: e.account_type || '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Repayment schedule derived with the existing rule: principal ÷ duration,
 * one instalment per month from the disbursement date. Charges are collected
 * once at origination and are therefore not part of the instalments.
 */
export function buildSchedule(loan) {
  const duration = loan.durationMonths
  if (!duration || !loan.principal || !loan.issuedDate) return []
  const base = loan.principal / duration
  const today = todayInput()
  const rows = []
  let cumulativeDue = 0

  for (let n = 1; n <= duration; n++) {
    const amount = n === duration ? loan.principal - base * (duration - 1) : base
    cumulativeDue += amount
    const dueDate = addMonthsStr(loan.issuedDate, n)
    const covered = Math.min(Math.max(loan.repaid - (cumulativeDue - amount), 0), amount)
    let status = 'Due'
    if (covered >= amount - 0.005) status = 'Paid'
    else if (covered > 0.005) status = 'Partial'
    else if (dueDate < today) status = 'Overdue'
    rows.push({
      n,
      dueDate,
      amount,
      cumulative: cumulativeDue,
      paid: covered,
      status,
    })
  }
  return rows
}

function addMonthsStr(dateStr, months) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  if (!y || !m || !d) return ''
  const base = new Date(y, m - 1, 1)
  base.setMonth(base.getMonth() + months)
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
  const day = Math.min(d, lastDay)
  return dayKey(new Date(base.getFullYear(), base.getMonth(), day))
}

export function defaultLoanFilters() {
  return {
    memberSearch: '',
    refSearch: '',
    status: 'Active',
    accountId: ALL,
    appliedFrom: '',
    appliedTo: '',
    disbursedFrom: '',
    disbursedTo: '',
    repayment: ALL,
  }
}
