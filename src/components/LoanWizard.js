import { state } from '../state/appState.js'
import { escapeHtml, escapeAttribute, generateId, formatCurrency } from '../utils/formatters.js'
import { hasPermission } from '../services/permissionService.js'
import { showToast } from '../services/toastService.js'

export async function showLoanRequestModal() {
  const isAdmin = hasPermission(state.welcomeUser.permissions, 'admin') ||
    hasPermission(state.welcomeUser.permissions, 'read_member') ||
    state.welcomeUser.username.toLowerCase() === 'admin' ||
    state.welcomeUser.username.toLowerCase() === state.welcomeUser.coopShortName?.toLowerCase()

  state.modal.isOpen = true;
  state.modal.title = "Withdrawal Request";
  state.modal.type = "withdrawal-request";

  state.loanRequest = {
    step: isAdmin ? 1 : 2, // Admins start at Step 1 (Member Select), Members start at Step 2 (Enterprise)
    memberId: state.welcomeUser.role === 'member' ? state.welcomeUser.memberId : '',
    memberName: state.welcomeUser.role === 'member' ? (state.welcomeUser.fullName || state.welcomeUser.username) : '',
    enterpriseId: '',
    amount: 0,
    duration: 1,
    guarantors: [],
    bankDetails: {
      bankName: '',
      accountName: '',
      accountNumber: ''
    }
  };

  await renderLoanRequestStep();
}

