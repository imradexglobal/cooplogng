/**
 * Experimental Ledger page — independent re-implementation.
 *
 * Renders a modern, accounting-style general ledger on top of the existing
 * data services (read-only). It imports nothing from src/screens/MemberLedger.js,
 * src/screens/AccountBalance.js or any other existing page component, hook or
 * stylesheet.
 *
 * Route: #ledger
 */

import {
  ALL,
  accountOptions,
  compareChrono,
  computeLedger,
  defaultFilters,
  invalidateLedgerCache,
  loadLedgerDataset,
  transactionTypes,
} from '../lib/ledgerData.js'
import {
  escapeHtml,
  formatCurrency,
  formatDate,
  formatNumber,
  todayInput,
} from '../lib/format.js'
import { barChartSVG, lineChartSVG } from '../lib/charts.js'
import { errorHTML, loadingHTML, setMobileTitle, toast } from '../lib/ui.js'
import { exportLedgerExcel } from '../lib/exportExcel.js'
import { exportLedgerPdf } from '../lib/exportPdf.js'
import { openLedgerDetail } from './ledgerDetail.js'

const PAGE_SIZES = [25, 50, 100, 250]

const state = {
  user: null,
  filters: defaultFilters(),
  memberName: 'All members',
  page: 1,
  pageSize: 50,
  sort: { key: 'date', dir: 'asc' },
  prefillRef: '',
  dataset: null,
  accountOpts: [],
  typeOpts: [],
  result: null,
  error: null,
  refSearchTimer: null,
}

/** Called by the Loan page when jumping across with a transaction reference. */
export function prefilterLedger(ref) {
  state.prefillRef = String(ref || '')
  state.filters.refSearch = String(ref || '')
  state.page = 1
}

function accountName() {
  if (state.filters.accountId === ALL) return ''
  const opt = (state.accountOpts || []).find((o) => o.id === state.filters.accountId)
  return opt ? opt.name : ''
}

function memberName() {
  if (state.filters.memberId === ALL) return ''
  return state.memberName && state.memberName !== 'All members' ? state.memberName : ''
}

function scopeText() {
  return [
    accountName() || 'All accounts',
    memberName() || 'All members',
    state.filters.dateFrom || 'start',
    state.filters.dateTo || 'today',
  ].join('  ·  ')
}

/* ------------------------------------------------------------------ shell */

