/**
 * Experimental Ledger — transaction detail drawer.
 *
 * Read-only inspection view: shows the parent remittance, the specific
 * account line, sibling lines of the same entry and the traceability fields
 * (reference, parent, loan link, reversal tag, approval stamps).
 */

import { openDrawer, toast } from '../lib/ui.js'
import { escapeHtml, formatDate, formatCurrency, shortRef } from '../lib/format.js'

function badge(status) {
  const cls =
    status === 'Approved'
      ? 'xp-badge-approved'
      : status === 'Pending'
      ? 'xp-badge-pending'
      : 'xp-badge-declined'
  return `<span class="xp-badge ${cls}">${escapeHtml(status)}</span>`
}

function kv(key, value, mono = false) {
  return `
    <div class="xp-kv-item">
      <div class="k">${escapeHtml(key)}</div>
      <div class="v${mono ? ' xp-mono' : ''}">${value || '—'}</div>
    </div>`
}

/**
 * @param {object} row      ledger row
 * @param {object} dataset  { rows, memberMap, entMap }
 * @param {{onOpenLoan?:(loanId:string)=>void}} [handlers]
 */
export function openLedgerDetail(row, dataset, handlers = {}) {
  const rem = row.rem || {}
  const siblings = (dataset.rows || []).filter((r) => r.remittanceId === row.remittanceId)

  const detail = (rem.details || []).find((d) => String(d.id) === String(row.detailId))
  const loanInfo = detail && detail.loan_info ? detail.loan_info : null
  const loanData = loanInfo ? loanInfo.loanData || {} : null
  const member = dataset.memberMap ? dataset.memberMap[String(row.memberId)] : null
  const memberReg = member ? member.registration_no || member.mobile || '' : ''

  const flags = [
    row.isReversal ? `<span class="xp-badge xp-badge-reversal">Reversal entry</span>` : '',
    row.isAutogen ? `<span class="xp-badge xp-badge-autogen">Automatic</span>` : '',
    row.isLoanRequest ? `<span class="xp-badge xp-badge-accent">Loan request</span>` : '',
    row.isWithdrawalRequest ? `<span class="xp-badge xp-badge-neutral">Withdrawal request</span>` : '',
    !row.hasDetail ? `<span class="xp-badge xp-badge-neutral">Header-only entry</span>` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const body = `
    <div class="xp-amount-hero">
      <div class="cell">
        <div class="k">Credit</div>
        <div class="v xp-is-credit">${row.credit ? escapeHtml(formatCurrency(row.credit)) : '—'}</div>
      </div>
      <div class="cell">
        <div class="k">Debit</div>
        <div class="v xp-is-debit">${row.debit ? escapeHtml(formatCurrency(row.debit)) : '—'}</div>
      </div>
      <div class="cell">
        <div class="k">Balance after entry</div>
        <div class="v">${escapeHtml(formatCurrency(row.balance))}</div>
      </div>
      <div class="cell">
        <div class="k">Posting</div>
        <div class="v" style="font-size:.95rem">${row.posted ? 'Posted' : 'Not posted'}</div>
      </div>
    </div>

    <div class="xp-badge-row" style="margin-bottom:1.1rem">
      ${badge(row.status)}
      ${flags}
    </div>

    <section class="xp-section">
      <h3>Entry</h3>
      <div class="xp-kv">
        ${kv('Transaction date', escapeHtml(formatDate(row.date)))}
        ${kv('Reference', escapeHtml(row.ref), true)}
        ${kv('Short reference', escapeHtml(shortRef(row.ref)), true)}
        ${kv('Transaction type', escapeHtml(row.transactionType || '—'))}
        ${kv('Category', escapeHtml(row.category || '—'))}
        ${kv('Bank / method', escapeHtml(row.bankName || '—'))}
        ${kv('Account', escapeHtml(row.accountName))}
        ${kv('Account type', escapeHtml(row.accountType || '—'))}
        ${kv('Member', escapeHtml(row.memberName))}
        ${kv('Member ID / reg.', escapeHtml(memberReg || row.memberId || '—'), true)}
        ${kv('Description', escapeHtml(row.displayDescription || '—'))}
        ${kv('Recorded', escapeHtml(formatDate(row.createdAt) || '—'))}
        ${kv('Created by', escapeHtml(row.createdBy || '—'))}
        ${kv(
          'Approved',
          row.approvedBy
            ? `${escapeHtml(row.approvedBy)}${row.approvedAt ? ` · ${escapeHtml(formatDate(row.approvedAt))}` : ''}`
            : '—'
        )}
      </div>
    </section>

    ${
      row.isReversal
        ? `<section class="xp-section">
             <h3>Reversal trace</h3>
             <div class="xp-note">
               This entry reverses an earlier one. The existing application records reversals as a
               <strong>new approved entry</strong> whose description begins with
               <strong>REVERSAL:</strong> — both the original and the reversal post to the ledger and
               net out to zero.
             </div>
           </section>`
        : ''
    }

    ${
      siblings.length > 1
        ? `<section class="xp-section">
             <h3>All lines of this entry (${siblings.length})</h3>
             <table class="xp-mini-table">
               <thead>
                 <tr><th>Account</th><th>Member</th><th class="xp-num">Credit</th><th class="xp-num">Debit</th></tr>
               </thead>
               <tbody>
                 ${siblings
                   .map(
                     (s) => `
                   <tr${s.uid === row.uid ? ' style="background:var(--xp-accent-soft)"' : ''}>
                     <td>${escapeHtml(s.accountName)}</td>
                     <td>${escapeHtml(s.memberName)}</td>
                     <td class="xp-num xp-is-credit">${s.credit ? escapeHtml(formatCurrency(s.credit)) : '—'}</td>
                     <td class="xp-num xp-is-debit">${s.debit ? escapeHtml(formatCurrency(s.debit)) : '—'}</td>
                   </tr>`
                   )
                   .join('')}
               </tbody>
             </table>
           </section>`
        : ''
    }

    ${
      loanData
        ? `<section class="xp-section">
             <h3>Loan request attached</h3>
             <div class="xp-kv">
               ${kv('Principal', escapeHtml(formatCurrency(loanData.principalAmount || 0)))}
               ${kv('Duration', `${escapeHtml(String(loanData.durationMonths || 0))} months`)}
               ${kv('Requested on', escapeHtml(formatDate(loanData.issueDate || row.date)))}
               ${kv('Request status', escapeHtml(loanData.status || '—'))}
               ${kv('Loan ID', escapeHtml(row.loanId || loanInfo.id || '—'), true)}
               ${kv(
                 'Guarantors',
                 (loanInfo.guarantors || []).length
                   ? loanInfo.guarantors
                       .map((g) => escapeHtml(g.name || g.member_id || 'Unknown'))
                       .join(', ')
                   : 'None'
               )}
             </div>
           </section>`
        : ''
    }

    <section class="xp-section">
      <h3>Traceability</h3>
      <div class="xp-kv">
        ${kv('Remittance ID', escapeHtml(row.remittanceId), true)}
        ${kv('Detail line ID', escapeHtml(row.detailId), true)}
        ${kv('Parent entry', escapeHtml(row.parentId || '—'), true)}
        ${kv('Linked loan', escapeHtml(row.loanId || '—'), true)}
      </div>
    </section>

    ${
      row.posted
        ? ''
        : `<div class="xp-note">
             <strong>${escapeHtml(row.status)}</strong> entries are shown for review only. Following the
             existing accounting rules, they do <strong>not</strong> affect the opening / closing balance,
             the credit or debit totals.
           </div>`
    }`

  const footer = `
    <button type="button" class="xp-btn" data-xp-copy="${escapeHtml(row.ref)}">Copy reference</button>
    ${
      row.loanId || row.isLoanRequest
        ? `<button type="button" class="xp-btn xp-btn-primary" data-xp-open-loan="${escapeHtml(
            row.loanId || ''
          )}">Open in Loan Management</button>`
        : ''
    }`

  const drawer = openDrawer({
    title: row.transactionType || 'Transaction',
    sub: `<span class="xp-ref">${escapeHtml(row.shortRef)}</span> &nbsp;·&nbsp; ${escapeHtml(
      formatDate(row.date)
    )} &nbsp;·&nbsp; ${escapeHtml(row.accountName)}`,
    body,
    footer,
    onMount(root) {
      root.querySelector('[data-xp-copy]')?.addEventListener('click', async (e) => {
        const value = e.currentTarget.getAttribute('data-xp-copy')
        try {
          await navigator.clipboard.writeText(value)
          toast('Reference copied to clipboard', 'success')
        } catch {
          toast(`Reference: ${value}`, 'info')
        }
      })
      root.querySelector('[data-xp-open-loan]')?.addEventListener('click', (e) => {
        const loanId = e.currentTarget.getAttribute('data-xp-open-loan')
        drawer.close()
        if (typeof handlers.onOpenLoan === 'function') handlers.onOpenLoan(loanId)
      })
    },
  })

  return drawer
}
