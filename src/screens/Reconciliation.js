import {
  checkReconciliation,
  saveReconciliationSummary,
  fetchBanks,
  getAllReconciliationSummaries,
  unsealReconciliation,
  getReconciliationDrillDown
} from '../services/dataService.js'
import { hasPermission } from '../services/permissionService.js'
import { formatCurrency, escapeHtml } from '../utils/formatters.js'
import { showToast } from '../services/toastService.js'
import { showWorkspaceSpinner } from '../components/workspaceSpinner.js'
import { save as persistState, load as loadPersisted, clear as clearPersisted } from '../services/statePersistence.js'

const STATUS_STYLES = {
  Draft: { bg: 'var(--bg-secondary)', border: 'var(--border-medium)', color: 'var(--text-muted)', icon: '📋', text: 'Draft', short: 'Draft' },
  Balanced: { bg: 'rgba(46, 160, 67, 0.12)', border: 'var(--success)', color: 'var(--success)', icon: '✓', text: 'Balanced', short: 'Balanced' },
  Discrepancy: { bg: 'rgba(207, 34, 46, 0.10)', border: 'var(--danger)', color: 'var(--danger)', icon: '⚠', text: 'Discrepancy Found', short: 'Discrepancy' },
  Sealed: { bg: 'rgba(32, 33, 36, 0.08)', border: 'var(--text-primary)', color: 'var(--text-primary)', icon: '🔒', text: 'Sealed', short: 'Sealed' },
  Unsealed: { bg: 'var(--bg-secondary)', border: 'var(--border-medium)', color: 'var(--text-muted)', icon: '🔓', text: 'Previously Unsealed', short: 'Unsealed' }
}

const SPACING = {
  page: '1.75rem',
  cardPad: '1.75rem',
  section: '1.25rem'
}

const CARD = (head, icon, body, opts = {}) => `
  <section class="card ${opts.class || ''}" style="
    background: var(--bg-card);
    border: 1px solid var(--border-light);
    border-radius: 14px;
    padding: ${SPACING.cardPad};
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    ${opts.style || ''}
  ">
    ${head ? `
    <header style="
      display: flex; align-items: center; justify-content: space-between;
      gap: 0.75rem;
      padding-bottom: 0.9rem;
      margin-bottom: 1.25rem;
      border-bottom: 1px solid var(--border-light);
    ">
      <h3 style="margin: 0; font-size: 1.05rem; font-weight: 800; color: var(--text-primary); display: flex; align-items: center; gap: 0.6rem;">
        <span style="font-size: 1.25rem;">${icon || ''}</span>
        ${head}
      </h3>
      ${opts.suffix || ''}
    </header>` : ''}
    ${body}
  </section>
`