export async function renderLoanRequestStep() {
  const { step } = state.loanRequest;
  const { fetchEnterprises, buildAccountBalance } = await import('../services/dataService.js');
  const enterprisesFull = await fetchEnterprises(state.welcomeUser.cooperativeId, true);
  
  // Get all enterprises, filter out compulsory due and penalty!
  const allEnterprises = enterprisesFull
    .filter(ent => !ent.compulsory_due && !ent.is_penalty)
    .map(ent => ({ 
      id: ent.id, 
      name: ent.account_name, 
      type: ent.account_type?.toLowerCase() || 'other' 
    }));

  // Determine if selected enterprise is savings (skip duration and guarantors)
  const selectedEnterprise = allEnterprises.find(e => e.id === state.loanRequest.enterpriseId);
  const isSavingsEnterprise = selectedEnterprise?.type === 'savings';
  
  // Get member's opening balance for selected enterprise if savings
  let maxAmount = null;
  if (isSavingsEnterprise && state.loanRequest.memberId) {
    const { accountBalance } = await buildAccountBalance(
      state.welcomeUser.cooperativeId, 
      { ...state.welcomeUser, memberId: state.loanRequest.memberId }
    );
    const entBalance = accountBalance.find(ab => ab.id === state.loanRequest.enterpriseId);
    maxAmount = entBalance ? Math.max(0, entBalance.sum_of_amount) : 0;
  }
  
  // Load member's existing bank details for step 6 (bank details)
  const { fetchMemberDoc } = await import('../services/dataService.js');
  if (state.loanRequest.memberId && 
      !state.loanRequest.bankDetails.bankName && 
      !state.loanRequest.bankDetails.accountName && 
      !state.loanRequest.bankDetails.accountNumber) {
    const memberDoc = await fetchMemberDoc(state.loanRequest.memberId);
    if (memberDoc) {
      state.loanRequest.bankDetails = {
        bankName: memberDoc.bank_name || '',
        accountName: memberDoc.account_name || '',
        accountNumber: memberDoc.account_number || ''
      };
    }
  }

  // Load all members specifically for this modal to avoid race conditions with RBAC-filtered state.members
  const { fetchAllMembers } = await import('../services/dataService.js');
  let content = '';
  let adjustedStep = step;
  if (isSavingsEnterprise && step > 3) {
    adjustedStep = step + 2; // Skip steps 4 (duration) and 5 (guarantors) for savings
  }

  const isAdmin = hasPermission(state.welcomeUser.permissions, 'admin') ||
    hasPermission(state.welcomeUser.permissions, 'read_member') ||
    state.welcomeUser.username.toLowerCase() === 'admin';

  if (adjustedStep === 1) {
    content = `
      <div style="padding: 1rem 0;">
        <h4 style="margin-top: 0;">Step 1: Select Member</h4>
        <p style="color: var(--text-muted); font-size: 0.9rem;">Who is requesting this withdrawal?</p>
        <div style="position: relative; margin-top: 1.5rem;">
          <input type="text" id="loan-member-search" placeholder="Search member by name or ID..." value="${escapeHtml(state.loanRequest.memberName || '')}" style="width: 100%; height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);" autocomplete="off">
          <div id="loan-member-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 200px; overflow-y: auto; margin-top: 0.25rem;"></div>
        </div>
        ${state.loanRequest.memberId ? `
          <div style="margin-top: 1rem; padding: 1rem; background: var(--bg-secondary); border-radius: 0.5rem; border: 1px solid var(--border-light);">
             <span style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Selected Member</span>
             <div style="font-weight: 700; color: var(--accent-primary); font-size: 1.1rem; margin-top: 0.25rem;">${escapeHtml(state.loanRequest.memberName)}</div>
          </div>
        ` : ''}
      </div>
    `;
  } else if (adjustedStep === 2) {
    content = `
      <div style="padding: 1rem 0;">
        <h4 style="margin-top: 0;">Step ${isAdmin ? '2' : '1'}: Select Enterprise</h4>
        <p style="color: var(--text-muted); font-size: 0.9rem;">Choose the enterprise for your withdrawal.</p>
        <div style="display: grid; gap: 0.75rem; margin-top: 1.5rem;">
          ${allEnterprises.map(ent => `
            <button class="ghost-button enterprise-option ${state.loanRequest.enterpriseId === ent.id ? 'active' : ''}" 
                    data-id="${ent.id}" 
                    style="text-align: left; padding: 1rem; border: 2px solid ${state.loanRequest.enterpriseId === ent.id ? 'var(--accent-primary)' : 'var(--border-medium)'}; justify-content: flex-start; height: auto;">
              <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(ent.name)}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">${ent.type}</div>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  } else if (adjustedStep === 3) {
    content = `
      <div style="padding: 1rem 0;">
        <h4 style="margin-top: 0;">Step ${isAdmin ? '3' : '2'}: Amount</h4>
        <p style="color: var(--text-muted); font-size: 0.9rem;">How much would you like to withdraw?</p>
        ${isSavingsEnterprise && maxAmount !== null ? `
          <div style="margin-top: 1rem; padding: 0.75rem; background: var(--bg-secondary); border-radius: 0.5rem; border: 1px solid var(--border-light);">
             <span style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Maximum Withdrawal</span>
             <div style="font-weight: 700; color: var(--accent-primary); font-size: 1.1rem; margin-top: 0.25rem;">${formatCurrency(maxAmount)}</div>
          </div>
        ` : ''}
        <div class="field" style="margin-top: 1.5rem;">
          <span>Amount (₦)</span>
          <input type="number" id="loan-amount-input" value="${state.loanRequest.amount || ''}" placeholder="0.00" ${isSavingsEnterprise && maxAmount !== null ? `max="${maxAmount}"` : ''} style="width: 100%; font-size: 1.25rem; font-weight: 700; padding: 0.75rem;" />
        </div>
      </div>
    `;
  } else if (adjustedStep === 4 && !isSavingsEnterprise) {
    content = `
      <div style="padding: 1rem 0;">
        <h4 style="margin-top: 0;">Step ${isAdmin ? '4' : '3'}: Duration</h4>
        <p style="color: var(--text-muted); font-size: 0.9rem;">How many months for repayment?</p>
        <div class="field" style="margin-top: 1.5rem;">
          <span>Duration (Months)</span>
          <input type="number" id="loan-duration-input" value="${state.loanRequest.duration || 1}" min="1" style="width: 100%; font-size: 1.25rem; font-weight: 700; padding: 0.75rem;" />
        </div>
      </div>
    `;
  } else if (adjustedStep === 5 && !isSavingsEnterprise) {
    content = `
      <div style="padding: 1rem 0; min-height: 400px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h4 style="margin: 0;">Step ${isAdmin ? '5' : '4'}: Guarantors</h4>
          <button type="button" id="add-guarantor-btn" class="ghost-button" style="color: var(--accent-primary); height: auto; padding: 0.5rem 1rem;">+ Add Guarantor</button>
        </div>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.5rem;">Select members to guarantee your withdrawal.</p>
        
        <div id="guarantors-list" style="display: flex; flex-direction: column; gap: 0.85rem;">
           ${state.loanRequest.guarantors.map((g, gi) => `
                 <div class="guarantor-row" data-index="${gi}" data-id="${g.tempId || generateId()}" style="display: flex; flex-direction: column; gap: 0.5rem; background: var(--bg-card); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border-medium);">
                    <div style="display: grid; grid-template-columns: 1fr 120px auto; gap: 0.75rem; align-items: center;">
                       <div style="position: relative;">
                           <input type="text" class="guarantor-search" placeholder="Search guarantor name..." value="${escapeHtml(g.name || '')}" style="width: 100%; height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                           <div class="guarantor-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 200px; overflow-y: auto; margin-top: 0.25rem;"></div>
                           <input type="hidden" class="guarantor-id" value="${g.member_id || ''}">
                       </div>
                       <input type="number" class="guarantor-amt" value="${g.amount || ''}" placeholder="Amount" style="height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                       <button type="button" class="remove-guarantor" style="color: var(--danger); border: 0; background: transparent; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center;">&times;</button>
                    </div>
                    <div class="g-info-row" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 0.25rem;">
                        <div class="g-selected-display" style="font-size: 0.75rem; color: var(--accent-primary); font-weight: 600;">
                            ${g.name ? `Selected: ${g.name}` : ''}
                        </div>
                        <div class="g-stats-display" style="display: flex; gap: 1rem; font-size: 0.7rem; color: var(--text-muted); font-weight: 500;">
                            <span class="g-active-count">Active: ${g.activeCount !== undefined ? g.activeCount : '-'}</span>
                            <span class="g-active-sum">Total: ${g.activeSum !== undefined ? formatCurrency(g.activeSum) : '-'}</span>
                            <span class="g-overdue-count" style="color: ${g.overdueCount > 0 ? 'var(--danger)' : 'inherit'}">Overdue: ${g.overdueCount !== undefined ? g.overdueCount : '-'}</span>
                        </div>
                    </div>
                 </div>
              `).join('')}
           ${state.loanRequest.guarantors.length === 0 ? '<p id="empty-guarantors-msg" style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 2rem; border: 1px dashed var(--border-light); border-radius: 0.5rem;">No guarantors added yet. Click "+ Add Guarantor" to start.</p>' : ''}
        </div>
      </div>
    `;
  } else if (step === 6) {
    content = `
      <div style="padding: 1rem 0;">
        <h4 style="margin-top: 0;">Step ${isAdmin ? '6' : (isSavingsEnterprise ? '3' : '5')}: Bank Details</h4>
        <p style="color: var(--text-muted); font-size: 0.9rem;">Where should the funds be sent? (Optional)</p>
        <div style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1.5rem;">
          <div class="field">
            <span>Bank Name</span>
            <input type="text" id="loan-bank-name" value="${escapeAttribute(state.loanRequest.bankDetails.bankName)}" placeholder="e.g. Zenith Bank" style="width: 100%;" />
          </div>
          <div class="field">
            <span>Account Name</span>
            <input type="text" id="loan-account-name" value="${escapeAttribute(state.loanRequest.bankDetails.accountName)}" placeholder="e.g. John Doe" style="width: 100%;" />
          </div>
          <div class="field">
            <span>Account Number</span>
            <input type="text" id="loan-account-number" value="${escapeAttribute(state.loanRequest.bankDetails.accountNumber)}" placeholder="0123456789" style="width: 100%;" />
          </div>
        </div>
      </div>
    `;
  } else if (step === 7) {
    const entName = allEnterprises.find(e => e.id === state.loanRequest.enterpriseId)?.name || 'Unknown';
    content = `
      <div style="padding: 1rem 0;">
        <h4 style="margin-top: 0;">Step ${isAdmin ? '7' : (isSavingsEnterprise ? '4' : '6')}: Confirmation</h4>
        <p style="color: var(--text-muted); font-size: 0.9rem;">Review your withdrawal request details.</p>
        <div style="background: var(--bg-secondary); padding: 1.25rem; border-radius: 0.75rem; margin-top: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;">
          ${isAdmin ? `
            <div style="display: flex; justify-content: space-between; font-size: 0.9rem;">
              <span style="color: var(--text-muted);">Member:</span>
              <span style="font-weight: 700;">${escapeHtml(state.loanRequest.memberName)}</span>
            </div>
          ` : ''}
          <div style="display: flex; justify-content: space-between; font-size: 0.9rem;">
            <span style="color: var(--text-muted);">Enterprise:</span>
            <span style="font-weight: 700;">${escapeHtml(entName)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.9rem;">
            <span style="color: var(--text-muted);">Amount:</span>
            <span style="font-weight: 700; color: var(--accent-primary);">${formatCurrency(parseFloat(state.loanRequest.amount || 0))}</span>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.9rem;">
            <span style="color: var(--text-muted);">Duration:</span>
            <span style="font-weight: 700;">${state.loanRequest.duration} Months</span>
          </div>
          <div style="display: flex; flex-direction: column; font-size: 0.9rem; border-top: 1px solid var(--border-medium); padding-top: 0.5rem; margin-top: 0.25rem;">
            <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700; margin-bottom: 0.25rem;">Guarantors:</span>
            ${state.loanRequest.guarantors.map(g => `
              <div style="display: flex; justify-content: space-between; margin-bottom: 0.25rem;">
                <span style="font-size: 0.85rem;">${escapeHtml(g.name)}</span>
                <span style="font-weight: 600;">${formatCurrency(g.amount || (Math.abs(state.loanRequest.amount) / (state.loanRequest.guarantors.length || 1)))}</span>
              </div>
            `).join('')}
            ${state.loanRequest.guarantors.length === 0 ? '<span style="color: var(--text-muted); font-style: italic; font-size: 0.8rem;">None</span>' : ''}
          </div>
          ${state.loanRequest.bankDetails.bankName ? `
            <div style="border-top: 1px solid var(--border-medium); margin-top: 0.5rem; padding-top: 0.5rem;">
              <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700; margin-bottom: 0.25rem;">Bank Details</div>
              <div style="font-size: 0.85rem; font-weight: 600;">${escapeHtml(state.loanRequest.bankDetails.bankName)}</div>
              <div style="font-size: 0.85rem;">${escapeHtml(state.loanRequest.bankDetails.accountName)} - ${escapeHtml(state.loanRequest.bankDetails.accountNumber)}</div>
            </div>
          ` : ''}
        </div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 1rem; line-height: 1.4;">
          After confirmation, you will be redirected to the Log Payment screen to finalize the transaction.
        </p>
      </div>
    `;
  }

  const isBackDisabled = (isAdmin && step === 1) || (!isAdmin && step === 2);
  let isNextDisabled = (step === 1 && !state.loanRequest.memberId) || (step === 2 && !state.loanRequest.enterpriseId);
  
  // Check amount validation for savings
  if (step === 3 && isSavingsEnterprise && maxAmount !== null) {
    isNextDisabled = isNextDisabled || !state.loanRequest.amount || state.loanRequest.amount <= 0 || state.loanRequest.amount > maxAmount;
  }

  content += `
    <div style="display: flex; justify-content: space-between; gap: 1rem; margin-top: 2rem;">
      <button class="secondary-button" id="loan-request-back" style="${isBackDisabled ? 'visibility: hidden;' : ''}">Back</button>
      <button class="primary-button" id="loan-request-next" ${isNextDisabled ? 'disabled' : ''}>
        ${step === 7 ? 'Confirm & Continue' : 'Next'}
      </button>
    </div>
  `;

  state.modal.content = content;
  window.__render();
}

