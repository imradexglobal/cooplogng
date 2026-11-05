/**
 * Experimental Loan Management — loan detail drawer.
 *
 * Read-only inspection of one loan: member, application, interest & charges,
 * disbursement, repayment history, schedule, guarantors, approval history and
 * the linked transaction references. Workflow buttons (approve / decline) are
 * rendered only when the caller passes the matching capabilities, and they
 * delegate back to the page so the existing services perform the write.
 */

import { openDrawer } from '../lib/ui.js'
import { escapeHtml, formatDate, formatCurrency, formatNumber } from '../lib/format.js'
import { buildSchedule } from '../lib/loanData.js'
import { progressHTML } from '../lib/charts.js'

function statusBadge(status) {
  const map = {
    Active: 'xp-badge-active',
    Approved: 'xp-badge-approved',
    Pending: 'xp-badge-pending',
    Declined: 'xp-badge-declined',
    Overdue: 'xp-badge-overdue',
    Completed: 'xp-badge-completed',
  }
  return `<span class="xp-badge ${map[status] || 'xp-badge-neutral'}">${escapeHtml(status)}</span>`
}

function kv(key, value, mono = false) {
  return `
    <div class="xp-kv-item">
      <div class="k">${escapeHtml(key)}</div>
      <div class="v${mono ? ' xp-mono' : ''}">${value || '—'}</div>
    </div>`
}

function scheduleStatusBadge(status) {
  const map = {
    Paid: 'xp-badge-approved',
    Partial: 'xp-badge-pending',
    Due: 'xp-badge-neutral',
    Overdue: 'xp-badge-overdue',
  }
  return `<span class="xp-badge ${map[status] || 'xp-badge-neutral'}">${escapeHtml(status)}</span>`
}

/**
 * @param {object} loan     normalized loan
 * @param {object} dataset  { remMap, entMap, memberMap }
 * @param {object} handlers { canApprove, canDecline, onApprove, onDecline,
 *                            onOpenLedger(ref) }
 */