function filterShell() {
  const f = state.filters
  const accounts = state.accountOpts || []
  const types = state.typeOpts || []

  const accountOptionsHTML = [
    `<option value="${ALL}">All accounts</option>`,
    ...groupByGroup(accounts).map(
      ([group, items]) => `
      <optgroup label="${escapeHtml(group)}">
        ${items
          .map(
            (o) =>
              `<option value="${escapeHtml(o.id)}" ${f.accountId === o.id ? 'selected' : ''}>${escapeHtml(
                o.name
              )}</option>`
          )
          .join('')}
      </optgroup>`
    ),
  ].join('')

  return `
    <section class="xp-panel xp-filters-panel" aria-label="Ledger filters">
      <div class="xp-panel-head">
        <h2>Filters</h2>
        <span class="xp-panel-hint">Balances follow the account · member · date scope.</span>
      </div>
      <div class="xp-filters">
        <div class="xp-field">
          <label for="xp-f-account">Account</label>
          <select id="xp-f-account" class="xp-select" data-xp-filter="accountId">${accountOptionsHTML}</select>
        </div>

        <div class="xp-field">
          <label for="xp-f-type">Transaction type</label>
          <select id="xp-f-type" class="xp-select" data-xp-filter="txType">
            <option value="${ALL}">All types</option>
            ${types
              .map(
                (t) =>
                  `<option value="${escapeHtml(t)}" ${f.txType === t ? 'selected' : ''}>${escapeHtml(
                    t
                  )}</option>`
              )
              .join('')}
          </select>
        </div>

        <div class="xp-field">
          <label for="xp-f-status">Status</label>
          <select id="xp-f-status" class="xp-select" data-xp-filter="status">
            <option value="${ALL}" ${f.status === ALL ? 'selected' : ''}>All statuses</option>
            <option value="Approved" ${f.status === 'Approved' ? 'selected' : ''}>Approved (posted)</option>
            <option value="Pending" ${f.status === 'Pending' ? 'selected' : ''}>Pending (not posted)</option>
            <option value="Declined" ${f.status === 'Declined' ? 'selected' : ''}>Declined (not posted)</option>
          </select>
        </div>

        <div class="xp-field">
          <label for="xp-f-from">From date</label>
          <input id="xp-f-from" class="xp-input" type="date" data-xp-filter="dateFrom" value="${escapeHtml(
            f.dateFrom
          )}" />
        </div>

        <div class="xp-field">
          <label for="xp-f-to">To date</label>
          <input id="xp-f-to" class="xp-input" type="date" data-xp-filter="dateTo" value="${escapeHtml(
            f.dateTo
          )}" />
        </div>

        <div class="xp-field">
          <label for="xp-f-ref">Reference search</label>
          <input id="xp-f-ref" class="xp-input" type="search" data-xp-filter="refSearch"
                 placeholder="Transaction reference (all dates)…" value="${escapeHtml(f.refSearch)}" />
        </div>

        <div class="xp-field xp-field-wide">
          <label for="xp-f-desc">Description search</label>
          <input id="xp-f-desc" class="xp-input" type="search" data-xp-filter="descSearch"
                 placeholder="Description, type, account…" value="${escapeHtml(f.descSearch)}" />
        </div>

        <div class="xp-field">
          <label for="xp-f-member">Member</label>
          <div class="xp-combo">
            <input id="xp-f-member" class="xp-input" type="text" autocomplete="off"
                   placeholder="All members" role="combobox" aria-expanded="false"
                   aria-controls="xp-member-list" value="${escapeHtml(
                     state.filters.memberId === ALL ? '' : state.memberName
                   )}" />
            <div class="xp-combo-list" id="xp-member-list" role="listbox"></div>
          </div>
        </div>

        <div class="xp-filter-actions">
          <button type="button" class="xp-btn xp-btn-primary" data-xp-action="apply">Search</button>
          <button type="button" class="xp-btn" data-xp-action="clear">Clear</button>
        </div>
      </div>
    </section>`
}

function groupByGroup(accounts) {
  const map = new Map()
  for (const a of accounts) {
    const g = a.group || 'Other'
    if (!map.has(g)) map.set(g, [])
    map.get(g).push(a)
  }
  return [...map.entries()]
}

function renderShell(container) {
  const user = state.user
  container.innerHTML = `
    <div class="xp xp-ledger">
      <div class="xp-print-head">
        <strong>Ledger — ${escapeHtml(user.cooperativeName || user.cooperativeId)}</strong><br/>
        <span>${escapeHtml(scopeText())}</span>
      </div>

      <header class="xp-head">
        <div>
          <h1>Ledger</h1>
          <p class="xp-sub" id="xp-scope-line">${escapeHtml(scopeText())}</p>
        </div>
        <div class="xp-head-actions">
          <button type="button" class="xp-btn" data-xp-action="refresh">↻ Refresh</button>
          <button type="button" class="xp-btn" data-xp-action="export-excel">⤓ Excel</button>
          <button type="button" class="xp-btn" data-xp-action="export-pdf">⤓ PDF</button>
          <button type="button" class="xp-btn" data-xp-action="print">🖨 Print</button>
        </div>
      </header>

      <section class="xp-cards" id="xp-cards" aria-label="Summary">${loadingHTML(
        'Computing balances…'
      )}</section>

      <section class="xp-recon" id="xp-recon" aria-label="Reconciliation"></section>

      ${filterShell()}

      <section class="xp-charts" id="xp-charts" aria-label="Trends"></section>

      <section class="xp-table-card" id="xp-table-card" aria-label="Transactions">
        ${loadingHTML('Reading transactions…')}
      </section>
    </div>`

  bindEvents(container.querySelector('.xp-ledger'))
}

