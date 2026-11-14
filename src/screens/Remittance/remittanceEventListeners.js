import { escapeHtml, generateId, wrapDateInput } from '../../utils/formatters.js';
import { hideWorkspaceSpinner, showWorkspaceSpinner } from '../../components/workspaceSpinner.js';
import { showToast } from '../../services/toastService.js';
import { showLoanConfigModal } from './remittanceLoanConfig.js';
import { showSimpleReviewModal, showLoanReviewModal } from './remittanceModal.js';
import { showWithdrawalWizard } from '../../components/WithdrawalWizard.js';
import { isMobile } from './constants.js';
import { save as persistState, load as loadPersisted } from '../../services/statePersistence.js';
import { fetchEnterprises, fetchMemberPaymentAdvise, calculateAdviceByEnterprise } from '../../services/dataService.js';
import { allocateAutoShare, formatPreview } from '../../services/autoShare/index.js';
import { showAutoSharePreview } from './auto-share-preview.js';

export function attachEventListeners(container, deps) {
    const { formData, enterpriseData, members, selectorMembers, openingBalances, paymentAdvise, showAllZeros, previewMode, editMode, historyState, panelSizes, user, isAdmin, isActualAdmin, cooperativeId, PANEL_SIZE_KEY, isMember, render, syncFormData, checkDirty, saveSavedForm, clearSavedForm, clearForm, loadHistoryData, handleMemberChange, handleSubmit, updateHistoryTable, updateDeleteSelectedButton, loadRemittanceToForm, attachImagePreview, trackFocus, isFormValid, restoreFocus } = deps;
    const mobile = isMobile();
    const openLoanRequestReview = () => {
      const details = Array.isArray(formData.details) ? formData.details : [];
      const loanDetail = details.find(detail => detail.loan_info) || details.find(detail => Number(detail.amount || 0) < 0);
      const mappedId = loanDetail?.enterprise_id || loanDetail?.item;
      const availableEnterprises = Array.isArray(enterpriseData) ? enterpriseData : [];
      const mappedEnterprise = mappedId ? availableEnterprises.find(enterprise => String(enterprise.id) === String(mappedId)) : null;
      const isLoanEnterprise = enterprise => String(enterprise?.account_type || enterprise?.type || '').toLowerCase() === 'loan';
      const loanEnterprise = isLoanEnterprise(mappedEnterprise) ? mappedEnterprise : availableEnterprises.find(isLoanEnterprise);
      const enterpriseId = loanEnterprise?.id || (!mappedEnterprise ? mappedId : '');
      if (!loanDetail || !enterpriseId) { showToast('This pending loan request has no mapped Loan enterprise. Map the row to a Loan enterprise before reviewing it.', 'error'); return; }
      loanDetail.enterprise_id = String(enterpriseId);
      const currentLoanData = loanDetail.loan_info?.loanData || {};
      const principal = Math.abs(Number(currentLoanData.principalAmount ?? currentLoanData.principal_amount ?? loanDetail.amount ?? 0));
      const duration = Number(currentLoanData.durationMonths ?? currentLoanData.duration_months ?? 0);
      const showReview = () => showLoanReviewModal(formData, enterpriseData, historyState, clearSavedForm, clearForm, loadHistoryData, render, deps);
      if (loanDetail.loan_info && principal > 0 && duration > 0) { showReview(); return; }
      const continueToReview = () => {
        const configuredDetail = details.find(detail => String(detail.enterprise_id || detail.item || '') === String(enterpriseId)) || loanDetail;
        const loanData = configuredDetail.loan_info?.loanData || {};
        const configuredPrincipal = Math.abs(Number(loanData.principalAmount ?? loanData.principal_amount ?? configuredDetail.amount ?? 0));
        const configuredDuration = Number(loanData.durationMonths ?? loanData.duration_months ?? 0);
        if (!(configuredPrincipal > 0) || !(configuredDuration > 0)) {
          showToast('Enter a valid principal and a loan duration greater than zero months to continue.', 'warning');
          showLoanConfigModal(String(enterpriseId), false, deps, continueToReview);
          return;
        }
        showReview();
      };
      showLoanConfigModal(String(enterpriseId), false, deps, continueToReview);
    };

    // --- Mobile Tab Switching (always bind; CSS hides tabs on desktop) ---
    const tabBtns = container.querySelectorAll('.mobile-tab-btn');
    const unifiedContainer = container.querySelector('.unified-container');
    if (tabBtns.length && unifiedContainer) {
      // Restore persisted active tab
      const savedTabVal = loadPersisted('remit-tab');
      if (savedTabVal) {
        unifiedContainer.setAttribute('data-mobile-tab', savedTabVal);
        tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === savedTabVal));
      }
      tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const tab = btn.dataset.tab;
          unifiedContainer.setAttribute('data-mobile-tab', tab);
          tabBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          persistState('remit-tab', tab);
        });
      });
    }

    const topSection = document.getElementById('top-section');
    if (topSection && !mobile) {
      if (panelSizes.topSectionHeight) {
        topSection.style.height = `${panelSizes.topSectionHeight}px`;
      } else {
        const h = Math.max(320, Math.floor(window.innerHeight * 0.55));
        topSection.style.height = `${h}px`;
        panelSizes.topSectionHeight = h;
      }
    }
    try {
      const saved = localStorage.getItem(PANEL_SIZE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.breakdownWidth && parsed.breakdownWidth !== 420) {
          const bp = document.getElementById('breakdown-panel');
          if (bp) bp.style.flex = `0 0 ${parsed.breakdownWidth}px`;
        }
      }
    } catch (e) {}
    const form = container.querySelector('#payment-form');
    if (form) {
      const updateAutoShareAvailability = () => {
        const autoShareBtn = container.querySelector('#auto-share-btn');
        if (!autoShareBtn) return;
        const amount = Number(formData.amount);
        const hasMember = !!formData.member_id && formData.member_id !== '0000000000';
        const hasRequiredFields = !!formData.remittance_date && !!formData.bank_name && amount > 0 && hasMember;
        const needsNote = String(formData.bank_name || '').toLowerCase() === 'internal transfer';
        const ready = hasRequiredFields && (!needsNote || !!String(formData.description || '').trim());
        autoShareBtn.disabled = !ready;
        autoShareBtn.title = ready
          ? 'Preview an automatic allocation of this remittance using the member’s payment advice'
          : 'Complete the required remittance fields before using Auto Share';
      };
      container.querySelectorAll('input[type="date"]').forEach(wrapDateInput);
      const adminCheck = container.querySelector('#admin-mode-check');
      if (adminCheck) {
        adminCheck.addEventListener('change', async (e) => {
          trackFocus();
          syncFormData();
          const targetMid = e.target.checked ? '0000000000' : '';
          await handleMemberChange(targetMid);
          render();
        });
      }
      form.addEventListener('input', () => {
        const wasValid = isFormValid();
        syncFormData();
        saveSavedForm(formData);
        updateAutoShareAvailability();
        const nowValid = isFormValid();
        if (wasValid !== nowValid) {
          const submitBtn = document.getElementById('submit-log-btn') || document.getElementById('update-log-btn');
          if (submitBtn) {
            submitBtn.disabled = !nowValid;
          }
        }
      });
      form.addEventListener('change', () => {
        trackFocus();
        syncFormData();
        saveSavedForm(formData);
        checkDirty();
        updateAutoShareAvailability();
        if (isFormValid()) {
          formData.details.forEach(d => {
            const ent = enterpriseData.find(e => e.id === (d.enterprise_id || d.item));
            if (!ent) return;
            const getAccountType = (acc) => (acc?.account_type || acc?.type || acc?.Account_Type || '').toLowerCase();
            if (getAccountType(ent) === 'loan' && parseFloat(d.amount || 0) < 0 && (!d.loan_info || !d.loan_info.loanData?.durationMonths)) {
              showLoanConfigModal(d.enterprise_id || d.item, false, deps);
            }
          });
        }
      });
      updateAutoShareAvailability();
      const memSearch = container.querySelector('#member-search-input');
      const memSuggestions = container.querySelector('#member-search-suggestions');
      const memSelect = container.querySelector('#member-id-select');
      const memDisplay = container.querySelector('#selected-member-display');
      const resetMemberBtn = container.querySelector('#reset-member-btn');
      const memberRow = container.querySelector('.member-row');
      if (memSearch && memSuggestions && selectorMembers.length > 0) {
        const getFullName = (m) => {
          if (!m) return '';
          return [m.first_name, m.middle_name, m.last_name].map(s => String(s || '').trim()).filter(Boolean).join(' ') || m.name || '';
        };
        const renderSuggestions = (term) => {
          if (!term) { memSuggestions.style.display = 'none'; return; }
          const filtered = selectorMembers.filter(m =>
            (String(m.registration_no || '').toLowerCase().includes(term)) ||
            (String(m.name || '').toLowerCase().includes(term)) ||
            (getFullName(m).toLowerCase().includes(term)) ||
            ([m.last_name, m.first_name, m.middle_name].map(s => String(s || '').trim()).filter(Boolean).join(' ').toLowerCase().includes(term)) ||
            (String(m.first_name || '').toLowerCase().includes(term)) ||
            (String(m.middle_name || '').toLowerCase().includes(term)) ||
            (String(m.last_name || '').toLowerCase().includes(term)) ||
            (String(m.mobile || '').includes(term)) ||
            (String(m.special_id || '').toLowerCase().includes(term))
          ).slice(0, 10);
          if (filtered.length === 0) {
            memSuggestions.innerHTML = '<div style="padding: 0.75rem; font-size: 0.825rem; color: var(--text-muted);">No matches found</div>';
          } else {
            memSuggestions.innerHTML = filtered.map(m => `
              <div class="suggestion-item" data-id="${m.id}" style="padding: 0.6rem 0.75rem; font-size: 0.825rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
                <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(getFullName(m))}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted);">
                  ${m.special_id ? `ID: ${escapeHtml(m.special_id)}` : ''} ${m.special_id && (m.registration_no || m.mobile) ? ' • ' : ''} ${m.registration_no ? `Reg: ${m.registration_no}` : ''} ${(m.special_id || m.registration_no) && m.mobile ? ' • ' : ''} ${m.mobile ? `Mobile: ${m.mobile}` : ''}
                </div>
              </div>
            `).join('');
          }
          const rect = memSearch.getBoundingClientRect();
          memSuggestions.style.position = 'fixed';
          memSuggestions.style.top = `${rect.bottom + window.scrollY}px`;
          memSuggestions.style.left = `${rect.left + window.scrollX}px`;
          memSuggestions.style.width = `${rect.width}px`;
          memSuggestions.style.zIndex = '999999';
          memSuggestions.style.display = 'block';
          memSuggestions.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('mousedown', async (e) => {
              e.preventDefault();
              const mid = item.dataset.id;
              const m = members.find(m => m.id === mid);
              memSelect.value = mid;
              memSearch.value = m ? getFullName(m) : '';
              memSuggestions.style.display = 'none';
              if (typeof syncFormData === 'function') syncFormData();
              await handleMemberChange(mid);
            });
          });
        };
        memSearch.addEventListener('input', (e) => {
          renderSuggestions(e.target.value.toLowerCase());
        });
        const updateDropdownPosition = () => {
          if (memSuggestions.style.display === 'block') {
            const rect = memSearch.getBoundingClientRect();
            memSuggestions.style.top = `${rect.bottom + window.scrollY}px`;
            memSuggestions.style.left = `${rect.left + window.scrollX}px`;
            memSuggestions.style.width = `${rect.width}px`;
          }
        };
        // Global listeners are replaced (not stacked): this setup re-runs on
        // every remittance-page render and old closures retain dead DOM + datasets.
        if (window._remitMemPos) window.removeEventListener('scroll', window._remitMemPos, true);
        if (window._remitMemResize) window.removeEventListener('resize', window._remitMemResize);
        if (window._remitMemOutside) document.removeEventListener('click', window._remitMemOutside);
        window._remitMemPos = updateDropdownPosition;
        window._remitMemResize = updateDropdownPosition;
        window._remitMemOutside = (e) => {
          if (!memSearch.contains(e.target) && !memSuggestions.contains(e.target)) {
            memSuggestions.style.display = 'none';
          }
        };
        window.addEventListener('scroll', window._remitMemPos, true);
        window.addEventListener('resize', window._remitMemResize);
        document.addEventListener('click', window._remitMemOutside);
      }
      if (resetMemberBtn) {
        resetMemberBtn.addEventListener('click', async () => {
          trackFocus();
          const memSearch = container.querySelector('#member-search-input');
          if (memSearch) memSearch.value = '';
          await handleMemberChange('');
          render();
        });
      }
      container.querySelectorAll('.clear-on-zero').forEach(input => {
        input.addEventListener('focus', () => {
          if (parseFloat(input.value) === 0) input.value = '';
        });
        if (input.classList.contains('detail-amt-grid')) {
          const handleInput = () => {
            const row = input.closest('.detail-item-row');
            if (!row) return;
            const entId = row.dataset.entid;
            const ent = enterpriseData.find(e => e.id === entId);
            if (!ent) return;
            const type = (ent.account_type || ent.type || '').toLowerCase();
            const opening = parseFloat(input.dataset.opening || 0);
            let valStr = input.value;
            if (valStr === '' || valStr === '-' || valStr === '.' || valStr === '-.') return;
            let val = parseFloat(valStr || 0);
            if (isNaN(val)) val = 0;
            const isCoopWide = formData.member_id === '0000000000';
            const isInternalTransfer = (formData.bank_name || '').toLowerCase() === 'internal transfer';
            let clampedVal = val;
            if (!isCoopWide && !isInternalTransfer) {
              if (type === 'savings') {
                if (clampedVal < -opening) clampedVal = -opening;
              } else if (type === 'loan') {
                const maxRepayment = -opening;
                if (clampedVal > maxRepayment) clampedVal = maxRepayment;
                if (ent.parent_account && ent.loan_multiplier) {
                  const parentBal = openingBalances[ent.parent_account] || 0;
                  const borrowingLimit = -(parentBal * ent.loan_multiplier);
                  const minInput = borrowingLimit - opening;
                  if (clampedVal < minInput) clampedVal = minInput;
                }
              }
            }
            if (clampedVal !== val) {
              input.value = clampedVal;
              val = clampedVal;
            }
            const isFinanciallyActive = !formData.status || formData.status === 'Approved';
            const closing = isFinanciallyActive ? opening + val : opening;
            input.style.color = val < 0 ? 'var(--danger)' : 'inherit';
            const closingCell = row.querySelector('.row-closing-bal');
            if (closingCell) {
              closingCell.textContent = closing === 0 ? '-' : closing.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2});
              closingCell.style.color = closing < 0 ? 'var(--danger)' : 'inherit';
            }
            const nameCell = row.querySelector('td:first-child');
            const existingDetail = formData.details.find(d => (d.enterprise_id || d.item) === entId);
            const hasExistingLoanInfo = !!(existingDetail?.loan_info);
            const isLoanCondition = type === 'loan' && !isInternalTransfer && !isCoopWide && (val < 0 || hasExistingLoanInfo);
            if (nameCell) {
              if (isLoanCondition || hasExistingLoanInfo) {
                nameCell.style.color = 'var(--accent-primary)';
                nameCell.style.fontWeight = '600';
                nameCell.style.textDecoration = 'underline';
              } else {
                nameCell.style.color = 'inherit';
                nameCell.style.fontWeight = 'normal';
                nameCell.style.textDecoration = 'none';
              }
            }
            syncFormData();
            saveSavedForm(formData);
            checkDirty();
          };
          input.addEventListener('input', handleInput);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const allInputs = Array.from(container.querySelectorAll('.detail-amt-grid'));
              const currentIdx = allInputs.indexOf(input);
              const targetIdx = e.key === 'ArrowUp' ? currentIdx - 1 : currentIdx + 1;
              if (targetIdx >= 0 && targetIdx < allInputs.length) {
                allInputs[targetIdx].focus();
                allInputs[targetIdx].select();
              }
            }
          });
        }
        input.addEventListener('blur', () => {
          if (input.value === '' || input.value === '-' || input.value === '.' || input.value === '-.') input.value = '0';
          if (input.classList.contains('detail-amt-grid')) {
            syncFormData();
            const row = input.closest('.detail-item-row');
            if (row) {
              const entId = row.dataset.entid;
              const d = formData.details.find(detail => (detail.enterprise_id || detail.item) === entId);
              if (d) {
                const ent = enterpriseData.find(e => e.id === (d.enterprise_id || d.item));
                const getAccountType = (acc) => (acc?.account_type || acc?.type || acc?.Account_Type || '').toLowerCase();
                const isLoan = getAccountType(ent) === 'loan';
                const bankName = formData.bank_name || '';
                const isInternalTransfer = (bankName || '').toLowerCase() === 'internal transfer';
                const isGlobalAdminNode = formData.member_id === '0000000000';
                const amtValue = parseFloat(d.amount || 0);
                const isLoanCondition = isLoan && !isInternalTransfer && !isGlobalAdminNode && amtValue < 0;
                if (isLoanCondition) {
                  if (!d.loan_info || !d.loan_info.loanData?.durationMonths) {
                    showLoanConfigModal(entId, false, deps);
                  } else {
                    const iconBtn = row.querySelector('.config-loan-btn');
                    if (iconBtn) {
                      iconBtn.classList.add('configured');
                      iconBtn.style.background = 'var(--success-bg)';
                      iconBtn.style.borderColor = 'var(--success)';
                      iconBtn.style.color = 'var(--success)';
                    }
                  }
                }
              }
            }
          }
        });
      });
      container.querySelectorAll('.config-loan-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const entId = btn.closest('.detail-item-row').dataset.entid;
          const isReadOnly = btn.dataset.readonly === 'true';
          syncFormData();
          if (entId) {
            showLoanConfigModal(entId, isReadOnly, deps);
          }
        });
      });
      container.querySelector('#toggle-show-zeros-check')?.addEventListener('change', (e) => {
        deps.showAllZeros = e.target.checked;
        render();
      });
      container.querySelector('#withdrawal-request-btn')?.addEventListener('click', () => showWithdrawalWizard());
      container.querySelector('#clear-log-btn')?.addEventListener('click', () => {
        clearForm();
      });
      container.querySelector('#auto-share-btn')?.addEventListener('click', async () => {
        trackFocus();
        const { cooperativeId } = deps;
        if (!cooperativeId) {
          showToast('Error: Cooperative ID missing.', 'error');
          return;
        }
        
        // Get the current member ID from form data
        const memberId = formData.member_id;
        if (!memberId || memberId === '0000000000') {
          showToast('Please select a member first.', 'warning');
          return;
        }
        if (!(Number(formData.amount) > 0)) {
          showToast('Auto Share is available only for positive remittance amounts.', 'warning');
          return;
        }
        
        // Show loading state
        showWorkspaceSpinner(container);
        
        try {
          // Load member payment advice
          const adviceTable = await fetchMemberPaymentAdvise(memberId);
          
          // Build advice map
          // Load enterprises
          const enterprises = await fetchEnterprises(cooperativeId, true);
          const activeEnterprises = enterprises.filter(e => !(e.is_deleted === 1 || e.deleted === 1));
          const adviceByEnterprise = calculateAdviceByEnterprise(
            activeEnterprises,
            adviceTable,
            Object.entries(openingBalances || {}).map(([id, sum_of_amount]) => ({ id, sum_of_amount }))
          );
          
          // Run allocation
          const allocationResult = allocateAutoShare({
            remittanceAmount: formData.amount,
            enterprises: activeEnterprises,
            adviceByEnterprise,
            balanceByEnterprise: openingBalances,
            member: formData.member_id ? { id: memberId } : undefined
          });
          
          // Format preview
          const preview = formatPreview(allocationResult, 2);
          
          // Hide spinner
          hideWorkspaceSpinner(container);
          
          // Show preview modal
          showAutoSharePreview(preview, memberId, cooperativeId, deps);
        } catch (err) {
          hideWorkspaceSpinner(container);
          showToast('Error running Auto Share: ' + err.message, 'error');
          console.error('[autoShare] Error:', err);
        }
      });
      
      (() => { let t=null; let longPressed=false; const btn=container.querySelector('#submit-log-btn'); if(!btn) return; btn.addEventListener('mousedown', () => { longPressed=false; t=setTimeout(()=>{ longPressed=true; window.__remitDevBypass=true; handleSubmit(); }, 600); }); btn.addEventListener('mouseup', () => { if(t){clearTimeout(t); t=null;} }); btn.addEventListener('mouseleave', () => { if(t){clearTimeout(t); t=null;} }); btn.addEventListener('click', (e) => { if(longPressed){ longPressed=false; window.__remitDevBypass=false; e.preventDefault(); e.stopPropagation(); return; } window.__remitDevBypass=false; handleSubmit(); }); })();
      (() => { let t=null; let longPressed=false; const btn=container.querySelector('#update-log-btn'); if(!btn) return; btn.addEventListener('mousedown', () => { longPressed=false; t=setTimeout(()=>{ longPressed=true; window.__remitDevBypass=true; handleSubmit(); }, 600); }); btn.addEventListener('mouseup', () => { if(t){clearTimeout(t); t=null;} }); btn.addEventListener('mouseleave', () => { if(t){clearTimeout(t); t=null;} }); btn.addEventListener('click', (e) => { if(longPressed){ longPressed=false; window.__remitDevBypass=false; e.preventDefault(); e.stopPropagation(); return; } window.__remitDevBypass=false; handleSubmit(); }); })();
      container.querySelector('#review-log-btn')?.addEventListener('click', async () => {
        const firstLoanDetail = formData.details.find(d => d.loan_info);
        if (formData.isLoanRequest && formData.status === 'Pending') {
          openLoanRequestReview();
        } else if (firstLoanDetail) {
          showLoanReviewModal(formData, enterpriseData, historyState, clearSavedForm, clearForm, loadHistoryData, render, deps);
        } else {
          showSimpleReviewModal(formData, enterpriseData, historyState, clearSavedForm, clearForm, loadHistoryData, render, deps);
        }
      });
    }
    const selectedMember = formData.member_id ? historyState.membersMap[formData.member_id] : null;
    if (selectedMember) {
      attachImagePreview(selectedMember);
    }
    const tbody = container.querySelector('#history-tbody');
    if (tbody) {
      const selectRow = async (idx) => {
        const rows = tbody.querySelectorAll('tr[data-id]');
        if (idx < 0 || idx >= rows.length) return;
        const row = rows[idx];
        const id = row.dataset.id;
        const remit = historyState.allRemittances[idx];
        if (!remit) return;
        historyState.selectedRemittanceId = id;
        historyState.selectedRemittanceIds.clear();
        historyState.selectedRemittanceIds.add(id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        await loadRemittanceToForm(remit);
        // Auto-open review modal for pending loan requests
        if (formData.isLoanRequest && formData.status === 'Pending' && deps.canApprove) {
          openLoanRequestReview();
          return;
        }
        row.scrollIntoView({ block: 'nearest' });
      };

      tbody.addEventListener('click', async (e) => {
        try {
          // Ignore clicks on checkboxes, buttons, and expand toggles
          if (e.target.closest('input[type="checkbox"]') || e.target.closest('button') || e.target.closest('.expand-toggle')) {
            return;
          }
          const row = e.target.closest('tr[data-id]');
          if (!row) return;

          const id = row.dataset.id;
          const isChildRow = row.classList.contains('child-row');

          // --- Child row click: load child as read-only preview ---
          if (isChildRow) {
            const parentId = row.dataset.parentId;
            let childRemit = null;
            if (parentId) {
              const parent = historyState.allRemittances.find(r => String(r.id) === String(parentId));
              if (parent && parent.children) {
                childRemit = parent.children.find(c => String(c.id) === String(id));
              }
            }
            if (!childRemit) {
              for (const parent of historyState.allRemittances) {
                if (parent.children) {
                  childRemit = parent.children.find(c => String(c.id) === String(id));
                  if (childRemit) break;
                }
              }
            }
            if (childRemit) {
              historyState.selectedRemittanceId = id;
              historyState.selectedRemittanceIds.clear();
              historyState.selectedRemittanceIds.add(id);
              updateHistoryTable();
              updateDeleteSelectedButton();
              await loadRemittanceToForm(childRemit);
            }
            return;
          }

          // --- Parent row click ---
          const idx = parseInt(row.dataset.rowIndex, 10);
          const remit = idx >= 0 && idx < historyState.allRemittances.length ? historyState.allRemittances[idx] : null;
          if (remit) {
            if (e.ctrlKey || e.metaKey) {
              if (historyState.selectedRemittanceIds.has(id)) {
                historyState.selectedRemittanceIds.delete(id);
              } else {
                historyState.selectedRemittanceIds.add(id);
              }
              updateHistoryTable();
              updateDeleteSelectedButton();
            } else if (e.shiftKey && historyState.selectedRemittanceId) {
              const anchorIdx = historyState.allRemittances.findIndex(r => r.id === historyState.selectedRemittanceId);
              if (anchorIdx === -1) {
                historyState.selectedRemittanceId = id;
                historyState.selectedRemittanceIds.clear();
                historyState.selectedRemittanceIds.add(id);
              } else {
                const minIdx = Math.min(anchorIdx, idx);
                const maxIdx = Math.max(anchorIdx, idx);
                historyState.selectedRemittanceIds.clear();
                for (let i = minIdx; i <= maxIdx; i++) {
                  historyState.selectedRemittanceIds.add(historyState.allRemittances[i].id);
                }
              }
              updateHistoryTable();
              updateDeleteSelectedButton();
              await loadRemittanceToForm(remit);
            } else {
              historyState.selectedRemittanceId = id;
              historyState.selectedRemittanceIds.clear();
              historyState.selectedRemittanceIds.add(id);
              updateHistoryTable();
              updateDeleteSelectedButton();
              await loadRemittanceToForm(remit);
            }
          }
        } catch (err) {
          console.error('[RowClick] Error selecting row:', err);
        }
      });

      // Replaced (not stacked) on every history render — see note above.
      if (window._remitHistArrowNav) document.removeEventListener('keydown', window._remitHistArrowNav);
      window._remitHistArrowNav = (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const active = document.activeElement;
        if (active && active.closest('.history-table-container') !== container.querySelector('.history-table-container')) return;
        e.preventDefault();
        const rows = Array.from(tbody.querySelectorAll('tr[data-id]'));
        if (!rows.length) return;
        const curIdx = rows.findIndex(r => r.dataset.id === historyState.selectedRemittanceId);
        const nextIdx = curIdx === -1 ? 0 : (e.key === 'ArrowDown' ? Math.min(curIdx + 1, rows.length - 1) : Math.max(curIdx - 1, 0));
        selectRow(nextIdx);
      };
      document.addEventListener('keydown', window._remitHistArrowNav);
    }
    function updateBreakdownTable() {
      const tableContainer = container.querySelector('.breakdown-table-container');
      if (!tableContainer) return;

      const detailsMap = (formData.details || []).reduce((acc, d) => ({ ...acc, [d.enterprise_id || d.item]: d }), {});
      let rowsHtml = '';
      enterpriseData.forEach((e, idx) => {
        const opening = parseFloat(openingBalances[e.id] || 0);
        const advise = parseFloat(paymentAdvise[e.id] || 0);
        const existingDetail = detailsMap[e.id];
        let inputAmt = existingDetail ? parseFloat(existingDetail.amount || 0) : 0;
        const isFinanciallyActive = !formData.status || formData.status === 'Approved';
        const closing = isFinanciallyActive ? opening + inputAmt : opening;
        const hasLoanInfo = !!existingDetail?.loan_info;
        const getAccountType = (acc) => (acc?.account_type || acc?.type || '').toLowerCase();
        const isLoan = getAccountType(e) === 'loan';
        const isInternalTransfer = (formData.bank_name || '').toLowerCase() === 'internal transfer';
        const isCoopWide = formData.member_id === '0000000000';
        const isLoanCondition = isLoan && !isInternalTransfer && !isCoopWide && (inputAmt < 0 || hasLoanInfo);
        if (!showAllZeros && opening === 0 && advise === 0 && inputAmt === 0 && !hasLoanInfo && !e.compulsory_due) return;

        rowsHtml += `
          <tr class="detail-item-row" data-entid="${e.id}" data-id="${existingDetail?.id || generateId(String(user.cooperativeId))}" data-loaninfo='${JSON.stringify(existingDetail?.loan_info || {})}' data-row-index="${idx}">
            <td style="padding: 0.4rem 0.6rem; text-align: left; ${isLoanCondition || hasLoanInfo ? 'color: var(--accent-primary); font-weight: 600; text-decoration: underline;' : ''}">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
                <span style="display: flex; align-items: center; gap: 0.35rem;">
                  ${e.compulsory_due ? `<span style="background: var(--accent-primary); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1; text-decoration: none; display: inline-block;">C</span>` : ''}
                  ${e.is_penalty ? `<span style="background: var(--danger); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1; text-decoration: none; display: inline-block;">P</span>` : ''}
                  ${escapeHtml(e.account_name || e.id)}
                </span>
                ${isLoan ? `
                  <button type="button" class="config-loan-btn ${hasLoanInfo ? 'configured' : ''}" data-entid="${e.id}" data-readonly="${previewMode && !editMode}">
                    ${hasLoanInfo ? 'View Details' : (previewMode && !editMode) ? 'View Details' : 'Configure'}
                  </button>
                ` : ''}
              </div>
            </td>
            <td style="padding: 0.4rem 0.6rem; color: ${opening < 0 ? 'var(--danger)' : 'inherit'}">
              ${opening === 0 ? '-' : opening.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </td>
            <td style="padding: 0.4rem 0.6rem; color: var(--text-muted)">
              ${advise === 0 ? '-' : advise.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </td>
            <td style="padding: 0.2rem;">
              <input type="number" step="0.01" class="detail-amt-grid clear-on-zero" data-opening="${opening}" value="${inputAmt}" data-row-index="${idx}" ${(previewMode && !editMode) || e.compulsory_due ? 'disabled' : ''} ${!(previewMode && !editMode) && e.compulsory_due ? 'title="Compulsory due — charged separately on save"' : ''}>
            </td>
            <td class="row-closing-bal" style="padding: 0.4rem 0.6rem; font-weight: 600; color: ${closing < 0 ? 'var(--danger)' : 'inherit'}">
              ${closing === 0 ? '-' : closing.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
            </td>
          </tr>
        `;
      });

      if (!rowsHtml) {
        rowsHtml = '<tr><td colspan="5" style="padding: 1.5rem; text-align: center; color: #94a3b8; font-style: italic;">No active balances to display. Check "Show All" to view hidden accounts.</td></tr>';
      }

      tableContainer.querySelector('tbody').innerHTML = rowsHtml;

      const totalDist = (formData.details || []).reduce((s, d) => s + (d.amount || 0), 0);
      const distTotalCell = container.querySelector('#dist-total-cell');
      if (distTotalCell) {
        distTotalCell.textContent = totalDist.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2});
        distTotalCell.style.color = totalDist < 0 ? 'var(--danger)' : 'inherit';
      }
      const distDiffCell = container.querySelector('#dist-diff-cell');
      if (distDiffCell) {
        const diff = formData.amount - totalDist;
        distDiffCell.textContent = diff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2});
        distDiffCell.style.color = Math.abs(diff) < 0.01 ? 'var(--success)' : 'var(--danger)';
      }

      container.querySelectorAll('.clear-on-zero').forEach(input => {
        input.addEventListener('focus', () => {
          if (parseFloat(input.value) === 0) input.value = '';
        });
        if (input.classList.contains('detail-amt-grid')) {
          const handleInput = () => {
            const row = input.closest('.detail-item-row');
            if (!row) return;
            const entId = row.dataset.entid;
            const ent = enterpriseData.find(e => e.id === entId);
            if (!ent) return;
            const type = (ent.account_type || ent.type || '').toLowerCase();
            const opening = parseFloat(input.dataset.opening || 0);
            let valStr = input.value;
            if (valStr === '' || valStr === '-' || valStr === '.' || valStr === '-.') return;
            let val = parseFloat(valStr || 0);
            if (isNaN(val)) val = 0;
            const isCoopWide = formData.member_id === '0000000000';
            const isInternalTransfer = (formData.bank_name || '').toLowerCase() === 'internal transfer';
            let clampedVal = val;
            if (!isCoopWide && !isInternalTransfer) {
              if (type === 'savings') {
                if (clampedVal < -opening) clampedVal = -opening;
              } else if (type === 'loan') {
                const maxRepayment = -opening;
                if (clampedVal > maxRepayment) clampedVal = maxRepayment;
                if (ent.parent_account && ent.loan_multiplier) {
                  const parentBal = openingBalances[ent.parent_account] || 0;
                  const borrowingLimit = -(parentBal * ent.loan_multiplier);
                  const minInput = borrowingLimit - opening;
                  if (clampedVal < minInput) clampedVal = minInput;
                }
              }
            }
            if (clampedVal !== val) {
              input.value = clampedVal;
              val = clampedVal;
            }
            const isFinanciallyActive = !formData.status || formData.status === 'Approved';
            const closing = isFinanciallyActive ? opening + val : opening;
            input.style.color = val < 0 ? 'var(--danger)' : 'inherit';
            const closingCell = row.querySelector('.row-closing-bal');
            if (closingCell) {
              closingCell.textContent = closing === 0 ? '-' : closing.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2});
              closingCell.style.color = closing < 0 ? 'var(--danger)' : 'inherit';
            }
            const nameCell = row.querySelector('td:first-child');
            const existingDetail = formData.details.find(d => (d.enterprise_id || d.item) === entId);
            const hasExistingLoanInfo = !!(existingDetail?.loan_info);
            const isLoanCondition = type === 'loan' && !isInternalTransfer && !isCoopWide && (val < 0 || hasExistingLoanInfo);
            if (nameCell) {
              if (isLoanCondition || hasExistingLoanInfo) {
                nameCell.style.color = 'var(--accent-primary)';
                nameCell.style.fontWeight = '600';
                nameCell.style.textDecoration = 'underline';
              } else {
                nameCell.style.color = 'inherit';
                nameCell.style.fontWeight = 'normal';
                nameCell.style.textDecoration = 'none';
              }
            }
            syncFormData();
            saveSavedForm(formData);
            checkDirty();
          };
          input.addEventListener('input', handleInput);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const allInputs = Array.from(container.querySelectorAll('.detail-amt-grid'));
              const currentIdx = allInputs.indexOf(input);
              const targetIdx = e.key === 'ArrowUp' ? currentIdx - 1 : currentIdx + 1;
              if (targetIdx >= 0 && targetIdx < allInputs.length) {
                allInputs[targetIdx].focus();
                allInputs[targetIdx].select();
              }
            }
          });
        }
        input.addEventListener('blur', () => {
          if (input.value === '' || input.value === '-' || input.value === '.' || input.value === '-.') input.value = '0';
          if (input.classList.contains('detail-amt-grid')) {
            syncFormData();
            const row = input.closest('.detail-item-row');
            if (row) {
              const entId = row.dataset.entid;
              const d = formData.details.find(detail => (detail.enterprise_id || detail.item) === entId);
              if (d) {
                const ent = enterpriseData.find(e => e.id === (d.enterprise_id || d.item));
                const getAccountType = (acc) => (acc?.account_type || acc?.type || acc?.Account_Type || '').toLowerCase();
                const isLoan = getAccountType(ent) === 'loan';
                const bankName = formData.bank_name || '';
                const isInternalTransfer = (bankName || '').toLowerCase() === 'internal transfer';
                const isGlobalAdminNode = formData.member_id === '0000000000';
                const amtValue = parseFloat(d.amount || 0);
                const isLoanCondition = isLoan && !isInternalTransfer && !isGlobalAdminNode && amtValue < 0;
                if (isLoanCondition) {
                  if (!d.loan_info || !d.loan_info.loanData?.durationMonths) {
                    showLoanConfigModal(entId, false, deps);
                  } else {
                    const iconBtn = row.querySelector('.config-loan-btn');
                    if (iconBtn) {
                      iconBtn.classList.add('configured');
                      iconBtn.style.background = 'var(--success-bg)';
                      iconBtn.style.borderColor = 'var(--success)';
                      iconBtn.style.color = 'var(--success)';
                    }
                  }
                }
              }
            }
          }
        });
      });

      container.querySelectorAll('.config-loan-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const entId = btn.closest('.detail-item-row').dataset.entid;
          const isReadOnly = btn.dataset.readonly === 'true';
          syncFormData();
          if (entId) {
            showLoanConfigModal(entId, isReadOnly, deps);
          }
        });
      });
    }

    let searchTimeout;
    const historySearchInput = container.querySelector('#history-search-input');
    if (historySearchInput) {
      historySearchInput.addEventListener('input', (e) => {
        historyState.searchTerm = e.target.value;
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
          await loadHistoryData(true);
          updateHistoryTable();
        }, 300);
      });
    }
    const searchColumnSelect = container.querySelector('#search-column-select');
    if (searchColumnSelect) {
      searchColumnSelect.addEventListener('change', async (e) => {
        historyState.searchColumn = e.target.value;
        await loadHistoryData(true);
        updateHistoryTable();
      });
    }
    // Replaced (not stacked) on every history setup — same leak as above.
    if (window._remitHistKeys) document.removeEventListener('keydown', window._remitHistKeys);
    window._remitHistKeys = async (e) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return;
      }
      let idx = historyState.allRemittances.findIndex(r => r.id === historyState.selectedRemittanceId);
      if (e.key === 'ArrowUp' && idx > 0) {
        e.preventDefault();
        const newIdx = idx - 1;
        const newRemit = historyState.allRemittances[newIdx];
        historyState.selectedRemittanceId = newRemit.id;
        if (!e.shiftKey) {
          historyState.selectedRemittanceIds.clear();
        }
        historyState.selectedRemittanceIds.add(newRemit.id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        const row = container.querySelector(`tr[data-id="${newRemit.id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowDown' && idx < historyState.allRemittances.length - 1) {
        e.preventDefault();
        const newIdx = idx + 1;
        const newRemit = historyState.allRemittances[newIdx];
        historyState.selectedRemittanceId = newRemit.id;
        if (!e.shiftKey) {
          historyState.selectedRemittanceIds.clear();
        }
        historyState.selectedRemittanceIds.add(newRemit.id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        const row = container.querySelector(`tr[data-id="${newRemit.id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Home' && historyState.allRemittances.length > 0) {
        e.preventDefault();
        const newRemit = historyState.allRemittances[0];
        historyState.selectedRemittanceId = newRemit.id;
        if (!e.shiftKey) {
          historyState.selectedRemittanceIds.clear();
        }
        historyState.selectedRemittanceIds.add(newRemit.id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        const row = container.querySelector(`tr[data-id="${newRemit.id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'End' && historyState.allRemittances.length > 0) {
        e.preventDefault();
        const newRemit = historyState.allRemittances[historyState.allRemittances.length - 1];
        historyState.selectedRemittanceId = newRemit.id;
        if (!e.shiftKey) {
          historyState.selectedRemittanceIds.clear();
        }
        historyState.selectedRemittanceIds.add(newRemit.id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        const row = container.querySelector(`tr[data-id="${newRemit.id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        if (historyState.allRemittances.length === 0) return;
        const pageSize = 10;
        const newIdx = Math.max(0, idx === -1 ? 0 : idx - pageSize);
        const newRemit = historyState.allRemittances[newIdx];
        historyState.selectedRemittanceId = newRemit.id;
        if (!e.shiftKey) {
          historyState.selectedRemittanceIds.clear();
        }
        historyState.selectedRemittanceIds.add(newRemit.id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        const row = container.querySelector(`tr[data-id="${newRemit.id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        if (historyState.allRemittances.length === 0) return;
        const pageSize = 10;
        const newIdx = Math.min(historyState.allRemittances.length - 1, idx === -1 ? 0 : idx + pageSize);
        const newRemit = historyState.allRemittances[newIdx];
        historyState.selectedRemittanceId = newRemit.id;
        if (!e.shiftKey) {
          historyState.selectedRemittanceIds.clear();
        }
        historyState.selectedRemittanceIds.add(newRemit.id);
        updateHistoryTable();
        updateDeleteSelectedButton();
        const row = container.querySelector(`tr[data-id="${newRemit.id}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    };
    document.addEventListener('keydown', window._remitHistKeys);
    // --- Resizers: desktop only ---
    if (!mobile) {
      const resizerV = document.getElementById('resizer-v');
      if (resizerV) {
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;
        resizerV.addEventListener('mousedown', (e) => {
          isResizing = true;
          startX = e.clientX;
          const breakdownPanel = document.getElementById('breakdown-panel');
          if (breakdownPanel) {
            startWidth = breakdownPanel.offsetWidth;
          }
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        });
        const onMouseMove = (e) => {
          if (!isResizing) return;
          const containerRect = container.getBoundingClientRect();
          const delta = startX - e.clientX;
          const newWidth = startWidth + delta;
          const minWidth = 300;
          const maxWidth = containerRect.width - 400;
          const breakdownPanel = document.getElementById('breakdown-panel');
          if (breakdownPanel && newWidth >= minWidth && newWidth <= maxWidth) {
            breakdownPanel.style.flex = `0 0 ${newWidth}px`;
            panelSizes.breakdownWidth = newWidth;
          }
        };
        const onMouseUp = () => {
          isResizing = false;
          localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSizes));
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };
      }
      const resizerH = document.getElementById('resizer-h');
      if (resizerH) {
        let isResizing = false;
        let startY = 0;
        let startTopHeight = 0;
        resizerH.addEventListener('mousedown', (e) => {
          isResizing = true;
          startY = e.clientY;
          const topSection = document.getElementById('top-section');
          if (topSection) {
            startTopHeight = topSection.offsetHeight;
          }
          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        });
        const onMouseMove = (e) => {
          if (!isResizing) return;
          const topSection = document.getElementById('top-section');
          if (topSection) {
            const newHeight = startTopHeight + (e.clientY - startY);
            const minHeight = 400;
            const maxHeight = window.innerHeight - 400;
            if (newHeight >= minHeight && newHeight <= maxHeight) {
              topSection.style.height = `${newHeight}px`;
              panelSizes.topSectionHeight = newHeight;
            }
          }
        };
        const onMouseUp = () => {
          isResizing = false;
          localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSizes));
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };
      }
    } // end if (!mobile)
}
