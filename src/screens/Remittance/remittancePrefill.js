import { generateId } from '../../utils/formatters.js';

// --- Loan Request Prefill ---
const applyLoanRequestPrefillInternal = (editingData, enterpriseData, memberId, user) => {
    console.log("[DIAG] applyLoanRequestPrefillInternal: editingData=", editingData);
    const loanAmount = -Math.abs(editingData.amount || 0);
    const principalAmount = Math.abs(loanAmount);
    const enterpriseId = editingData.enterpriseId || editingData.enterprise_id;

    const issueDateStr = new Date().toISOString().split('T')[0];
    const durationMonths = editingData.duration || 1;
    const dDate = new Date(issueDateStr);
    dDate.setMonth(dDate.getMonth() + durationMonths);
    const dueDateStr = dDate.toISOString().split('T')[0];

    // Load default charges from Enterprise
    const enterprise = enterpriseData.find(e => String(e.id) === String(enterpriseId));
    const defaultCharges = [];
    if (enterprise) {
      // Map old enterprise fields to charges (always positive magnitudes)
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

    const prefilled = {
      id: null,
      member_id: editingData.member_id || memberId,
      amount: loanAmount,
      transaction_type: 'Member Loan',
      isLoanRequest: true,
      description: editingData.description || 'Loan Request',
      remittance_date: issueDateStr,
      details: [{
        id: generateId(String(user.cooperativeId)),
        enterprise_id: enterpriseId,
        item: enterpriseId,
        amount: loanAmount,
        loan_info: {
          loanData: {
            principalAmount,
            durationMonths,
            issueDate: issueDateStr,
            dueDate: dueDateStr,
            status: 'Pending',
            notes: 'Loan Request'
          },
          guarantors: (editingData.guarantors || []).map(g => ({
            id: g.id || generateId(String(user.cooperativeId)),
            member_id: g.member_id,
            name: g.name,
            file_no: g.file_no || '',
            amount: g.amount || (principalAmount / Math.max(editingData.guarantors.length, 1)),
            guarantor_approval: null
          })),
          charges: defaultCharges
        }
      }]
    };
    console.log("[DIAG] Prefilled data:", prefilled);
    return prefilled;
};

// --- Withdrawal Request Prefill ---
const applyWithdrawalRequestPrefillInternal = (withdrawalData, enterpriseData, memberId, user) => {
    console.log("[DIAG] applyWithdrawalRequestPrefillInternal: withdrawalData=", withdrawalData);
    const withdrawalAmount = -Math.abs(withdrawalData.amount || 0);
    const enterpriseId = withdrawalData.enterpriseId || withdrawalData.enterprise_id;
    const enterprise = enterpriseData.find(e => e.id === enterpriseId);
    const accountType = enterprise?.account_type?.toLowerCase() || 'savings';
    const transactionType = accountType === 'loan' ? 'Member Loan' : 'Savings Withdrawal';
    
    const issueDateStr = new Date().toISOString().split('T')[0];

    const prefilled = {
      id: null,
      member_id: withdrawalData.member_id || memberId,
      amount: withdrawalAmount,
      transaction_type: transactionType,
      isLoanRequest: accountType === 'loan',
      isWithdrawalRequest: true,
      description: accountType === 'loan' ? 'Loan Withdrawal' : 'Withdrawal Request',
      remittance_date: issueDateStr,
      details: [{
        id: generateId(String(user.cooperativeId)),
        enterprise_id: enterpriseId,
        item: enterpriseId,
        amount: withdrawalAmount,
        loan_info: accountType === 'loan' ? {
          loanData: {
            principalAmount: Math.abs(withdrawalAmount),
            durationMonths: withdrawalData.duration || 1,
            issueDate: issueDateStr,
            dueDate: withdrawalData.dueDate || '',
            status: 'Pending',
            notes: 'Loan Withdrawal'
          },
          guarantors: (withdrawalData.guarantors || []).map(g => ({
            id: g.id || generateId(String(user.cooperativeId)),
            member_id: g.member_id,
            name: g.name,
            file_no: g.file_no || '',
            amount: g.amount || (Math.abs(withdrawalAmount) / Math.max(withdrawalData.guarantors.length, 1)),
            guarantor_approval: null
          }))
        } : null
      }]
    };
    console.log("[DIAG] Prefilled withdrawal data:", prefilled);
    return prefilled;
};

export { applyLoanRequestPrefillInternal, applyWithdrawalRequestPrefillInternal };