export function openLoanDetail(loan, dataset, handlers = {}) {
  const member = dataset.memberMap[loan.memberId] || {}
  const rem = loan.rem || {}
  const schedule = buildSchedule(loan)
  const paidInstalments = schedule.filter((s) => s.status === 'Paid').length

  // ---- recorded charges (posted at origination) --------------------------
  const chargeLines = Object.values(dataset.remMap || {}).filter(
    (r) =>
      String(r.loan_id || '') === loan.id &&
      !r.is_deleted &&
      r.status === 'Approved' &&
      r.transaction_type === 'Loan Charges' &&
      Number(r.autogen) === 1
  )
  const chargeDebits = chargeLines.filter((r) => Number(r.amount) < 0)
  const chargePickups = chargeLines.filter((r) => Number(r.amount) > 0)

  const interestLines =
    loan.interestSource === 'recorded'
      ? chargeDebits.map((r) => ({
          name: String(r.description || 'Loan Charge').replace(/^Loan Charge:\s*/i, ''),
          value: Math.abs(Number(r.amount) || 0),
          rate: 'posted at origination',
        }))
      : loan.policyCharges.lines

  const interestSourceLabel =
    loan.interestSource === 'recorded'
      ? 'Posted charges linked to this loan'
      : loan.interestSource === 'policy'
      ? 'Estimated from the account’s configured rates (nothing posted yet)'
      : 'No interest configured for this account'

  // ---- disbursement -------------------------------------------------------
  const disbursementDetail = (rem.details || []).find(
    (d) => String(d.enterprise_id || d.item || '') === loan.accountId && Number(d.amount) < 0
  )

  // ---- approval history ---------------------------------------------------
  const history = []
  if (rem.created_at) {
    history.push({
      when: rem.created_at,
      who: rem.created_by || '—',
      what: 'Loan request submitted',
      result: 'Pending',
    })
  }
  if (loan.statusRaw === 'Declined') {
    history.push({
      when: rem.modified_at || loan.raw.modified_at || '',
      who: rem.modified_by || loan.raw.modified_by || '—',
      what: 'Request declined',
      result: 'Declined',
    })
  }
  if (loan.statusRaw !== 'Pending' && loan.statusRaw !== 'Declined') {
    history.push({
      when: loan.approvedAt || rem.approved_at || loan.issuedDate,
      who: loan.approvedBy || rem.approved_by || '—',
      what: 'Approved and disbursed',
      result: 'Active',
    })
  }

  const canApprove = !!handlers.canApprove && loan.statusRaw === 'Pending'
  const canDecline = !!handlers.canDecline && loan.statusRaw === 'Pending'

  const body = `
    <div class="xp-amount-hero">
      <div class="cell">
        <div class="k">Principal</div>
        <div class="v">${escapeHtml(formatCurrency(loan.principal))}</div>
      </div>
      <div class="cell">
        <div class="k">Interest &amp; charges</div>
        <div class="v">${escapeHtml(formatCurrency(loan.interest))}</div>
      </div>
      <div class="cell">
        <div class="k">Total payable</div>
        <div class="v">${escapeHtml(formatCurrency(loan.totalPayable))}</div>
      </div>
      <div class="cell">
        <div class="k">Repaid</div>
        <div class="v xp-is-credit">${escapeHtml(formatCurrency(loan.repaid))}</div>
      </div>
      <div class="cell">
        <div class="k">Outstanding</div>
        <div class="v ${loan.outstanding > 0 ? 'xp-is-debit' : ''}">${escapeHtml(
    formatCurrency(loan.outstanding)
  )}</div>
      </div>
    </div>

    <div class="xp-badge-row" style="margin-bottom:1rem">
      ${statusBadge(loan.statusDisplay)}
      ${
        loan.statusDisplay !== loan.statusRaw
          ? `<span class="xp-badge xp-badge-neutral">stored status: ${escapeHtml(
              loan.statusRaw
            )}</span>`
          : ''
      }
      <span class="xp-badge xp-badge-accent">${escapeHtml(loan.accountName || 'Loan account')}</span>
      ${
        loan.surplus > 0
          ? `<span class="xp-badge xp-badge-approved">Credit balance ${escapeHtml(
              formatCurrency(loan.surplus)
            )}</span>`
          : ''
      }
    </div>

    <div style="margin-bottom:1.2rem">
      <div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--xp-text-3);margin-bottom:.35rem">
        <span>Repayment progress</span>
        <span><strong>${escapeHtml(formatNumber(loan.progress.toFixed(1)))}%</strong> · ${escapeHtml(
    formatNumber(paidInstalments)
  )} of ${escapeHtml(formatNumber(schedule.length))} instalments settled</span>
      </div>
      ${progressHTML(loan.progress, loan.statusDisplay === 'Completed' ? 'complete' : loan.statusDisplay === 'Overdue' ? 'late' : '')}
    </div>

    <section class="xp-section">
      <h3>Member</h3>
      <div class="xp-kv">
        ${kv('Name', escapeHtml(loan.memberName))}
        ${kv('Registration no.', escapeHtml(loan.memberReg || '—'))}
        ${kv('Member ID', escapeHtml(loan.memberId), true)}
        ${kv('Mobile', escapeHtml(member.mobile || '—'))}
      </div>
    </section>

    <section class="xp-section">
      <h3>Application</h3>
      <div class="xp-kv">
        ${kv('Loan reference', escapeHtml(loan.ref), true)}
        ${kv('Loan type / account', escapeHtml(loan.accountName))}
        ${kv('Applied', escapeHtml(formatDate(loan.appliedDate)))}
        ${kv('Requested by', escapeHtml(rem.created_by || '—'))}
        ${kv('Duration', `${escapeHtml(formatNumber(loan.durationMonths))} months`)}
        ${kv(
          'Monthly instalment',
          loan.instalment ? escapeHtml(formatCurrency(loan.instalment)) : '—'
        )}
        ${kv('Notes', escapeHtml(loan.notes || '—'))}
      </div>
    </section>

    <section class="xp-section">
      <h3>Interest &amp; charges</h3>
      <table class="xp-mini-table">
        <thead>
          <tr><th>Charge</th><th>Basis</th><th class="xp-num">Amount</th></tr>
        </thead>
        <tbody>
          ${
            interestLines.length
              ? interestLines
                  .map(
                    (c) => `
              <tr>
                <td>${escapeHtml(c.name)}</td>
                <td>${escapeHtml(c.rate || '—')}</td>
                <td class="xp-num">${escapeHtml(formatCurrency(c.value))}</td>
              </tr>`
                  )
                  .join('')
              : `<tr><td colspan="3" style="color:var(--xp-text-3)">No interest or charges configured for this account.</td></tr>`
          }
          <tr>
            <td colspan="2"><strong>Total ${loan.interestSource === 'recorded' ? 'posted' : 'estimated'}</strong></td>
            <td class="xp-num"><strong>${escapeHtml(formatCurrency(loan.interest))}</strong></td>
          </tr>
        </tbody>
      </table>
      <div class="xp-note" style="margin-top:.6rem">
        ${escapeHtml(interestSourceLabel)}. Interest and fees are collected <strong>once at
        origination</strong> — the app does not accrue interest over the life of the loan, and the
        instalment schedule covers the principal only.
        ${
          chargePickups.length
            ? `<br/>Linked internal income pickup: <strong>${escapeHtml(
                formatCurrency(chargePickups.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0))
              )}</strong> posted to the cooperative’s Loan Income account.`
            : ''
        }
      </div>
    </section>

    <section class="xp-section">
      <h3>Disbursement</h3>
      <div class="xp-kv">
        ${kv('Disbursed on', escapeHtml(formatDate(loan.issuedDate)))}
        ${kv('Due (maturity)', escapeHtml(formatDate(loan.dueDate)))}
        ${kv('Bank / method', escapeHtml(rem.bank_name || '—'))}
        ${kv('Disbursement amount', loan.raw && disbursementDetail ? escapeHtml(formatCurrency(Math.abs(Number(disbursementDetail.amount) || 0))) : '—')}
        ${kv('Transaction reference', escapeHtml(loan.remittanceId || '—'), true)}
        ${kv('Entry description', escapeHtml(rem.description || '—'))}
      </div>
      ${
        loan.remittanceId
          ? `<button type="button" class="xp-btn xp-btn-sm" style="margin-top:.7rem"
 data-xp-open-ledger="${escapeHtml(loan.remittanceId)}">View in General Ledger</button>`
          : ''
      }
    </section>

    <section class="xp-section">
      <h3>Repayment history (${escapeHtml(formatNumber(loan.repayments.length))})</h3>
      ${
        loan.repayments.length
          ? `<table class="xp-mini-table">
              <thead>
                <tr><th>Date</th><th>Reference</th><th>Description</th><th class="xp-num">Amount</th></tr>
              </thead>
              <tbody>
                ${loan.repayments
                  .map(
                    (r) => `
                  <tr>
                    <td>${escapeHtml(formatDate(r.date))}</td>
                    <td><span class="xp-ref">${escapeHtml(r.shortRef)}</span></td>
                    <td>${escapeHtml(r.description || r.transactionType || 'Repayment')}</td>
                    <td class="xp-num xp-is-credit">${escapeHtml(formatCurrency(r.amount))}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
            <div class="xp-note" style="margin-top:.6rem">
              Repayments are positive entries on this member’s loan account inside the period this
              loan was outstanding. Total recorded: <strong>${escapeHtml(
                formatCurrency(loan.repaymentTotal)
              )}</strong>.
            </div>`
          : `<div class="xp-note">No repayments recorded against this loan yet.</div>`
      }
    </section>

    <section class="xp-section">
      <h3>Repayment schedule (${escapeHtml(formatNumber(schedule.length))} instalments)</h3>
      ${
        schedule.length
          ? `<table class="xp-mini-table">
              <thead>
                <tr>
                  <th>#</th><th>Due date</th><th class="xp-num">Instalment</th>
                  <th class="xp-num">Cumulative</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${schedule
                  .map(
                    (s) => `
                  <tr${s.status === 'Overdue' ? ' class="xp-row-muted"' : ''}>
                    <td>${s.n}</td>
                    <td>${escapeHtml(formatDate(s.dueDate))}</td>
                    <td class="xp-num">${escapeHtml(formatCurrency(s.amount))}</td>
                    <td class="xp-num">${escapeHtml(formatCurrency(s.cumulative))}</td>
                    <td>${scheduleStatusBadge(s.status)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
            <div class="xp-note" style="margin-top:.6rem">
              Schedule derived with the existing rule — <strong>principal ÷ duration</strong>, one
              instalment per month from the disbursement date. It is a view only; no records are
              written.
            </div>`
          : `<div class="xp-note">No schedule: this loan has no duration or principal recorded.</div>`
      }
    </section>

    <section class="xp-section">
      <h3>Guarantors (${escapeHtml(formatNumber(loan.guarantors.length))})</h3>
      ${
        loan.guarantors.length
          ? `<table class="xp-mini-table">
              <thead>
                <tr><th>Guarantor</th><th class="xp-num">Guarantee</th><th>Decision</th></tr>
              </thead>
              <tbody>
                ${loan.guarantors
                  .map(
                    (g) => `
                  <tr>
                    <td>${escapeHtml(g.memberName)}</td>
                    <td class="xp-num">${escapeHtml(formatCurrency(g.amount))}</td>
                    <td>${statusBadge(
                      g.approvalState === 'approved'
                        ? 'Approved'
                        : g.approvalState === 'rejected'
                        ? 'Declined'
                        : 'Pending'
                    )}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<div class="xp-note">No guarantors recorded for this loan.</div>`
      }
    </section>

    <section class="xp-section">
      <h3>Approval history</h3>
      <table class="xp-mini-table">
        <thead>
          <tr><th>When</th><th>Who</th><th>Event</th><th>Result</th></tr>
        </thead>
        <tbody>
          ${
            history.length
              ? history
                  .map(
                    (h) => `
              <tr>
                <td>${escapeHtml(formatDate(h.when) || '—')}</td>
                <td>${escapeHtml(h.who)}</td>
                <td>${escapeHtml(h.what)}</td>
                <td>${statusBadge(h.result)}</td>
              </tr>`
                  )
                  .join('')
              : `<tr><td colspan="4" style="color:var(--xp-text-3)">No audit events recorded.</td></tr>`
          }
        </tbody>
      </table>
    </section>

    <section class="xp-section">
      <h3>Linked records</h3>
      <div class="xp-kv">
        ${kv('Loan ID', escapeHtml(loan.ref), true)}
        ${kv('Remittance ID', escapeHtml(loan.remittanceId || '—'), true)}
        ${kv('Current status', escapeHtml(loan.statusRaw))}
        ${kv('Last modified', escapeHtml(formatDate(loan.raw.modified_at)))}
      </div>
    </section>

    ${
      loan.statusRaw === 'Pending'
        ? `<div class="xp-note">
             This application is still <strong>pending</strong>. Approving runs the existing
             approval service: it posts the disbursement, creates the linked charge entries and
             the monthly payment advice — exactly once.
           </div>`
        : ''
    }
  `

  const footer = `
    ${
      canDecline
        ? `<button type="button" class="xp-btn xp-btn-danger" data-xp-decline>Decline</button>`
        : ''
    }
    ${
      canApprove
        ? `<button type="button" class="xp-btn xp-btn-primary" data-xp-approve>Approve &amp; disburse</button>`
        : ''
    }
    ${
      !canApprove && !canDecline
        ? `<button type="button" class="xp-btn" data-xp-close>Close</button>`
        : ''
    }`

  const drawer = openDrawer({
    title: loan.accountName || 'Loan',
    sub: `<span class="xp-ref">${escapeHtml(loan.shortRef)}</span> &nbsp;·&nbsp; ${escapeHtml(
      loan.memberName
    )} &nbsp;·&nbsp; ${escapeHtml(formatCurrency(loan.principal))}`,
    body,
    footer,
    onMount(root) {
      root.querySelector('[data-xp-open-ledger]')?.addEventListener('click', (e) => {
        const ref = e.currentTarget.getAttribute('data-xp-open-ledger')
        drawer.close()
        if (typeof handlers.onOpenLedger === 'function') handlers.onOpenLedger(ref)
      })
      root.querySelector('[data-xp-approve]')?.addEventListener('click', () => {
        drawer.close()
        if (typeof handlers.onApprove === 'function') handlers.onApprove(loan)
      })
      root.querySelector('[data-xp-decline]')?.addEventListener('click', () => {
        drawer.close()
        if (typeof handlers.onDecline === 'function') handlers.onDecline(loan)
      })
    },
  })

  return drawer
}