export async function setupLoanRequestListeners() {
  const body = document.getElementById('modal-body');
  if (!body) return;

  const nextBtn = body.querySelector('#loan-request-next');
  const backBtn = body.querySelector('#loan-request-back');
  const step = state.loanRequest.step;



  // Step 1: Enterprise Selection
  body.querySelectorAll('.enterprise-option').forEach(btn => {
    btn.addEventListener('click', () => {
      state.loanRequest.enterpriseId = btn.dataset.id;
      state.loanRequest.step = 2; // Auto-advance to amount
      renderLoanRequestStep();
    });
  });

  // Step 2: Amount
  const amountInput = body.querySelector('#loan-amount-input');
  amountInput?.addEventListener('input', (e) => {
    state.loanRequest.amount = parseFloat(e.target.value) || 0;
  });

  // Step 3: Duration
  const durationInput = body.querySelector('#loan-duration-input');
  durationInput?.addEventListener('input', (e) => {
    state.loanRequest.duration = parseInt(e.target.value) || 1;
  });

  // Step 4: Guarantors (Row-based)
  const addGuarantorBtn = body.querySelector('#add-guarantor-btn');
  const guarantorsList = body.querySelector('#guarantors-list');

  const setupGuarantorSearch = async (row) => {
    const searchInput = row.querySelector('.guarantor-search');
    const suggestions = row.querySelector('.guarantor-suggestions');
    const hiddenId = row.querySelector('.guarantor-id');
    const amtInput = row.querySelector('.guarantor-amt');
    const display = row.querySelector('.g-selected-display');
    const statsDiv = row.querySelector('.g-stats-display');
    const removeBtn = row.querySelector('.remove-guarantor');
    const gi = parseInt(row.dataset.index);

    searchInput?.addEventListener('input', async (e) => {
      const text = (e.target.value || '').toLowerCase().trim();
      if (!text) {
        suggestions.style.display = 'none';
        return;
      }

      // Always fetch full list (cached) to ensure non-admins see all potential guarantors
      const { fetchAllMembers } = await import('../services/dataService.js');
      const allMembers = await fetchAllMembers(state.welcomeUser.cooperativeId, state.welcomeUser.username, true);

      const matches = allMembers.filter(m => {
        const isSelf = m.id === state.welcomeUser.memberId || m.id === state.selectedMemberId;
        if (isSelf) return false;

        const nameMatch = (m.name || '').toLowerCase().includes(text);
        const regMatch = String(m.registration_no || m.file_no || '').toLowerCase().includes(text);
        return nameMatch || regMatch;
      }).slice(0, 8);

      if (matches.length > 0) {
        suggestions.innerHTML = matches.map(m => `
          <div class="g-suggestion" data-id="${m.id}" data-name="${escapeHtml(m.name)}" data-file="${escapeHtml(m.file_no || m.registration_no || 'N/A')}" style="padding: 0.75rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
            <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">${escapeHtml(m.name)}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">File/Reg: ${m.file_no || m.registration_no || 'N/A'}</div>
          </div>
        `).join('');
        suggestions.style.display = 'block';

        suggestions.querySelectorAll('.g-suggestion').forEach(item => {
          item.addEventListener('mousedown', async (e) => {
            e.preventDefault(); // Prevent blur on input
            const { id, name, file } = item.dataset;
            hiddenId.value = id;
            searchInput.value = name;
            display.innerText = `Selected: ${name}`;
            suggestions.style.display = 'none';

            // Update state
            const currentIdx = parseInt(row.dataset.index);
            state.loanRequest.guarantors[currentIdx] = {
              ...state.loanRequest.guarantors[currentIdx],
              member_id: id,
              name,
              file_no: file
            };

            // Fetch stats
            try {
              statsDiv.querySelector('.g-active-count').innerText = 'Loading...';
              const { fetchGuarantorStats } = await import('../services/dataService.js');
              const stats = await fetchGuarantorStats(id, state.welcomeUser.cooperativeId);

              state.loanRequest.guarantors[currentIdx].activeCount = stats.activeCount;
              state.loanRequest.guarantors[currentIdx].activeSum = stats.activeSum;
              state.loanRequest.guarantors[currentIdx].overdueCount = stats.overdueCount;

              statsDiv.querySelector('.g-active-count').innerText = `Active: ${stats.activeCount}`;
              statsDiv.querySelector('.g-active-sum').innerText = `Total: ${formatCurrency(stats.activeSum)}`;
              const odSpan = statsDiv.querySelector('.g-overdue-count');
              odSpan.innerText = `Overdue: ${stats.overdueCount}`;
              if (stats.overdueCount > 0) odSpan.style.color = 'var(--danger)';
              else odSpan.style.color = 'inherit';
            } catch (err) {
              console.error("Error fetching stats:", err);
            }
          });
        });
      } else {
        suggestions.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-style: italic;">No members found</div>';
        suggestions.style.display = 'block';
      }
    });

    searchInput?.addEventListener('blur', () => {
      setTimeout(() => { suggestions.style.display = 'none' }, 200);
    });

    amtInput?.addEventListener('input', (e) => {
      const currentIdx = parseInt(row.dataset.index);
      state.loanRequest.guarantors[currentIdx].amount = parseFloat(e.target.value) || 0;
    });

    removeBtn?.addEventListener('click', () => {
      const currentIdx = parseInt(row.dataset.index);
      state.loanRequest.guarantors.splice(currentIdx, 1);
      // Re-index remaining rows in state and DOM if needed, but for simplicity a full re-render is safer here
      // OR we just remove the row and re-render step
      renderLoanRequestStep();
    });
  };

  if (addGuarantorBtn && guarantorsList) {
    addGuarantorBtn.addEventListener('click', () => {
      const gIdx = state.loanRequest.guarantors.length;
      const gTempId = generateId();
      state.loanRequest.guarantors.push({ member_id: '', name: '', amount: 0, tempId: gTempId });

      const emptyMsg = body.querySelector('#empty-guarantors-msg');
      if (emptyMsg) emptyMsg.remove();

      const rowHtml = `
        <div class="guarantor-row" data-index="${gIdx}" data-id="${gTempId}" style="display: flex; flex-direction: column; gap: 0.5rem; background: var(--bg-card); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border-medium);">
          <div style="display: grid; grid-template-columns: 1fr 120px auto; gap: 0.75rem; align-items: center;">
            <div style="position: relative;">
                <input type="text" class="guarantor-search" placeholder="Search guarantor name..." style="width: 100%; height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                <div class="guarantor-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 200px; overflow-y: auto; margin-top: 0.25rem;"></div>
                <input type="hidden" class="guarantor-id">
            </div>
            <input type="number" class="guarantor-amt" value="0" placeholder="Amount" style="height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
            <button type="button" class="remove-guarantor" style="color: var(--danger); border: 0; background: transparent; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center;">&times;</button>
          </div>
          <div class="g-info-row" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 0.25rem;">
              <div class="g-selected-display" style="font-size: 0.75rem; color: var(--accent-primary); font-weight: 600;"></div>
              <div class="g-stats-display" style="display: flex; gap: 1rem; font-size: 0.7rem; color: var(--text-muted); font-weight: 500;">
                  <span class="g-active-count">Active: -</span>
                  <span class="g-active-sum">Total: -</span>
                  <span class="g-overdue-count">Overdue: -</span>
              </div>
          </div>
        </div>
      `;
      guarantorsList.insertAdjacentHTML('beforeend', rowHtml);
      setupGuarantorSearch(guarantorsList.lastElementChild);
    });
  }

  body.querySelectorAll('.guarantor-row').forEach((row) => {
    setupGuarantorSearch(row);
  });


  // Step 5: Bank Details
  const bankName = body.querySelector('#loan-bank-name');
  const accountName = body.querySelector('#loan-account-name');
  const accountNumber = body.querySelector('#loan-account-number');

  bankName?.addEventListener('input', (e) => state.loanRequest.bankDetails.bankName = e.target.value);
  accountName?.addEventListener('input', (e) => state.loanRequest.bankDetails.accountName = e.target.value);
  accountNumber?.addEventListener('input', (e) => state.loanRequest.bankDetails.accountNumber = e.target.value);

  // Navigation
  backBtn?.addEventListener('click', async () => {
    const isAdmin = hasPermission(state.welcomeUser.permissions, 'admin') ||
      hasPermission(state.welcomeUser.permissions, 'read_member') ||
      state.welcomeUser.username.toLowerCase() === 'admin';
    const minStep = 1;

    // Check if selected enterprise is savings
    const { fetchEnterprises: fetchEntsBack } = await import('../services/dataService.js');
    const entsBack = await fetchEntsBack(state.welcomeUser.cooperativeId);
    const allEntsBack = Object.entries(entsBack).map(([id, name]) => {
      const isLoan = name.toLowerCase().includes('loan') || id.toLowerCase().includes('loan');
      const isSavings = name.toLowerCase().includes('saving') || id.toLowerCase().includes('saving');
      return { id, name, type: isLoan ? 'loan' : (isSavings ? 'savings' : 'other') };
    });
    const selEntBack = allEntsBack.find(e => e.id === state.loanRequest.enterpriseId);
    const isSavingsBack = selEntBack?.type === 'savings';

    if (state.loanRequest.step > minStep) {
      let prevStep = state.loanRequest.step - 1;
      // If going back from Bank Details step and it's a savings enterprise, go back to Enterprise selection
      const bankDetailsStep = isAdmin ? 6 : 5; // Adjust this if we change step order
      const enterpriseStep = isAdmin ? 2 : 1;
      if (state.loanRequest.step === bankDetailsStep && isSavingsBack) {
        prevStep = enterpriseStep;
      }
      state.loanRequest.step = prevStep;
      renderLoanRequestStep();
    }
  });


  nextBtn?.addEventListener('click', async () => {
    const isAdmin = hasPermission(state.welcomeUser.permissions, 'admin') ||
      hasPermission(state.welcomeUser.permissions, 'read_member') ||
      state.welcomeUser.username.toLowerCase() === 'admin';

    // Check if selected enterprise is savings
    const { fetchEnterprises: fetchEnts } = await import('../services/dataService.js');
    const ents = await fetchEnts(state.welcomeUser.cooperativeId);
    const allEnts = Object.entries(ents).map(([id, name]) => {
      const isLoan = name.toLowerCase().includes('loan') || id.toLowerCase().includes('loan');
      const isSavings = name.toLowerCase().includes('saving') || id.toLowerCase().includes('saving');
      return { id, name, type: isLoan ? 'loan' : (isSavings ? 'savings' : 'other') };
    });
    const selEnt = allEnts.find(e => e.id === state.loanRequest.enterpriseId);
    const isSavings = selEnt?.type === 'savings';

    if (state.loanRequest.step === 7) {
      finalizeLoanRequest();
    } else {
      let nextStep = state.loanRequest.step + 1;
      // If current step is Enterprise selection and it's a savings enterprise, skip to Bank Details step
      const enterpriseStep = isAdmin ? 2 : 1;
      const bankDetailsStep = isAdmin ? 6 : 5;
      if (state.loanRequest.step === enterpriseStep && isSavings) {
        nextStep = bankDetailsStep;
      }
      state.loanRequest.step = nextStep;
      renderLoanRequestStep();
    }
  });

  // Setup Step 1 Member Search
  const memberSearchInput = body.querySelector('#loan-member-search');
  const memberSuggestions = body.querySelector('#loan-member-suggestions');
  if (memberSearchInput && memberSuggestions) {
    memberSearchInput.addEventListener('input', async (e) => {
      const text = (e.target.value || '').toLowerCase().trim();
      if (!text) {
        memberSuggestions.style.display = 'none';
        return;
      }

      const { fetchAllMembers } = await import('../services/dataService.js');
      const allMembers = await fetchAllMembers(state.welcomeUser.cooperativeId, state.welcomeUser.username, true);

      const matches = allMembers.filter(m => {
        const nameMatch = (m.name || '').toLowerCase().includes(text);
        const regMatch = String(m.registration_no || m.file_no || '').toLowerCase().includes(text);
        const specialIdMatch = String(m.special_id || '').toLowerCase().includes(text);
        const mobileMatch = String(m.mobile || '').toLowerCase().includes(text);
        return nameMatch || regMatch || specialIdMatch || mobileMatch;
      }).slice(0, 10);

      if (matches.length > 0) {
        memberSuggestions.innerHTML = matches.map(m => `
          <div class="m-suggestion" data-id="${m.id}" data-name="${escapeHtml(m.name)}" style="padding: 0.75rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
            <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">${escapeHtml(m.name)}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">
              ${m.special_id ? `ID: ${escapeHtml(m.special_id)}` : ''} ${m.special_id && (m.registration_no || m.file_no) ? ' • ' : ''} ${m.registration_no || m.file_no ? `Reg: ${m.registration_no || m.file_no}` : ''} ${(m.special_id || m.registration_no || m.file_no) && m.mobile ? ' • ' : ''} ${m.mobile ? `Mobile: ${m.mobile}` : ''}
            </div>
          </div>
        `).join('');
        memberSuggestions.style.display = 'block';

        memberSuggestions.querySelectorAll('.m-suggestion').forEach(item => {
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const { id, name } = item.dataset;
            state.loanRequest.memberId = id;
            state.loanRequest.memberName = name;
            renderLoanRequestStep(); // Re-render to show selected and enable next
          });
        });
      } else {
        memberSuggestions.innerHTML = '<div style="padding: 0.75rem; color: var(--text-muted); font-style: italic;">No members found</div>';
        memberSuggestions.style.display = 'block';
      }
    });

    memberSearchInput.addEventListener('blur', () => {
      setTimeout(() => { memberSuggestions.style.display = 'none' }, 200);
    });
  }

  // Setup Step 2 Enterprise Selection (auto-advance)
  const enterpriseOptions = body.querySelectorAll('.enterprise-option');
  enterpriseOptions.forEach(option => {
    option.addEventListener('click', async () => {
      const id = option.dataset.id;
      state.loanRequest.enterpriseId = id;
      
      // Auto advance to next step
      const isAdmin = hasPermission(state.welcomeUser.permissions, 'admin') ||
        hasPermission(state.welcomeUser.permissions, 'read_member') ||
        state.welcomeUser.username.toLowerCase() === 'admin';
      
      // Check if selected enterprise is savings
      const { fetchEnterprises: fetchEntsAuto } = await import('../services/dataService.js');
      const entsAuto = await fetchEntsAuto(state.welcomeUser.cooperativeId, true);
      const selEntAuto = entsAuto.find(e => e.id === id);
      const isSavingsAuto = (selEntAuto?.account_type || '').toLowerCase() === 'savings';
      
      let nextStep = state.loanRequest.step + 1;
      if (isSavingsAuto) {
        // Skip duration and guarantors for savings, go to bank details
        nextStep = isAdmin ? 6 : 5;
      }
      state.loanRequest.step = nextStep;
      renderLoanRequestStep();
    });
  });
}