/* ----------------------------------------------------------------- events */

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

    const rowEl = e.target.closest('tr[data-xp-uid]')
    if (rowEl) {
      openRow(rowEl.getAttribute('data-xp-uid'))
      return
    }
  })

  root.addEventListener('change', (e) => {
    const filterEl = e.target.closest('[data-xp-filter]')
    if (filterEl) {
      applyFilters(root, { fromControl: filterEl })
      return
    }
    if (e.target.matches('[data-xp-page-size]')) {
      state.pageSize = Number(e.target.value) || 50
      state.page = 1
      paint(root)
    }
  })

  root.addEventListener('input', (e) => {
    const searchEl = e.target.closest('[data-xp-filter="refSearch"]')
    if (!searchEl) return
    if (state.refSearchTimer) clearTimeout(state.refSearchTimer)
    state.refSearchTimer = setTimeout(() => {
      state.refSearchTimer = null
      applyFilters(root, { fromControl: searchEl })
    }, 140)
  })

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.xp-filters')) {
      e.preventDefault()
      applyFilters(root, {})
      return
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-xp-uid]')) {
      e.preventDefault()
      openRow(e.target.getAttribute('data-xp-uid'))
    }
  })

  bindMemberCombo(root)
}

async function handleAction(action, root, el) {
  const container = root.parentElement
  switch (action) {
    case 'apply':
      applyFilters(root, {})
      break
    case 'clear':
      state.filters = defaultFilters()
      state.memberName = 'All members'
      state.page = 1
      state.sort = { key: 'date', dir: 'asc' }
      await refreshPage(container)
      break
    case 'refresh':
      invalidateLedgerCache()
      await refreshPage(container)
      toast('Ledger reloaded from local data', 'success')
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

async function runExport(kind, el) {
  if (!state.dataset || !state.result) {
    toast('Nothing to export yet', 'warning')
    return
  }
  const original = el.textContent
  el.disabled = true
  el.textContent = 'Preparing…'
  try {
    const args = {
      user: state.user,
      dataset: state.dataset,
      filters: state.filters,
      result: state.result,
      accountName: accountName(),
      memberName: memberName(),
    }
    if (kind === 'excel') await exportLedgerExcel(args)
    else await exportLedgerPdf(args)
    toast(`${kind === 'excel' ? 'Excel' : 'PDF'} export generated for the current filters`, 'success')
  } catch (err) {
    console.error('[ledger] export failed', err)
    toast(`Export failed: ${err.message || err}`, 'error')
  } finally {
    el.disabled = false
    el.textContent = original
  }
}

function applyFilters(root, { fromControl = null } = {}) {
  if (state.refSearchTimer) {
    clearTimeout(state.refSearchTimer)
    state.refSearchTimer = null
  }
  const f = state.filters
  if (fromControl) {
    const key = fromControl.getAttribute('data-xp-filter')
    if (key) f[key] = fromControl.value
  } else {
    root.querySelectorAll('[data-xp-filter]').forEach((control) => {
      f[control.getAttribute('data-xp-filter')] = control.value
    })
  }

  // Date sanity: keep the range usable.
  if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) {
    const swap = f.dateFrom
    f.dateFrom = f.dateTo
    f.dateTo = swap
    const fromEl = root.querySelector('[data-xp-filter="dateFrom"]')
    const toEl = root.querySelector('[data-xp-filter="dateTo"]')
    if (fromEl) fromEl.value = f.dateFrom
    if (toEl) toEl.value = f.dateTo
    toast('Date range corrected (From ≤ To)', 'warning')
  }

  // Member combobox: only accept a resolved selection.
  const memberInput = root.querySelector('#xp-f-member')
  if (memberInput) {
    const typed = memberInput.value.trim()
    if (!typed) {
      f.memberId = ALL
      state.memberName = 'All members'
    } else if (state.memberName && typed === state.memberName && f.memberId !== ALL) {
      // keep current selection
    } else {
      const hit = (state.dataset?.members || []).find((m) => String(m.name || '').trim() === typed)
      if (hit) {
        f.memberId = String(hit.id)
        state.memberName = hit.name
      } else {
        f.memberId = ALL
        state.memberName = 'All members'
        if (typed.length > 1) toast('Member not matched — showing all members', 'warning')
      }
    }
  }

  if (fromControl && fromControl.getAttribute('data-xp-filter') === 'refSearch') {
    state.prefillRef = ''
  }

  state.page = 1
  repaintAll(root)
}

function repaintAll(root) {
  state.result = state.dataset ? computeLedger(state.dataset.rows, state.filters) : null
  const scopeEl = root.querySelector('#xp-scope-line')
  if (scopeEl) scopeEl.textContent = scopeText()
  paint(root)
}

function toggleSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    state.sort.key = key
    state.sort.dir = key === 'date' ? 'asc' : 'desc'
  }
}