const SYS_CSS = `
:root {
  --recon-section-gap: clamp(1rem, 2.2vw, 1.5rem);
  --recon-pad: clamp(1rem, 2.4vw, 1.75rem);
}
#recon-wrap { display: flex; flex-direction: column; gap: var(--recon-section-gap); }
#recon-wrap .card {
  margin: 0;
  width: 100%;
}

/* --- Page header --- */
#recon-wrap .recon-page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap;
}
#recon-wrap .recon-page-title {
  font-size: clamp(1.35rem, 2.8vw, 1.8rem);
  font-weight: 800;
  color: var(--text-primary);
  margin: 0;
  display: flex; align-items: center; gap: 0.6rem;
  line-height: 1.2;
}
#recon-wrap .recon-page-title-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 2.4rem; height: 2.4rem; border-radius: 12px;
  background: var(--accent-soft);
  font-size: 1.3rem;
}
#recon-wrap .recon-page-subtitle {
  margin: 0.5rem 0 0 0;
  color: var(--text-muted);
  font-size: 0.92rem;
  line-height: 1.5;
  max-width: 42rem;
}

/* --- Workspace card (single unified card, not double-nested) --- */
#recon-wrap .recon-workspace {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: clamp(1.25rem, 3vw, 2.75rem);
  align-items: start;
}
#recon-wrap .recon-ws-col { display: flex; flex-direction: column; gap: 1.25rem; min-width: 0; }
#recon-wrap .recon-ws-col + .recon-ws-col {
  padding-left: clamp(1rem, 2.6vw, 2rem);
  border-left: 1px solid var(--border-light);
}
#recon-wrap .recon-subheading {
  display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
  margin: 0 0 0.75rem 0;
  font-size: 0.88rem;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-primary);
}
#recon-wrap .recon-subheading::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-light);
  margin-left: 0.5rem;
}
#recon-wrap .recon-subheading-icon { font-size: 1rem; margin-right: 0.35rem; }

/* --- What & When column --- */
#recon-wrap .recon-period-range-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem 1rem;
  margin-bottom: 1rem;
}
#recon-wrap .recon-period-fields-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.75rem 1rem;
  align-items: end;
}
#recon-wrap .recon-range-pill {
  display: inline-flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 0.85rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-primary);
  font-weight: 700;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  margin-bottom: 0.5rem;
}
#recon-wrap .recon-range-pill .sep { opacity: 0.6; }
#recon-wrap .recon-cal-shell {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 0.9rem 1rem;
  position: relative;
}
#recon-wrap .recon-cal-caption {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 0.76rem;
  color: var(--text-muted);
  margin-bottom: 0.6rem;
  gap: 0.5rem;
  flex-wrap: wrap;
}
#recon-wrap .recon-cal-legend {
  display: flex; gap: 0.75rem 1rem;
  font-size: 0.68rem;
  color: var(--text-muted);
  flex-wrap: wrap;
  margin-top: 0.7rem;
}
#recon-wrap .recon-cal-legend-item {
  display: inline-flex; align-items: center; gap: 0.35rem;
}
#recon-wrap .recon-cal-legend-swatch {
  display: inline-block; width: 11px; height: 11px; border-radius: 3px;
}

/* --- Statement / Status column --- */
#recon-wrap .recon-status-block {
  display: flex; flex-direction: column; gap: 0.6rem;
  padding: 1rem 1.1rem;
  border-radius: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
}
#recon-wrap .recon-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.9rem;
  border-radius: 999px;
  font-weight: 800;
  font-size: 0.86rem;
  align-self: flex-start;
  letter-spacing: 0.01em;
}
#recon-wrap .recon-status-msg {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-muted);
  line-height: 1.55;
}
#recon-wrap .recon-statement-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
#recon-wrap .recon-tip-box {
  background: rgba(59, 130, 246, 0.06);
  border: 1px solid rgba(59, 130, 246, 0.18);
  border-radius: 10px;
  padding: 0.8rem 1rem;
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-muted);
}
#recon-wrap .recon-tip-icon { font-size: 1rem; line-height: 1.3; flex-shrink: 0; margin-top: 0.05rem; }
#recon-wrap .recon-tip-box strong { color: var(--text-primary); }

#recon-wrap .recon-check-btn {
  width: 100%;
  padding: 0.95rem 1.1rem;
  font-size: 1rem;
  font-weight: 800;
  letter-spacing: 0.01em;
  border-radius: 999px;
  min-height: 3.25rem;
}
#recon-wrap .recon-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
#recon-wrap .recon-actions button { flex: 1 1 160px; min-height: 3rem; }

/* --- Result block --- */
#recon-wrap .recon-result-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 0;
  align-items: center;
}
#recon-wrap .recon-result-row { display: contents; }
#recon-wrap .recon-result-colhead {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 0.5rem 0.75rem 0.75rem;
  border-bottom: 2px solid var(--border-light);
}
#recon-wrap .recon-result-colhead:first-child { padding-left: 0.25rem; }
#recon-wrap .recon-result-colhead:last-child { padding-right: 0.25rem; }
#recon-wrap .recon-result-label {
  font-weight: 700;
  color: var(--text-primary);
  font-size: 0.95rem;
  padding: 0.85rem 0.75rem;
  border-bottom: 1px solid var(--border-light);
}
#recon-wrap .recon-result-label { padding-left: 0.25rem; }
#recon-wrap .recon-result-cell {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-size: 0.98rem;
  padding: 0.85rem 0.75rem;
  border-bottom: 1px solid var(--border-light);
}
#recon-wrap .recon-result-cell:last-child { padding-right: 0.25rem; }
#recon-wrap .recon-result-cell.ok { color: var(--success); }
#recon-wrap .recon-result-cell.err { color: var(--danger); }
#recon-wrap .recon-result-cell::before { display: none; }
#recon-wrap .recon-result-row:last-child .recon-result-label,
#recon-wrap .recon-result-row:last-child .recon-result-cell { border-bottom: none; }

/* --- Drill down table --- */
#recon-wrap .recon-drill-table {
  display: block;
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  max-height: 480px;
}
#recon-wrap .recon-drill-table .data-table {
  width: 100%;
  font-size: 0.85rem;
  min-width: 780px;
  border-collapse: collapse;
}
#recon-wrap .recon-drill-table .data-table th,
#recon-wrap .recon-drill-table .data-table td {
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid var(--border-light);
  color: var(--text-primary);
}
#recon-wrap .recon-drill-table .data-table th {
  position: sticky;
  top: 0;
  background: var(--bg-card);
  z-index: 1;
  font-weight: 700;
  color: var(--text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: left;
}

/* --- History --- */
#recon-wrap .recon-history-empty {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-muted);
}
#recon-wrap .recon-history-empty-icon {
  font-size: 2.5rem;
  margin-bottom: 0.75rem;
}
#recon-wrap .recon-history-empty h4 {
  margin: 0 0 0.5rem 0;
  font-weight: 700;
  color: var(--text-primary);
  font-size: 1rem;
}
#recon-wrap .recon-history-empty p {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
}
#recon-wrap .recon-history-cards { display: none; }

#recon-wrap .recon-history-table-wrap .recon-scrollfix {
  max-height: 520px;
  overflow: auto;
}
#recon-wrap .recon-history-table .data-table {
  width: 100%;
  font-size: 0.85rem;
  min-width: 960px;
  border-collapse: collapse;
}
#recon-wrap .recon-history-table .data-table th {
  position: sticky;
  top: 0;
  background: var(--bg-card);
  z-index: 1;
  padding: 0.75rem 1rem;
  border-bottom: 2px solid var(--border-light);
  color: var(--text-muted);
  font-weight: 800;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  text-align: left;
}
#recon-wrap .recon-history-table .data-table th[style*="text-align: right"] { text-align: right; }
#recon-wrap .recon-history-table .data-table th[style*="text-align: center"] { text-align: center; }
#recon-wrap .recon-history-table .data-table td {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-light);
  color: var(--text-primary);
}
#recon-wrap .recon-history-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0.85rem 0 0 0.25rem;
  line-height: 1.5;
}

/* --- Calendar internals (visual weight reduced) --- */
#recon-wrap .recon-cal-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 0.35rem;
}
#recon-wrap .recon-cal-head button {
  padding: 0.25rem 0.65rem;
  border-radius: 8px;
  min-height: 2rem;
  min-width: 2rem;
  font-size: 0.85rem;
  font-weight: 800;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  cursor: pointer;
  transition: all 0.15s ease;
}
#recon-wrap .recon-cal-head button:hover {
  background: var(--bg-card);
  color: var(--text-primary);
}
#recon-wrap .recon-cal-month {
  color: var(--text-primary);
  font-size: 0.86rem;
  font-weight: 800;
  letter-spacing: 0.01em;
}
#recon-wrap table.recon-cal-grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 2px;
}
#recon-wrap table.recon-cal-grid th {
  padding: 0.3rem 0;
  font-size: 0.65rem;
  color: var(--text-muted);
  text-transform: uppercase;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-align: center;
}

/* Scrollbar */
.recon-scrollfix::-webkit-scrollbar { height: 8px; width: 8px; }
.recon-scrollfix::-webkit-scrollbar-thumb { background: var(--border-medium); border-radius: 4px; }
.recon-scrollfix::-webkit-scrollbar-track { background: transparent; }

/* ========================================================== */
/* TABLET (769 - 1024px) — graceful degradation               */
/* ========================================================== */
@media (min-width: 769px) and (max-width: 1024px) {
  #recon-wrap .recon-workspace { gap: 1.25rem; }
  #recon-wrap .recon-ws-col + .recon-ws-col { padding-left: 1.25rem; }
  #recon-wrap .recon-period-fields-grid { grid-template-columns: 1fr 1fr; }
  #recon-wrap .recon-period-fields-grid .field:first-child { grid-column: 1 / -1; }
  #recon-wrap .recon-result-grid { column-gap: 0.25rem; }
}

/* ========================================================== */
/* DESKTOP (>=769px) — calendar cell height                   */
/* ========================================================== */
@media (min-width: 769px) {
  #recon-wrap .recon-cal-cell { min-height: 32px; line-height: 32px; }
}

/* ========================================================== */
/* MOBILE (<=768px) — intentional vertical redesign           */
/* ========================================================== */
@media (max-width: 768px) {
  #recon-wrap { gap: 1rem; }
  #recon-wrap .recon-page-header { gap: 0.75rem; }
  #recon-wrap .recon-page-header .ghost-button { flex: 1; min-width: 0; }
  #recon-wrap .recon-workspace {
    grid-template-columns: 1fr;
    gap: 1.25rem;
  }
  #recon-wrap .recon-ws-col + .recon-ws-col {
    padding-left: 0;
    border-left: none;
    border-top: 1px solid var(--border-light);
    padding-top: 1.25rem;
  }
  #recon-wrap .recon-period-fields-grid,
  #recon-wrap .recon-statement-grid {
    grid-template-columns: 1fr;
  }
  #recon-wrap .recon-actions { flex-direction: column; }
  #recon-wrap .recon-actions button {
    width: 100%;
    flex: 1 1 auto;
    min-height: 3.25rem;
  }

  /* Result block: stacked cards per row */
  #recon-wrap .recon-result-grid {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  #recon-wrap .recon-result-row {
    display: block;
    border: 1px solid var(--border-light);
    border-radius: 12px;
    padding: 0.9rem 1rem;
    background: var(--bg-secondary);
  }
  #recon-wrap .recon-result-cols { display: none; }
  #recon-wrap .recon-result-label {
    display: block;
    font-weight: 800;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-primary);
    border: none !important;
    padding: 0 !important;
  }
  #recon-wrap .recon-result-cell {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0;
    border: none !important;
    font-size: 0.92rem;
  }
  #recon-wrap .recon-result-cell::before {
    display: inline;
    content: attr(data-col);
    color: var(--text-muted);
    font-size: 0.76rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }

  /* History: cards instead of table */
  #recon-wrap .recon-history-table-wrap { display: none; }
  #recon-wrap .recon-history-cards {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  #recon-wrap .recon-history-card {
    border: 1px solid var(--border-light);
    border-radius: 12px;
    padding: 1rem;
    background: var(--bg-card);
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  #recon-wrap .recon-history-card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  #recon-wrap .recon-history-card-bank {
    font-size: 0.95rem;
    font-weight: 800;
    color: var(--text-primary);
    line-height: 1.3;
  }
  #recon-wrap .recon-history-card-period {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-bottom: 0.75rem;
  }
  #recon-wrap .recon-history-card-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.55rem;
    margin-bottom: 0.75rem;
  }
  #recon-wrap .recon-history-card-grid > div {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  #recon-wrap .recon-history-card-grid > div:nth-child(odd) { padding-right: 0.25rem; }
  #recon-wrap .recon-history-card-grid span {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    font-weight: 800;
  }
  #recon-wrap .recon-history-card-grid strong {
    font-size: 0.88rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }
  #recon-wrap .recon-history-card-meta {
    padding-top: 0.65rem;
    border-top: 1px solid var(--border-light);
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* Drill-down scrolls horizontally on mobile */
  #recon-wrap .recon-drill-table .data-table td,
  #recon-wrap .recon-drill-table .data-table th {
    white-space: nowrap;
    padding-inline: 0.6rem;
  }

  /* Calendar cells: 44px touch targets */
  #recon-wrap .recon-cal-cell {
    min-height: 44px;
    min-width: 44px;
    line-height: 44px;
  }
  #recon-wrap .recon-cal-legend { font-size: 0.66rem; gap: 0.55rem; }
}
`