export async function finalizeLoanRequest() {
  // First, determine enterprise type
  const { 
    fetchEnterprises,
    fetchAllMembers,
    addRemittance,
    updateMemberBankInfo
  } = await import('../services/dataService.js');
  const { showToast } = await import('../services/toastService.js');
  const { generateId } = await import('../utils/formatters.js');
  const enterprisesFull = await fetchEnterprises(state.welcomeUser.cooperativeId, true);
  const selectedEnterprise = enterprisesFull.find(e => e.id === state.loanRequest.enterpriseId);
  const isSavingsEnterprise = (selectedEnterprise?.account_type || '').toLowerCase() === 'savings';

  // Update member bank details if needed
  if (state.loanRequest.bankDetails.bankName || state.loanRequest.bankDetails.accountName || state.loanRequest.bankDetails.accountNumber) {
    await updateMemberBankInfo(
      state.loanRequest.memberId, 
      state.loanRequest.bankDetails, 
      state.welcomeUser.username, 
      state.welcomeUser.cooperativeId
    );
  }

  // Get member details
  const allMembers = await fetchAllMembers(state.welcomeUser.cooperativeId, state.welcomeUser.username, true);
  const selectedMember = allMembers.find(m => m.id === state.loanRequest.memberId);

  // Determine transaction type and amount
  let transactionType = isSavingsEnterprise ? 'Savings Withdrawal' : 'Member Loan';
  let amount = isSavingsEnterprise ? -Math.abs(state.loanRequest.amount) : -Math.abs(state.loanRequest.amount);

  const status = 'Pending'; // As per instruction
  const description = isSavingsEnterprise ? 'Savings Withdrawal Request' : 'Loan Request';

  // Prepare remittance data
  const remittanceData = {
    member_id: state.loanRequest.memberId,
    amount: amount,
    transaction_type: transactionType,
    description: description,
    remittance_date: new Date().toISOString().split('T')[0],
    bank_name: state.loanRequest.bankDetails.bankName || '',
    cooperative_id: state.welcomeUser.cooperativeId,
    user_role: state.welcomeUser.role || 'member',
    user_roles: [state.welcomeUser.role || 'member'],
    status: status,
    isLoanRequest: !isSavingsEnterprise,
    isWithdrawalRequest: true,
    is_deleted: 0,
    is_synced: 0,
    created_at: new Date().toISOString(),
    created_by: state.welcomeUser.username,
    modified_at: new Date().toISOString(),
    modified_by: state.welcomeUser.username,
    details: [
      {
        id: generateId(state.welcomeUser.cooperativeId),
        item: state.loanRequest.enterpriseId,
        amount: amount,
        auto_description: `${transactionType} - ${selectedEnterprise?.account_name || 'Unknown'}`,
        ...(isSavingsEnterprise ? {} : {
          loan_info: {
            loanData: {
              principalAmount: Math.abs(state.loanRequest.amount),
              durationMonths: state.loanRequest.duration || 1,
              issueDate: new Date().toISOString().split('T')[0],
              status: 'Pending',
              notes: 'Loan Request'
            },
            guarantors: state.loanRequest.guarantors.map(g => ({
              id: g.id || generateId(state.welcomeUser.cooperativeId),
              member_id: g.member_id,
              name: g.name,
              file_no: g.file_no || '',
              amount: g.amount || (Math.abs(state.loanRequest.amount) / (state.loanRequest.guarantors.length || 1)),
              guarantor_approval: null
            }))
          }
        })
      }
    ]
  };

  // Save the remittance
  await addRemittance(remittanceData, state.welcomeUser.username);

  // Reset state
  state.modal.isOpen = false;
  state.modal.type = null;
  state.loanRequest = {
    step: 1,
    enterpriseId: '',
    amount: 0,
    duration: 1,
    guarantors: [],
    bankDetails: {
      bankName: '',
      accountName: '',
      accountNumber: ''
    }
  };

  window.__render();
  showToast('Withdrawal/Loan request submitted successfully!', 'success');
}