function openRow(uid) {
  if (!state.dataset || !state.result) return
  const row = state.result.display.find((r) => r.uid === uid)
  if (!row) return
  openLedgerDetail(row, state.dataset, {
    onOpenLoan(loanId) {
      if (loanId) sessionStorage.setItem('xp-loan-focus', loanId)
      window.location.hash = 'loan'
    },
    onEditRemittance(remittanceId, record) {
      window.dispatchEvent(new CustomEvent('edit-remittance', {
        detail: { id: String(remittanceId), record },
      }))
    },
  })
}

/* --------------------------------------------------------- member combo */

function bindMemberCombo(root) {
  const input = root.querySelector('#xp-f-member')
  const list = root.querySelector('#xp-member-list')
  if (!input || !list) return

  const close = () => {
    list.classList.remove('is-open')
    input.setAttribute('aria-expanded', 'false')
  }

  const renderOptions = () => {
    const term = input.value.trim().toLowerCase()
    const members = state.dataset?.members || []
    if (!term) {
      close()
      return
    }
    const hits = members
      .filter((m) => {
        const hay = `${m.name || ''} ${m.registration_no || ''} ${m.mobile || ''}`.toLowerCase()
        return hay.includes(term)
      })
      .slice(0, 8)

    if (hits.length === 0) {
      list.innerHTML = `<div class="xp-combo-option" style="cursor:default;color:var(--xp-text-3)">No member matches</div>`
    } else {
      list.innerHTML = hits
        .map(
          (m) => `
        <div class="xp-combo-option${String(m.id) === state.filters.memberId ? ' is-selected' : ''}"
             role="option" data-member-id="${escapeHtml(String(m.id))}"
             data-member-name="${escapeHtml(m.name || '')}">
          <span>${escapeHtml(m.name || m.id)}</span>
          <span class="xp-combo-meta">${escapeHtml(m.registration_no || m.mobile || '')}</span>
        </div>`
        )
        .join('')
    }
    list.classList.add('is-open')
    input.setAttribute('aria-expanded', 'true')
  }

  input.addEventListener('input', renderOptions)
  input.addEventListener('focus', () => {
    if (input.value.trim()) renderOptions()
  })

  list.addEventListener('mousedown', (e) => {
    const option = e.target.closest('[data-member-id]')
    if (!option) return
    e.preventDefault()
    state.filters.memberId = option.getAttribute('data-member-id')
    state.memberName = option.getAttribute('data-member-name') || 'Selected member'
    input.value = state.memberName
    close()
    state.page = 1
    repaintAll(root)
  })

  input.addEventListener('blur', () => setTimeout(close, 120))
}

/* ----------------------------------------------------------------- paint */