export async function renderReconciliation(state, container) {
  const user = state.welcomeUser
  const canRead = hasPermission(user.permissions, 'read_reconcile')
  const canCreate = hasPermission(user.permissions, 'create_reconcile')
  const isAdmin = hasPermission(user.permissions, 'admin') || (user.username && user.username.toLowerCase() === 'admin')
  const coopId = user.cooperativeId

  if (!canRead) {
    container.innerHTML = `
      <div class="page-container">
        <div class="alert" role="alert">
          <strong>Access Restricted:</strong> Your account does not have sufficient permissions to access the Reconciliation module.
        </div>
      </div>`
    return
  }

  showWorkspaceSpinner(container)

  let banks = []
  try {
    banks = await fetchBanks(coopId)
    banks = banks.filter(b => (b.bank_name || '').toLowerCase() !== 'internal transfer')
  } catch (err) {
    console.error('Failed to fetch banks', err)
  }

  const DRAFT_KEY = `recon-draft-${coopId}`
  const today = new Date().toISOString().slice(0, 10)
  const saved = loadPersisted(DRAFT_KEY) || {}

  const localState = {
    banks,
    bankName: saved.bankName || (banks[0] && banks[0].bank_name) || '',
    from: saved.from || today,
    to: saved.to || today,
    bankCr: saved.bankCr || '',
    bankDr: saved.bankDr || '',
    lastCheck: null,
    history: [],
    drillDownOpen: false,
    drillDownRows: [],
    inspectedSummaryId: null,
    inspectedSummary: null,
    calendarMonth: new Date().toISOString().slice(0, 7),
    calendarSelecting: 'from',
    user,
    coopId,
    canRead,
    canCreate,
    isAdmin,
    DRAFT_KEY
  }

  const refreshHistory = async () => {
    try {
      localState.history = await getAllReconciliationSummaries(coopId, localState.bankName || null)
    } catch (e) {
      console.error('Failed to load history', e)
      localState.history = []
    }
  }
  await refreshHistory()

  const render = () => {
    const ls = localState
    const st = ls.lastCheck
    const inspected = ls.inspectedSummary
    const readOnly = !!ls.inspectedSummaryId && inspected && inspected.is_deleted === 0 && inspected.status === 'Sealed'

    let displayStatus = 'Draft'
    if (readOnly) displayStatus = 'Sealed'
    else if (ls.inspectedSummaryId && inspected && inspected.is_deleted === 1) displayStatus = 'Unsealed'
    else if (st) displayStatus = st.status

    const statStyle = STATUS_STYLES[displayStatus] || STATUS_STYLES.Draft

    const periodLabel = readOnly && inspected
      ? `${inspected.period_start || ''} → ${inspected.period_end || ''}`
      : (st && st.periodStart && st.periodEnd ? `${st.periodStart} → ${st.periodEnd}` : '')

    const sysCr = readOnly ? (inspected?.system_total_cr ?? 0) : (st?.systemCr ?? 0)
    const sysDr = readOnly ? (inspected?.system_total_dr ?? 0) : (st?.systemDr ?? 0)
    const bCr = readOnly ? (inspected?.bank_total_cr ?? 0) : (st?.bankCr ?? 0)
    const bDr = readOnly ? (inspected?.bank_total_dr ?? 0) : (st?.bankDr ?? 0)
    const diffCr = bCr - sysCr
    const diffDr = bDr - sysDr
    const txCount = readOnly ? (inspected?.transactionCount ?? '—') : (st?.transactionCount ?? 0)
    const diffCrOk = Math.abs(Math.round(diffCr * 1000) / 1000) <= 0.009
    const diffDrOk = Math.abs(Math.round(diffDr * 1000) / 1000) <= 0.009

    const hasRange = ls.from && ls.to && ls.from !== '' && ls.to !== ''
    const rangeText = hasRange
      ? `${ls.from} <span class="sep">→</span> ${ls.to}`
      : '<span class="sep">Select a range</span>'

    container.innerHTML = `
      <style>${SYS_CSS}</style>
      <div id="recon-wrap" class="recon-page page-container" style="
        padding: clamp(1rem, 2vw, ${SPACING.page});
        max-width: 1400px;
        margin: 0 auto;
      ">
        <div class="recon-page-header">
          <div style="min-width: 0; flex: 1 1 320px;">
            <h2 class="recon-page-title">
              <span class="recon-page-title-icon">🏦</span>
              Bank Reconciliation
            </h2>
            <p class="recon-page-subtitle">
              Verify, compare and seal bank ledger totals for any date range — daily, weekly, partial or full month.
            </p>
          </div>
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button type="button" class="ghost-button" id="clear-recon-form-btn" title="Reset the current form and start a new reconciliation">
              ✨ New Reconciliation
            </button>
          </div>
        </div>

        ${CARD('Reconciliation Workspace', '', `
          <div class="recon-workspace">
            <div class="recon-ws-col">
              <h4 class="recon-subheading"><span class="recon-subheading-icon">📍</span>What & When</h4>

              <div class="recon-period-range-row">
                <span class="recon-range-pill" aria-label="Selected period">${rangeText}</span>
              </div>

              <div class="recon-period-fields-grid">
                <label class="field">
                  <span>Bank Account</span>
                  <select id="recon-bank" ${readOnly ? 'disabled' : ''} aria-label="Bank Account">
                    <option value="">Select Bank</option>
                    ${ls.banks.map(b => `<option value="${escapeHtml(b.bank_name)}" ${b.bank_name === ls.bankName ? 'selected' : ''}>${escapeHtml(b.bank_name)}</option>`).join('')}
                  </select>
                </label>
                <label class="field">
                  <span>From Date</span>
                  <input type="date" id="recon-from" value="${escapeHtml(ls.from)}" ${readOnly ? 'disabled' : ''} aria-label="From Date">
                </label>
                <label class="field">
                  <span>To Date</span>
                  <input type="date" id="recon-to" value="${escapeHtml(ls.to)}" ${readOnly ? 'disabled' : ''} aria-label="To Date">
                </label>
              </div>

              <div class="recon-cal-shell" aria-label="Visual date picker">
                <div class="recon-cal-caption">
                  <span>Visual picker</span>
                  <span style="font-weight: 600; color: var(--text-secondary);">Click twice to set a range</span>
                </div>
                <div id="recon-calendar" class="recon-scrollfix"></div>
              </div>
            </div>

            <div class="recon-ws-col">
              <h4 class="recon-subheading"><span class="recon-subheading-icon">🏦</span>Statement & Actions</h4>

              ${renderStatusBlock(ls, statStyle, displayStatus, readOnly, inspected)}

              <h4 class="recon-subheading" style="margin-top: 0.5rem;"><span class="recon-subheading-icon">🧾</span>Bank Statement Totals</h4>
              <div class="recon-statement-grid">
                <label class="field">
                  <span>Statement Credits (₦)</span>
                  <input type="number" id="bank-cr" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${escapeHtml(String(ls.bankCr))}" ${readOnly ? 'disabled' : ''} aria-label="Statement Credits">
                </label>
                <label class="field">
                  <span>Statement Debits (₦)</span>
                  <input type="number" id="bank-dr" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${escapeHtml(String(ls.bankDr))}" ${readOnly ? 'disabled' : ''} aria-label="Statement Debits">
                </label>
              </div>

              <div class="recon-tip-box">
                <span class="recon-tip-icon">💡</span>
                <div>
                  <strong>Tip:</strong> Credits = deposits received. Debits = payments, withdrawals & charges. Internal transfers are automatically excluded from system calculations.
                </div>
              </div>

              ${!readOnly ? `<button id="btn-check" class="primary-button recon-check-btn">🔍 Check Reconciliation</button>` : ''}

              ${renderActions(ls, st, readOnly)}
            </div>
          </div>
        `)}

        ${(st || readOnly) ? CARD(
          `Reconciliation Result${periodLabel ? ` — <span style="color: var(--text-muted); font-weight: 500; font-size: 0.88rem;">${escapeHtml(periodLabel)}</span>` : ''}`,
          '📊',
          `
            <div class="recon-result-grid">
              <div class="recon-result-row recon-result-cols">
                <span class="recon-result-colhead" style="border-bottom-color: transparent;"></span>
                <span class="recon-result-colhead" style="text-align: left;">Bank Statement</span>
                <span class="recon-result-colhead" style="text-align: left;">System / Ledger</span>
                <span class="recon-result-colhead" style="text-align: left;">Difference</span>
              </div>
              <div class="recon-result-row">
                <span class="recon-result-label">Credits</span>
                <span class="recon-result-cell" data-col="Bank Statement">${formatCurrency(bCr)}</span>
                <span class="recon-result-cell" data-col="System / Ledger">${formatCurrency(sysCr)}</span>
                <span class="recon-result-cell ${diffCrOk ? 'ok' : 'err'}" data-col="Difference">${formatCurrency(diffCr)} ${diffCrOk ? '✓' : '⚠'}</span>
              </div>
              <div class="recon-result-row">
                <span class="recon-result-label">Debits</span>
                <span class="recon-result-cell" data-col="Bank Statement">${formatCurrency(bDr)}</span>
                <span class="recon-result-cell" data-col="System / Ledger">${formatCurrency(sysDr)}</span>
                <span class="recon-result-cell ${diffDrOk ? 'ok' : 'err'}" data-col="Difference">${formatCurrency(diffDr)} ${diffDrOk ? '✓' : '⚠'}</span>
              </div>
              <div class="recon-result-row">
                <span class="recon-result-label">Transactions</span>
                <span class="recon-result-cell" data-col="Bank Statement">—</span>
                <span class="recon-result-cell" data-col="System / Ledger">${txCount}</span>
                <span class="recon-result-cell" data-col="Difference">—</span>
              </div>
            </div>
          `
        ) : ''}

        ${ls.drillDownOpen && ls.drillDownRows.length ? CARD(
          `Discrepancy Drill-Down — ${ls.drillDownRows.length} records`,
          '🕵',
          `
            <div class="recon-drill-table recon-scrollfix">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="position: sticky; left: 0; background: var(--bg-card); z-index: 2;">Date</th>
                    <th>Member</th>
                    <th>Description</th>
                    <th style="text-align: right;">Amount (₦)</th>
                    <th>C/D</th>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Reconciled</th>
                  </tr>
                </thead>
                <tbody>
                  ${ls.drillDownRows.map(r => `
                    <tr>
                      <td style="position: sticky; left: 0; background: var(--bg-card); white-space: nowrap;">${escapeHtml(String(r.remittance_date || '').slice(0, 10))}</td>
                      <td>${escapeHtml(r.memberName || '—')}</td>
                      <td>${escapeHtml(r.description || '')}</td>
                      <td style="text-align: right; font-variant-numeric: tabular-nums;">${formatCurrency(Math.abs(r.amount || 0))}</td>
                      <td>
                        <span style="
                          padding: 0.2rem 0.55rem;
                          border-radius: 999px;
                          font-size: 0.72rem; font-weight: 800;
                          background: ${r.crDr === 'CR' ? 'rgba(46, 160, 67, 0.12)' : 'rgba(207, 34, 46, 0.10)'};
                          color: ${r.crDr === 'CR' ? 'var(--success)' : 'var(--danger)'};
                        ">${r.crDr}</span>
                      </td>
                      <td>${escapeHtml(r.status || '')}</td>
                      <td>${escapeHtml(r.transaction_type || '')}</td>
                      <td>${r.reconciliation_summary_id
                        ? '<span style="color: var(--success); font-weight: 800;">✔ Yes</span>'
                        : '<span style="color: var(--text-muted);">— No</span>'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `
        ) : ''}

        ${CARD(
          `Reconciliation History — ${ls.history.length} records`,
          '🗂',
          ls.history.length === 0 ? `
            <div class="recon-history-empty">
              <div class="recon-history-empty-icon">🗒️</div>
              <h4>No sealed reconciliations yet</h4>
              <p>Choose bank, enter statement totals, run Check Reconciliation, then click Seal to begin building your audit trail.</p>
            </div>
          ` : `
            <div class="recon-history-table-wrap">
              <div class="recon-history-table recon-scrollfix">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th style="position: sticky; left: 0; background: var(--bg-card); z-index: 2;">Bank</th>
                      <th>Period</th>
                      <th style="text-align: right;">Bank CR</th>
                      <th style="text-align: right;">Bank DR</th>
                      <th style="text-align: right;">System CR</th>
                      <th style="text-align: right;">System DR</th>
                      <th style="text-align: right;">Difference</th>
                      <th style="text-align: center;">Tx</th>
                      <th>Status</th>
                      <th style="position: sticky; right: 0; background: var(--bg-card); z-index: 2;">Sealed</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${ls.history.map(h => {
                      const diff = (h.system_total_cr - h.bank_total_cr) - (h.system_total_dr - h.bank_total_dr)
                      const selected = String(h.id) === String(ls.inspectedSummaryId)
                      const hst = h.is_deleted === 1 ? 'Unsealed' : (h.status || 'Sealed')
                      const hStyle = STATUS_STYLES[hst] || STATUS_STYLES.Draft
                      return `
                        <tr data-history-id="${escapeHtml(h.id)}" style="
                          cursor: pointer;
                          ${selected ? `background: ${hStyle.bg};` : ''}
                          transition: background 0.15s ease;
                          ${selected ? `border-left: 3px solid ${hStyle.border};` : ''}
                        "
                        onmouseover="this.style.background = selected ? this.style.background : 'var(--bg-secondary)'"
                        onmouseout="this.style.background = selected ? this.style.background : ''">
                          <td style="position: sticky; left: 0; background: inherit; font-weight: 800; white-space: nowrap;">
                            ${escapeHtml(h.bank_name || '')}
                          </td>
                          <td style="white-space: nowrap; font-variant-numeric: tabular-nums;">
                            ${escapeHtml(h.period_start || '')} → ${escapeHtml(h.period_end || '')}
                          </td>
                          <td style="text-align: right; font-variant-numeric: tabular-nums;">${formatCurrency(h.bank_total_cr)}</td>
                          <td style="text-align: right; font-variant-numeric: tabular-nums;">${formatCurrency(h.bank_total_dr)}</td>
                          <td style="text-align: right; font-variant-numeric: tabular-nums;">${formatCurrency(h.system_total_cr)}</td>
                          <td style="text-align: right; font-variant-numeric: tabular-nums;">${formatCurrency(h.system_total_dr)}</td>
                          <td style="text-align: right; font-variant-numeric: tabular-nums; color: ${Math.abs(diff) >= 0.01 ? 'var(--danger)' : 'var(--text-primary)'}; font-weight: 800;">
                            ${formatCurrency(diff)}
                          </td>
                          <td style="text-align: center; font-weight: 800;">${h.transactionCount ?? 0}</td>
                          <td>
                            <span style="
                              display: inline-flex; align-items: center; gap: 0.3rem;
                              padding: 0.22rem 0.65rem; border-radius: 999px;
                              font-size: 0.72rem; font-weight: 800;
                              background: ${hStyle.bg}; color: ${hStyle.color};
                              border: 1px solid ${hStyle.border};
                            ">${hStyle.icon} ${hStyle.text}</span>
                          </td>
                          <td style="position: sticky; right: 0; background: inherit; white-space: nowrap; font-size: 0.78rem; line-height: 1.4;">
                            ${h.created_at ? new Date(h.created_at).toLocaleDateString() : ''}<br>
                            <span style="color: var(--text-muted);">by ${escapeHtml(h.created_by || '')}</span>
                          </td>
                        </tr>
                      `
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
            <div class="recon-history-cards">
              ${ls.history.map(h => {
                const diff = (h.system_total_cr - h.bank_total_cr) - (h.system_total_dr - h.bank_total_dr)
                const selected = String(h.id) === String(ls.inspectedSummaryId)
                const hst = h.is_deleted === 1 ? 'Unsealed' : (h.status || 'Sealed')
                const hStyle = STATUS_STYLES[hst] || STATUS_STYLES.Draft
                return `
                  <div class="recon-history-card" data-history-id="${escapeHtml(h.id)}" style="
                    ${selected ? `border-color: ${hStyle.border}; border-width: 2px; background: ${hStyle.bg};` : ''}
                  ">
                    <div class="recon-history-card-top">
                      <div class="recon-history-card-bank">${escapeHtml(h.bank_name || '')}</div>
                      <span style="
                        display: inline-flex; align-items: center; gap: 0.3rem;
                        padding: 0.22rem 0.6rem; border-radius: 999px;
                        font-size: 0.7rem; font-weight: 800;
                        background: ${hStyle.bg}; color: ${hStyle.color};
                        border: 1px solid ${hStyle.border};
                        flex-shrink: 0;
                      ">${hStyle.icon} ${hStyle.short}</span>
                    </div>
                    <div class="recon-history-card-period">${escapeHtml(h.period_start || '')} → ${escapeHtml(h.period_end || '')}</div>
                    <div class="recon-history-card-grid">
                      <div><span>Bank CR</span><strong>${formatCurrency(h.bank_total_cr)}</strong></div>
                      <div><span>Bank DR</span><strong>${formatCurrency(h.bank_total_dr)}</strong></div>
                      <div><span>System CR</span><strong>${formatCurrency(h.system_total_cr)}</strong></div>
                      <div><span>System DR</span><strong>${formatCurrency(h.system_total_dr)}</strong></div>
                      <div><span>Difference</span><strong style="color: ${Math.abs(diff) >= 0.01 ? 'var(--danger)' : 'var(--text-primary)'}">${formatCurrency(diff)}</strong></div>
                      <div><span>Tx</span><strong>${h.transactionCount ?? 0}</strong></div>
                    </div>
                    <div class="recon-history-card-meta">
                      ${h.created_at ? `Sealed ${new Date(h.created_at).toLocaleDateString()}` : ''}${h.created_by ? ` · by ${escapeHtml(h.created_by)}` : ''}
                    </div>
                  </div>
                `
              }).join('')}
            </div>
            <p class="recon-history-hint">
              👆 Click any record to load its values into the reconciliation form for inspection. Admins can Unseal from there.
            </p>
          `
        )}
      </div>
    `

    bindEvents()
    renderCalendar()
  }

  function renderStatusBlock(ls, statStyle, displayStatus, readOnly, inspected) {
    const st = ls.lastCheck
    return `
      <div class="recon-status-block">
        <span class="recon-status-badge" style="
          background: ${statStyle.bg};
          color: ${statStyle.color};
          border: 1px solid ${statStyle.border};
        ">
          <span style="font-size: 1rem;">${statStyle.icon}</span> ${statStyle.text}
        </span>
        <p class="recon-status-msg">
          ${readOnly ? `
            Sealed ${inspected && inspected.created_at ? `<strong style="color: var(--text-primary);">${new Date(inspected.created_at).toLocaleString()}</strong>` : ''}
            by <strong style="color: var(--text-primary);">${escapeHtml(inspected && inspected.created_by || '')}</strong>.
            <br><span style="font-size: 0.8rem;">This is a read-only view. Associated remittances are locked from edits.</span>
          ` : (st ? (
            st.status === 'Balanced'
              ? '✅ <strong style="color: var(--success);">System records match bank statement</strong> within tolerance. You may now Seal.'
              : '⚠️ <strong style="color: var(--danger);">Differences detected</strong>. Use Investigate Difference to drill down into the individual items causing mismatch.'
          ) : 'ℹ️ Fill in the bank, date range and statement totals, then click <strong>Check Reconciliation</strong> to compare.')}
        </p>
      </div>
    `
  }

  const renderActions = (ls, st, readOnly) => `
    <div class="recon-actions">
      ${!readOnly && st && st.status === 'Balanced' && ls.canCreate ? `<button id="btn-lock" class="secondary-button" style="background: var(--text-primary); color: var(--bg-card);">🔒 Seal Reconciliation</button>` : ''}
      ${!readOnly && st && st.status === 'Discrepancy' ? `<button id="btn-drill" class="secondary-button">🕵 Investigate Difference</button>` : ''}
      ${readOnly && ls.isAdmin ? `<button id="btn-unseal" class="secondary-button" style="background: var(--danger); color: white; border: 1px solid var(--danger);">🔓 Unseal Reconciliation</button>` : ''}
    </div>
  `

  const renderCalendar = () => {
    const calEl = document.getElementById('recon-calendar')
    if (!calEl) return
    const ls = localState
    const [cy, cm] = ls.calendarMonth.split('-').map(Number)
    const firstDay = new Date(cy, cm - 1, 1)
    const lastDay = new Date(cy, cm, 0)
    const startDow = firstDay.getDay()
    const numDays = lastDay.getDate()

    const monthName = firstDay.toLocaleString('default', { month: 'long', year: 'numeric' })

    const selectedFrom = ls.from ? new Date(ls.from + 'T00:00:00') : null
    const selectedTo = ls.to ? new Date(ls.to + 'T23:59:59') : null

    const sealedRanges = (ls.history || [])
      .filter(s => !ls.bankName || s.bank_name === ls.bankName)
      .map(s => ({
        s: new Date(s.period_start + 'T00:00:00'),
        e: new Date(s.period_end + 'T23:59:59')
      }))

    const isReconciled = d => sealedRanges.some(r => d >= r.s && d <= r.e)
    const isSelected = d => selectedFrom && selectedTo && d >= selectedFrom && d <= selectedTo
    const dayEq = (d, ref) => ref && d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate()

    const rows = []
    let cells = []
    for (let i = 0; i < startDow; i++) cells.push('<td></td>')
    for (let d = 1; d <= numDays; d++) {
      const date = new Date(cy, cm - 1, d)
      const dateStr = `${cy}-${String(cm).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      const reconciled = isReconciled(date)
      const selected = isSelected(date)
      const fromMark = dayEq(date, selectedFrom)
      const toMark = dayEq(date, selectedTo)

      const styles = [
        'text-align: center',
        'border-radius: 8px',
        'cursor: pointer',
        'font-weight: 600',
        'user-select: none',
        '-webkit-tap-highlight-color: transparent',
        'transition: transform 0.1s ease'
      ]
      const cls = ['recon-cal-cell']
      let bg = 'transparent', color = 'var(--text-primary)', border = '1px solid transparent'

      if (reconciled) { bg = 'rgba(46, 160, 67, 0.15)'; color = 'var(--success)'; }
      if (selected) { bg = 'var(--text-primary)'; color = 'var(--bg-card)'; border = `2px solid var(--text-primary)`; }
      if (fromMark || toMark) { border = `2px solid var(--text-primary)`; if (!selected) { color = 'var(--text-primary)' } }

      styles.push(`background:${bg}`, `color:${color}`, `border:${border}`)

      cells.push(`<td class="${cls.join(' ')}" data-cal-date="${dateStr}" style="${styles.join(';')}">${d}</td>`)
      if (cells.length === 7) { rows.push(`<tr>${cells.join('')}</tr>`); cells = [] }
    }
    if (cells.length) { while (cells.length < 7) cells.push('<td></td>'); rows.push(`<tr>${cells.join('')}</tr>`) }

    calEl.innerHTML = `
      <div class="recon-cal-head">
        <button type="button" id="cal-prev" aria-label="Previous month">‹</button>
        <span class="recon-cal-month">${monthName}</span>
        <button type="button" id="cal-next" aria-label="Next month">›</button>
      </div>
      <table class="recon-cal-grid" role="grid" aria-label="Calendar date range picker">
        <thead>
          <tr>
            ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((n, i) => `<th scope="col">${n}</th>`).join('')}
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <div class="recon-cal-legend">
        <span class="recon-cal-legend-item">
          <span class="recon-cal-legend-swatch" style="background: rgba(46, 160, 67, 0.25);"></span>
          Reconciled
        </span>
        <span class="recon-cal-legend-item">
          <span class="recon-cal-legend-swatch" style="background: var(--text-primary);"></span>
          Selected
        </span>
        <span class="recon-cal-legend-item">
          <span class="recon-cal-legend-swatch" style="background: transparent; border: 2px solid var(--text-primary);"></span>
          Boundary
        </span>
      </div>
    `

    calEl.querySelector('#cal-prev').addEventListener('click', e => { e.preventDefault(); const d = new Date(cy, cm - 2, 1); ls.calendarMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; renderCalendar() })
    calEl.querySelector('#cal-next').addEventListener('click', e => { e.preventDefault(); const d = new Date(cy, cm, 1); ls.calendarMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; renderCalendar() })
    calEl.querySelectorAll('td[data-cal-date]').forEach(td => {
      td.addEventListener('click', () => {
        if (ls.inspectedSummaryId) return
        const ds = td.getAttribute('data-cal-date')
        if (ls.calendarSelecting === 'from') {
          ls.from = ds; ls.to = ds; ls.calendarSelecting = 'to'
        } else {
          const fromDate = new Date(ls.from + 'T00:00:00')
          const clickDate = new Date(ds + 'T00:00:00')
          if (clickDate < fromDate) { ls.from = ds; ls.to = ds; ls.calendarSelecting = 'to' }
          else { ls.to = ds; ls.calendarSelecting = 'from' }
        }
        saveDraft()
        render()
      })
    })
  }

  const saveDraft = () => {
    const ls = localState
    persistState(ls.DRAFT_KEY, { bankName: ls.bankName, from: ls.from, to: ls.to, bankCr: ls.bankCr, bankDr: ls.bankDr })
  }

  const clearDraft = () => clearPersisted(localState.DRAFT_KEY)

  const bindEvents = () => {
    const ls = localState
    document.getElementById('clear-recon-form-btn').addEventListener('click', () => {
      if (!confirm('Clear current reconciliation form and start a new one?')) return
      clearDraft()
      localState.bankName = (localState.banks[0] && localState.banks[0].bank_name) || ''
      localState.from = today
      localState.to = today
      localState.bankCr = ''
      localState.bankDr = ''
      localState.lastCheck = null
      localState.drillDownOpen = false
      localState.drillDownRows = []
      localState.inspectedSummaryId = null
      localState.inspectedSummary = null
      localState.calendarSelecting = 'from'
      render()
    })

    const bindInput = (id, key, parse) => {
      const el = document.getElementById(id)
      if (!el) return
      el.addEventListener('input', () => {
        localState[key] = parse ? parse(el.value) : el.value
        localState.lastCheck = null
        localState.drillDownOpen = false
        saveDraft()
      })
      el.addEventListener('change', async () => {
        if (id === 'recon-bank') { await refreshHistory(); renderCalendar() }
      })
    }
    bindInput('recon-bank', 'bankName')
    bindInput('recon-from', 'from')
    bindInput('recon-to', 'to')
    bindInput('bank-cr', 'bankCr', v => v)
    bindInput('bank-dr', 'bankDr', v => v)

    const wireBtn = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn) }
    wireBtn('btn-check', onCheck)
    wireBtn('btn-lock', onSeal)
    wireBtn('btn-drill', onDrill)
    wireBtn('btn-unseal', onUnseal)

    document.querySelectorAll('#recon-wrap [data-history-id]').forEach(el => {
      el.addEventListener('click', () => {
        const hid = el.getAttribute('data-history-id')
        const hit = localState.history.find(h => String(h.id) === String(hid))
        if (!hit) return
        localState.inspectedSummaryId = hid
        localState.inspectedSummary = hit
        localState.bankName = hit.bank_name || ''
        localState.from = hit.period_start || ''
        localState.to = hit.period_end || ''
        localState.bankCr = hit.bank_total_cr != null ? String(hit.bank_total_cr) : ''
        localState.bankDr = hit.bank_total_dr != null ? String(hit.bank_total_dr) : ''
        localState.lastCheck = {
          status: 'Balanced',
          diffCr: (hit.bank_total_cr || 0) - (hit.system_total_cr || 0),
          diffDr: (hit.bank_total_dr || 0) - (hit.system_total_dr || 0),
          systemCr: hit.system_total_cr || 0,
          systemDr: hit.system_total_dr || 0,
          transactionCount: hit.transactionCount || 0,
          relevantIds: [],
          checkHash: '',
          bankCr: hit.bank_total_cr || 0,
          bankDr: hit.bank_total_dr || 0,
          bankName: hit.bank_name,
          periodStart: hit.period_start,
          periodEnd: hit.period_end,
          cooperativeId: String(localState.coopId)
        }
        render()
      })
    })
  }

  const onCheck = async () => {
    const ls = localState
    if (!ls.bankName) return showToast('Select Bank Account', 'warning')
    if (!ls.from || !ls.to) return showToast('Enter From and To dates', 'warning')
    if (new Date(ls.from) > new Date(ls.to)) return showToast('From date must be before To date', 'warning')
    if (ls.bankCr === '' || ls.bankDr === '') return showToast('Enter statement CR and DR totals', 'warning')
    try {
      const btn = document.getElementById('btn-check')
      if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Verifying…' }
      const res = await checkReconciliation(ls.coopId, ls.bankName, ls.from, ls.to, ls.bankCr, ls.bankDr)
      ls.lastCheck = res
      ls.drillDownOpen = false
      ls.drillDownRows = []
      showToast(res.status === 'Balanced' ? 'Balanced — System and statement match' : 'Discrepancies detected — review', res.status === 'Balanced' ? 'success' : 'warning')
    } catch (e) {
      console.error(e)
      showToast('Error verifying reconciliation: ' + (e.message || String(e)), 'error')
    } finally {
      render()
    }
  }

  const onSeal = async () => {
    const ls = localState
    const st = ls.lastCheck
    if (!st || st.status !== 'Balanced') return showToast('Reconciliation must be balanced before sealing', 'warning')
    if (!ls.canCreate) return showToast('Insufficient permission to seal', 'warning')
    if (!confirm(`Seal reconciliation?\n\nBank: ${ls.bankName}\nPeriod: ${ls.from} → ${ls.to}\n\nAssociated records will be locked.`)) return
    try {
      const b = document.getElementById('btn-lock')
      if (b) { b.disabled = true; b.innerHTML = '⏳ Sealing…' }
      const id = await saveReconciliationSummary(st, ls.user.username)
      await refreshHistory()
      const sealed = ls.history.find(h => String(h.id) === String(id))
      if (sealed) {
        ls.inspectedSummaryId = id
        ls.inspectedSummary = sealed
        ls.bankName = sealed.bank_name || ''
        ls.from = sealed.period_start || ''
        ls.to = sealed.period_end || ''
        ls.bankCr = sealed.bank_total_cr != null ? String(sealed.bank_total_cr) : ''
        ls.bankDr = sealed.bank_total_dr != null ? String(sealed.bank_total_dr) : ''
        ls.lastCheck = {
          status: 'Balanced',
          diffCr: (sealed.bank_total_cr || 0) - (sealed.system_total_cr || 0),
          diffDr: (sealed.bank_total_dr || 0) - (sealed.system_total_dr || 0),
          systemCr: sealed.system_total_cr || 0, systemDr: sealed.system_total_dr || 0,
          transactionCount: sealed.transactionCount || 0, relevantIds: [], checkHash: '',
          bankCr: sealed.bank_total_cr || 0, bankDr: sealed.bank_total_dr || 0,
          bankName: sealed.bank_name, periodStart: sealed.period_start, periodEnd: sealed.period_end,
          cooperativeId: String(ls.coopId)
        }
      }
      clearDraft()
      showToast('🔒 Reconciliation sealed successfully', 'success')
    } catch (e) {
      console.error(e)
      showToast('Failed to seal: ' + (e.message || String(e)), 'error')
    } finally {
      render()
    }
  }

  const onDrill = async () => {
    const ls = localState
    if (!ls.bankName || !ls.from || !ls.to) return
    try {
      const b = document.getElementById('btn-drill')
      if (b) { b.disabled = true; b.innerHTML = '⏳ Loading…' }
      ls.drillDownRows = await getReconciliationDrillDown(ls.coopId, ls.bankName, ls.from, ls.to)
      ls.drillDownOpen = true
    } catch (e) {
      console.error(e)
      showToast('Failed to load drill-down', 'error')
    } finally {
      render()
    }
  }

  const onUnseal = async () => {
    const ls = localState
    if (!ls.isAdmin) return showToast('Only admins can unseal', 'warning')
    if (!ls.inspectedSummaryId) return
    if (!confirm('Unseal this reconciliation?\n\nAssociated records will be unlocked and editable.')) return
    try {
      const b = document.getElementById('btn-unseal')
      if (b) { b.disabled = true; b.innerHTML = '⏳ Unsealing…' }
      await unsealReconciliation(ls.inspectedSummaryId, ls.user.username)
      await refreshHistory()
      const wasFrom = ls.from, wasTo = ls.to, wasBank = ls.bankName
      ls.inspectedSummaryId = null
      ls.inspectedSummary = null
      ls.bankCr = ''
      ls.bankDr = ''
      ls.lastCheck = null
      ls.bankName = wasBank
      ls.from = wasFrom
      ls.to = wasTo
      showToast('🔓 Reconciliation unsealed', 'success')
    } catch (e) {
      console.error(e)
      showToast('Failed to unseal: ' + (e.message || String(e)), 'error')
    } finally {
      render()
    }
  }

  render()
}
