/**
 * Experimental Loan Management page — independent re-implementation.
 *
 * Route: #experimental-loans
 *
 * Reads the existing loans / remittance / guarantor records through the
 * unchanged data services. The only writes it can perform are the existing
 * approveLoanRequest / declineLoanRequest calls, invoked from an explicit
 * review dialog with the same preconditions the existing approval UI uses.
 * Nothing from src/screens/MemberLedger.js, src/components/LoanWizard.js,
 * src/components/WithdrawalWizard.js or src/components/TransactionModal.js is
 * imported here.
 */

import {
  ALL,
  computeLoanSummary,
  defaultLoanFilters,
  filterLoans,
  invalidateLoanCache,
  loadLoanDataset,
  loanTypeOptions,
} from '../lib/loanData.js'
import { escapeHtml, formatDate, formatCurrency, formatNumber, todayInput } from '../lib/format.js'
import { errorHTML, loadingHTML, openDrawer, setMobileTitle, toast } from '../lib/ui.js'
import { exportLoansExcel } from '../lib/exportExcel.js'
import { exportLoansPdf } from '../lib/exportPdf.js'
import { openLoanDetail } from './loanDetail.js'
import { invalidateLedgerCache } from '../lib/ledgerData.js'
import { hasPermission } from '../../services/permissionService.js'
import { fetchBanks } from '../../services/data/banks.js'

const PAGE_SIZES = [25, 50, 100]

const state = {
  user: null,
  filters: defaultLoanFilters(),
  page: 1,
  pageSize: 50,
  sort: { key: 'applied', dir: 'desc' },
  dataset: null,
  loans: [],
  scopeLoans: [],
  typeOpts: [],
  summary: null,
  error: null,
}

const STATUS_OPTIONS = ['Active', 'Pending', 'Overdue', 'Completed', 'Declined']
const REPAYMENT_OPTIONS = [
  { id: ALL, label: 'All repayment states' },
  { id: 'none', label: 'Not started' },
  { id: 'partial', label: 'Partially repaid' },
  { id: 'complete', label: 'Fully repaid' },
  { id: 'overdue', label: 'Overdue' },
]

function isAdminUser() {
  const u = state.user || {}
  return (
    !!u.isAdmin ||
    hasPermission(u.permissions, 'admin') ||
    String(u.username || '').toLowerCase() === 'admin'
  )
}

/* ----------------------------------------------------------------- shell */