function paint(root) {
  if (!root) return
  if (state.error) {
    const cards = root.querySelector('#xp-cards')
    if (cards) cards.innerHTML = ''
    const recon = root.querySelector('#xp-recon')
    if (recon) recon.innerHTML = ''
    const charts = root.querySelector('#xp-charts')
    if (charts) charts.innerHTML = ''
    const table = root.querySelector('#xp-table-card')
    if (table) table.innerHTML = errorHTML(state.error)
    return
  }
  if (!state.result) return

  paintCards(root)
  paintRecon(root)
  paintCharts(root)
  paintTable(root)
}

function paintCards(root) {
  const r = state.result
  const el = root.querySelector('#xp-cards')
  if (!el) return

  const balanceClass = r.closing < 0 ? 'xp-is-debit' : 'xp-is-credit'
  const pendingNote = r.pendingCount
    ? `${escapeHtml(formatCurrency(r.pendingAmount))} awaiting approval`
    : 'Nothing awaiting approval'

  el.innerHTML = `
    <div class="xp-card xp-card-accent">
      <div class="xp-card-label">Current balance</div>
      <div class="xp-card-value ${balanceClass}">${escapeHtml(formatCurrency(r.closing))}</div>
      <div class="xp-card-note">Closing balance at <strong>${escapeHtml(
        state.filters.dateTo || todayInput()
      )}</strong></div>
    </div>

    <div class="xp-card xp-card-credit">
      <div class="xp-card-label">Total credits</div>
      <div class="xp-card-value xp-is-credit">${escapeHtml(formatCurrency(r.credits))}</div>
      <div class="xp-card-note"><strong>${escapeHtml(
        formatNumber(r.ordered.filter((x) => x.posted && x.amount >= 0).length)
      )}</strong> posted entries in period</div>
    </div>

    <div class="xp-card xp-card-debit">
      <div class="xp-card-label">Total debits</div>
      <div class="xp-card-value xp-is-debit">${escapeHtml(formatCurrency(r.debits))}</div>
      <div class="xp-card-note"><strong>${escapeHtml(
        formatNumber(r.ordered.filter((x) => x.posted && x.amount < 0).length)
      )}</strong> posted entries in period</div>
    </div>

    <div class="xp-card xp-card-warn">
      <div class="xp-card-label">Pending transactions</div>
      <div class="xp-card-value">${escapeHtml(formatNumber(r.pendingCount))}</div>
      <div class="xp-card-note">${pendingNote}${
    r.declinedCount ? ` · <strong>${escapeHtml(formatNumber(r.declinedCount))}</strong> declined` : ''
  }</div>
    </div>`
}

function paintRecon(root) {
  const r = state.result
  const el = root.querySelector('#xp-recon')
  if (!el) return

  el.innerHTML = `
    <div class="xp-recon-item">
      <span class="k">Opening balance</span>
      <span class="v">${escapeHtml(formatCurrency(r.opening))}</span>
    </div>
    <span class="xp-recon-op">+</span>
    <div class="xp-recon-item">
      <span class="k">Credits</span>
      <span class="v xp-is-credit">${escapeHtml(formatCurrency(r.credits))}</span>
    </div>
    <span class="xp-recon-op">−</span>
    <div class="xp-recon-item">
      <span class="k">Debits</span>
      <span class="v xp-is-debit">${escapeHtml(formatCurrency(r.debits))}</span>
    </div>
    <span class="xp-recon-op">=</span>
    <div class="xp-recon-item">
      <span class="k">Closing balance</span>
      <span class="v">${escapeHtml(formatCurrency(r.closing))}</span>
    </div>
    <div class="xp-recon-spacer"></div>
    <div class="xp-recon-hint">
      Opening = posted activity before <strong>${escapeHtml(state.filters.dateFrom || 'the start')}</strong>.
      Pending and declined entries never move the balance.
    </div>`
}

