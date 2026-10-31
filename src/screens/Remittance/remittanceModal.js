import { escapeHtml, generateId, wrapDateInput, formatDate, formatDateForInput, formatCurrency } from '../../utils/formatters.js';
import { showToast } from '../../services/toastService.js';
import { getLocalDateString } from '../../services/sqliteService.js';

export function showSimpleReviewModal(
  formData,
  enterpriseData,
  historyState,
  clearSavedFormFn,
  clearFormFn,
  loadHistoryDataFn,
  renderFn,
  deps
) {
  const { user } = deps || {};
  const modalId = 'simple-review-modal';
  const existingModal = document.getElementById(modalId);
  if (existingModal) existingModal.remove();
  const modalDiv = document.createElement('div');
  modalDiv.id = modalId;
  modalDiv.innerHTML = `
    <div class="modal-backdrop" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 99999;">
      <div class="modal-content" style="max-width: 90%; width: 420px; background: var(--bg-card); border-radius: 12px; box-shadow: var(--shadow-xl); overflow: hidden;">
        <div class="modal-header" style="padding: 1rem 1.25rem; border-bottom: 1px solid var(--border-light);">
          <h3 style="margin:0; font-weight: 700; color: var(--text-primary); font-size:1.1rem;">Review Remittance</h3>
        </div>
        <div class="modal-body" id="simple-modal-body" style="padding: 1.5rem; color: var(--text-muted); font-size:0.9rem;">
          <div style="text-align: center; padding: 2rem;">Loading details...</div>
        </div>
        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 0.5rem; padding: 1rem; border-top: 1px solid var(--border-light);">
          <button type="button" class="secondary-button" id="simple-close-btn" style="padding: 0.5rem 1rem; border-radius: 8px; font-size:0.85rem;">Close</button>
          <button type="button" class="secondary-button" id="simple-decline-btn" style="background: var(--danger-bg, #fee2e2); border: 1px solid var(--danger, #dc2626); color: var(--danger, #dc2626); padding: 0.5rem 1rem; border-radius: 8px; font-size:0.85rem;">Decline</button>
          <button type="button" class="primary-button" id="simple-approve-btn" style="background: var(--accent-primary); color: white; border: none; padding: 0.5rem 1rem; border-radius: 8px; font-size:0.85rem;" disabled>Approve</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modalDiv);
  const closeBtn = modalDiv.querySelector('#simple-close-btn');
  const declineBtn = modalDiv.querySelector('#simple-decline-btn');
  const approveBtn = modalDiv.querySelector('#simple-approve-btn');
  const modalBody = modalDiv.querySelector('#simple-modal-body');
  closeBtn.addEventListener('click', () => modalDiv.remove());

  let isSavingsRequest = false;
  let balanceBefore = 0;
  let balanceAfter = 0;
  let entName = 'General Contribution';
  let formattedAmount = '';
  const cooperativeId = formData.cooperative_id || (historyState && historyState.cooperativeId);

  (async () => {
    try {
      const detail = formData.details ? formData.details[0] : null;
      const targetEntId = detail ? (detail.enterprise_id || detail.item) : null;
      const targetEnt = targetEntId ? (enterpriseData && enterpriseData.find ? enterpriseData.find(e => e.id === targetEntId) : null) : null;

      isSavingsRequest = formData.transaction_type === 'Savings Withdrawal' || 
                        formData.isWithdrawalRequest === true ||
                        (targetEnt && (targetEnt.account_type || '').toLowerCase() === 'savings');

      entName = targetEnt ? targetEnt.account_name : (detail ? (detail.notes || detail.auto_description || detail.item) : 'Savings Account');

      const amountVal = Math.abs(parseFloat(formData.amount || (detail ? detail.amount : 0) || 0));
      formattedAmount = formatCurrency(amountVal);

      if (isSavingsRequest && cooperativeId && formData.member_id) {
        const { buildAccountBalance } = await import('../../services/dataService.js');
        const memberIdString = typeof formData.member_id === 'object' ? formData.member_id.id : formData.member_id;
        const limitKey = formData.id && (formData.remittance_date || formData.created_at)
          ? {
              date: getLocalDateString(formData.remittance_date || formData.created_at),
              ts: formData.created_at || '',
              id: formData.id
            }
          : null;
        const { accountBalance } = await buildAccountBalance(cooperativeId, { memberId: memberIdString }, limitKey);
        const balObj = accountBalance.find(b => b.id === targetEntId);
        balanceBefore = balObj ? parseFloat(balObj.sum_of_amount || 0) : 0;
        balanceAfter = balanceBefore - amountVal;
      }

      let bodyHtml = '';
      if (isSavingsRequest) {
        bodyHtml = `
          <div style="display: flex; flex-direction: column; gap: 1rem;">
            <div style="background: var(--bg-main); padding: 1rem; border-radius: 8px; border: 1px solid var(--border-medium);">
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <div>
                  <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Enterprise</span>
                  <div style="font-weight: 600; color: var(--text-primary); margin-top: 0.15rem;">${escapeHtml(entName)}</div>
                </div>
                <div>
                  <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Amount</span>
                  <div style="font-weight: 700; color: var(--danger); margin-top: 0.15rem;">-${formattedAmount}</div>
                </div>
                <div>
                  <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Balance Before</span>
                  <div style="font-weight: 600; color: var(--text-primary); margin-top: 0.15rem;">${formatCurrency(balanceBefore)}</div>
                </div>
                <div>
                  <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Balance After</span>
                  <div style="font-weight: 700; color: ${balanceAfter < 0 ? 'var(--danger)' : 'var(--success)'}; margin-top: 0.15rem;">${formatCurrency(balanceAfter)}</div>
                </div>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
              <div class="field">
                <label>Approval Date *</label>
                <input type="date" id="simple-date-input" value="${new Date().toISOString().split('T')[0]}" required>
              </div>
              <div class="field">
                <label>Bank *</label>
                <select id="simple-bank-select" required>
                  <option value="">-- Choose Bank --</option>
                  ${(historyState?.banks || []).map(b => `<option value="${escapeHtml(b.bank_name)}" ${formData.bank_name === b.bank_name ? 'selected' : ''}>${escapeHtml(b.bank_name)}</option>`).join('')}
                </select>
              </div>
            </div>
          </div>
        `;
      } else {
        bodyHtml = `
          <p>This remittance is pending approval. Please review and take action.</p>
          <div style="background: var(--bg-main); padding: 0.75rem; border-radius: 8px; border: 1px solid var(--border-medium); font-size: 0.85rem; margin-top: 1rem;">
            <div><strong>Type:</strong> ${escapeHtml(formData.transaction_type || 'General')}</div>
            <div><strong>Amount:</strong> ${formattedAmount}</div>
          </div>
        `;
      }

      modalBody.innerHTML = bodyHtml;
      modalBody.querySelectorAll('input[type="date"]').forEach(wrapDateInput);
      approveBtn.disabled = false;
    } catch (err) {
      console.error(err);
      modalBody.innerHTML = `<div style="color: var(--danger); text-align: center; padding: 2rem;">Failed to load details: ${escapeHtml(err.message)}</div>`;
    }
  })();

  declineBtn.addEventListener('click', async () => {
    const reason = prompt('Enter decline reason (optional):');
    if (reason === null) return;
    if (!confirm('Are you sure you want to decline this remittance?')) return;
    try {
      declineBtn.disabled = true;
      declineBtn.innerText = 'Declining...';
      const { declineRemittance } = await import('../../services/dataService.js');
      const approvedByString = user?.username || 'admin';
      await declineRemittance(formData.id, approvedByString, reason.trim());
      showToast('Remittance declined successfully!', 'success');
      modalDiv.remove();
      if (clearSavedFormFn) clearSavedFormFn();
      if (loadHistoryDataFn) await loadHistoryDataFn(true);
      if (clearFormFn) await clearFormFn();
      if (renderFn) renderFn();
    } catch (err) {
      console.error(err);
      showToast('Error declining remittance: ' + err.message, 'error');
      declineBtn.disabled = false;
      declineBtn.innerText = 'Decline';
    }
  });

  approveBtn.addEventListener('click', async () => {
    try {
      let resolvedBank = '';
      let resolvedDate = '';

      if (isSavingsRequest) {
        const bankSelect = modalDiv.querySelector('#simple-bank-select');
        const dateInput = modalDiv.querySelector('#simple-date-input');

        if (!bankSelect || !bankSelect.value) {
          showToast('Please select a bank for disbursement.', 'warning');
          return;
        }
        if (!dateInput || !dateInput.value) {
          showToast('Please select an approval date.', 'warning');
          return;
        }
        resolvedBank = bankSelect.value;
        resolvedDate = dateInput.value;
      }

      approveBtn.disabled = true;
      approveBtn.innerText = 'Approving...';
      const { approveRemittance } = await import('../../services/dataService.js');
      const approvedByString = user?.username || 'admin';
      await approveRemittance(formData.id, approvedByString, resolvedBank, resolvedDate);
      showToast('Remittance approved successfully!', 'success');
      modalDiv.remove();
      if (clearSavedFormFn) clearSavedFormFn();
      if (loadHistoryDataFn) await loadHistoryDataFn(true);
      if (clearFormFn) await clearFormFn();
      if (renderFn) renderFn();
    } catch (err) {
      console.error(err);
      showToast('Error approving remittance: ' + err.message, 'error');
      approveBtn.disabled = false;
      approveBtn.innerText = 'Approve';
    }
  });
}

export function showLoanReviewModal(
  formData,
  enterpriseData,
  historyState,
  clearSavedFormFn,
  clearFormFn,
  loadHistoryDataFn,
  renderFn,
  deps
) {
  const { user } = deps || {};
  const modalId = 'loan-review-modal';
  const existing = document.getElementById(modalId);
  if (existing) existing.remove();

  const loanDetail = formData.details.find(d => d.loan_info);
  if (!loanDetail) {
    showSimpleReviewModal(formData, enterpriseData, historyState, clearSavedFormFn, clearFormFn, loadHistoryDataFn, renderFn, deps);
    return;
  }

  const loanInfo = loanDetail.loan_info;
  const loanData = loanInfo.loanData;
  if (loanData) {
    if (!loanData.issueDate) {
      loanData.issueDate = formData.remittance_date || new Date().toISOString();
    }
    if (!loanData.dueDate && loanData.durationMonths && loanData.issueDate) {
      const issueD = new Date(loanData.issueDate);
      if (!isNaN(issueD.getTime())) {
        const duration = parseInt(loanData.durationMonths) || 0;
        issueD.setMonth(issueD.getMonth() + duration);
        loanData.dueDate = issueD.toISOString();
      }
    }
  }
  const guarantors = loanInfo.guarantors || [];
  const member = historyState.membersMap[formData.member_id] || { name: 'Unknown' };
  const memberName = member ? (member.name || member.first_name + ' ' + member.last_name) : 'Unknown';
  const memberReg = member ? (member.registration_no || member.member_registration_no || '') : '';

  let modalCharges = (loanInfo.charges || []).map(c => ({
    id: c.id || generateId(String(user.cooperativeId)),
    name: c.name || '',
    value: parseFloat(c.value) || 0,
    type: c.type || 'fixed'
  }));

  // Pre-fill charges from enterprise table if no charges exist yet
  if (modalCharges.length === 0) {
    const detail = formData.details.find(d => d.loan_info);
    const targetEntId = detail ? (detail.enterprise_id || detail.item) : null;
    const enterprise = targetEntId ? (enterpriseData || []).find(e => String(e.id) === String(targetEntId)) : null;
    if (enterprise) {
      if (enterprise.interest_rate !== undefined && enterprise.interest_rate !== null && enterprise.interest_rate !== '') {
        modalCharges.push({
          id: generateId(String(user.cooperativeId)),
          name: 'Interest',
          value: Math.abs(parseFloat(enterprise.interest_rate) || 0),
          type: enterprise.interest_is_percent ? 'percentage' : 'fixed'
        });
      }
      if (enterprise.form_fee !== undefined && enterprise.form_fee !== null && enterprise.form_fee !== '') {
        modalCharges.push({
          id: generateId(String(user.cooperativeId)),
          name: 'Form Fee',
          value: Math.abs(parseFloat(enterprise.form_fee) || 0),
          type: enterprise.form_fee_is_percent ? 'percentage' : 'fixed'
        });
      }
      if (enterprise.admin_charge !== undefined && enterprise.admin_charge !== null && enterprise.admin_charge !== '') {
        modalCharges.push({
          id: generateId(String(user.cooperativeId)),
          name: 'Admin Charge',
          value: Math.abs(parseFloat(enterprise.admin_charge) || 0),
          type: enterprise.admin_charge_is_percent ? 'percentage' : 'fixed'
        });
      }
    }
  }

  const modalDiv = document.createElement('div');
  modalDiv.id = modalId;
  modalDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:99999;';
  modalDiv.addEventListener('click', (e) => {
    if (e.target === modalDiv) modalDiv.remove();
  });
  document.body.appendChild(modalDiv);

  const renderModal = () => {
    const existingContent = modalDiv.querySelector('.lrm-content');
    if (existingContent) existingContent.remove();

    const totalCharges = modalCharges.reduce((sum, c) => {
      let val = parseFloat(c.value) || 0;
      if (c.type === 'percentage') {
        val = (val / 100) * Math.abs(parseFloat(loanData?.principalAmount || 0));
      }
      return sum + val;
    }, 0);

    const content = document.createElement('div');
    content.className = 'lrm-content';
    content.innerHTML = `
      <div class="modal-content" style="max-width:600px;background:var(--bg-card);border-radius:0.75rem;box-shadow:var(--shadow-xl);overflow:hidden;">
        <div class="modal-header" style="padding:1rem 1.25rem;border-bottom:1px solid var(--border-light);display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;font-weight:700;color:var(--text-primary);">Loan Request Review</h3>
          <button type="button" class="lr-x-btn" style="background:transparent;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-muted);line-height:1;">&times;</button>
        </div>
        <div class="modal-body" style="padding:1.25rem;overflow-y:auto;max-height:70vh;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
            <div class="field">
              <label>Approval Date *</label>
              <input type="date" class="lr-date" value="${formatDateForInput(loanData?.issueDate || formData.remittance_date || new Date())}">
            </div>
            <div class="field">
              <label>Bank / Method *</label>
              <select class="lr-bank">
                <option value="">-- Select Bank --</option>
                ${(historyState.banks || []).map(b => `<option value="${escapeHtml(b.bank_name)}">${escapeHtml(b.bank_name)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;padding:0.75rem;background:var(--bg-main);border-radius:0.5rem;">
            <div><strong>Member:</strong> ${escapeHtml(memberName)}</div>
            <div><strong>Reg No:</strong> ${escapeHtml(memberReg)}</div>
            <div><strong>Principal:</strong> ${formatCurrency(parseFloat(loanData?.principalAmount || 0))}</div>
            <div><strong>Duration:</strong> ${loanData?.durationMonths || 0} months</div>
            <div><strong>Issue Date:</strong> ${formatDate(loanData?.issueDate || formData.remittance_date)}</div>
            <div><strong>Due Date:</strong> ${formatDate(loanData?.dueDate || '—')}</div>
          </div>

          <div style="margin-bottom:1rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
              <strong style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;">Loan Charges</strong>
              <button type="button" class="lr-add-charge-btn" style="padding:0.4rem 0.8rem;border-radius:var(--radius-sm);border:1px solid var(--border-light);background:transparent;color:var(--accent-primary);font-weight:600;cursor:pointer;font-size:0.8rem;">+ Add Charge</button>
            </div>
            <div class="lr-charges-list" style="display:flex;flex-direction:column;gap:0.5rem;">
              ${modalCharges.length === 0 ? '<p style="color:var(--text-muted);font-style:italic;font-size:0.85rem;padding:0.5rem;">No charges added.</p>' : ''}
              ${modalCharges.map((c, ci) => `
                <div class="lr-charge-row" data-index="${ci}" style="display:flex;gap:0.5rem;align-items:center;background:var(--bg-main);padding:0.5rem;border-radius:0.5rem;border:1px solid var(--border-medium);">
                  <input type="text" class="lr-charge-name" value="${escapeHtml(c.name || '')}" placeholder="Charge name" style="flex:2;padding:0.4rem 0.5rem;border-radius:var(--radius-sm);border:1px solid var(--border-medium);background:var(--bg-input);color:var(--text-primary);font-size:0.8rem;">
                  <select class="lr-charge-type" style="flex:1;padding:0.4rem;border-radius:var(--radius-sm);border:1px solid var(--border-medium);background:var(--bg-input);color:var(--text-primary);font-size:0.8rem;">
                    <option value="percentage" ${c.type === 'percentage' ? 'selected' : ''}>%</option>
                    <option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Fixed (₦)</option>
                  </select>
                  <input type="number" class="lr-charge-value" value="${c.value}" step="0.01" min="0" style="flex:1;padding:0.4rem 0.5rem;border-radius:var(--radius-sm);border:1px solid var(--border-medium);background:var(--bg-input);color:var(--text-primary);font-size:0.8rem;width:80px;">
                  <span class="lr-charge-calc" style="flex:1;font-size:0.8rem;color:var(--text-muted);text-align:right;white-space:nowrap;">
                    ${(() => {
                      let val = parseFloat(c.value) || 0;
                      if (c.type === 'percentage') {
                        val = (val / 100) * Math.abs(parseFloat(loanData?.principalAmount || 0));
                      }
                      return formatCurrency(val);
                    })()}
                  </span>
                  <button type="button" class="lr-remove-charge-btn" data-index="${ci}" style="padding:0.25rem 0.5rem;border-radius:0.3rem;border:1px solid var(--danger);background:transparent;color:var(--danger);font-weight:600;cursor:pointer;font-size:0.75rem;">&times;</button>
                </div>
              `).join('')}
            </div>
            <div style="display:flex;justify-content:flex-end;padding:0.5rem 0 0 0;font-weight:700;font-size:0.9rem;">
              <span>Total Charges: ${formatCurrency(totalCharges)}</span>
            </div>
          </div>

          ${guarantors.length > 0 ? `
            <div>
              <strong style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;">Guarantors</strong>
              <div style="margin-top:0.5rem;">
                ${guarantors.map(g => {
                  const gMember = historyState.membersMap[g.member_id] || { name: 'Unknown' };
                  const gName = gMember ? (gMember.name || gMember.first_name + ' ' + gMember.last_name) : 'Unknown';
                  const approval = g.guarantor_approval;
                  const statusText = approval === 1 ? '✓ Approved' : approval === 0 ? '✗ Declined' : '⏳ Awaiting';
                  const statusColor = approval === 1 ? 'var(--success)' : approval === 0 ? 'var(--danger)' : 'var(--warning)';
                  return `<div style="display:flex;justify-content:space-between;padding:0.3rem 0;"><span>${escapeHtml(gName)}</span><span style="color:${statusColor}">${statusText}</span></div>`;
                }).join('')}
              </div>
            </div>
          ` : ''}
        </div>
        <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:0.75rem;padding:1rem;border-top:1px solid var(--border-light);">
          <button type="button" class="secondary-button" id="lr-cancel-btn" style="background:transparent;border:1px solid var(--border-medium);color:var(--text-primary);padding:0.6rem 1.2rem;border-radius:0.5rem;font-weight:700;cursor:pointer;">Cancel</button>
          <button type="button" class="secondary-button" id="lr-decline-btn" style="background:var(--danger);border:1px solid var(--danger);color:white;padding:0.6rem 1.2rem;border-radius:0.5rem;font-weight:700;cursor:pointer;">Decline</button>
          <button type="button" class="primary-button" id="lr-approve-btn" style="background:var(--accent-primary);color:white;border:none;padding:0.6rem 1.2rem;border-radius:0.5rem;font-weight:700;cursor:pointer;">Approve</button>
        </div>
      </div>
    `;
    modalDiv.appendChild(content);
    modalDiv.querySelectorAll('input[type="date"]').forEach(wrapDateInput);
    attachModalListeners();
  };

  const attachModalListeners = () => {
    modalDiv.querySelectorAll('.lr-x-btn').forEach(el => {
      el.addEventListener('click', () => modalDiv.remove());
    });
    modalDiv.querySelector('#lr-cancel-btn').addEventListener('click', () => modalDiv.remove());
    
    const dateInput = modalDiv.querySelector('input[type="date"].lr-date');
    if (dateInput) {
      dateInput.addEventListener('change', () => {
        const selectedDateStr = dateInput.value;
        if (selectedDateStr) {
          const issueD = new Date(selectedDateStr);
          if (!isNaN(issueD.getTime())) {
            if (loanData) {
              loanData.issueDate = selectedDateStr;
              const duration = parseInt(loanData.durationMonths) || 0;
              issueD.setMonth(issueD.getMonth() + duration);
              loanData.dueDate = issueD.toISOString();
            }
            formData.remittance_date = selectedDateStr;
            renderModal();
          }
        }
      });
    }

    modalDiv.querySelector('.lr-add-charge-btn')?.addEventListener('click', () => {
      modalCharges.push({ id: generateId(String(user.cooperativeId)), name: '', value: 0, type: 'percentage' });
      renderModal();
    });

    modalDiv.querySelectorAll('.lr-charge-row').forEach(row => {
      const idx = parseInt(row.dataset.index, 10);
      const nameInput = row.querySelector('.lr-charge-name');
      const typeInput = row.querySelector('.lr-charge-type');
      const valueInput = row.querySelector('.lr-charge-value');

      nameInput.addEventListener('input', () => {
        modalCharges[idx].name = nameInput.value;
      });
      typeInput.addEventListener('change', () => {
        modalCharges[idx].type = typeInput.value;
        renderModal();
      });
      valueInput.addEventListener('input', () => {
        modalCharges[idx].value = parseFloat(valueInput.value) || 0;
        renderModal();
      });

      const removeBtn = row.querySelector('.lr-remove-charge-btn');
      if (removeBtn) {
        removeBtn.addEventListener('click', () => {
          modalCharges.splice(idx, 1);
          renderModal();
        });
      }
    });

    modalDiv.querySelector('#lr-decline-btn').addEventListener('click', async () => {
      if (!confirm('Are you sure you want to decline this loan request?')) return;
      try {
        const btn = modalDiv.querySelector('#lr-decline-btn');
        btn.disabled = true;
        btn.innerText = 'Declining...';
        const { declineLoanRequest } = await import('../../services/dataService.js');
        await declineLoanRequest(formData.id, formData.member_id ? (typeof formData.member_id === 'object' ? formData.member_id.username : formData.member_id) : null);
        showToast('Loan request declined.', 'success');
        modalDiv.remove();
        clearSavedFormFn();
        await loadHistoryDataFn(true);
        await clearFormFn();
        renderFn();
      } catch (err) {
        console.error(err);
        showToast('Error declining loan request: ' + err.message, 'error');
      }
    });

    modalDiv.querySelector('#lr-approve-btn').addEventListener('click', async () => {
      const dateVal = modalDiv.querySelector('input[type="date"].lr-date').value;
      const bankVal = modalDiv.querySelector('.lr-bank').value;

      if (!dateVal) { showToast('Approval Date is required.', 'error'); return; }
      if (!bankVal) { showToast('Bank is required.', 'error'); return; }

      if (!confirm('Are you sure you want to approve this loan request?')) return;
      try {
        const btn = modalDiv.querySelector('#lr-approve-btn');
        btn.disabled = true;
        btn.innerText = 'Approving...';

        if (loanDetail && loanDetail.loan_info) {
          loanDetail.loan_info.charges = JSON.parse(JSON.stringify(modalCharges));
        }

        const { approveLoanRequest } = await import('../../services/dataService.js');
        await approveLoanRequest(formData.id, user?.username || 'admin', {
          remittance_date: dateVal,
          bank_name: bankVal,
          charges: JSON.parse(JSON.stringify(modalCharges)),
          details: formData.details
        });
        showToast('Loan request approved successfully!', 'success');
        modalDiv.remove();
        clearSavedFormFn();
        await loadHistoryDataFn(true);
        await clearFormFn();
        renderFn();
      } catch (err) {
        console.error(err);
        showToast('Error approving loan request: ' + err.message, 'error');
      }
    });
  };

  renderModal();
}
