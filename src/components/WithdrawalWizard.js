import { state } from '../state/appState.js'
import { escapeHtml, generateId, formatCurrency } from '../utils/formatters.js'
import { showToast } from '../services/toastService.js'

export async function showWithdrawalWizard() {
  const {
    fetchEnterprises,
    fetchAllMembers,
    addRemittance,
    buildAccountBalance
  } = await import('../services/dataService.js');
  const { showToast } = await import('../services/toastService.js');
  const { generateId, formatCurrency, escapeHtml } = await import('../utils/formatters.js');
  
  const existingModal = document.getElementById('withdrawal-wizard-modal');
  if (existingModal) existingModal.remove();

  // This module keeps its own copy of app state which can be stale when the
  // shell logs in without a page reload — refresh it from the stored session.
  if (!state.welcomeUser) {
    const { loadSavedSession } = await import('../services/offlineAuthService.js');
    state.welcomeUser = loadSavedSession();
  }
  if (!state.welcomeUser) {
    showToast('Your session has expired. Please log in again.', 'error');
    return;
  }

  // Any non-member (staff/admin) can use this wizard and pick the member they
  // are requesting for on their behalf. Members only ever request for
  // themselves. This is deliberately not tied to dashboard access.
  const canSelectMember = state.welcomeUser.role !== 'member';

  // Get required data first
  const enterprises = await fetchEnterprises(state.welcomeUser.cooperativeId, true);
  const allMembers = await fetchAllMembers(state.welcomeUser.cooperativeId, state.welcomeUser.username, true);
  
  // Determine initial member ID — non-members must select one explicitly
  let memberId = canSelectMember ? null : (state.welcomeUser.memberId || null);
  
  // Function to get member balances as a map (entId -> balance)
  const getMemberBalances = async (mId) => {
    if (!mId) return {};
    const result = await buildAccountBalance(state.welcomeUser.cooperativeId, { ...state.welcomeUser, memberId: mId });
    const balanceMap = {};
    result.accountBalance.forEach(ent => {
      balanceMap[ent.id] = ent.sum_of_amount;
    });
    return balanceMap;
  };
  
  let memberBalances = memberId ? await getMemberBalances(memberId) : {};

  // Modal state
    let wizardStep = canSelectMember ? 1 : 1; // 1: select member (staff/admin) or select type (member), 2: select type (non-member), 3: select enterprise, 4: enter amount, 5: review
    let selectedMemberId = memberId;
    let selectedEnterprise = null;
    let withdrawalAmount = 0;
    let loanDuration = 1;
    let guarantors = [];
    let termsAccepted = false;
    let totalSteps = canSelectMember ? 5 : 4;

  const filterEnterprise = (e) => {
    // Filter out if isCompulsoryDue or isPenalty is true
    if (e.isCompulsoryDue || e.isPenalty) {
      return false;
    }
    // Filter out if name contains any of these keywords
    const nameLower = (e.account_name || '').toLowerCase();
    const forbiddenKeywords = ['compulsory', 'penalty', 'due', 'charges'];
    if (forbiddenKeywords.some(keyword => nameLower.includes(keyword))) {
      return false;
    }
    // Filter out if deleted
    if (e.is_deleted && e.is_deleted !== 0) {
      return false;
    }
    return true;
  };

  const getSavingsEnterprises = () => {
    return enterprises.filter(e => 
      (e.account_type || '').toLowerCase() === 'savings' && 
      filterEnterprise(e)
    );
  };

  const getLoanEnterprises = () => {
    return enterprises.filter(e => 
      (e.account_type || '').toLowerCase() === 'loan' && 
      filterEnterprise(e)
    );
  };

  const getEnterpriseBalance = (entId) => {
    return parseFloat(memberBalances[entId] || 0);
  };

  const buildLoanCharges = (ent, principal) => {
    const charges = [];
    const add = (name, raw, isPercent) => {
      if (raw === undefined || raw === null || raw === '') return;
      const base = Math.abs(parseFloat(raw) || 0);
      if (!base) return;
      const value = isPercent ? (base / 100) * principal : base;
      if (value <= 0) return;
      charges.push({ name, value, rate: isPercent ? `${base}% of amount` : null });
    };
    add('Interest', ent?.interest_rate, !!ent?.interest_is_percent);
    add('Form Fee', ent?.form_fee, !!ent?.form_fee_is_percent);
    add('Admin Charge', ent?.admin_charge, !!ent?.admin_charge_is_percent);
    return charges;
  };

  const getConfirmStepNo = () => selectedEnterprise?.type === 'loan'
    ? (canSelectMember ? 7 : 6)
    : (canSelectMember ? 5 : 4);

  const renderModal = () => {
    const modalContainer = document.getElementById('withdrawal-wizard-modal');
    if (!modalContainer) return;
    
    let stepContent = '';
    totalSteps = selectedEnterprise?.type === 'loan' 
      ? (canSelectMember ? 7 : 6) 
      : (canSelectMember ? 5 : 4);
    
    const wizardTitle = selectedEnterprise?.type === 'loan' 
      ? 'Loan Request' 
      : (selectedEnterprise?.type === 'savings' ? 'Savings Withdrawal Request' : 'Withdrawal Request');
    
    if (canSelectMember && wizardStep === 1) {
      // Step 1: Select Member (non-members only) - searchable dropdown
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Select Member</h4>
          <p style="color: var(--text-muted); font-size: 0.9rem;">Who is requesting this?</p>
          <div style="position: relative; z-index: 999999;">
            <input type="text" id="wizard-member-search" placeholder="Search member by name or ID..." value="${escapeHtml(selectedMemberId ? (allMembers.find(m => m.id === selectedMemberId)?.name || '') : '')}" style="width: 100%; height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);" autocomplete="off">
            <div id="wizard-member-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 250px; overflow-y: auto; margin-top: 0.25rem;"></div>
          </div>
          ${selectedMemberId ? (() => {
            const mem = allMembers.find(m => String(m.id) === String(selectedMemberId));
            if (!mem) return '';
            const networthVal = Object.values(memberBalances || {}).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
            const networthColor = networthVal < 0 ? 'var(--danger)' : 'var(--success)';
            const initial = (mem.name || 'U').charAt(0).toUpperCase();
            return `
              <div style="margin-top: 1rem; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.75rem; padding: 0.85rem; box-shadow: var(--shadow-sm);">
                <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em;">Selected Member</span>
                <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: 0.5rem;">
                  <div style="width: 40px; height: 40px; border-radius: 50%; background: var(--accent-primary); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1rem; flex-shrink: 0; letter-spacing: 0.02em;">
                    ${escapeHtml(initial)}
                  </div>
                  <div style="min-width: 0; flex: 1;">
                    <div style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); line-height: 1.3;">${escapeHtml(mem.name || 'Unknown')}</div>
                    <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.15rem;">Member ID: ${escapeHtml(mem.id || '—')}</div>
                  </div>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.45rem 0.6rem; margin-top: 0.65rem; font-size: 0.78rem;">
                  ${mem.special_id ? `
                    <div style="display: flex; flex-direction: column; gap: 0.1rem;">
                      <span style="font-weight: 700; color: var(--accent-primary); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;">Special ID</span>
                      <span style="font-weight: 600; color: var(--text-primary); word-break: break-word;">${escapeHtml(mem.special_id)}</span>
                    </div>
                  ` : ''}
                  ${(mem.registration_no || mem.file_no) ? `
                    <div style="display: flex; flex-direction: column; gap: 0.1rem;">
                      <span style="font-weight: 700; color: var(--text-muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;">Reg No</span>
                      <span style="font-weight: 600; color: var(--text-primary); word-break: break-word;">${escapeHtml(mem.registration_no || mem.file_no)}</span>
                    </div>
                  ` : ''}
                  ${mem.mobile ? `
                    <div style="display: flex; flex-direction: column; gap: 0.1rem;">
                      <span style="font-weight: 700; color: var(--text-muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;">Mobile</span>
                      <span style="font-weight: 600; color: var(--text-primary); word-break: break-word;">${escapeHtml(mem.mobile)}</span>
                    </div>
                  ` : ''}
                  <div style="display: flex; flex-direction: column; gap: 0.1rem;">
                    <span style="font-weight: 700; color: ${networthColor}; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;">Networth</span>
                    <span style="font-weight: 700; color: ${networthColor};">${formatCurrency(networthVal)}</span>
                  </div>
                </div>
              </div>
            `;
          })() : ''}
        </div>
      `;
    } else if ((canSelectMember && wizardStep === 2) || (!canSelectMember && wizardStep === 1)) {
      // Step 2 (non-member) / Step 1 (Member): Select Enterprise Type
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Select Request Type</h4>
          <div style="display: grid; grid-template-columns: 1fr; gap: 0.75rem;">
            <button type="button" class="wizard-type-btn" data-type="savings" style="padding: 1.25rem; border: 1px solid var(--border-medium); border-radius: 0.75rem; background: var(--bg-card); cursor: pointer; text-align: left; transition: all 0.2s;">
              <div style="font-weight: 700; color: var(--text-primary);">Savings Withdrawal Request</div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Withdraw from your savings account</div>
            </button>
            <button type="button" class="wizard-type-btn" data-type="loan" style="padding: 1.25rem; border: 1px solid var(--border-medium); border-radius: 0.75rem; background: var(--bg-card); cursor: pointer; text-align: left; transition: all 0.2s;">
              <div style="font-weight: 700; color: var(--text-primary);">Loan Request</div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Take a loan</div>
            </button>
          </div>
        </div>
      `;
    } else if ((canSelectMember && wizardStep === 3) || (!canSelectMember && wizardStep === 2)) {
      // Step 3 (non-member) / Step 2 (Member): Select Enterprise
      const ents = selectedEnterprise.type === 'savings' ? getSavingsEnterprises() : getLoanEnterprises();
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Select Account</h4>
          <div style="display: grid; grid-template-columns: 1fr; gap: 0.75rem; max-height: 400px; overflow-y: auto;">
            ${ents.map(e => `
              <button type="button" class="wizard-enterprise-btn" data-entid="${e.id}" style="padding: 1.25rem; border: 1px solid var(--border-medium); border-radius: 0.75rem; background: var(--bg-card); cursor: pointer; text-align: left; transition: all 0.2s;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(e.account_name)}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
                      Balance: ${formatCurrency(getEnterpriseBalance(e.id))}
                    </div>
                  </div>
                </div>
              </button>
            `).join('')}
          </div>
        </div>
      `;
    } else if ((canSelectMember && wizardStep === 4) || (!canSelectMember && wizardStep === 3)) {
      // Step 4 (non-member) / Step 3 (Member): Enter Withdrawal Amount
      const ent = enterprises.find(e => e.id === selectedEnterprise.id);
      const maxWithdrawal = selectedEnterprise.type === 'savings' 
        ? Math.max(0, getEnterpriseBalance(ent.id)) 
        : 999999999;
      
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Enter Amount</h4>
          <div style="padding: 1rem; background: var(--bg-secondary); border-radius: 0.75rem; border: 1px solid var(--border-light);">
            <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Account</div>
            <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(ent?.account_name)}</div>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem;">
              Current Balance: ${formatCurrency(getEnterpriseBalance(ent?.id))}
            </div>
            ${selectedEnterprise.type === 'savings' ? `
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">
                Max withdrawal: ${formatCurrency(maxWithdrawal)}
              </div>
            ` : ''}
          </div>
          <div class="field">
            <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;">Amount (₦)</label>
            <input type="number" id="wizard-withdrawal-amount" step="0.01" min="0" ${selectedEnterprise.type === 'savings' ? `max="${maxWithdrawal}"` : ''} value="${withdrawalAmount || ''}" style="padding: 0.85rem; font-size: 1.1rem; font-weight: 700;">
          </div>
        </div>
      `;
    } else if (selectedEnterprise.type === 'loan' && ((canSelectMember && wizardStep === 5) || (!canSelectMember && wizardStep === 4))) {
      // Loan only: Step 5 (non-member) / Step 4 (Member): Enter Duration
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Enter Duration</h4>
          <div class="field">
            <label style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em;">Duration (Months)</label>
            <input type="number" id="wizard-loan-duration" min="1" value="${loanDuration || 1}" style="padding: 0.85rem; font-size: 1.1rem; font-weight: 700;">
          </div>
        </div>
      `;
    } else if (selectedEnterprise.type === 'loan' && ((canSelectMember && wizardStep === 6) || (!canSelectMember && wizardStep === 5))) {
      // Loan only: Step 6 (non-member) / Step 5 (Member): Select Guarantors
      stepContent = `
        <div style="padding: 1rem 0; min-height: 400px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h4 style="margin: 0;">Select Guarantors</h4>
            <button type="button" id="wizard-add-guarantor-btn" class="ghost-button" style="color: var(--accent-primary); height: auto; padding: 0.5rem 1rem;">+ Add Guarantor</button>
          </div>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.5rem;">Select members to guarantee this loan.</p>
          
          <div id="wizard-guarantors-list" style="display: flex; flex-direction: column; gap: 0.85rem;">
            ${guarantors.map((g, gi) => `
              <div class="wizard-guarantor-row" data-index="${gi}" style="display: flex; flex-direction: column; gap: 0.5rem; background: var(--bg-card); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border-medium);">
                <div style="display: grid; grid-template-columns: 1fr 120px auto; gap: 0.75rem; align-items: center;">
                  <div style="position: relative; z-index: 999999;">
                    <input type="text" class="wizard-guarantor-search" placeholder="Search guarantor name..." value="${escapeHtml(g.name || '')}" style="width: 100%; height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                    <div class="wizard-guarantor-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 200px; overflow-y: auto; margin-top: 0.25rem;"></div>
                    <input type="hidden" class="wizard-guarantor-id" value="${g.member_id || ''}">
                  </div>
                  <input type="number" class="wizard-guarantor-amt" value="${g.amount || ''}" placeholder="Amount" style="height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                  <button type="button" class="wizard-remove-guarantor" style="color: var(--danger); border: 0; background: transparent; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center;">&times;</button>
                </div>
                <div class="wizard-g-info-row" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 0.25rem;">
                  <div class="wizard-g-selected-display" style="font-size: 0.75rem; color: var(--accent-primary); font-weight: 600;">
                    ${g.name ? `Selected: ${g.name}` : ''}
                  </div>
                </div>
              </div>
            `).join('')}
            ${guarantors.length === 0 ? '<p id="wizard-empty-guarantors-msg" style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 2rem; border: 1px dashed var(--border-light); border-radius: 0.5rem;">No guarantors added yet. Click "+ Add Guarantor" to start.</p>' : ''}
          </div>
        </div>
      `;
    } else if (selectedEnterprise.type === 'loan' && ((canSelectMember && wizardStep === 7) || (!canSelectMember && wizardStep === 6))) {
      // Loan only: Step 7 (non-member) / Step 6 (Member): Review and Confirm
      const ent = enterprises.find(e => e.id === selectedEnterprise.id);
      const selectedMember = allMembers.find(m => m.id === selectedMemberId);
      const principal = Math.abs(parseFloat(withdrawalAmount) || 0);
      const months = Math.max(1, parseInt(loanDuration) || 1);
      const monthlyRepayment = parseFloat((principal / months).toFixed(2));
      const loanCharges = buildLoanCharges(ent, principal);
      const totalCharges = loanCharges.reduce((sum, c) => sum + c.value, 0);
      const totalRepayment = principal + totalCharges;
      const maturityDate = (() => {
        const d = new Date();
        d.setMonth(d.getMonth() + months);
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      })();
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Confirm Loan Request</h4>
          <p style="margin: 0; color: var(--text-muted); font-size: 0.85rem;">Please review the loan details below carefully before submitting.</p>
          <div style="padding: 1rem; background: var(--bg-secondary); border-radius: 0.75rem; border: 1px solid var(--border-light);">
            ${canSelectMember ? `
              <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <span style="color: var(--text-muted);">Member</span>
                <span style="font-weight: 700; color: var(--text-primary);">${escapeHtml(selectedMember?.name || 'Unknown Member')}</span>
              </div>
            ` : ''}
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="color: var(--text-muted);">Account</span>
              <span style="font-weight: 700; color: var(--text-primary);">${escapeHtml(ent?.account_name)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="color: var(--text-muted);">Loan Amount</span>
              <span style="font-weight: 700; font-size: 1.25rem; color: var(--danger);">${formatCurrency(-withdrawalAmount)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="color: var(--text-muted);">Duration</span>
              <span style="font-weight: 700; color: var(--text-primary);">${months} Month${months > 1 ? 's' : ''}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="color: var(--text-muted);">Instalments</span>
              <span style="font-weight: 700; color: var(--text-primary);">${months} Monthly Payment${months > 1 ? 's' : ''}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Expected Completion</span>
              <span style="font-weight: 700; color: var(--text-primary);">${maturityDate}</span>
            </div>

            <div style="margin-top: 0.85rem; padding: 0.9rem; background: var(--bg-card); border: 1px solid var(--accent-primary); border-radius: 0.6rem;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; font-weight: 700;">Monthly Repayment</span>
                <span style="font-weight: 800; font-size: 1.35rem; color: var(--accent-primary);">${formatCurrency(monthlyRepayment)}</span>
              </div>
              <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.4rem;">
                ${formatCurrency(monthlyRepayment)} payable every month for ${months} month${months > 1 ? 's' : ''}, totalling ${formatCurrency(monthlyRepayment * months)} in principal repayments.
              </div>
            </div>

            ${loanCharges.length > 0 ? `
              <div style="border-top: 1px solid var(--border-medium); padding-top: 0.6rem; margin-top: 0.85rem;">
                <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Applicable Charges</span>
                ${loanCharges.map(c => `
                  <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-top: 0.5rem;">
                    <span style="color: var(--text-primary);">${escapeHtml(c.name)}${c.rate ? ` <span style="color: var(--text-muted);">(${c.rate})</span>` : ''}</span>
                    <span style="font-weight: 600; color: var(--danger);">${formatCurrency(c.value)}</span>
                  </div>
                `).join('')}
                <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-top: 0.5rem; font-weight: 700;">
                  <span style="color: var(--text-muted);">Total Charges</span>
                  <span style="color: var(--danger);">${formatCurrency(totalCharges)}</span>
                </div>
              </div>
            ` : ''}

            <div style="display: flex; justify-content: space-between; border-top: 1px solid var(--border-medium); padding-top: 0.6rem; margin-top: 0.6rem;">
              <span style="color: var(--text-muted); font-weight: 700;">Total Repayment</span>
              <span style="font-weight: 800; color: var(--text-primary);">${formatCurrency(totalRepayment)}</span>
            </div>

            ${guarantors.length > 0 ? `
              <div style="display: flex; flex-direction: column; gap: 0.5rem; border-top: 1px solid var(--border-medium); padding-top: 0.5rem; margin-top: 0.5rem;">
                <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; font-weight: 700;">Guarantors:</span>
                ${guarantors.map(g => `
                  <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                    <span>${escapeHtml(g.name || 'Unknown')}</span>
                    <span style="font-weight: 600;">${formatCurrency(g.amount || Math.abs(withdrawalAmount) / (guarantors.length || 1))}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>

          <div style="padding: 1rem; background: var(--bg-secondary); border-left: 4px solid var(--accent-primary); border-radius: 0.5rem;">
            <div style="font-weight: 700; color: var(--text-primary); font-size: 0.9rem; margin-bottom: 0.4rem;">Important Notice</div>
            <p style="margin: 0; color: var(--text-muted); font-size: 0.85rem; line-height: 1.5;">
              By submitting this request, ${canSelectMember ? `the member (${escapeHtml(selectedMember?.name || 'the member')})` : 'you'} confirm that the details above are correct and agree to the terms guiding this loan or withdrawal request. This includes the obligation to repay the loan in monthly instalments of <strong style="color: var(--text-primary);">${formatCurrency(monthlyRepayment)}</strong>, the applicable charges, and all other cooperative loan/recovery policies. The request remains subject to approval by the cooperative.
            </p>
          </div>

          <label for="wizard-terms-check" style="display: flex; align-items: flex-start; gap: 0.6rem; padding: 0.85rem; background: var(--bg-card); border: 1px solid ${termsAccepted ? 'var(--accent-primary)' : 'var(--border-medium)'}; border-radius: 0.6rem; cursor: pointer;">
            <input type="checkbox" id="wizard-terms-check" ${termsAccepted ? 'checked' : ''} style="margin-top: 0.2rem; width: 1.1rem; height: 1.1rem; accent-color: var(--accent-primary); flex-shrink: 0; cursor: pointer;">
            <span style="font-size: 0.85rem; color: var(--text-primary); line-height: 1.45;">I have read and understood the details above, and I agree to the terms guiding this loan or withdrawal request.</span>
          </label>
        </div>
      `;
    } else if ((canSelectMember && wizardStep === 5) || (!canSelectMember && wizardStep === 4)) {
      // Savings only: Step 5 (non-member) / Step 4 (Member): Review and Confirm
      const ent = enterprises.find(e => e.id === selectedEnterprise.id);
      const selectedMember = allMembers.find(m => m.id === selectedMemberId);
      stepContent = `
        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <h4 style="margin: 0; color: var(--text-primary);">Confirm Savings Withdrawal</h4>
          <div style="padding: 1rem; background: var(--bg-secondary); border-radius: 0.75rem; border: 1px solid var(--border-light);">
            ${canSelectMember ? `
              <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <span style="color: var(--text-muted);">Member</span>
                <span style="font-weight: 700; color: var(--text-primary);">${escapeHtml(selectedMember?.name || 'Unknown Member')}</span>
              </div>
            ` : ''}
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="color: var(--text-muted);">Account</span>
              <span style="font-weight: 700; color: var(--text-primary);">${escapeHtml(ent?.account_name)}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Amount</span>
              <span style="font-weight: 700; font-size: 1.25rem; color: var(--danger);">${formatCurrency(-withdrawalAmount)}</span>
            </div>
          </div>

          <div style="padding: 1rem; background: var(--bg-secondary); border-left: 4px solid var(--accent-primary); border-radius: 0.5rem;">
            <div style="font-weight: 700; color: var(--text-primary); font-size: 0.9rem; margin-bottom: 0.4rem;">Important Notice</div>
            <p style="margin: 0; color: var(--text-muted); font-size: 0.85rem; line-height: 1.5;">
              By submitting this request, ${canSelectMember ? `the member (${escapeHtml(selectedMember?.name || 'the member')})` : 'you'} confirm that the details above are correct and agree to the terms guiding this loan or withdrawal request, including the cooperative's savings withdrawal and account policies. The request remains subject to approval by the cooperative.
            </p>
          </div>

          <label for="wizard-terms-check" style="display: flex; align-items: flex-start; gap: 0.6rem; padding: 0.85rem; background: var(--bg-card); border: 1px solid ${termsAccepted ? 'var(--accent-primary)' : 'var(--border-medium)'}; border-radius: 0.6rem; cursor: pointer;">
            <input type="checkbox" id="wizard-terms-check" ${termsAccepted ? 'checked' : ''} style="margin-top: 0.2rem; width: 1.1rem; height: 1.1rem; accent-color: var(--accent-primary); flex-shrink: 0; cursor: pointer;">
            <span style="font-size: 0.85rem; color: var(--text-primary); line-height: 1.45;">I have read and understood the details above, and I agree to the terms guiding this loan or withdrawal request.</span>
          </label>
        </div>
      `;
    }

    const isNextEnabled = calculateIsNextEnabled();

    modalContainer.innerHTML = `
      <div class="modal-content" style="max-width: 500px; display: flex; flex-direction: column; height: 95vh; max-height: 95vh; margin: auto;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border-light); flex-shrink: 0;">
          <h3 style="margin: 0; font-weight: 700; color: var(--text-primary);">${wizardTitle}</h3>
          <button class="close-btn" onclick="document.getElementById('withdrawal-wizard-modal').remove()" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1.5rem 1.25rem; overflow-y: auto; flex-grow: 1;">
          <div style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem;">
            ${Array.from({length: totalSteps}, (_, i) => i + 1).map(step => `
              <div style="flex: 1; height: 4px; border-radius: 2px; background: ${step <= wizardStep ? 'var(--accent-primary)' : 'var(--border-light)'};"></div>
            `).join('')}
          </div>
          ${stepContent}
        </div>
        <div class="modal-footer" style="display: flex; justify-content: space-between; gap: 0.75rem; padding: 1rem; border-top: 1px solid var(--border-light); flex-shrink: 0;">
          ${wizardStep > (canSelectMember ? 1 : 1) ? `
            <button type="button" class="secondary-button" id="wizard-back-btn" style="background: transparent; border: 1px solid var(--border-medium); color: var(--text-primary); padding: 0.6rem 1.2rem; border-radius: 0.5rem; font-weight: 700; cursor: pointer;">Back</button>
          ` : '<div></div>'}
          <button type="button" class="primary-button" id="wizard-next-btn" style="background: var(--accent-primary); color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 0.5rem; font-weight: 700; cursor: pointer; ${!isNextEnabled ? 'opacity: 0.5; pointer-events: none;' : ''}">
            ${wizardStep < totalSteps ? 'Next' : 'Submit'}
          </button>
        </div>
      </div>
    `;

    attachModalListeners();
  };
  
  const calculateIsNextEnabled = () => {
    const ent = enterprises.find(e => e.id === selectedEnterprise?.id);
    const maxWithdrawal = selectedEnterprise?.type === 'savings' && ent 
      ? Math.max(0, getEnterpriseBalance(ent.id)) 
      : 999999999;
    const isValidAmount = (selectedEnterprise?.type === 'loan' ? ((canSelectMember && wizardStep === 4) || (!canSelectMember && wizardStep === 3)) : ((canSelectMember && wizardStep === 4) || (!canSelectMember && wizardStep === 3)))
      ? withdrawalAmount > 0 && (selectedEnterprise.type !== 'savings' || withdrawalAmount <= maxWithdrawal)
      : true;
    const isValidMember = !canSelectMember || selectedMemberId;
    const isValidDuration = selectedEnterprise?.type === 'loan' && ((canSelectMember && wizardStep === 5) || (!canSelectMember && wizardStep === 4))
      ? loanDuration >= 1
      : true;
    const isValidTerms = wizardStep !== getConfirmStepNo() || termsAccepted;
    const isTypeStep = (canSelectMember && wizardStep === 2) || (!canSelectMember && wizardStep === 1);
    const isValidType = !isTypeStep || !!selectedEnterprise;
    const isEnterpriseStep = (canSelectMember && wizardStep === 3) || (!canSelectMember && wizardStep === 2);
    const isValidEnterprise = !isEnterpriseStep || !!selectedEnterprise?.id;
    return isValidAmount && isValidMember && isValidDuration && isValidTerms && isValidType && isValidEnterprise;
  };
  
  const updateNextButton = () => {
    const nextBtn = document.getElementById('wizard-next-btn');
    if (nextBtn) {
      const isNextEnabled = calculateIsNextEnabled();
      if (isNextEnabled) {
        nextBtn.style.opacity = '1';
        nextBtn.style.pointerEvents = 'auto';
      } else {
        nextBtn.style.opacity = '0.5';
        nextBtn.style.pointerEvents = 'none';
      }
    }
  };

  const attachModalListeners = () => {
    // Back button
    document.getElementById('wizard-back-btn')?.addEventListener('click', () => {
      wizardStep--;
      renderModal();
    });

    // Terms agreement checkbox (final confirm step)
    const termsCheck = document.getElementById('wizard-terms-check');
    termsCheck?.addEventListener('change', (e) => {
      termsAccepted = !!e.target.checked;
      const label = termsCheck.closest('label');
      if (label) label.style.borderColor = termsAccepted ? 'var(--accent-primary)' : 'var(--border-medium)';
      updateNextButton();
    });

    if (canSelectMember && wizardStep === 1) {
      // Setup searchable member dropdown
      const memberSearchInput = document.getElementById('wizard-member-search');
      const memberSuggestions = document.getElementById('wizard-member-suggestions');
      if (memberSearchInput && memberSuggestions) {
        memberSearchInput.addEventListener('input', async (e) => {
          const text = (e.target.value || '').toLowerCase().trim();
          if (!text) {
            memberSuggestions.style.display = 'none';
            return;
          }

          const matches = allMembers.filter(m => {
            const nameMatch = (m.name || '').toLowerCase().includes(text);
            const regMatch = String(m.registration_no || m.file_no || '').toLowerCase().includes(text);
            const specialIdMatch = String(m.special_id || '').toLowerCase().includes(text);
            const mobileMatch = String(m.mobile || '').toLowerCase().includes(text);
            return nameMatch || regMatch || specialIdMatch || mobileMatch;
          }).slice(0, 10);

          if (matches.length > 0) {
            memberSuggestions.innerHTML = matches.map(m => `
              <div class="wizard-member-suggestion" data-id="${m.id}" data-name="${escapeHtml(m.name)}" style="padding: 0.75rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
                <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">${escapeHtml(m.name)}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">
                  ${m.special_id ? `ID: ${escapeHtml(m.special_id)}` : ''} ${m.special_id && (m.registration_no || m.file_no) ? ' • ' : ''} ${m.registration_no || m.file_no ? `Reg: ${m.registration_no || m.file_no}` : ''} ${(m.special_id || m.registration_no || m.file_no) && m.mobile ? ' • ' : ''} ${m.mobile ? `Mobile: ${m.mobile}` : ''}
                </div>
              </div>
            `).join('');
            memberSuggestions.style.display = 'block';

            memberSuggestions.querySelectorAll('.wizard-member-suggestion').forEach(item => {
                item.addEventListener('mousedown', async (e) => {
                    e.preventDefault();
                    const { id, name } = item.dataset;
                    selectedMemberId = id;
                    memberBalances = selectedMemberId 
                        ? await getMemberBalances(selectedMemberId) 
                        : {};
                    renderModal();
                    const searchAgain = document.getElementById('wizard-member-search');
                    if (searchAgain) {
                      searchAgain.focus();
                      searchAgain.select();
                    }
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
    } else if ((canSelectMember && wizardStep === 2) || (!canSelectMember && wizardStep === 1)) {
      // Select type
      document.querySelectorAll('.wizard-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedEnterprise = { type: btn.dataset.type };
          // Reset loan-specific state
          loanDuration = 1;
          guarantors = [];
          termsAccepted = false;
          wizardStep = canSelectMember ? 3 : 2;
          renderModal();
        });
      });
    } else if ((canSelectMember && wizardStep === 3) || (!canSelectMember && wizardStep === 2)) {
      // Select enterprise
      document.querySelectorAll('.wizard-enterprise-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedEnterprise.id = btn.dataset.entid;
          wizardStep = canSelectMember ? 4 : 3;
          renderModal();
        });
      });
    } else if ((canSelectMember && wizardStep === 4) || (!canSelectMember && wizardStep === 3)) {
      // Capture amount input - update state and button without full re-render
      const amtInput = document.getElementById('wizard-withdrawal-amount');
      amtInput?.addEventListener('input', (e) => {
        withdrawalAmount = parseFloat(e.target.value || 0);
        updateNextButton();
      });
    } else if (selectedEnterprise.type === 'loan' && ((canSelectMember && wizardStep === 5) || (!canSelectMember && wizardStep === 4))) {
      // Loan duration input
      const durationInput = document.getElementById('wizard-loan-duration');
      durationInput?.addEventListener('input', (e) => {
        loanDuration = parseInt(e.target.value || 1);
        updateNextButton();
      });
    } else if (selectedEnterprise.type === 'loan' && ((canSelectMember && wizardStep === 6) || (!canSelectMember && wizardStep === 5))) {
      // Guarantor management
      const addGuarantorBtn = document.getElementById('wizard-add-guarantor-btn');
      const guarantorsList = document.getElementById('wizard-guarantors-list');
      
      const setupGuarantorSearch = (row) => {
        const searchInput = row.querySelector('.wizard-guarantor-search');
        const suggestions = row.querySelector('.wizard-guarantor-suggestions');
        const hiddenId = row.querySelector('.wizard-guarantor-id');
        const amtInput = row.querySelector('.wizard-guarantor-amt');
        const display = row.querySelector('.wizard-g-selected-display');
        const removeBtn = row.querySelector('.wizard-remove-guarantor');
        const gi = parseInt(row.dataset.index);
        
        searchInput?.addEventListener('input', async (e) => {
          const text = (e.target.value || '').toLowerCase().trim();
          if (!text) {
            suggestions.style.display = 'none';
            return;
          }
          
          const matches = allMembers.filter(m => {
            const isSelf = m.id === selectedMemberId;
            if (isSelf) return false;
            const nameMatch = (m.name || '').toLowerCase().includes(text);
            const regMatch = String(m.registration_no || m.file_no || '').toLowerCase().includes(text);
            return nameMatch || regMatch;
          }).slice(0, 8);
          
          if (matches.length > 0) {
            suggestions.innerHTML = matches.map(m => `
              <div class="wizard-g-suggestion" data-id="${m.id}" data-name="${escapeHtml(m.name)}" data-file="${escapeHtml(m.file_no || m.registration_no || 'N/A')}" style="padding: 0.75rem 1rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
                <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">${escapeHtml(m.name)}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">File/Reg: ${m.file_no || m.registration_no || 'N/A'}</div>
              </div>
            `).join('');
            suggestions.style.display = 'block';
            
            suggestions.querySelectorAll('.wizard-g-suggestion').forEach(item => {
              item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const { id, name } = item.dataset;
                hiddenId.value = id;
                searchInput.value = name;
                display.innerText = `Selected: ${name}`;
                suggestions.style.display = 'none';
                
                // Update state
                guarantors[gi] = {
                  ...guarantors[gi],
                  member_id: id,
                  name
                };
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
          guarantors[currentIdx].amount = parseFloat(e.target.value || 0);
        });
        
        removeBtn?.addEventListener('click', () => {
          const currentIdx = parseInt(row.dataset.index);
          guarantors.splice(currentIdx, 1);
          renderModal();
        });
      };
      
      if (addGuarantorBtn && guarantorsList) {
        addGuarantorBtn.addEventListener('click', () => {
          const gIdx = guarantors.length;
          const gTempId = generateId();
          guarantors.push({ member_id: '', name: '', amount: 0, tempId: gTempId });
          
          const emptyMsg = guarantorsList.querySelector('#wizard-empty-guarantors-msg');
          if (emptyMsg) emptyMsg.remove();
          
          const rowHtml = `
            <div class="wizard-guarantor-row" data-index="${gIdx}" data-id="${gTempId}" style="display: flex; flex-direction: column; gap: 0.5rem; background: var(--bg-card); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border-medium);">
              <div style="display: grid; grid-template-columns: 1fr 120px auto; gap: 0.75rem; align-items: center;">
                <div style="position: relative; z-index: 999999;">
                  <input type="text" class="wizard-guarantor-search" placeholder="Search guarantor name..." style="width: 100%; height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                  <div class="wizard-guarantor-suggestions" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: 0.5rem; box-shadow: var(--shadow-lg); z-index: 999999; max-height: 200px; overflow-y: auto; margin-top: 0.25rem;"></div>
                  <input type="hidden" class="wizard-guarantor-id">
                </div>
                <input type="number" class="wizard-guarantor-amt" value="0" placeholder="Amount" style="height: 2.75rem; padding: 0 0.75rem; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius-sm);">
                <button type="button" class="wizard-remove-guarantor" style="color: var(--danger); border: 0; background: transparent; font-size: 1.5rem; cursor: pointer; display: flex; align-items: center; justify-content: center;">&times;</button>
              </div>
              <div class="wizard-g-info-row" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 0.25rem;">
                <div class="wizard-g-selected-display" style="font-size: 0.75rem; color: var(--accent-primary); font-weight: 600;"></div>
              </div>
            </div>
          `;
          guarantorsList.insertAdjacentHTML('beforeend', rowHtml);
          setupGuarantorSearch(guarantorsList.lastElementChild);
        });
      }
      
      document.querySelectorAll('.wizard-guarantor-row').forEach(row => {
        setupGuarantorSearch(row);
      });
    }

    // Next button
    document.getElementById('wizard-next-btn')?.addEventListener('click', async () => {
      totalSteps = selectedEnterprise?.type === 'loan' 
        ? (canSelectMember ? 7 : 6) 
        : (canSelectMember ? 5 : 4);
      if (wizardStep < totalSteps) {
        // Validation
        if ((canSelectMember && wizardStep === 4) || (!canSelectMember && wizardStep === 3)) {
          // Amount step
          if (!withdrawalAmount || withdrawalAmount <= 0) {
            showToast('Please enter a valid amount', 'warning');
            return;
          }
          const ent = enterprises.find(e => e.id === selectedEnterprise.id);
          if (selectedEnterprise.type === 'savings') {
            const maxWithdrawal = Math.max(0, getEnterpriseBalance(ent.id));
            if (withdrawalAmount > maxWithdrawal) {
              showToast('Amount exceeds available balance', 'error');
              return;
            }
          }
        } else if (canSelectMember && wizardStep === 1) {
          // Member selection step
          if (!selectedMemberId) {
            showToast('Please select a member', 'warning');
            return;
          }
        }
        wizardStep++;
        renderModal();
      } else {
        // Submit directly to database
        if (!termsAccepted) {
          showToast('Please accept the terms guiding this request before submitting', 'warning');
          return;
        }
        try {
          const ent = enterprises.find(e => e.id === selectedEnterprise.id);
          const selectedMember = allMembers.find(m => m.id === selectedMemberId);
          const transactionType = selectedEnterprise.type === 'loan' ? 'Member Loan' : 'Savings Withdrawal';
          const requestBase = selectedEnterprise.type === 'loan' ? 'Loan Request' : 'Savings Withdrawal Request';
          const requesterRef = selectedMember ? (selectedMember.file_no || selectedMember.registration_no) : '';
          const description = (canSelectMember && selectedMember?.name)
            ? `${requestBase} — Requested for ${selectedMember.name}${requesterRef ? ` (${requesterRef})` : ''}`
            : requestBase;
          const amount = -Math.abs(withdrawalAmount);
          const details = [
            {
              id: generateId(state.welcomeUser.cooperativeId),
              enterprise_id: ent.id,
              item: ent.id,
              amount: amount,
              ...(selectedEnterprise.type === 'loan' ? {
                loan_info: {
                  loanData: {
                    principalAmount: Math.abs(withdrawalAmount),
                    durationMonths: loanDuration,
                    issueDate: new Date().toISOString().split('T')[0],
                    dueDate: '',
                    status: 'Pending',
                    notes: 'Loan Request'
                  },
                  guarantors: guarantors.map(g => ({
                    ...g,
                    id: g.id || generateId(state.welcomeUser.cooperativeId),
                    amount: g.amount || Math.abs(withdrawalAmount) / (guarantors.length || 1)
                  }))
                }
              } : {})
            }
          ];

          const remittanceData = {
            id: null,
            member_id: selectedMemberId,
            amount: amount,
            bank_name: '',
            description: description,
            transaction_type: transactionType,
            remittance_date: new Date().toISOString().split('T')[0],
            details: details,
            isLoanRequest: selectedEnterprise.type === 'loan',
            isWithdrawalRequest: true,
            cooperative_id: state.welcomeUser.cooperativeId,
            user_role: state.welcomeUser.role || 'member',
            user_roles: [state.welcomeUser.role || 'member'],
            status: 'Pending',
            is_deleted: 0,
            is_synced: 0,
            created_at: new Date().toISOString(),
            created_by: state.welcomeUser.username,
            modified_at: new Date().toISOString(),
            modified_by: state.welcomeUser.username
          };

          await addRemittance(remittanceData, state.welcomeUser.username);

          document.getElementById('withdrawal-wizard-modal').remove();
          
          // Refresh the current screen — this module has no direct access to
          // the app renderer, so signal it instead of calling render().
          window.dispatchEvent(new CustomEvent('remittance-saved'));
          showToast('Request submitted successfully!', 'success');
        } catch (err) {
          showToast('Error submitting request: ' + err.message, 'error');
        }
      }
    });
  };

  const overlay = document.createElement('div');
  overlay.id = 'withdrawal-wizard-modal';
  overlay.className = 'modal-overlay open';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '999999';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '1rem';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const handleWizardEnter = (e) => {
    if (!overlay.isConnected) {
      document.removeEventListener('keydown', handleWizardEnter);
      return;
    }
    if (e.key !== 'Enter') return;
    const el = e.target;
    const tag = (el?.tagName || '').toLowerCase();
    if (tag === 'button') return;
    const inModal = overlay.contains(el);
    const isIdle = el === document.body || el === document.documentElement;
    if (!inModal && !isIdle) return;
    if (!isIdle && tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    if (!calculateIsNextEnabled()) return;
    const nextBtn = document.getElementById('wizard-next-btn');
    if (!nextBtn || nextBtn.style.pointerEvents === 'none') return;
    e.preventDefault();
    nextBtn.click();
  };
  document.addEventListener('keydown', handleWizardEnter);
  document.body.appendChild(overlay);
  renderModal();
}