function paintCharts(root) {
  const r = state.result
  const el = root.querySelector('#xp-charts')
  if (!el) return

  el.innerHTML = `
    <div class="xp-chart-card">
      <h3>Account balance trend</h3>
      <div class="xp-chart-sub">Closing balance at the end of each month in the selected period</div>
      ${lineChartSVG(r.balanceSeries)}
      <div class="xp-legend"><span><i style="background:var(--xp-accent)"></i> Closing balance</span></div>
    </div>

    <div class="xp-chart-card">
      <h3>Monthly credits &amp; debits</h3>
      <div class="xp-chart-sub">Posted movement per month for the current account · member scope</div>
      ${barChartSVG(r.totalsByMonth)}
      <div class="xp-legend">
        <span><i style="background:var(--xp-credit)"></i> Credits</span>
        <span><i style="background:var(--xp-debit)"></i> Debits</span>
      </div>
    </div>`
}

function sortedRows() {
  const rows = [...state.result.display]
  const dir = state.sort.dir === 'desc' ? -1 : 1
  const key = state.sort.key
  rows.sort((a, b) => {
    let cmp = 0
    switch (key) {
      case 'description':
        cmp = String(a.displayDescription || '').localeCompare(String(b.displayDescription || ''))
        break
      case 'account':
        cmp = String(a.accountName).localeCompare(String(b.accountName))
        break
      case 'member':
        cmp = String(a.memberName).localeCompare(String(b.memberName))
        break
      case 'credit':
        cmp = a.credit - b.credit
        break
      case 'debit':
        cmp = a.debit - b.debit
        break
      case 'balance':
        cmp = a.balance - b.balance
        break
      case 'status':
        cmp = String(a.status).localeCompare(String(b.status))
        break
      case 'date':
      default:
        cmp = compareChrono(a, b)
        break
    }
    return cmp * dir || compareChrono(a, b)
  })
  return rows
}

function sortIndicator(key) {
  if (state.sort.key !== key) return `<span class="xp-sort-ind">↕</span>`
  return `<span class="xp-sort-ind">${state.sort.dir === 'asc' ? '↑' : '↓'}</span>`
}

function sortClass(key) {
  return state.sort.key === key ? ' is-sorted' : ''
}

function statusBadge(r) {
  const cls =
    r.status === 'Approved'
      ? 'xp-badge-approved'
      : r.status === 'Pending'
      ? 'xp-badge-pending'
      : 'xp-badge-declined'
  const extras = [
    r.isReversal ? `<span class="xp-badge xp-badge-reversal">Reversal</span>` : '',
    r.isAutogen ? `<span class="xp-badge xp-badge-autogen">Auto</span>` : '',
  ]
    .filter(Boolean)
    .join('')
  return `<div class="xp-badge-row"><span class="xp-badge ${cls}">${escapeHtml(r.status)}</span>${extras}</div>`
}

