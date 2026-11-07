import { generateId, formatDateForInput, escapeHtml, escapeAttribute, formatDate, formatCurrency } from '../../utils/formatters.js';
import { fetchGuarantorStats } from '../../services/dataService.js';
import { showToast } from '../../services/toastService.js';

// --- Show Loan Config Modal ---
export function showLoanConfigModal(enterpriseId, isReadOnly = false, deps) {
    const { formData, enterpriseData, members, selectorMembers, isMember, user, historyState, loadHistoryData, clearForm, clearSavedForm, render } = deps;

    const existingModal = document.getElementById('loan-config-modal');
    if (existingModal) existingModal.remove();
    const loanId = formData.id || 'NEW';
    const detail = formData.details.find(d => String(d.enterprise_id || d.item || '') === String(enterpriseId));
    if (!detail) {
      return;
    }
    // Load default charges from Enterprise (always positive magnitudes)
    const enterprise = enterpriseData.find(e => String(e.id) === String(enterpriseId));
    const defaultCharges = [];
    if (enterprise) {
      // Map old enterprise fields to charges
      if (enterprise.interest_rate !== undefined && enterprise.interest_rate !== null && enterprise.interest_rate !== '') {
        defaultCharges.push({
          id: generateId(String(user.cooperativeId)),
          name: 'Interest',
          value: Math.abs(parseFloat(enterprise.interest_rate) || 0),
          type: enterprise.interest_is_percent ? 'percentage' : 'fixed'
        });
      }
      if (enterprise.form_fee !== undefined && enterprise.form_fee !== null && enterprise.form_fee !== '') {
        defaultCharges.push({
          id: generateId(String(user.cooperativeId)),
          name: 'Form Fee',
          value: Math.abs(parseFloat(enterprise.form_fee) || 0),
          type: enterprise.form_fee_is_percent ? 'percentage' : 'fixed'
        });
      }
      if (enterprise.admin_charge !== undefined && enterprise.admin_charge !== null && enterprise.admin_charge !== '') {
        defaultCharges.push({
          id: generateId(String(user.cooperativeId)),
          name: 'Admin Charge',
          value: Math.abs(parseFloat(enterprise.admin_charge) || 0),
          type: enterprise.admin_charge_is_percent ? 'percentage' : 'fixed'
        });
      }
    }
    
    const currentLoan = detail.loan_info || {
      loanData: {
        principalAmount: Math.abs(detail.amount),
        durationMonths: 0,
        issueDate: formData.remittance_date,
        dueDate: '',
        notes: ''
      },
      guarantors: [],
      charges: defaultCharges
    };
    // Calculate duration from due date if needed
    if (!currentLoan.loanData.durationMonths && currentLoan.loanData.issueDate && currentLoan.loanData.dueDate) {
      try {
        const d1 = new Date(currentLoan.loanData.issueDate);
        const d2 = new Date(currentLoan.loanData.dueDate);
        const months = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
        if (months > 0) {
          currentLoan.loanData.durationMonths = months;
        }
      } catch (e) {}
    }
    
    // Calculate due date from duration if needed
    if (!currentLoan.loanData.dueDate && currentLoan.loanData.issueDate && currentLoan.loanData.durationMonths) {
      try {
        const d1 = new Date(currentLoan.loanData.issueDate);
        d1.setMonth(d1.getMonth() + currentLoan.loanData.durationMonths);
        currentLoan.loanData.dueDate = d1.toISOString();
      } catch (e) {}
    }
    const displayPrincipal = Math.abs(detail.amount);
    let activeModalTab = 'details';
    let modalState = JSON.parse(JSON.stringify(currentLoan));

    const renderModal = () => {
      const modalContainer = document.getElementById('loan-config-modal');
      if (!modalContainer) return;
      const principalDisabled = isReadOnly ? 'disabled' : '';
      const dueDateReadonly = 'disabled';
      const dueDateBg = 'var(--bg-main)';
      const durationDisabled = isReadOnly ? 'disabled' : '';
      const notesDisabled = isReadOnly ? 'disabled' : '';
      const statusValue = modalState.loanData.status || (formData.isLoanRequest ? 'Pending' : 'Active');
      const detailsDisplay = activeModalTab === 'details' ? 'block' : 'none';
      const guarantorsDisplay = activeModalTab === 'guarantors' ? 'block' : 'none';
      const chargesDisplay = activeModalTab === 'charges' ? 'block' : 'none';
      const tabDetailsActiveClass = activeModalTab === 'details' ? 'active' : '';
      const tabDetailsBottomColor = activeModalTab === 'details' ? 'var(--accent-primary)' : 'transparent';
      const tabDetailsColor = activeModalTab === 'details' ? 'var(--accent-primary)' : 'var(--text-muted)';
      const tabGuarantorsActiveClass = activeModalTab === 'guarantors' ? 'active' : '';
      const tabGuarantorsBottomColor = activeModalTab === 'guarantors' ? 'var(--accent-primary)' : 'transparent';
      const tabGuarantorsColor = activeModalTab === 'guarantors' ? 'var(--accent-primary)' : 'var(--text-muted)';
      const tabChargesActiveClass = activeModalTab === 'charges' ? 'active' : '';
      const tabChargesBottomColor = activeModalTab === 'charges' ? 'var(--accent-primary)' : 'transparent';
      const tabChargesColor = activeModalTab === 'charges' ? 'var(--accent-primary)' : 'var(--text-muted)';
      const content = `
        <div class="modal-content" style="max-width: 800px; display: flex; flex-direction: column; height: 90vh; min-height: 600px;">
          <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border-light);">
            <h3 style="margin: 0; font-weight: 700; color: var(--text-primary);">Configure Loan Details</h3>
            <button class="close-btn" onclick="document.getElementById('loan-config-modal').remove()" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
          </div>
          <div class="modal-body" style="padding: 1rem 1.25rem; overflow-y: auto; flex: 1;">
            <div class="modal-tabs" style="display: flex; border-bottom: 1px solid var(--border-medium); margin-bottom: 1.5rem; position: sticky; top: 0; background: var(--bg-card); z-index: 10; padding-top: 1rem;">
              <button class="modal-tab-btn ${tabDetailsActiveClass}" id="tab-btn-details" style="flex: 1; padding: 0.75rem 1rem; background: transparent; border: none; border-bottom: 2px solid ${tabDetailsBottomColor}; font-weight: 600; color: ${tabDetailsColor}; cursor: pointer; transition: all 0.2s;">Loan Details</button>
              <button class="modal-tab-btn ${tabGuarantorsActiveClass}" id="tab-btn-guarantors" style="flex: 1; padding: 0.75rem 1rem; background: transparent; border: none; border-bottom: 2px solid ${tabGuarantorsBottomColor}; font-weight: 600; color: ${tabGuarantorsColor}; cursor: pointer; transition: all 0.2s;">Guarantors</button>
              <button class="modal-tab-btn ${tabChargesActiveClass}" id="tab-btn-charges" style="flex: 1; padding: 0.75rem 1rem; background: transparent; border: none; border-bottom: 2px solid ${tabChargesBottomColor}; font-weight: 600; color: ${tabChargesColor}; cursor: pointer; transition: all 0.2s;">Charges</button>
            </div>
            <div class="modal-tab-content ${tabDetailsActiveClass}" id="tab-content-details" style="display: ${detailsDisplay};">
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div class="field">
                  <label>Principal Amount (₦)</label>
                  <input type="number" id="loan-principal" value="${modalState.loanData.principalAmount || 0}" step="0.01" ${principalDisabled}>
                </div>
                <div class="field">
                  <label>Status</label>
                  <input type="text" id="loan-status" value="${statusValue}" readonly style="background: var(--bg-main); font-weight: 600; color: var(--accent-primary);">
                </div>
                <div class="field">
                  <label>Issue Date</label>
                  <input type="text" id="loan-issue-date-display" value="${formatDate(modalState.loanData.issueDate || formData.remittance_date)}" disabled style="background: var(--bg-main);">
                  <input type="hidden" id="loan-issue-date" value="${formatDateForInput(modalState.loanData.issueDate || formData.remittance_date)}">
                </div>
                <div class="field">
                  <label>Due Date</label>
                  <input type="text" id="loan-due-date-display" value="${modalState.loanData.dueDate ? formatDate(modalState.loanData.dueDate) : ''}" disabled style="background: ${dueDateBg};">
                  <input type="hidden" id="loan-due-date" value="${formatDateForInput(modalState.loanData.dueDate)}">
                </div>
                <div class="field">
                  <label>Duration (Months)</label>
                  <input type="number" id="loan-duration" value="${modalState.loanData.durationMonths || 0}" min="0" ${durationDisabled}>
                </div>
              </div>
              <div class="field" style="margin-top: 0.5rem;">
                <label>Notes / Description</label>
                <textarea id="loan-notes" rows="2" style="resize: vertical;" placeholder="Additional details about this loan..." ${notesDisabled}>${escapeHtml(modalState.loanData.notes || '')}</textarea>
              </div>
            </div>
            <div class="modal-tab-content ${tabGuarantorsActiveClass}" id="tab-content-guarantors" style="display: ${guarantorsDisplay}; padding-bottom: 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h4 style="margin: 0; color: var(--text-primary);">Guarantors</h4>
                ${!isReadOnly ? '<button type="button" id="add-guarantor-btn" class="ghost-button" style="padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); border: 1px solid var(--border-light); background: transparent; color: var(--text-muted); font-weight: 600; cursor: pointer; color: var(--accent-primary);">+ Add Guarantor</button>' : ''}
              </div>
              ${modalState.guarantors.length === 0 && !isReadOnly ? '<p style="color: var(--text-muted); font-style: italic; font-size: 0.85rem;">No guarantors added yet.</p>' : ''}
              <div id="guarantors-list" style="display: flex; flex-direction: column; gap: 0.85rem;">
                ${modalState.guarantors.map((g, gi) => {
                  const gMember = selectorMembers.find(m => m.id === g.member_id);
                  const approval = g.guarantor_approval;
                  const isApproved = approval === 1;
                  const isDeclined = approval === 0;
                  const isAwaiting = !isApproved && !isDeclined;
                  const statusColor = isApproved ? 'var(--success)' : isDeclined ? 'var(--danger)' : 'var(--warning)';
                  const statusBg = isApproved ? 'var(--success-bg)' : isDeclined ? 'var(--danger-bg)' : 'var(--warning-bg)';
                  const statusLabel = isApproved ? '✓ Approved' : isDeclined ? '✗ Declined' : '⏳ Awaiting';
                  const borderStyle = isDeclined ? 'var(--danger)' : 'var(--border-medium)';
                  const cursorStyle = isDeclined && !isReadOnly ? 'pointer' : 'default';
                  return `
                    <div class="guarantor-row" data-index="${gi}" data-id="${g.id || generateId(String(user.cooperativeId))}" data-approval="${approval ?? ''}" style="display: flex; flex-direction: column; gap: 0.5rem; background: var(--bg-main); padding: 1rem; border-radius: 0.75rem; border: 1px solid ${borderStyle}; margin-bottom: 0.5rem;">
                      <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                        <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
                          <div style="position: relative; flex: 1;">
                            <input type="text" class="guarantor-search" placeholder="Search guarantor name..." value="${escapeHtml(gMember?.name || '')}" style="width: 100%; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm); padding: 0.5rem;" ${isReadOnly ? 'disabled' : ''}>
                            <div class="guarantor-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 200px; overflow-y: auto; margin-top: 0.25rem;"></div>
                            <input type="hidden" class="guarantor-id" value="${g.member_id}">
                          </div>
                          <input type="number" class="guarantor-amt" value="${g.amount || 0}" placeholder="Amount" style="width: 100px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm); padding: 0.5rem;" ${isReadOnly ? 'disabled' : ''}>
                        </div>
                        <div style="display: flex; align-items: center; gap: 0.5rem;">
                          <span class="g-approval-badge" data-approval="${approval ?? ''}" style="font-size: 0.72rem; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 999px; background: ${statusBg}; color: ${statusColor}; white-space: nowrap; cursor: ${cursorStyle};" title="${isDeclined && !isReadOnly ? 'Click to resend request' : statusLabel}">${statusLabel}</span>
                          ${!isReadOnly ? `<button type="button" class="remove-guarantor-btn" data-index="${gi}" style="padding: 0.2rem 0.5rem; border-radius: 0.5rem; border: none; background: transparent; color: var(--danger); font-size: 1.2rem; line-height: 1; font-weight: 800; cursor: pointer;" title="Remove Guarantor">&times;</button>` : ''}
                        </div>
                      </div>
                      <div class="g-info-row" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 0.15rem;">
                        <div class="g-selected-display" style="font-size: 0.75rem; color: var(--accent-primary); font-weight: 600;">
                          ${gMember ? `Selected: ${gMember.name}` : ''}
                        </div>
                        ${!isMember ? `<div class="g-stats-display" style="display: flex; gap: 1rem; font-size: 0.7rem; color: var(--text-muted); font-weight: 500;">
                          <span class="g-active-count">Active: -</span>
                          <span class="g-active-sum">Total: -</span>
                          <span class="g-overdue-count">Overdue: -</span>
                        </div>` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
              ${(() => {
                const totalG = modalState.guarantors.reduce((sum, g) => sum + (parseFloat(g.amount) || 0), 0);
                const diff = (modalState.loanData.principalAmount || 0) - totalG;
                return `
                <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-medium); display: flex; justify-content: space-between; font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">
                  <span>Total Guarantee: ${formatCurrency(totalG)}</span>
                  <span style="color: ${diff > 0 ? 'var(--danger)' : 'var(--success)'};">Difference (Principal - Guarantee): ${formatCurrency(diff)}</span>
                </div>
                `;
              })()}
            </div>
            <div class="modal-tab-content ${tabChargesActiveClass}" id="tab-content-charges" style="display: ${chargesDisplay}; padding-bottom: 1rem;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h4 style="margin: 0; color: var(--text-primary);">Charges</h4>
                ${!isReadOnly ? '<button type="button" id="add-charge-btn" class="ghost-button" style="padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); border: 1px solid var(--border-light); background: transparent; color: var(--text-muted); font-weight: 600; cursor: pointer; color: var(--accent-primary);">+ Add Charge</button>' : ''}
              </div>
              ${modalState.charges.length === 0 ? '<p style="color: var(--text-muted); font-style: italic; font-size: 0.85rem;">No charges added yet.</p>' : ''}
              <div id="charges-list" style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${modalState.charges.map((c, ci) => `
                  <div class="charge-row" data-index="${ci}" data-id="${c.id || generateId(String(user.cooperativeId))}" style="display: grid; grid-template-columns: 2fr 1fr 1.5fr auto; gap: 0.75rem; align-items: end; background: var(--bg-main); padding: 0.75rem; border-radius: 0.5rem; border: 1px solid var(--border-medium);">
                    <div class="field">
                      <label>Charge Name</label>
                      <input type="text" class="charge-name" value="${escapeHtml(c.name || '')}" placeholder="e.g. Interest" ${isReadOnly ? 'disabled' : ''}>
                    </div>
                    <div class="field">
                      <label>Type</label>
                      <select class="charge-type" ${isReadOnly ? 'disabled' : ''}>
                        <option value="percentage" ${c.type === 'percentage' ? 'selected' : ''}>%</option>
                        <option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Fixed (₦)</option>
                      </select>
                    </div>
                    <div class="field">
                      <label>Value</label>
                      <input type="number" class="charge-value" value="${c.value || 0}" step="0.01" min="0" ${isReadOnly ? 'disabled' : ''}>
                    </div>
                    ${!isReadOnly ? `<button type="button" class="remove-charge-btn" data-index="${ci}" style="padding: 0.4rem; border-radius: 0.5rem; border: none; background: transparent; color: var(--danger); font-size: 1.2rem; font-weight: 800; line-height: 1; cursor: pointer; margin-bottom: 0.1rem;" title="Remove Charge">&times;</button>` : '<div style="width:24px;"></div>'}
                  </div>
                `).join('')}
              </div>
              ${(() => {
                const p = modalState.loanData.principalAmount || 0;
                const totalC = modalState.charges.reduce((sum, c) => {
                  const val = parseFloat(c.value) || 0;
                  return sum + (c.type === 'percentage' ? (val / 100) * p : val);
                }, 0);
                return `
                <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-medium); text-align: right; font-weight: 700; font-size: 0.95rem; color: var(--text-primary);">
                  Total Estimated Charges: ${formatCurrency(totalC)}
                </div>
                `;
              })()}
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 0.75rem; padding: 1rem; border-top: 1px solid var(--border-light);">
            <button type="button" class="secondary-button" id="modal-close-btn" style="background: transparent; border: 1px solid var(--border-medium); color: var(--text-primary); padding: 0.6rem 1.2rem; border-radius: 0.5rem; font-weight: 700; cursor: pointer;">Close</button>
            <button type="button" class="primary-button" id="modal-ok-btn" style="background: var(--accent-primary); color: white; border: none; padding: 0.6rem 2rem; border-radius: 0.5rem; font-weight: 700; cursor: pointer;">OK</button>
          </div>
        </div>
      `;
      modalContainer.innerHTML = content;
      attachModalListeners();
    };

    const attachModalListeners = () => {
      document.getElementById('tab-btn-details')?.addEventListener('click', () => {
        activeModalTab = 'details';
        renderModal();
      });
      document.getElementById('tab-btn-guarantors')?.addEventListener('click', () => {
        activeModalTab = 'guarantors';
        renderModal();
      });
      document.getElementById('tab-btn-charges')?.addEventListener('click', () => {
        activeModalTab = 'charges';
        renderModal();
      });
      
      // Add charge button listener
      if (!isReadOnly) {
        document.getElementById('add-charge-btn')?.addEventListener('click', () => {
          modalState.charges.push({
            id: generateId(String(user.cooperativeId)),
            name: '',
            value: 0,
            type: 'percentage'
          });
          saveCharges();
          renderModal();
        });
      }
      
      // Process each charge row
      document.querySelectorAll('.charge-row').forEach((row, idx) => {
        const nameInput = row.querySelector('.charge-name');
        const typeInput = row.querySelector('.charge-type');
        const valueInput = row.querySelector('.charge-value');
        const removeBtn = row.querySelector('.remove-charge-btn');
        
        const updateFormDataCharges = () => {
          saveCharges();
        };
        
        if (nameInput && !isReadOnly) {
          nameInput.addEventListener('input', () => {
            modalState.charges[idx].name = nameInput.value;
            updateFormDataCharges();
          });
        }
        if (typeInput && !isReadOnly) {
          typeInput.addEventListener('change', () => {
            modalState.charges[idx].type = typeInput.value;
            updateFormDataCharges();
            renderModal();
          });
        }
        if (valueInput && !isReadOnly) {
          valueInput.addEventListener('input', () => {
            modalState.charges[idx].value = parseFloat(valueInput.value || 0);
            updateFormDataCharges();
          });
        }
        if (removeBtn && !isReadOnly) {
          removeBtn.addEventListener('click', () => {
            modalState.charges.splice(idx, 1);
            updateFormDataCharges();
            renderModal();
          });
        }
      });
      if (!isReadOnly) {
        document.getElementById('loan-duration')?.addEventListener('input', (e) => {
          const m = parseInt(e.target.value || 0);
          modalState.loanData.durationMonths = m;
          if (modalState.loanData.issueDate && m > 0) {
            const d = new Date(modalState.loanData.issueDate);
            d.setMonth(d.getMonth() + m);
            document.getElementById('loan-due-date').value = formatDateForInput(d);
            document.getElementById('loan-due-date-display').value = formatDate(d);
            modalState.loanData.dueDate = formatDateForInput(d);
          } else {
            document.getElementById('loan-due-date').value = '';
            document.getElementById('loan-due-date-display').value = '';
            modalState.loanData.dueDate = '';
          }
        });
        document.getElementById('loan-duration')?.addEventListener('change', (e) => {
          renderModal();
        });
        document.getElementById('loan-principal')?.addEventListener('change', (e) => {
          modalState.loanData.principalAmount = parseFloat(e.target.value || 0);
          renderModal();
        });
        document.getElementById('loan-notes')?.addEventListener('change', (e) => {
          modalState.loanData.notes = e.target.value;
        });
        document.getElementById('add-guarantor-btn')?.addEventListener('click', () => {
          modalState.guarantors.push({
            id: generateId(String(user.cooperativeId)),
            member_id: '',
            amount: 0,
            guarantor_approval: null
          });
          renderModal();
        });
      }
      
      // Process each guarantor row
      document.querySelectorAll('.guarantor-row').forEach((row, idx) => {
        // Setup search
        const suggestionsDiv = row.querySelector('.guarantor-suggestions');
        const idInput = row.querySelector('.guarantor-id');
        const input = row.querySelector('.guarantor-search');
        if (input && suggestionsDiv && !isReadOnly) {
          let searchTimer;
          const showSuggestions = (list) => {
            suggestionsDiv.innerHTML = list.map(m => `
              <div class="suggestion-item" data-id="${m.id}" style="padding: 0.75rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
                <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(m.name)}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted);">${m.registration_no || m.mobile || 'No ID'}</div>
              </div>
            `).join('');
            suggestionsDiv.style.display = 'block';
            suggestionsDiv.querySelectorAll('.suggestion-item').forEach(el => {
              el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const mid = el.dataset.id;
                const mem = selectorMembers.find(m => m.id === mid);
                idInput.value = mid;
                input.value = mem ? mem.name : '';
                modalState.guarantors[idx].member_id = mid;
                
                // Reset approval badge
                const badge = row.querySelector('.g-approval-badge');
                if (badge) {
                  badge.dataset.approval = '';
                  badge.textContent = '⏳ Awaiting';
                  badge.style.background = 'var(--warning-bg)';
                  badge.style.color = 'var(--warning)';
                  badge.style.cursor = 'default';
                  badge.title = '⏳ Awaiting';
                  row.dataset.approval = '';
                }
                
                // Fetch guarantor stats
                if (!isMember && mid) {
                  const statsDiv = row.querySelector('.g-stats-display');
                  if (statsDiv) {
                    statsDiv.querySelector('.g-active-count').innerText = 'Loading...';
                    fetchGuarantorStats(mid, user.cooperativeId).then(stats => {
                      statsDiv.querySelector('.g-active-count').innerText = `Active: ${stats.activeCount}`;
                      statsDiv.querySelector('.g-active-sum').innerText = `Total: ${formatCurrency(stats.activeSum)}`;
                      const odSpan = statsDiv.querySelector('.g-overdue-count');
                      odSpan.innerText = `Overdue: ${stats.overdueCount}`;
                      if (stats.overdueCount > 0) odSpan.style.color = 'var(--danger)';
                    });
                  }
                }
                
                suggestionsDiv.style.display = 'none';
                renderModal();
              });
            });
          };
          input.addEventListener('focus', () => {
            const list = selectorMembers.slice(0, 50);
            showSuggestions(list);
          });
          input.addEventListener('input', () => {
            const term = input.value.toLowerCase();
            clearTimeout(searchTimer);
            if (!term) {
              const list = selectorMembers.slice(0, 50);
              showSuggestions(list);
              return;
            }
            searchTimer = setTimeout(() => {
              const list = selectorMembers.filter(m =>
                (m.name && m.name.toLowerCase().includes(term)) ||
                (String(m.id).includes(term)) ||
                (m.mobile && m.mobile.includes(term))
              ).slice(0, 50);
              showSuggestions(list);
            }, 200);
          });
          // Bound once per input: guarantor rows re-render often and the old
          // anonymous handler stacked a document listener per setup.
          if (!input.dataset.outsideBound) {
            input.dataset.outsideBound = '1';
            document.addEventListener('click', (e) => {
              if (!input.contains(e.target) && !suggestionsDiv.contains(e.target)) {
                suggestionsDiv.style.display = 'none';
              }
            });
          }
        }
        
        if (!isReadOnly) {
          // Setup amount input
          const amtInput = row.querySelector('.guarantor-amt');
          if (amtInput) {
            amtInput.addEventListener('change', () => {
              modalState.guarantors[idx].amount = parseFloat(amtInput.value || 0);
              renderModal();
            });
          }
          
          // Setup remove button
          const removeBtn = row.querySelector('.remove-guarantor-btn');
          if (removeBtn) {
            removeBtn.addEventListener('click', () => {
              modalState.guarantors.splice(idx, 1);
              renderModal();
            });
          }
          
          // Resend handler: clicking a Declined badge resets it to Awaiting
          const badge = row.querySelector('.g-approval-badge');
          if (badge && badge.dataset.approval === '0') {
            badge.style.cursor = 'pointer';
            badge.addEventListener('click', () => {
              badge.dataset.approval = '';
              badge.textContent = '⏳ Awaiting (Resend)';
              badge.style.background = 'var(--warning-bg)';
              badge.style.color = 'var(--warning)';
              badge.style.cursor = 'default';
              badge.title = 'Will resend approval request on save';
              row.dataset.approval = '';
            });
          }
        }
        
        // Fetch stats for existing guarantors
        const mid = idInput?.value;
        if (mid && !isMember) {
          const statsDiv = row.querySelector('.g-stats-display');
          if (statsDiv) {
            fetchGuarantorStats(mid, user.cooperativeId).then(stats => {
              statsDiv.querySelector('.g-active-count').innerText = `Active: ${stats.activeCount}`;
              statsDiv.querySelector('.g-active-sum').innerText = `Total: ${formatCurrency(stats.activeSum)}`;
              const odSpan = statsDiv.querySelector('.g-overdue-count');
              odSpan.innerText = `Overdue: ${stats.overdueCount}`;
              if (stats.overdueCount > 0) odSpan.style.color = 'var(--danger)';
            });
          }
        }
      });
      
      // Helper to save charges changes
      const saveCharges = () => {
        // Ensure any pending input values are captured before saving
        const principalEl = document.getElementById('loan-principal');
        if (principalEl) modalState.loanData.principalAmount = parseFloat(principalEl.value || 0);
        
        const durationEl = document.getElementById('loan-duration');
        if (durationEl) modalState.loanData.durationMonths = parseInt(durationEl.value || 0);
        
        const dueDateEl = document.getElementById('loan-due-date');
        if (dueDateEl) modalState.loanData.dueDate = dueDateEl.value;
        
        const notesEl = document.getElementById('loan-notes');
        if (notesEl) modalState.loanData.notes = notesEl.value;

        // Update the detail in the current formData.details array to avoid stale closures
        const currentDetail = formData.details.find(d => String(d.enterprise_id || d.item || '') === String(enterpriseId));
        if (currentDetail) {
          currentDetail.loan_info = JSON.parse(JSON.stringify(modalState));
        }

        if (detail) {
          detail.loan_info = JSON.parse(JSON.stringify(modalState));
        }
        
        // Also update the dataset so syncFormData doesn't lose it if recreating rows
        const row = document.querySelector(`.detail-item-row[data-entid="${enterpriseId}"]`);
        if (row) {
          row.dataset.loaninfo = JSON.stringify(modalState);
        }
      };

      // Close button
      document.getElementById('modal-close-btn')?.addEventListener('click', () => {
        saveCharges();
        document.getElementById('loan-config-modal').remove();
      });

      // OK button - saves charges to formData in memory, no DB writes
      document.getElementById('modal-ok-btn')?.addEventListener('click', () => {
        saveCharges();
        document.getElementById('loan-config-modal').remove();
      });
    };

    const overlay = document.createElement('div');
    overlay.id = 'loan-config-modal';
    overlay.className = 'modal-overlay open';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '9999';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    renderModal();
}

export function showLoanReviewModal(
  formData,
  historyState,
  clearSavedFormFn,
  clearFormFn,
  loadHistoryDataFn,
  renderFn,
  showSimpleReviewModalFn
) {
  const modalId = 'loan-review-modal';
  const existing = document.getElementById(modalId);
  if (existing) existing.remove();

  const loanDetail = formData.details.find(d => d.loan_info);
  if (!loanDetail) {
    if (showSimpleReviewModalFn) showSimpleReviewModalFn();
    return;
  }

  const loanInfo = loanDetail.loan_info;
  const loanData = loanInfo.loanData;
  const requestRecord = (historyState.allRemittances || []).find(record => String(record.id) === String(formData.id)) || {};
  const readRequestImages = record => {
    const list = Array.isArray(record.withdrawal_form_images) ? record.withdrawal_form_images : [];
    if (list.length) return list;
    const legacy = record.withdrawal_form_image;
    if (Array.isArray(legacy)) return legacy;
    if (typeof legacy === 'string' && legacy.startsWith('[')) {
      try { const parsed = JSON.parse(legacy); if (Array.isArray(parsed)) return parsed; } catch {}
    }
    return typeof legacy === 'string' && legacy ? [legacy] : [];
  };
  const requestImages = readRequestImages(requestRecord).length ? readRequestImages(requestRecord) : readRequestImages(formData);
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
          ${requestImages.length ? `<section style="margin-bottom:1rem;padding:0.85rem;background:var(--bg-main);border:1px solid var(--border-light);border-radius:0.65rem;"><div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:center;"><strong>Physical form attachments</strong><span style="font-size:0.78rem;color:var(--text-muted);">${requestImages.length} image${requestImages.length === 1 ? '' : 's'}</span></div><div style="display:flex;flex-wrap:wrap;gap:0.65rem;margin-top:0.65rem;">${requestImages.map((src, index) => `<div style="display:flex;flex-direction:column;gap:0.35rem;align-items:center;"><button type="button" class="lr-request-image-preview" data-image-index="${index}" aria-label="View physical form image ${index + 1} full screen" style="padding:0;border:1px solid var(--border-medium);border-radius:0.45rem;background:transparent;cursor:zoom-in;"><img src="${escapeAttribute(src)}" alt="Physical form image ${index + 1}" style="display:block;width:120px;height:90px;object-fit:cover;border-radius:0.4rem;"></button><button type="button" class="lr-request-image-preview" data-image-index="${index}" style="padding:0.25rem 0.5rem;font-size:0.75rem;">View full screen</button></div>`).join('')}</div><p style="margin:0.6rem 0 0;font-size:0.78rem;color:var(--text-muted);">Select any thumbnail or View full screen to inspect the entire submitted form.</p></section>` : '<div style="margin-bottom:1rem;padding:0.8rem;border:1px solid var(--warning);border-radius:0.6rem;color:var(--text-muted);">No physical form images are attached to this request.</div>'}
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
    attachModalListeners();
  };

  const attachModalListeners = () => {
    modalDiv.querySelectorAll('.lr-request-image-preview').forEach(button => button.addEventListener('click', () => {
      const src = requestImages[Number(button.dataset.imageIndex)];
      if (!src) return;
      const viewer = document.createElement('div');
      viewer.className = 'modal-overlay open';
      Object.assign(viewer.style, { position: 'fixed', inset: '0', zIndex: '1000000', background: 'rgba(0,0,0,0.96)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' });
      viewer.innerHTML = `<button type="button" aria-label="Close physical form preview" style="position:fixed;top:1rem;right:1rem;z-index:1;width:46px;height:46px;border:0;border-radius:50%;background:#fff;color:#111;font-size:1.6rem;cursor:pointer;">&times;</button><img src="${escapeAttribute(src)}" alt="Physical withdrawal form full-screen preview" style="max-width:100%;max-height:100%;object-fit:contain;">`;
      const close = () => { viewer.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = event => { if (event.key === 'Escape') close(); };
      viewer.querySelector('button').addEventListener('click', close);
      viewer.addEventListener('click', event => { if (event.target === viewer) close(); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(viewer);
    }));
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
        await declineLoanRequest(formData.id, user.username || 'admin');
        showToast('Loan request declined.', 'success');
        modalDiv.remove();
        if (clearSavedFormFn) clearSavedFormFn();
        if (loadHistoryDataFn) await loadHistoryDataFn(true);
        if (clearFormFn) await clearFormFn();
        if (renderFn) renderFn();
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
        await approveLoanRequest(formData.id, user.username || 'admin', {
          remittance_date: dateVal,
          bank_name: bankVal,
          charges: JSON.parse(JSON.stringify(modalCharges)),
          details: formData.details
        });
        showToast('Loan request approved successfully!', 'success');
        modalDiv.remove();
        if (clearSavedFormFn) clearSavedFormFn();
        if (loadHistoryDataFn) await loadHistoryDataFn(true);
        if (clearFormFn) await clearFormFn();
        if (renderFn) renderFn();
      } catch (err) {
        console.error(err);
        showToast('Error approving loan request: ' + err.message, 'error');
      }
    });
  };

  renderModal();
}

