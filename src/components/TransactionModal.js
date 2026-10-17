import { state } from '../state/appState.js'
import { escapeHtml, escapeAttribute, formatCurrency, formatDate, wrapDateInput, shortRef } from '../utils/formatters.js'
import { showToast } from '../services/toastService.js'
import { hasPermission } from '../services/permissionService.js'

window.showTransactionModal = async (remittance) => {
  const overlay = document.getElementById('modal-overlay')
  const title = document.getElementById('modal-title')
  const body = document.getElementById('modal-body')

  if (!overlay || !body) return

  // Clear previous content
  body.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-muted);">Loading details...</div>'
  overlay.classList.add('open')
  document.body.style.overflow = 'hidden'

  try {
    // Use static imports already available at the top or via dataService
    const { fetchEnterprises, fetchAllMembers } = await import('../services/dataService.js')
    const fmt = await import('../utils/formatters.js')

    // Fetch all members (full list) to ensure guarantor names can be resolved even for non-admins
    const allMembers = await fetchAllMembers(state.welcomeUser.cooperativeId, state.welcomeUser.username, true)

    title.innerText = `#${shortRef(remittance.id)} — ${fmt.formatDate(remittance.remittance_date)}`
    const enterprisesArray = await fetchEnterprises(state.welcomeUser.cooperativeId, true)
    const enterpriseNames = {}
    enterprisesArray.forEach(e => { enterpriseNames[e.id] = e.account_name })

    // Resolve member / recipient display names from the already-fetched list.
    const memberNameOf = (m) => {
      if (!m) return ''
      const full = [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ').trim()
      return m.name || full || m.username || m.mobile || m.id || ''
    }
    const memberId = remittance.member_id && remittance.member_id !== '0000000000' ? remittance.member_id : ''
    const memberObj = memberId ? allMembers.find(m => m.id === memberId) : null
    const recipientObj = remittance.recipient_id ? allMembers.find(m => m.id === remittance.recipient_id) : null
    const recipientLabel = remittance.recipient_id ? (memberNameOf(recipientObj) || remittance.recipient_id) : ''
    
    const details = remittance.details || []

    let balanceBefore = 0;
    let balanceAfter = 0;
    let entName = 'Savings Account';
    const detail = details[0] || {};
    const targetEntId = detail.enterprise_id || detail.item;
    const targetEnt = targetEntId ? enterprisesArray.find(e => e.id === targetEntId) : null;
    
    const isSavingsRequest = remittance.transaction_type === 'Savings Withdrawal' || 
                             remittance.isWithdrawalRequest === true ||
                             (targetEnt && (targetEnt.account_type || '').toLowerCase() === 'savings');

    if (isSavingsRequest && remittance.member_id) {
      const { buildAccountBalance } = await import('../services/dataService.js');
      const limitKey = remittance && remittance.created_at ? { ts: remittance.created_at, id: remittance.id } : null;
      const { accountBalance } = await buildAccountBalance(state.welcomeUser.cooperativeId, { memberId: remittance.member_id }, limitKey);
      const balObj = accountBalance.find(b => b.id === targetEntId);
      balanceBefore = balObj ? parseFloat(balObj.sum_of_amount || 0) : 0;
      balanceAfter = balanceBefore - Math.abs(parseFloat(remittance.amount || detail.amount || 0));
      entName = targetEnt ? targetEnt.account_name : (detail.notes || detail.auto_description || 'Savings Account');
    }

    let html = `
            <div style="margin-bottom: 1.5rem; padding: 1.25rem; background: linear-gradient(135deg, var(--bg-main) 0%, var(--bg-secondary) 100%); border-radius: 1rem; border: 1px solid var(--border-medium);">
                <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Bank / Method</div>
                <div style="font-size: 1.125rem; font-weight: 700; color: var(--text-primary); margin-top: 0.25rem;">${escapeHtml(remittance.bank_name || 'Direct Deposit')}</div>
                <div style="display: flex; justify-content: space-between; margin-top: 1.25rem; align-items: flex-end;">
                    <div>
                         <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Total Amount</div>
                         <div style="font-size: 1.75rem; font-weight: 800; color: ${remittance.amount < 0 ? 'var(--danger)' : 'var(--accent-primary)'}; line-height: 1;">${fmt.formatCurrency(remittance.amount)}</div>
                    </div>
                     <span class="status-badge status-${escapeHtml(remittance.status)}">${escapeHtml(remittance.status)}</span>
                </div>
            </div>
        `

    // ── Member + transaction info (only rows with data) ──
    const infoRows = []
    if (memberObj || memberId) {
      const sub = memberObj
        ? [memberObj.registration_no || memberObj.special_id, memberObj.mobile].filter(Boolean).join(' • ')
        : ''
      infoRows.push({
        label: 'Member',
        value: `<div style="font-weight: 600;">${escapeHtml(memberNameOf(memberObj) || memberId)}</div>` +
          (sub ? `<div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(sub)}</div>` : '')
      })
    }
    if (remittance.transaction_type) infoRows.push({ label: 'Type', value: escapeHtml(remittance.transaction_type) })
    if (remittance.category) infoRows.push({ label: 'Category', value: escapeHtml(remittance.category) })
    if (remittance.description) infoRows.push({ label: 'Description', value: escapeHtml(remittance.description) })
    if (remittance.cheque_number) infoRows.push({ label: 'Cheque No', value: escapeHtml(remittance.cheque_number) })
    if (recipientLabel) infoRows.push({ label: 'Recipient', value: escapeHtml(recipientLabel) })
    if (remittance.created_by || remittance.created_at) {
      infoRows.push({
        label: 'Recorded',
        value: escapeHtml([remittance.created_by, remittance.created_at ? fmt.formatDate(remittance.created_at) : ''].filter(Boolean).join(' • '))
      })
    }
    if (remittance.modified_at && remittance.modified_at !== remittance.created_at) {
      infoRows.push({
        label: remittance.status === 'Declined' ? 'Declined' : 'Last update',
        value: escapeHtml([remittance.modified_by, remittance.modified_at ? fmt.formatDate(remittance.modified_at) : ''].filter(Boolean).join(' • '))
      })
    }
    if (remittance.approved_by || remittance.approved_at) {
      infoRows.push({
        label: 'Approved',
        value: escapeHtml([remittance.approved_by, remittance.approved_at ? fmt.formatDate(remittance.approved_at) : ''].filter(Boolean).join(' • '))
      })
    }
    if (infoRows.length > 0) {
      html += `
        <div style="margin-bottom: 1.5rem; padding: 1rem 1.1rem; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 0.75rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem 1rem;">
          ${infoRows.map(r => `
            <div>
              <div style="font-size: 0.7rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">${escapeHtml(r.label)}</div>
              <div style="font-size: 0.88rem; color: var(--text-primary); margin-top: 0.15rem;">${r.value}</div>
            </div>`).join('')}
        </div>
      `
    }

    if (isSavingsRequest) {
      html += `
        <div style="margin-bottom: 1.5rem; padding: 1rem; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 0.75rem;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; font-size: 0.85rem;">
            <div>
              <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Enterprise</span>
              <div style="font-weight: 600; color: var(--text-primary); margin-top: 0.15rem;">${escapeHtml(entName)}</div>
            </div>
            <div>
              <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Withdrawal Amount</span>
              <div style="font-weight: 700; color: var(--danger); margin-top: 0.15rem;">-${fmt.formatCurrency(Math.abs(remittance.amount))}</div>
            </div>
            <div>
              <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Balance Before</span>
              <div style="font-weight: 600; color: var(--text-primary); margin-top: 0.15rem;">${fmt.formatCurrency(balanceBefore)}</div>
            </div>
            <div>
              <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Balance After</span>
              <div style="font-weight: 700; color: ${balanceAfter < 0 ? 'var(--danger)' : 'var(--success)'}; margin-top: 0.15rem;">${fmt.formatCurrency(balanceAfter)}</div>
            </div>
          </div>
        </div>
      `;
    }

    html += `
            <div style="font-weight: 700; font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.75rem; letter-spacing: 0.05em; padding-left: 0.25rem;">BREAKDOWN</div>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
        `

    if (details.length === 0) {
      html += `<p style="color: #94a3b8; font-style: italic; text-align: center; padding: 1rem;">No specific item breakdown found.</p>`
    } else {
      details.forEach(d => {
        const name = enterpriseNames[d.enterprise_id] || d.enterprise_name || d.item || 'General Contribution'
        const amt = parseFloat(d.amount || 0)
        const lineNote = d.notes || d.auto_description || ''
        html += `
                <div class="detail-row" style="background: var(--bg-card); padding: 1rem; border-radius: 0.85rem; border: 1px solid var(--border-light); transition: all 0.2s; display: flex; flex-direction: column; gap: 0.35rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem;">
                      <span class="detail-name" style="font-weight: 600; color: var(--text-secondary);">${escapeHtml(name)}</span>
                      <span class="detail-amount ${amt < 0 ? 'text-red' : 'text-green'}" style="font-weight: 700; font-size: 1.05rem;">${fmt.formatCurrency(amt)}</span>
                    </div>
                    ${lineNote ? `<div style="font-size: 0.78rem; color: var(--text-muted); line-height: 1.5;">${escapeHtml(lineNote)}</div>` : ''}
                </div>
            `
      })
    }

    // --- Render Loan Section (Nested Data) ---
    const loans = remittance.loans || []
    if (loans.length > 0) {
      html += `
                <div style="margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px dashed var(--border-medium);">
                    <div style="font-weight: 700; font-size: 0.875rem; color: var(--text-muted); margin-bottom: 0.75rem; letter-spacing: 0.05em; text-transform: uppercase;">Loan Details</div>
                    ${loans.map(loan => {
        const guarantors = loan.guarantors || []
        return `
                            <div style="background: var(--accent-soft); padding: 1.25rem; border-radius: 1rem; border: 1px solid var(--border-light); margin-bottom: 1rem;">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                                    <div>
                                        <div style="font-size: 0.7rem; color: var(--accent-primary); font-weight: 700; text-transform: uppercase;">Principal</div>
                                        <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">${fmt.formatCurrency(loan.principal_amount || loan.principalAmount)}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 0.7rem; color: var(--accent-primary); font-weight: 700; text-transform: uppercase;">Duration</div>
                                        <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-primary);">${loan.duration_months || loan.durationMonths || 0} Months</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 0.7rem; color: var(--accent-primary); font-weight: 700; text-transform: uppercase;">Issue Date</div>
                                        <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary);">${fmt.formatDate(loan.issued_date || loan.issueDate)}</div>
                                    </div>
                                    <div>
                                        <div style="font-size: 0.7rem; color: var(--accent-primary); font-weight: 700; text-transform: uppercase;">Due Date</div>
                                        <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary);">${fmt.formatDate(loan.due_date || loan.dueDate)}</div>
                                    </div>
                                </div>
                                
                                ${loan.notes ? `
                                    <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border-light);">
                                        <div style="font-size: 0.7rem; color: var(--accent-primary); font-weight: 700; text-transform: uppercase;">Notes</div>
                                        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem;">${escapeHtml(loan.notes)}</div>
                                    </div>
                                ` : ''}

                                ${guarantors.length > 0 ? `
                                    <div style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border-light);">
                                        <div style="font-size: 0.7rem; color: var(--accent-primary); font-weight: 700; text-transform: uppercase; margin-bottom: 0.5rem;">Guarantors</div>
                                        <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                                            ${guarantors.map(g => {
          const gMember = allMembers.find(m => m.id === g.member_id)
          return `
                                                    <div style="display: flex; justify-content: space-between; font-size: 0.8rem; background: var(--bg-main); padding: 0.4rem 0.6rem; border-radius: 0.4rem; align-items: center;">
                                                         <div>
                                                            <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(gMember?.name || 'Unknown')}</div>
                                                            <div style="font-size: 0.7rem; color: ${g.guarantor_approval === 1 ? 'var(--success)' : 'var(--danger)'}; font-weight: 700;">
                                                              ${g.guarantor_approval === 1 ? 'Approved' : 'Pending Approval'}
                                                            </div>
                                                         </div>
                                                         <span style="font-weight: 700; color: var(--text-primary);">${fmt.formatCurrency(g.guarantee_amount || g.amount || 0)}</span>
                                                     </div>
                                                 `
        }).join('')}
                                         </div>
                                     </div>
                                 ` : ''}
                             </div>
                          `
      }).join('')}
                </div>
            `
    }

    // --- Approval Section ---
    const isActualAdmin = hasPermission(state.welcomeUser.permissions, 'admin') 
        || state.welcomeUser.username.toLowerCase() === 'admin' 
        || state.welcomeUser.username.toLowerCase() === state.welcomeUser.coopShortName?.toLowerCase();
    if (isActualAdmin && remittance.status === 'Pending') {
      const allGuarantorsApproved = (remittance.details || []).every(d => {
        if (!d.loan_info || !d.loan_info.guarantors) return true;
        return d.loan_info.guarantors.every(g => g.guarantor_approval === 1);
      });

      const hasBank = !!remittance.bank_name && remittance.bank_name !== '0' && remittance.bank_name !== '';
      const canApprove = isSavingsRequest ? true : (allGuarantorsApproved && hasBank);

      const { fetchBanks } = await import('../services/dataService.js');
      const banks = await fetchBanks(state.welcomeUser.cooperativeId);

      html += `
        <div style="margin-top: 2rem; padding: 1.5rem; background: var(--bg-main); border: 2px solid var(--border-medium); border-radius: 1rem;">
          <h4 style="margin: 0 0 1rem 0; color: var(--text-primary);">Approval Workflow</h4>
          
          ${isSavingsRequest ? `
            <div class="field" style="margin-bottom: 1rem;">
              <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Disbursement Date *</span>
              <input type="date" id="approval-date-input" value="${new Date().toISOString().split('T')[0]}" style="width: 100%; margin-top: 0.5rem; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary);" required />
            </div>
            <div class="field" style="margin-bottom: 1rem;">
              <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Select Bank for Disbursement *</span>
              <select id="approval-bank-select" style="width: 100%; margin-top: 0.5rem; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary);" required>
                <option value="">-- Choose Bank --</option>
                ${banks.map(b => `<option value="${escapeAttribute(b.bank_name)}" ${remittance.bank_name === b.bank_name ? 'selected' : ''}>${escapeHtml(b.bank_name)}</option>`).join('')}
              </select>
            </div>
          ` : `
            ${!hasBank ? `
              <div class="field" style="margin-bottom: 1rem;">
                <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Select Bank for Disbursement</span>
                <select id="approval-bank-select" style="width: 100%; margin-top: 0.5rem; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary);">
                  <option value="">-- Choose Bank --</option>
                  ${banks.map(b => `<option value="${escapeAttribute(b.bank_name)}">${escapeHtml(b.bank_name)}</option>`).join('')}
                </select>
              </div>
            ` : ''}
          `}

          ${!isSavingsRequest ? `
            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
              <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem;">
                <span style="color: ${allGuarantorsApproved ? '#16a34a' : '#ef4444'}; font-weight: 700;">${allGuarantorsApproved ? '✓' : '✗'}</span>
                <span>All Guarantors Approved</span>
              </div>
              <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem;">
                <span style="color: ${hasBank ? '#16a34a' : '#ef4444'}; font-weight: 700;">${hasBank ? '✓' : '✗'}</span>
                <span>Bank Selected</span>
              </div>
            </div>
          ` : ''}

          <div style="display: flex; gap: 0.75rem; margin-top: 1.5rem;">
            <button id="approve-transaction-btn" class="primary-button" ${!canApprove ? 'disabled' : ''} style="flex: 1; height: 3.5rem; font-size: 1.1rem;">
              Approve &amp; Disburse
            </button>
            <button id="decline-transaction-btn-modal" class="secondary-button" style="flex: 0 0 auto; height: 3.5rem; font-size: 1rem; background: var(--danger-bg, #fee2e2); color: var(--danger, #dc2626); border: 1px solid var(--danger, #dc2626);">
              Decline
            </button>
          </div>
          ${(!isSavingsRequest && !canApprove) ? `<p style="font-size: 0.75rem; color: #ef4444; text-align: center; margin-top: 0.5rem;">Please ensure all conditions are met before approval.</p>` : ''}
        </div>
      `;
    }

    html += `</div>`
    body.innerHTML = html
    body.querySelectorAll('input[type="date"]').forEach(wrapDateInput);

    // Attach Approval Listeners
    if (isActualAdmin && remittance.status === 'Pending') {
      const approveBtn = body.querySelector('#approve-transaction-btn');
      const bankSelect = body.querySelector('#approval-bank-select');

      bankSelect?.addEventListener('change', async (e) => {
        if (isSavingsRequest) return;
        const newBank = e.target.value;
        if (newBank) {
          // Re-render modal with new bank (locally for now, we'll save on approve)
          const updatedRemittance = { ...remittance, bank_name: newBank };
          window.showTransactionModal(updatedRemittance);
        }
      });

      approveBtn?.addEventListener('click', async () => {
        try {
          // Determine bank name and date
          const bankSelectEl = body.querySelector('#approval-bank-select');
          const dateInputEl = body.querySelector('#approval-date-input');

          const resolvedBankName = (bankSelectEl && bankSelectEl.value) ? bankSelectEl.value : remittance.bank_name;
          const resolvedDate = (dateInputEl && dateInputEl.value) ? dateInputEl.value : remittance.remittance_date;

          if (isSavingsRequest) {
            if (!resolvedBankName) {
              showToast('Please select a bank for disbursement.', 'warning');
              return;
            }
            if (!resolvedDate) {
              showToast('Please select an approval date.', 'warning');
              return;
            }
          }

          approveBtn.disabled = true;
          approveBtn.innerText = 'Processing...';

          const { approveRemittance } = await import('../services/dataService.js');
          await approveRemittance(remittance.id, state.welcomeUser.username, resolvedBankName, resolvedDate);
          showToast('Transaction approved and disbursed successfully!', 'success');
          overlay.classList.remove('open');
          document.body.style.overflow = '';

          // Refresh list if we are on Remittance History
          window.dispatchEvent(new CustomEvent('remittance-saved'));
        } catch (err) {
          showToast('Approval failed: ' + err.message, 'error');
          approveBtn.disabled = false;
          approveBtn.innerText = 'Approve & Disburse';
        }
      });

      // --- Decline button (modal) ---
      const declineBtnModal = body.querySelector('#decline-transaction-btn-modal');
      declineBtnModal?.addEventListener('click', async () => {
        const reason = prompt('Enter decline reason (optional):');
        if (reason === null) return; // cancelled
        if (!confirm('Are you sure you want to decline this remittance? This cannot be undone.')) return;
        try {
          declineBtnModal.disabled = true;
          declineBtnModal.innerText = 'Declining...';
          const { declineRemittance } = await import('../services/dataService.js');
          await declineRemittance(remittance.id, state.welcomeUser.username, reason.trim());
          showToast('Remittance declined.', 'info');
          overlay.classList.remove('open');
          document.body.style.overflow = '';
          window.dispatchEvent(new CustomEvent('remittance-saved'));
        } catch (err) {
          showToast('Decline failed: ' + err.message, 'error');
          declineBtnModal.disabled = false;
          declineBtnModal.innerText = 'Decline';
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<div class="alert">Error loading details: ${err.message}</div>`
  }
}

export function closeModal() {
  // If no state-managed modal is active but the overlay is open
  // (e.g., transaction details opened via showTransactionModal),
  // close it directly without a full re-render to preserve scroll position
  if (!state.modal.isOpen && !state.modal.type) {
    const overlay = document.getElementById('modal-overlay')
    if (overlay && overlay.classList.contains('open')) {
      overlay.classList.remove('open')
      document.body.style.overflow = ''
      return
    }
  }
  state.modal.isOpen = false
  state.modal.type = null
  window.__render()
}