function pagerHTML(total, page, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), pages)
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1
  const to = Math.min(total, current * pageSize)

  const numbers = []
  const push = (n) => numbers.push(n)
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) push(i)
  } else {
    push(1)
    if (current > 3) push('…')
    for (let i = Math.max(2, current - 1); i <= Math.min(pages - 1, current + 1); i++) push(i)
    if (current < pages - 2) push('…')
    push(pages)
  }

  return `
    <div class="xp-pager-info">Showing <strong>${escapeHtml(formatNumber(from))}–${escapeHtml(
    formatNumber(to)
  )}</strong> of <strong>${escapeHtml(formatNumber(total))}</strong> entries</div>
    <div class="xp-pager-controls">
      <label class="xp-pager-info" for="xp-page-size">Rows
        <select id="xp-page-size" data-xp-page-size
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
  const r = state.result
  const el = root.querySelector('#xp-table-card')
  if (!el) return

  const rows = sortedRows()
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize))
  if (state.page > pages) state.page = pages
  const start = (state.page - 1) * state.pageSize
  const pageRows = rows.slice(start, start + state.pageSize)

  const displayCredits = rows.reduce((sum, x) => sum + x.credit, 0)
  const displayDebits = rows.reduce((sum, x) => sum + x.debit, 0)
  const carryIn = pageRows.length > 0 ? pageRows[0].balanceBefore : r.closing

  const body = []
  body.push(`
    <tr class="xp-row-carry">
      <td data-label="Date">—</td>
      <td data-label="Description" class="xp-cell-stack"><span class="xp-cell-primary">${
        state.page > 1 ? 'Balance brought forward' : 'Opening balance (before period)'
      }</span></td>
      <td data-label="Reference">—</td>
      <td data-label="Account">${escapeHtml(accountName() || 'All accounts')}</td>
      <td data-label="Member">${escapeHtml(memberName() || 'All members')}</td>
      <td data-label="Credit" class="xp-num"></td>
      <td data-label="Debit" class="xp-num"></td>
      <td data-label="Balance" class="xp-num xp-strong">${escapeHtml(formatCurrency(carryIn))}</td>
      <td data-label="Status">—</td>
      <td data-label="Action" class="xp-action-col"></td>
    </tr>`)

  if (pageRows.length === 0) {
    body.push(`
      <tr>
        <td colspan="10" class="xp-empty">
          <strong>No transactions match this view</strong>
          Adjust the filters, widen the date range, or clear the search fields.
        </td>
      </tr>`)
  } else {
    for (const row of pageRows) {
      const rowCls = row.status === 'Pending' ? ' xp-row-pending' : row.status === 'Declined' ? ' xp-row-declined' : ''
      body.push(`
        <tr class="xp-row-clickable${rowCls}" data-xp-uid="${escapeHtml(row.uid)}" tabindex="0">
          <td data-label="Date">
            <span class="xp-cell-primary">${escapeHtml(formatDate(row.date))}</span>
            <div class="xp-cell-sub">${escapeHtml(row.createdAt ? row.createdAt.slice(0, 10) : '')}</div>
          </td>
          <td data-label="Description" class="xp-cell-stack">
            <span class="xp-cell-primary">${escapeHtml(row.displayDescription || '—')}</span>
            <div class="xp-cell-sub">${escapeHtml(row.transactionType || '')}${
        row.category && row.category !== row.transactionType ? ` · ${escapeHtml(row.category)}` : ''
      }</div>
          </td>
          <td data-label="Reference"><span class="xp-ref" title="${escapeHtml(row.ref)}">${escapeHtml(
        row.shortRef
      )}</span></td>
          <td data-label="Account">
            <span class="xp-cell-primary">${escapeHtml(row.accountName)}</span>
            <div class="xp-cell-sub">${escapeHtml(row.accountType || '')}</div>
          </td>
          <td data-label="Member">
            <span>${escapeHtml(row.memberName)}</span>
          </td>
          <td data-label="Credit" class="xp-num xp-amount xp-is-credit">${
            row.credit ? escapeHtml(formatCurrency(row.credit)) : '—'
          }</td>
          <td data-label="Debit" class="xp-num xp-amount xp-is-debit">${
            row.debit ? escapeHtml(formatCurrency(row.debit)) : '—'
          }</td>
          <td data-label="Balance" class="xp-num xp-amount${
            row.balance < 0 ? ' xp-is-debit' : ''
          }">${escapeHtml(formatCurrency(row.balance))}</td>
          <td data-label="Status">${statusBadge(row)}</td>
          <td data-label="Action" class="xp-action-col">
            <button type="button" class="xp-icon-btn" data-xp-uid="${escapeHtml(
              row.uid
            )}" title="View details">View</button>
          </td>
        </tr>`)
    }
  }

  body.push(`
    <tr class="xp-row-total">
      <td data-label="">—</td>
      <td data-label="Description" class="xp-cell-stack">TOTAL — ${escapeHtml(
        formatNumber(rows.length)
      )} filtered ${rows.length === 1 ? 'entry' : 'entries'}</td>
      <td data-label="Reference">—</td>
      <td data-label="Account">—</td>
      <td data-label="Member">—</td>
      <td data-label="Credit" class="xp-num xp-is-credit">${escapeHtml(formatCurrency(displayCredits))}</td>
      <td data-label="Debit" class="xp-num xp-is-debit">${escapeHtml(formatCurrency(displayDebits))}</td>
      <td data-label="Balance" class="xp-num">${escapeHtml(formatCurrency(r.closing))}</td>
      <td data-label="Status">—</td>
      <td data-label="Action" class="xp-action-col"></td>
    </tr>`)

  el.innerHTML = `
    <div class="xp-table-head">
      <div>
        <h2>Transactions</h2>
        <div class="xp-table-meta">
          ${escapeHtml(formatNumber(rows.length))} entries · default order is chronological
          ${
            r.hasTableFilters
              ? ' · <span style="color:var(--xp-warn)">text/status filters narrow this table only — totals above follow the account · member · date scope</span>'
              : ''
          }
        </div>
      </div>
      <div class="xp-table-tools">
        <span class="xp-badge xp-badge-neutral">Opening ${escapeHtml(formatCurrency(r.opening))}</span>
        <span class="xp-badge xp-badge-approved">Closing ${escapeHtml(formatCurrency(r.closing))}</span>
      </div>
    </div>

    <div class="xp-table-wrap">
      <table class="xp-table xp-table-cards">
        <thead>
          <tr>
            <th class="xp-sortable${sortClass('date')}" data-xp-sort="date">Date${sortIndicator('date')}</th>
            <th class="xp-sortable${sortClass('description')}" data-xp-sort="description">Description${sortIndicator(
    'description'
  )}</th>
            <th>Reference</th>
            <th class="xp-sortable${sortClass('account')}" data-xp-sort="account">Account${sortIndicator(
    'account'
  )}</th>
            <th class="xp-sortable${sortClass('member')}" data-xp-sort="member">Member${sortIndicator(
    'member'
  )}</th>
            <th class="xp-num xp-sortable${sortClass('credit')}" data-xp-sort="credit">Credit${sortIndicator(
    'credit'
  )}</th>
            <th class="xp-num xp-sortable${sortClass('debit')}" data-xp-sort="debit">Debit${sortIndicator(
    'debit'
  )}</th>
            <th class="xp-num xp-sortable${sortClass('balance')}" data-xp-sort="balance">Balance${sortIndicator(
    'balance'
  )}</th>
            <th class="xp-sortable${sortClass('status')}" data-xp-sort="status">Status${sortIndicator(
    'status'
  )}</th>
            <th class="xp-action-col">Action</th>
          </tr>
        </thead>
        <tbody>${body.join('')}</tbody>
      </table>
    </div>

    <div class="xp-pager">${pagerHTML(rows.length, state.page, state.pageSize)}</div>`
}

/* ----------------------------------------------------------------- entry */

async function loadData() {
  try {
    const dataset = await loadLedgerDataset(state.user)
    state.dataset = dataset
    state.accountOpts = accountOptions(dataset)
    state.typeOpts = transactionTypes(dataset.rows)
    state.error = null
    state.result = computeLedger(dataset.rows, state.filters)
  } catch (err) {
    console.error('[ledger] load failed', err)
    state.error = err
    state.result = null
  }
}

async function refreshPage(container) {
  await loadData()
  renderShell(container)
  paint(container.querySelector('.xp-ledger'))
}

export async function renderLedgerPage(container, user) {
  state.user = user

  try {
    const linkedRef = sessionStorage.getItem('xp-ledger-reference') || ''
    if (linkedRef) {
      state.prefillRef = linkedRef
      sessionStorage.removeItem('xp-ledger-reference')
    }
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }

  if (state.prefillRef) {
    state.filters.refSearch = state.prefillRef
    state.prefillRef = ''
    state.page = 1
  }

  setMobileTitle('Ledger', 'Account transaction register')

  container.innerHTML = `<div class="xp xp-ledger">${loadingHTML('Loading ledger data…')}</div>`
  await loadData()
  renderShell(container)
  paint(container.querySelector('.xp-ledger'))
}