function renderShell(container) {
  const f = state.filters
  const types = state.typeOpts || []

  container.innerHTML = `
    <div class="xp xp-loans">
      <div class="xp-print-head">
        <strong>Loan Management — ${escapeHtml(
          state.user.cooperativeName || state.user.cooperativeId
        )}</strong><br/>
        <span>${escapeHtml(f.status === ALL ? 'All statuses' : f.status)} · generated ${escapeHtml(
    todayInput()
  )}</span>
      </div>

      <header class="xp-head">
        <div>
          <div class="xp-eyebrow">Experimental · independent build</div>
          <h1>Loan Management</h1>
          <p class="xp-sub" id="xp-loan-scope">Applications, disbursements and repayments for
            <strong>${escapeHtml(state.user.cooperativeName || state.user.cooperativeId)}</strong></p>
        </div>
        <div class="xp-head-actions">
          <button type="button" class="xp-btn" data-xp-action="refresh">↻ Refresh</button>
          <button type="button" class="xp-btn" data-xp-action="export-excel">⤓ Excel</button>
          <button type="button" class="xp-btn" data-xp-action="export-pdf">⤓ PDF</button>
          <button type="button" class="xp-btn" data-xp-action="print">🖨 Print</button>
        </div>
      </header>

      <section class="xp-cards" id="xp-loan-cards" aria-label="Loan summary">
        ${loadingHTML('Summarising loans…')}
      </section>

      <section class="xp-panel xp-filters-panel" aria-label="Loan filters">
        <div class="xp-panel-head">
          <h2>Filters</h2>
          <span class="xp-panel-hint">Status and date filters apply to the register below.</span>
        </div>
        <div class="xp-filters">
          <div class="xp-field">
            <label for="xp-l-member">Member search</label>
            <input id="xp-l-member" class="xp-input" type="search" data-lf="memberSearch"
                   placeholder="Name, reg. no or ID…" value="${escapeHtml(f.memberSearch)}" />
          </div>

          <div class="xp-field">
            <label for="xp-l-ref">Loan reference</label>
            <input id="xp-l-ref" class="xp-input" type="search" data-lf="refSearch"
                   placeholder="Loan or transaction reference…" value="${escapeHtml(f.refSearch)}" />
          </div>

          <div class="xp-field">
            <label for="xp-l-status">Loan status</label>
            <select id="xp-l-status" class="xp-select" data-lf="status">
              <option value="${ALL}" ${f.status === ALL ? 'selected' : ''}>All statuses</option>
              ${STATUS_OPTIONS.map(
                (s) =>
                  `<option value="${s}" ${f.status === s ? 'selected' : ''}>${s}${
                    s === 'Active' ? ' (approved, not settled)' : ''
                  }</option>`
              ).join('')}
            </select>
          </div>

          <div class="xp-field">
            <label for="xp-l-type">Loan type</label>
            <select id="xp-l-type" class="xp-select" data-lf="accountId">
              <option value="${ALL}">All types</option>
              ${types
                .map(
                  (t) =>
                    `<option value="${escapeHtml(t.id)}" ${
                      f.accountId === t.id ? 'selected' : ''
                    }>${escapeHtml(t.name)}</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="xp-field">
            <label for="xp-l-repay">Repayment status</label>
            <select id="xp-l-repay" class="xp-select" data-lf="repayment">
              ${REPAYMENT_OPTIONS.map(
                (o) =>
                  `<option value="${o.id}" ${f.repayment === o.id ? 'selected' : ''}>${escapeHtml(
                    o.label
                  )}</option>`
              ).join('')}
            </select>
          </div>

          <div class="xp-field">
            <label for="xp-l-app-from">Applied from</label>
            <input id="xp-l-app-from" class="xp-input" type="date" data-lf="appliedFrom" value="${escapeHtml(
              f.appliedFrom
            )}" />
          </div>

          <div class="xp-field">
            <label for="xp-l-app-to">Applied to</label>
            <input id="xp-l-app-to" class="xp-input" type="date" data-lf="appliedTo" value="${escapeHtml(
              f.appliedTo
            )}" />
          </div>

          <div class="xp-field">
            <label for="xp-l-disb-from">Disbursed from</label>
            <input id="xp-l-disb-from" class="xp-input" type="date" data-lf="disbursedFrom" value="${escapeHtml(
              f.disbursedFrom
            )}" />
          </div>

          <div class="xp-field">
            <label for="xp-l-disb-to">Disbursed to</label>
            <input id="xp-l-disb-to" class="xp-input" type="date" data-lf="disbursedTo" value="${escapeHtml(
              f.disbursedTo
            )}" />
          </div>

          <div class="xp-filter-actions">
            <button type="button" class="xp-btn xp-btn-primary" data-xp-action="apply">Search</button>
            <button type="button" class="xp-btn" data-xp-action="clear">Clear</button>
          </div>
        </div>
      </section>

      <section class="xp-table-card" id="xp-loan-table" aria-label="Loan register">
        ${loadingHTML('Reading loan records…')}
      </section>
    </div>`

  bindEvents(container.querySelector('.xp-loans'))
}

/* ---------------------------------------------------------------- events */

function bindEvents(root) {
  if (!root) return

  root.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-xp-action]')
    if (actionEl) {
      handleAction(actionEl.getAttribute('data-xp-action'), root, actionEl)
      return
    }
    const sortEl = e.target.closest('[data-xp-sort]')
    if (sortEl) {
      toggleSort(sortEl.getAttribute('data-xp-sort'))
      paint(root)
      return
    }
    const pageEl = e.target.closest('[data-xp-page]')
    if (pageEl && !pageEl.disabled) {
      const value = pageEl.getAttribute('data-xp-page')
      if (value === 'prev') state.page = Math.max(1, state.page - 1)
      else if (value === 'next') state.page = state.page + 1
      else state.page = Number(value) || 1
      paint(root)
      return
    }
    const rowEl = e.target.closest('tr[data-loan-id]')
    if (rowEl) openLoan(rowEl.getAttribute('data-loan-id'))
  })

  root.addEventListener('change', (e) => {
    const filterEl = e.target.closest('[data-lf]')
    if (filterEl) {
      applyFilters(root, filterEl)
      return
    }
    if (e.target.matches('[data-xp-page-size]')) {
      state.pageSize = Number(e.target.value) || 50
      state.page = 1
      paint(root)
    }
  })

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.xp-filters')) {
      e.preventDefault()
      applyFilters(root, null)
      return
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-loan-id]')) {
      e.preventDefault()
      openLoan(e.target.getAttribute('data-loan-id'))
    }
  })
}

async function handleAction(action, root, el) {
  const container = root.parentElement
  switch (action) {
    case 'apply':
      applyFilters(root, null)
      break
    case 'clear':
      state.filters = defaultLoanFilters()
      state.page = 1
      state.sort = { key: 'applied', dir: 'desc' }
      await refreshPage(container)
      break
    case 'refresh':
      invalidateLoanCache()
      invalidateLedgerCache()
      await refreshPage(container)
      toast('Loan register reloaded', 'success')
      break
    case 'export-excel':
      await runExport('excel', el)
      break
    case 'export-pdf':
      await runExport('pdf', el)
      break
    case 'print':
      window.print()
      break
    default:
      break
  }
}

function applyFilters(root, control) {
  const f = state.filters
  if (control) {
    f[control.getAttribute('data-lf')] = control.value
  } else {
    root.querySelectorAll('[data-lf]').forEach((c) => {
      f[c.getAttribute('data-lf')] = c.value
    })
  }
  const swap = (a, b) => {
    if (f[a] && f[b] && f[a] > f[b]) {
      const t = f[a]
      f[a] = f[b]
      f[b] = t
      const ea = root.querySelector(`[data-lf="${a}"]`)
      const eb = root.querySelector(`[data-lf="${b}"]`)
      if (ea) ea.value = f[a]
      if (eb) eb.value = f[b]
      toast('Date range corrected (From ≤ To)', 'warning')
    }
  }
  swap('appliedFrom', 'appliedTo')
  swap('disbursedFrom', 'disbursedTo')
  state.page = 1
  recompute()
  paint(root)
}

function toggleSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
  else {
    state.sort.key = key
    state.sort.dir = ['principal', 'outstanding', 'repaid'].includes(key) ? 'desc' : 'asc'
  }
}

async function runExport(kind, el) {
  if (!state.dataset) {
    toast('Nothing to export yet', 'warning')
    return
  }
  const original = el.textContent
  el.disabled = true
  el.textContent = 'Preparing…'
  try {
    const args = {
      user: state.user,
      loans: state.loans,
      summary: computeLoanSummary(state.loans),
      filters: state.filters,
    }
    if (kind === 'excel') await exportLoansExcel(args)
    else await exportLoansPdf(args)
    toast(`${kind === 'excel' ? 'Excel' : 'PDF'} export generated for the current filters`, 'success')
  } catch (err) {
    console.error('[experimental-loans] export failed', err)
    toast(`Export failed: ${err.message || err}`, 'error')
  } finally {
    el.disabled = false
    el.textContent = original
  }
}

/* ------------------------------------------------------------ workflow */

function openLoan(loanId) {
  if (!state.dataset) return
  const loan = state.loans.find((l) => l.id === String(loanId))
  if (!loan) return
  openLoanDetail(loan, state.dataset, {
    canApprove: isAdminUser(),
    canDecline: isAdminUser(),
    onApprove: confirmApproval,
    onDecline: confirmDecline,
    onOpenLedger(ref) {
      try {
        sessionStorage.setItem('xp-ledger-reference', String(ref || ''))
      } catch {
        // The ledger remains usable; only the optional reference prefilter is lost.
      }
      window.location.hash = 'experimental-ledger'
    },
  })
}

function resolveCharges(loan) {
  const detail = ((loan.rem || {}).details || []).find((d) => d.loan_info)
  const stored = detail && detail.loan_info.charges ? detail.loan_info.charges : []
  if (stored.length > 0) {
    return stored.map((c) => ({
      name: c.name || 'Charge',
      value: parseFloat(c.value) || 0,
      type: c.type || 'fixed',
    }))
  }
  // Same pre-fill the existing approval modal applies when the request
  // carries no stored charges: enterprise-configured interest / fees.
  const ent = state.dataset.entMap[loan.accountId]
  const lines = []
  if (!ent) return lines
  const push = (name, raw, isPercent) => {
    if (raw === undefined || raw === null || raw === '') return
    const base = Math.abs(parseFloat(raw) || 0)
    if (!base) return
    lines.push({ name, value: base, type: isPercent ? 'percentage' : 'fixed' })
  }
  push('Interest', ent.interest_rate, ent.interest_is_percent === 1 || ent.interest_is_percent === '1' || ent.interest_is_percent === true)
  push('Form Fee', ent.form_fee, ent.form_fee_is_percent === 1 || ent.form_fee_is_percent === '1' || ent.form_fee_is_percent === true)
  push('Admin Charge', ent.admin_charge, ent.admin_charge_is_percent === 1 || ent.admin_charge_is_percent === '1' || ent.admin_charge_is_percent === true)
  return lines
}

function chargeValue(charge, principal) {
  let v = parseFloat(charge.value) || 0
  if (charge.type === 'percentage') v = (v / 100) * principal
  return v
}

function contentContainer() {
  return document.getElementById('dashboard-main-content')
}

async function confirmApproval(loan) {
  const guarantorsApproved = loan.guarantors.every((g) => g.approval === 1 || g.approval === '1' || g.approval === true)
  const existingBank = (loan.rem || {}).bank_name || ''
  const hasBank = !!existingBank && existingBank !== '0'
  const charges = resolveCharges(loan)
  const banks = await fetchBanks(state.user.cooperativeId).catch(() => [])

  const chargeTotal = charges.reduce((s, c) => s + chargeValue(c, loan.principal), 0)
  const canApprove = guarantorsApproved

  const body = `
    <div class="xp-amount-hero">
      <div class="cell"><div class="k">Principal</div><div class="v">${escapeHtml(formatCurrency(loan.principal))}</div></div>
      <div class="cell"><div class="k">Duration</div><div class="v">${escapeHtml(formatNumber(loan.durationMonths))} mo</div></div>
      <div class="cell"><div class="k">Monthly instalment</div><div class="v">${escapeHtml(
        formatCurrency(loan.instalment)
      )}</div></div>
      <div class="cell"><div class="k">Charges at origination</div><div class="v">${escapeHtml(
        formatCurrency(chargeTotal)
      )}</div></div>
    </div>

    <section class="xp-section">
      <h3>Preconditions</h3>
      <div class="xp-kv">
        ${kvRow('All guarantors approved', guarantorsApproved ? '✓ Yes' : '✗ No — waiting on guarantor decisions')}
        ${kvRow('Bank / method selected', hasBank ? `✓ ${escapeHtml(existingBank)}` : '✗ Not selected yet')}
        ${kvRow('Current status', escapeHtml(loan.statusRaw))}
      </div>
      ${
        !guarantorsApproved
          ? `<div class="xp-note" style="margin-top:.7rem">
               The existing approval rule requires <strong>every guarantor to approve</strong> first.
               Guantor decisions are recorded under Settings → Guarantor Requests.
             </div>`
          : ''
      }
    </section>

    <section class="xp-section">
      <h3>Disbursement</h3>
      <div class="xp-filters">
        <div class="xp-field">
          <label for="xp-ap-date">Disbursement date</label>
          <input id="xp-ap-date" class="xp-input" type="date" value="${todayInput()}" />
        </div>
        <div class="xp-field">
          <label for="xp-ap-bank">Bank / method</label>
          <select id="xp-ap-bank" class="xp-select">
            <option value="">-- Select --</option>
            ${banks
              .map(
                (b) =>
                  `<option value="${escapeHtml(b.bank_name)}" ${
                    b.bank_name === existingBank ? 'selected' : ''
                  }>${escapeHtml(b.bank_name)}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>
    </section>

    <section class="xp-section">
      <h3>Charges that will be posted</h3>
      <table class="xp-mini-table">
        <thead><tr><th>Charge</th><th>Basis</th><th class="xp-num">Amount</th></tr></thead>
        <tbody>
          ${
            charges.length
              ? charges
                  .map(
                    (c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td>${escapeHtml(c.type === 'percentage' ? `${c.value}% of principal` : 'fixed')}</td>
              <td class="xp-num">${escapeHtml(formatCurrency(chargeValue(c, loan.principal)))}</td>
            </tr>`
                  )
                  .join('')
              : `<tr><td colspan="3" style="color:var(--xp-text-3)">No charges configured.</td></tr>`
          }
        </tbody>
      </table>
      <div class="xp-note" style="margin-top:.7rem">
        Approving runs the <strong>existing</strong> approval service once: it marks the request
        Approved, activates the loan, posts these charge entries, records the income pickup and
        writes the monthly payment advice. No duplicate transactions are created.
      </div>
    </section>`

  const footer = `
    <button type="button" class="xp-btn" data-xp-close>Cancel</button>
    <button type="button" class="xp-btn xp-btn-primary" data-xp-confirm ${
      canApprove ? '' : 'disabled'
    }>Approve &amp; disburse</button>`

  const drawer = openDrawer({
    title: 'Approve loan request',
    sub: `<span class="xp-ref">${escapeHtml(loan.shortRef)}</span> &nbsp;·&nbsp; ${escapeHtml(
      loan.memberName
    )}`,
    body,
    footer,
    onMount(root) {
      root.querySelector('[data-xp-confirm]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget
        const date = root.querySelector('#xp-ap-date')?.value || todayInput()
        const bank = root.querySelector('#xp-ap-bank')?.value || ''
        if (!bank) {
          toast('Select the disbursement bank / method first', 'warning')
          return
        }
        btn.disabled = true
        btn.textContent = 'Approving…'
        try {
          const { approveLoanRequest } = await import('../../services/data/loans.js')
          await approveLoanRequest(loan.remittanceId, state.user.username || 'admin', {
            remittance_date: date,
            bank_name: bank,
            charges,
          })
          drawer.close()
          invalidateLoanCache()
          invalidateLedgerCache()
          await refreshPage(contentContainer())
          toast('Loan approved and disbursed', 'success')
        } catch (err) {
          console.error('[experimental-loans] approve failed', err)
          toast(`Approval failed: ${err.message || err}`, 'error')
          btn.disabled = false
          btn.textContent = 'Approve & disburse'
        }
      })
    },
  })
}

async function confirmDecline(loan) {
  const body = `
    <div class="xp-note">
      Declining marks the request <strong>Declined</strong>, declines the linked loan record and
      resets the guarantor decisions — exactly what the existing decline service does. No
      financial entries are posted.
    </div>
    <section class="xp-section" style="margin-top:1.2rem">
      <h3>Request</h3>
      <div class="xp-kv">
        ${kvRow('Reference', escapeHtml(loan.ref))}
        ${kvRow('Member', escapeHtml(loan.memberName))}
        ${kvRow('Principal', escapeHtml(formatCurrency(loan.principal)))}
        ${kvRow('Status', escapeHtml(loan.statusRaw))}
      </div>
    </section>`

  const footer = `
    <button type="button" class="xp-btn" data-xp-close>Keep pending</button>
    <button type="button" class="xp-btn xp-btn-danger" data-xp-confirm>Decline request</button>`

  const drawer = openDrawer({
    title: 'Decline loan request',
    sub: `<span class="xp-ref">${escapeHtml(loan.shortRef)}</span>`,
    body,
    footer,
    onMount(root) {
      root.querySelector('[data-xp-confirm]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.textContent = 'Declining…'
        try {
          const { declineLoanRequest } = await import('../../services/data/loans.js')
          await declineLoanRequest(loan.remittanceId, state.user.username || 'admin')
          drawer.close()
          invalidateLoanCache()
          invalidateLedgerCache()
          await refreshPage(contentContainer())
          toast('Loan request declined', 'success')
        } catch (err) {
          console.error('[experimental-loans] decline failed', err)
          toast(`Decline failed: ${err.message || err}`, 'error')
          btn.disabled = false
          btn.textContent = 'Decline request'
        }
      })
    },
  })
}

function kvRow(key, value) {
  return `
    <div class="xp-kv-item">
      <div class="k">${escapeHtml(key)}</div>
      <div class="v">${value}</div>
    </div>`
}

/* ---------------------------------------------------------------- paint */

function recompute() {
  if (!state.dataset) return
  // Summary cards follow the scope filters (member / reference / type / dates)
  // but ignore the status + repayment view selectors, so the overview stays
  // complete while the register below is narrowed.
  const scopeFilters = { ...state.filters, status: ALL, repayment: ALL }
  state.scopeLoans = filterLoans(state.dataset.loans, scopeFilters)
  state.summary = computeLoanSummary(state.scopeLoans)
  state.loans = filterLoans(state.dataset.loans, state.filters)
}

function paint(root) {
  if (!root) return
  if (state.error) {
    const cards = root.querySelector('#xp-loan-cards')
    if (cards) cards.innerHTML = ''
    const table = root.querySelector('#xp-loan-table')
    if (table) table.innerHTML = errorHTML(state.error)
    return
  }
  if (!state.summary) return
  paintCards(root)
  paintTable(root)
}

function paintCards(root) {
  const s = state.summary
  const el = root.querySelector('#xp-loan-cards')
  if (!el) return

  el.innerHTML = `
    <div class="xp-card xp-card-accent">
      <div class="xp-card-label">Total loans disbursed</div>
      <div class="xp-card-value">${escapeHtml(formatCurrency(s.disbursed))}</div>
      <div class="xp-card-note"><strong>${escapeHtml(formatNumber(s.approved))}</strong> approved loans</div>
    </div>

    <div class="xp-card xp-card-debit">
      <div class="xp-card-label">Total outstanding</div>
      <div class="xp-card-value xp-is-debit">${escapeHtml(formatCurrency(s.outstanding))}</div>
      <div class="xp-card-note">Principal + charges still owed</div>
    </div>

    <div class="xp-card xp-card-credit">
      <div class="xp-card-label">Total loan repayments</div>
      <div class="xp-card-value xp-is-credit">${escapeHtml(formatCurrency(s.repayments))}</div>
      <div class="xp-card-note">Received against approved loans</div>
    </div>

    <div class="xp-card xp-card-warn">
      <div class="xp-card-label">Pending applications</div>
      <div class="xp-card-value">${escapeHtml(formatNumber(s.pending))}</div>
      <div class="xp-card-note">Awaiting review or guarantor sign-off</div>
    </div>

    <div class="xp-card">
      <div class="xp-card-label">Approved loans</div>
      <div class="xp-card-value">${escapeHtml(formatNumber(s.approved))}</div>
      <div class="xp-card-note"><strong>${escapeHtml(formatNumber(s.completed))}</strong> fully settled</div>
    </div>

    <div class="xp-card ${s.overdueCount ? 'xp-card-debit' : ''}">
      <div class="xp-card-label">Overdue loans</div>
      <div class="xp-card-value ${s.overdueCount ? 'xp-is-debit' : ''}">${escapeHtml(
    formatNumber(s.overdueCount)
  )}</div>
      <div class="xp-card-note">${escapeHtml(formatCurrency(s.overdueAmount))} past due date</div>
    </div>`
}

function sortIndicator(key) {
  if (state.sort.key !== key) return `<span class="xp-sort-ind">↕</span>`
  return `<span class="xp-sort-ind">${state.sort.dir === 'asc' ? '↑' : '↓'}</span>`
}

function sortClass(key) {
  return state.sort.key === key ? ' is-sorted' : ''
}

function sortedLoans() {
  const rows = [...state.loans]
  const dir = state.sort.dir === 'desc' ? -1 : 1
  const key = state.sort.key
  rows.sort((a, b) => {
    let cmp = 0
    switch (key) {
      case 'ref':
        cmp = a.ref.localeCompare(b.ref)
        break
      case 'member':
        cmp = a.memberName.localeCompare(b.memberName)
        break
      case 'type':
        cmp = a.accountName.localeCompare(b.accountName)
        break
      case 'principal':
        cmp = a.principal - b.principal
        break
      case 'interest':
        cmp = a.interest - b.interest
        break
      case 'payable':
        cmp = a.totalPayable - b.totalPayable
        break
      case 'repaid':
        cmp = a.repaid - b.repaid
        break
      case 'outstanding':
        cmp = a.outstanding - b.outstanding
        break
      case 'issued':
        cmp = String(a.issuedDate || '').localeCompare(String(b.issuedDate || ''))
        break
      case 'status':
        cmp = a.statusDisplay.localeCompare(b.statusDisplay)
        break
      case 'applied':
      default:
        cmp = String(a.appliedDate || '').localeCompare(String(b.appliedDate || ''))
        break
    }
    return cmp * dir || a.ref.localeCompare(b.ref)
  })
  return rows
}

function loanStatusBadge(l) {
  const cls =
    l.statusDisplay === 'Active'
      ? 'xp-badge-active'
      : l.statusDisplay === 'Pending'
      ? 'xp-badge-pending'
      : l.statusDisplay === 'Declined'
      ? 'xp-badge-declined'
      : l.statusDisplay === 'Overdue'
      ? 'xp-badge-overdue'
      : l.statusDisplay === 'Completed'
      ? 'xp-badge-completed'
      : 'xp-badge-neutral'
  return `<span class="xp-badge ${cls}">${escapeHtml(l.statusDisplay)}</span>`
}

function pagerHTML(total, page, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), pages)
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1
  const to = Math.min(total, current * pageSize)

  const numbers = []
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) numbers.push(i)
  } else {
    numbers.push(1)
    if (current > 3) numbers.push('…')
    for (let i = Math.max(2, current - 1); i <= Math.min(pages - 1, current + 1); i++) numbers.push(i)
    if (current < pages - 2) numbers.push('…')
    numbers.push(pages)
  }

  return `
    <div class="xp-pager-info">Showing <strong>${escapeHtml(formatNumber(from))}–${escapeHtml(
    formatNumber(to)
  )}</strong> of <strong>${escapeHtml(formatNumber(total))}</strong> loans</div>
    <div class="xp-pager-controls">
      <label class="xp-pager-info" for="xp-loan-page-size">Rows
        <select id="xp-loan-page-size" data-xp-page-size
                style="margin-left:.35rem;padding:.25rem .4rem;border-radius:6px;border:1px solid var(--xp-border-strong);background:var(--xp-surface);color:var(--xp-text);font-size:.78rem;">
          ${PAGE_SIZES.map(
            (s) => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s}</option>`
          ).join('')}
        </select>
      </label>
      <button type="button" class="xp-pager-page" data-xp-page="prev" ${
        current <= 1 ? 'disabled' : ''
      }>‹</button>
      ${numbers
        .map((n) =>
          n === '…'
            ? `<span class="xp-pager-info" style="padding:0 .25rem">…</span>`
            : `<button type="button" class="xp-pager-page${
                n === current ? ' is-active' : ''
              }" data-xp-page="${n}">${n}</button>`
        )
        .join('')}
      <button type="button" class="xp-pager-page" data-xp-page="next" ${
        current >= pages ? 'disabled' : ''
      }>›</button>
    </div>`
}

function paintTable(root) {
  const el = root.querySelector('#xp-loan-table')
  if (!el) return

  const rows = sortedLoans()
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize))
  if (state.page > pages) state.page = pages
  const start = (state.page - 1) * state.pageSize
  const pageRows = rows.slice(start, start + state.pageSize)

  const body = pageRows.length
    ? pageRows
        .map((l) => {
          const cls =
            l.statusDisplay === 'Pending'
              ? ' xp-row-pending'
              : l.statusDisplay === 'Declined'
              ? ' xp-row-declined'
              : ''
          return `
        <tr class="xp-row-clickable${cls}" data-loan-id="${escapeHtml(l.id)}" tabindex="0">
          <td data-label="Loan reference">
            <span class="xp-ref" title="${escapeHtml(l.ref)}">${escapeHtml(l.shortRef)}</span>
            <div class="xp-cell-sub">${escapeHtml(l.remittanceId ? l.remittanceId.slice(0, 12) : '')}</div>
          </td>
          <td data-label="Member" class="xp-cell-stack">
            <span class="xp-cell-primary">${escapeHtml(l.memberName)}</span>
            <div class="xp-cell-sub">${escapeHtml(l.memberReg || l.memberId)}</div>
          </td>
          <td data-label="Loan type">
            <span>${escapeHtml(l.accountName || '—')}</span>
            <div class="xp-cell-sub">${escapeHtml(l.accountType)}</div>
          </td>
          <td data-label="Principal" class="xp-num xp-amount">${escapeHtml(formatCurrency(l.principal))}</td>
          <td data-label="Interest" class="xp-num xp-amount" title="${
            l.interestSource === 'recorded' ? 'Posted charges' : 'Estimated from account rates'
          }">${escapeHtml(formatCurrency(l.interest))}</td>
          <td data-label="Total payable" class="xp-num xp-amount">${escapeHtml(formatCurrency(l.totalPayable))}</td>
          <td data-label="Amount repaid" class="xp-num xp-amount xp-is-credit">${escapeHtml(
            formatCurrency(l.repaid)
          )}</td>
          <td data-label="Outstanding" class="xp-num xp-amount ${
            l.outstanding > 0 ? 'xp-is-debit' : ''
          }">${escapeHtml(formatCurrency(l.outstanding))}</td>
          <td data-label="Application date">
            <span>${escapeHtml(formatDate(l.appliedDate))}</span>
            <div class="xp-cell-sub">Disbursed ${escapeHtml(formatDate(l.issuedDate))}</div>
          </td>
          <td data-label="Status">${loanStatusBadge(l)}</td>
          <td data-label="Action" class="xp-action-col">
            <button type="button" class="xp-icon-btn" data-loan-id="${escapeHtml(
              l.id
            )}" title="View loan details">View</button>
          </td>
        </tr>`
        })
        .join('')
    : `<tr><td colspan="11" class="xp-empty">
          <strong>No loans match this view</strong>
          Adjust the status, dates or search terms — or clear the filters.
        </td></tr>`

  const s = state.summary
  const totals = `
    <tr class="xp-row-total">
      <td data-label="">—</td>
      <td data-label="Member" class="xp-cell-stack">TOTAL — ${escapeHtml(formatNumber(rows.length))} loans</td>
      <td data-label="Loan type">—</td>
      <td data-label="Principal" class="xp-num">${escapeHtml(formatCurrency(rows.reduce((a, l) => a + l.principal, 0)))}</td>
      <td data-label="Interest" class="xp-num">${escapeHtml(formatCurrency(rows.reduce((a, l) => a + l.interest, 0)))}</td>
      <td data-label="Total payable" class="xp-num">${escapeHtml(formatCurrency(rows.reduce((a, l) => a + l.totalPayable, 0)))}</td>
      <td data-label="Amount repaid" class="xp-num xp-is-credit">${escapeHtml(formatCurrency(rows.reduce((a, l) => a + l.repaid, 0)))}</td>
      <td data-label="Outstanding" class="xp-num xp-is-debit">${escapeHtml(formatCurrency(rows.reduce((a, l) => a + l.outstanding, 0)))}</td>
      <td data-label="Application date">—</td>
      <td data-label="Status">—</td>
      <td data-label="Action" class="xp-action-col"></td>
    </tr>`

  el.innerHTML = `
    <div class="xp-table-head">
      <div>
        <h2>Loan register</h2>
        <div class="xp-table-meta">
          ${escapeHtml(formatNumber(state.scopeLoans.length))} loans in scope · ${escapeHtml(
    formatNumber(s.pending)
  )} pending · ${escapeHtml(formatNumber(s.overdueCount))} overdue
          · outstanding ${escapeHtml(formatCurrency(s.outstanding))}
          · showing ${escapeHtml(formatNumber(rows.length))}
        </div>
      </div>
      <div class="xp-table-tools">
        <span class="xp-badge xp-badge-neutral">Disbursed ${escapeHtml(formatCurrency(s.disbursed))}</span>
        <span class="xp-badge xp-badge-approved">Repaid ${escapeHtml(formatCurrency(s.repayments))}</span>
      </div>
    </div>

    <div class="xp-table-wrap">
      <table class="xp-table xp-table-cards">
        <thead>
          <tr>
            <th class="xp-sortable${sortClass('ref')}" data-xp-sort="ref">Loan reference${sortIndicator('ref')}</th>
            <th class="xp-sortable${sortClass('member')}" data-xp-sort="member">Member${sortIndicator('member')}</th>
            <th class="xp-sortable${sortClass('type')}" data-xp-sort="type">Loan type${sortIndicator('type')}</th>
            <th class="xp-num xp-sortable${sortClass('principal')}" data-xp-sort="principal">Principal${sortIndicator('principal')}</th>
            <th class="xp-num xp-sortable${sortClass('interest')}" data-xp-sort="interest">Interest${sortIndicator('interest')}</th>
            <th class="xp-num xp-sortable${sortClass('payable')}" data-xp-sort="payable">Total payable${sortIndicator('payable')}</th>
            <th class="xp-num xp-sortable${sortClass('repaid')}" data-xp-sort="repaid">Amount repaid${sortIndicator('repaid')}</th>
            <th class="xp-num xp-sortable${sortClass('outstanding')}" data-xp-sort="outstanding">Outstanding${sortIndicator('outstanding')}</th>
            <th class="xp-sortable${sortClass('applied')}" data-xp-sort="applied">Application date${sortIndicator('applied')}</th>
            <th class="xp-sortable${sortClass('status')}" data-xp-sort="status">Status${sortIndicator('status')}</th>
            <th class="xp-action-col">Action</th>
          </tr>
        </thead>
        <tbody>${body}${rows.length ? totals : ''}</tbody>
      </table>
    </div>

    <div class="xp-pager">${pagerHTML(rows.length, state.page, state.pageSize)}</div>`
}

/* ---------------------------------------------------------------- entry */

async function loadData() {
  try {
    const dataset = await loadLoanDataset(state.user)
    state.dataset = dataset
    state.typeOpts = loanTypeOptions(dataset)
    state.error = null
    recompute()
  } catch (err) {
    console.error('[experimental-loans] load failed', err)
    state.error = err
    state.summary = null
  }
}

async function refreshPage(container) {
  await loadData()
  renderShell(container)
  paint(container.querySelector('.xp-loans'))
}

export async function renderLoansPage(container, user) {
  state.user = user
  setMobileTitle('Loan Management', 'Experimental · loan register')
  container.innerHTML = `<div class="xp xp-loans">${loadingHTML('Loading loan data…')}</div>`
  await loadData()
  renderShell(container)
  paint(container.querySelector('.xp-loans'))
}
