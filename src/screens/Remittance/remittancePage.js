import { fetchRemittances, fetchEnterprises, fetchAllMembers, addRemittance, updateRemittance, fetchBanks, buildAccountBalance, fetchLoanById, fetchGuarantorStats, fetchMemberDoc, fetchTransactionTypes, fetchRemittancesPage, deleteRemittance, fetchMemberPaymentAdvise, cleanupRemittanceFamily, updateMemberPaymentAdvice } from '../../services/dataService.js';
import { createDuesTransfer, createDuesIncomePickup } from '../../services/data/duesTransfer.js';
import { hasPermission } from '../../services/permissionService.js';
import { formatCurrency, formatDate, formatDateForInput, escapeHtml, getTimestampMs, generateId, generateRemittanceId, wrapDateInput, formatDateTime, getInitials, timestampTail } from '../../utils/formatters.js';
import { showToast } from '../../services/toastService.js';
import { getAllForCoop, queryOne } from '../../services/sqliteService.js';
import { getAvatarColor, isMobile } from './constants.js';
import { applyLoanRequestPrefillInternal, applyWithdrawalRequestPrefillInternal } from './remittancePrefill.js';
import { showLoanConfigModal } from './remittanceLoanConfig.js';
import { exportData } from './remittanceExport.js';
import { attachEventListeners } from './remittanceEventListeners.js';
import { render as _render } from './remittanceRender.js';
import { showReverseModal } from './remittanceReverse.js';
import { showBulkRemittanceModal } from './remittanceBulk.js';
import { showWorkspaceSpinner } from '../../components/workspaceSpinner.js';
import { save as persistState, load as loadPersisted } from '../../services/statePersistence.js';

    export async function renderUnifiedPayment(container, user) {
    const isActualAdmin = hasPermission(user.permissions, 'admin') || (user.username || '').toLowerCase() === 'admin';
    const canApprove = isActualAdmin || hasPermission(user.permissions, 'approve_remittance');
    const canDelete = isActualAdmin || hasPermission(user.permissions, 'delete_remittance');
    const canReverse = isActualAdmin || hasPermission(user.permissions, 'reverse_remittance');
    const canUpdate = isActualAdmin || hasPermission(user.permissions, 'update_remittance');
    const isAdmin = isActualAdmin || user.isAdmin || hasPermission(user.permissions, 'read_member');
    const isMember = user.role === 'member';
    const cooperativeId = user.cooperativeId;

  // Members are never allowed to view Remittance (all devices).
  // Staff/admin (any non-member role) always can, regardless of permission.
  if (isMember) {
    container.innerHTML = '<div class="alert">Access Restricted: Members cannot view the Remittance page.</div>';
    return;
  }

  if (!cooperativeId) {
    container.innerHTML = '<div class="alert">Error: Cooperative ID missing. Please log in again.</div>';
    return;
  }

  const deps = {};

  // --- State Variables ---
  let enterpriseData = [];
  let members = [];
  let selectorMembers = [];
  let banks = [];
  let transactionTypes = [];
  let openingBalances = {};
  let paymentAdvise = {};
  let showAllZeros = false;
  let previewMode = false; // When true, form is read-only showing a selected history record
  let editMode = false; // When true, form is editable for updating an existing parent remittance
  let sealLocked = false; // Reconciled record: Bank/Date/Amount inputs are frozen

  // --- Form State ---
  let formData = {
    id: null,
    remittance_date: new Date().toISOString().split('T')[0],
    bank_name: '',
    amount: 0,
    description: '',
    transaction_type: '',
    member_id: isAdmin ? '' : user.memberId,
    details: [],
    isLoanRequest: false,
    isWithdrawalRequest: false
  };
  let initialFormData = JSON.parse(JSON.stringify(formData));

  // --- History State ---
  // A dashboard shortcut ("Review pending") may pre-set the status filter
  // via sessionStorage; consume it once so the table lands pre-filtered
  // (the filter overlay select reflects historyState.filters.status).
  let requestedHistoryStatus = 'All';
  try {
    const v = sessionStorage.getItem('cooplog-history-status');
    if (v && ['Pending', 'Approved', 'Rejected'].includes(v)) requestedHistoryStatus = v;
    sessionStorage.removeItem('cooplog-history-status');
  } catch {}

  // Restore persisted history filters (survives F5)
  const _savedRemit = loadPersisted('remit-filters') || {};
  const historyState = {
    cooperativeId,
    allRemittances: [],
    members: [],
    membersMap: {},
    managedMemberIds: null,
    lastVisibleDoc: null,
    hasMore: true,
    isLoading: false,
    searchTerm: _savedRemit.searchTerm || '',
    searchColumn: _savedRemit.searchColumn || 'All Columns',
    selectedRemittanceId: null,
    selectedRemittanceIds: new Set(),
    filters: {
      status: requestedHistoryStatus !== 'All' ? requestedHistoryStatus : (_savedRemit.status || 'All'),
      bank: _savedRemit.bank || 'All',
      dateRange: _savedRemit.dateRange || 'All',
      minAmount: _savedRemit.minAmount || null,
      maxAmount: _savedRemit.maxAmount || null,
      memberId: (isActualAdmin || isAdmin) ? (_savedRemit.memberId || 'All') : (user.memberId || 'All'),
      transactionType: _savedRemit.transactionType || 'All',
      dateFrom: _savedRemit.dateFrom || '',
      dateTo: _savedRemit.dateTo || ''
    },
    selectAll: false,
    expandedRemittanceIds: new Set(),
    stats: {
      total: 0,
      approved: 0,
      pending: 0,
      monthTotal: 0,
      rejected: 0
    }
  };

  // --- Panel Size State ---
  const PANEL_SIZE_KEY = `cooplog-panels-${user.cooperativeId}-${user.id}`;
  let panelSizes = {
    breakdownWidth: 420,
    topSectionHeight: null
  };
  try {
    const saved = localStorage.getItem(PANEL_SIZE_KEY);
    if (saved) {
      panelSizes = JSON.parse(saved);
    }
  } catch (e) {
    console.error('Failed to load panel sizes:', e);
  }

  // --- Session Storage ---
  const SESSION_KEY = `cooplog-form-${user.cooperativeId}-${isAdmin ? 'admin' : user.memberId}`;
  const saveSavedForm = (data) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch (e) {}
  };
  const clearSavedForm = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  };

  // --- Focus Tracking ---
  let activeId = null;
  let activeName = null;
  let activeRowEntId = null;
  let selectionStart = 0;
  let selectionEnd = 0;
  const trackFocus = () => {
    const el = document.activeElement;
    if (!el || !container.contains(el)) {
      activeId = null;
      activeName = null;
      activeRowEntId = null;
      selectionStart = 0;
      selectionEnd = 0;
      return;
    }
    activeId = el.id || null;
    activeName = el.name || null;
    const detailRow = el.closest('.detail-item-row');
    activeRowEntId = detailRow ? detailRow.dataset.entid : null;
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        selectionStart = el.selectionStart || 0;
        selectionEnd = el.selectionEnd || 0;
      }
    } catch (e) {}
  };
  document.addEventListener('focusin', trackFocus);
  document.addEventListener('focusout', trackFocus);

  // --- Helpers ---
  const getFormattedName = (mid, tranType = '') => {
    if (mid === '0000000000' || mid === '0') return tranType || 'Cooperative';
    const mem = historyState.membersMap[mid];
    if (!mem) return 'Unknown Member';
    const last = mem.last_name || '';
    const firstName = String(mem.first_name || '');
    const middleName = String(mem.middle_name || '');
    const first = firstName ? firstName[0].toUpperCase() + '.' : '';
    const middle = middleName ? middleName[0].toUpperCase() + '.' : '';
    return `${last} ${first}${middle}`.trim();
  };
  const canViewRemittance = (remit) => {
    if (isActualAdmin) return true;
    if (isMember) return String(remit.member_id) === String(user.memberId);
    if (!isAdmin) {
      const mid = String(remit.member_id);
      const isCoop = mid === '0000000000' || mid === '0';
      if (isCoop) return true;
      if (historyState.membersMap[mid]) return true;
      return false;
    }
    return true;
  };
  const calculateStats = () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    historyState.stats = historyState.allRemittances.reduce((acc, r) => {
      acc.total++;
      const s = (r.status || '').toLowerCase();
      if (s === 'approved') acc.approved += Number(r.amount);
      if (s === 'pending') acc.pending++;
      if (s === 'rejected') acc.rejected++;
      const rDate = new Date(r.remittance_date);
      if (rDate >= monthStart && s === 'approved') acc.monthTotal += Number(r.amount);
      return acc;
    }, { total: 0, approved: 0, pending: 0, monthTotal: 0, rejected: 0 });
  };

  const applyWithdrawalRequestPrefill = async (wrData) => {
    if (!wrData) return;
    trackFocus();
    formData = applyWithdrawalRequestPrefillInternal(wrData, enterpriseData, user.memberId);
    try {
      if (formData.member_id && formData.member_id !== '0000000000') {
        await loadMemberBalances(formData.member_id);
      }
    } catch (e) {
      console.error('Failed to load balances for withdrawal prefill:', e);
    }
    initialFormData = JSON.parse(JSON.stringify(formData));
    render();
  };

  const applyLoanRequestPrefill = async (lrData) => {
    if (!lrData) return;
    trackFocus();
    formData = applyLoanRequestPrefillInternal(lrData, enterpriseData, user.memberId);
    try {
      if (formData.member_id && formData.member_id !== '0000000000') {
        await loadMemberBalances(formData.member_id);
      }
    } catch (e) {
      console.error('Failed to load balances for prefill:', e);
    }
    initialFormData = JSON.parse(JSON.stringify(formData));
    render();
  };

  // --- Load Data ---
  showWorkspaceSpinner(container);
  try {
    const [entRes, memRes, bankRes, txRes] = await Promise.all([
      fetchEnterprises(cooperativeId, true, true),
      fetchAllMembers(cooperativeId, user.username, isAdmin),
      fetchBanks(cooperativeId),
      fetchTransactionTypes(cooperativeId)
    ]);
    enterpriseData = entRes || [];
    members = memRes || [];
    banks = bankRes || [];
    transactionTypes = txRes || [];
    if (!isActualAdmin && isAdmin) {
      selectorMembers = await fetchAllMembers(cooperativeId, user.username, false);
    } else {
      selectorMembers = members;
    }
    historyState.members = members;
    historyState.managedMemberIds = members.map(m => String(m.id));
    members.forEach(m => historyState.membersMap[m.id] = m);
    historyState.banks = banks;
    historyState.transactionTypes = transactionTypes.filter(t => t.is_active);
    await loadHistoryData(true);

    // Load from session
    let loadedForm = null;
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      loadedForm = raw ? JSON.parse(raw) : null;
    } catch (e) {}

    if (loadedForm && loadedForm.id !== 'NEW' && !loadedForm.id) {
      formData = loadedForm;
      if (formData.member_id && formData.member_id !== '0000000000') {
        await loadMemberBalances(formData.member_id);
      }
    } else {
      if (formData.member_id && formData.member_id !== '0000000000') {
        await loadMemberBalances(formData.member_id);
      }
    }
    initialFormData = JSON.parse(JSON.stringify(formData));
  } catch (err) {
    console.error('Data loading error:', err);
    initialFormData = JSON.parse(JSON.stringify(formData));
  }

  // --- History Loader ---
  async function loadHistoryData(isInitial = false) {
    if (historyState.isLoading || (!isInitial && !historyState.hasMore)) return;
    historyState.isLoading = true;
    let autoFetchCount = 0;
    const MAX_AUTO_FETCH = 10;
    let currentIsInitial = isInitial;
    
    while (true) {
      try {
        if (currentIsInitial) {
          historyState.lastVisibleDoc = null;
          historyState.hasMore = true;
          historyState.allRemittances = [];
        }
        const pageSize = 50;
        const searchOptions = {
          searchTerm: historyState.searchTerm,
          searchColumn: historyState.searchColumn,
          ...historyState.filters
        };
        const result = await fetchRemittancesPage(
          cooperativeId,
          user,
          historyState.lastVisibleDoc || 0,
          pageSize,
          searchOptions
        );
        const existingIds = new Set(historyState.allRemittances.map(r => r.id));
        const uniqueBatch = result.remittances.filter(r => !existingIds.has(r.id));
        const newBatch = uniqueBatch.filter(r => canViewRemittance(r));
        if (currentIsInitial) {
          historyState.allRemittances = newBatch;
        } else {
          historyState.allRemittances = [...historyState.allRemittances, ...newBatch];
        }
        historyState.lastVisibleDoc = result.nextOffset;
        if (result.remittances.length < pageSize) historyState.hasMore = false;
        
        // Break if we got items, exhausted data, or hit the auto-fetch safety limit
        if (newBatch.length > 0 || !historyState.hasMore || autoFetchCount >= MAX_AUTO_FETCH) {
          break;
        }
        autoFetchCount++;
        currentIsInitial = false;
      } catch (err) {
        console.error('History load error:', err);
        break;
      }
    }
    
    // Group autogen children under their parents to reduce table clutter.
    // Match by parent_remittance_id (primary), loan_id fallback (legacy), or
    // ID prefix (e.g. child id "PARENT-01" belongs to parent "PARENT").
    const rawRemittances = [...historyState.allRemittances];
    const parentMap = new Map();
    const orphans = [];
    for (const r of rawRemittances) {
      if (r.autogen !== 1) {
        r.children = [];
        parentMap.set(String(r.id), r);
      }
    }
    for (const r of rawRemittances) {
      if (r.autogen !== 1) continue;
      const childId = String(r.id);
      const parentId = r.parent_remittance_id || r.loan_id;
      let parent = parentMap.get(String(parentId));
      // ID-prefix fallback: child "PARENT-01" belongs to parent "PARENT"
      if (!parent) {
        const dashIdx = childId.lastIndexOf('-');
        if (dashIdx > 0) {
          const prefix = childId.substring(0, dashIdx);
          parent = parentMap.get(prefix);
        }
      }
      if (parent) {
        parent.children.push(r);
      } else {
        orphans.push(r);
      }
    }
    historyState.allRemittances = [...parentMap.values(), ...orphans];

    // Sort: newest first by creation time, fallback to remittance_date (desc), then id.
    historyState.allRemittances.sort((a, b) => {
      const createdCmp = String(b.created_at || '').localeCompare(String(a.created_at || ''));
      if (createdCmp !== 0) return createdCmp;
      const dateCmp = new Date(b.remittance_date || 0) - new Date(a.remittance_date || 0);
      if (dateCmp !== 0) return dateCmp;
      return String(b.id).localeCompare(String(a.id));
    });
    calculateStats();
    updateHistoryTable();
    historyState.isLoading = false;
  }

  let historyScrollAttached = false;
  function setupHistoryScrollListener() {
    const tableContainer = container.querySelector('.history-table-container');
    if (!tableContainer || tableContainer.dataset.scrollListener) return;
    historyScrollAttached = true;
    tableContainer.dataset.scrollListener = 'true';
    let scrollTimeout = null;
    tableContainer.addEventListener('scroll', () => {
      if (scrollTimeout) return;
      scrollTimeout = setTimeout(() => {
        scrollTimeout = null;
        if (historyState.isLoading || !historyState.hasMore) return;
        const el = tableContainer;
        const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (scrollBottom < 150) {
          loadHistoryData(false);
        }
      }, 150);
    });
  }

  // --- Member Balances ---
  // Opening rule: sum ONLY records created BEFORE the selected remittance
  // (< its created_on). No remittance selected (new form) -> limitKey is null
  // -> no date limit. Pending records never count: buildAccountBalance only
  // sums Approved, and Closing adds only freshly typed inputs on top.
  async function loadMemberBalances(memberId) {
    if (!memberId || memberId === '0000000000') {
      openingBalances = {};
      paymentAdvise = {};
      return;
    }
    try {
      const limitKey = formData.id && formData.created_at ? { ts: formData.created_at, id: formData.id } : null;
      const balData = await buildAccountBalance(cooperativeId, { ...user, memberId }, limitKey);
      openingBalances = {};
      balData.accountBalance.forEach(b => openingBalances[b.id] = b.sum_of_amount);
      paymentAdvise = {};
      const advTable = await fetchMemberPaymentAdvise(memberId);
      if (advTable && advTable.length > 0) {
        advTable.forEach(adv => {
          if (!paymentAdvise[adv.enterprise_id]) paymentAdvise[adv.enterprise_id] = 0;
          paymentAdvise[adv.enterprise_id] += parseFloat(adv.amount || 0);
        });
      }
    } catch (err) {
      console.error('Balance fetch error:', err);
    }
  }

  // --- Handle Member Change ---
  async function handleMemberChange(newMemberId) {
    formData.member_id = newMemberId;
    previewMode = false;
    // When re-assigning a member on an EXISTING record, keep edit mode so the
    // submit path calls updateRemittance (same tran id) instead of falling
    // through to addRemittance and creating a duplicate record.
    if (!formData.id) editMode = false;
    // Mirror the member choice onto the Admin Mode checkbox immediately so a
    // syncFormData() fired while we await below can't revert the selection.
    const adminCheckEl = container.querySelector('#admin-mode-check');
    if (adminCheckEl) adminCheckEl.checked = newMemberId === '0000000000';
    
    // Keep existing form data — only update member_id
    
    // Load new balances
    if (newMemberId && newMemberId !== '0000000000') {
      await loadMemberBalances(newMemberId);
    } else {
      openingBalances = {};
      paymentAdvise = {};
    }
    
    // Update filters
    historyState.filters.memberId = newMemberId || (isAdmin ? 'All' : user.memberId);
    historyState.selectedRemittanceId = null;
    
    // When a member is freshly selected, force showAllZeros = false so only non-zero rows appear
    deps.showAllZeros = false;
    
    // Refresh history
    await loadHistoryData(true);
    
    render();
  }

  // --- Load Remittance to Form for Read-Only Preview or Edit ---
  async function loadRemittanceToForm(remit) {
    // Determine edit eligibility: only parent (non-autogen), non-reversed records
    const isChild = !!remit.autogen;
    const isReversed = (remit.description || '').toUpperCase().startsWith('REVERSAL:');
    const isPendingLoanRequest = remit.status === 'Pending' && (remit.isLoanRequest || (remit.loans && remit.loans.length > 0));
    const canEditThis = canUpdate && !isChild && !isReversed && !isPendingLoanRequest;
    editMode = canEditThis;
    previewMode = !canEditThis;
    
    // Create a map of loans by enterprise_id for quick lookup
    const loansByEnterprise = {};
    if (remit.loans && remit.loans.length > 0) {
      remit.loans.forEach(loan => {
        loansByEnterprise[loan.enterprise_id] = loan;
      });
    }
    
    // Process each detail and attach loan info if applicable
    const processedDetails = remit.details ? remit.details.map((detail, idx) => {
      let loan = loansByEnterprise[detail.enterprise_id] || loansByEnterprise[detail.item];
      if (loan) {
        // Calculate due date if duration is present but due date is missing
        let dueDate = loan.due_date;
        if (!dueDate && loan.duration_months && loan.issued_date) {
          const issueDate = new Date(loan.issued_date);
          issueDate.setMonth(issueDate.getMonth() + loan.duration_months);
          dueDate = issueDate.toISOString().split('T')[0];
        }
        
        // Load default charges from enterprise if there are none (always positive magnitudes)
        let charges = loan.charges || [];
        if (charges.length === 0) {
          const ent = enterpriseData.find(e => String(e.id) === String(detail.enterprise_id));
          const defaultCharges = [];
          if (ent) {
            if (ent.interest_rate !== undefined && ent.interest_rate !== null && ent.interest_rate !== '') {
              defaultCharges.push({
                id: generateId(String(cooperativeId)),
                name: 'Interest',
                value: Math.abs(parseFloat(ent.interest_rate) || 0),
                type: ent.interest_is_percent ? 'percentage' : 'fixed'
              });
            }
            if (ent.form_fee !== undefined && ent.form_fee !== null && ent.form_fee !== '') {
              defaultCharges.push({
                id: generateId(String(cooperativeId)),
                name: 'Form fee',
                value: Math.abs(parseFloat(ent.form_fee) || 0),
                type: ent.form_fee_is_percent ? 'percentage' : 'fixed'
              });
            }
            if (ent.admin_charge !== undefined && ent.admin_charge !== null && ent.admin_charge !== '') {
              defaultCharges.push({
                id: generateId(String(cooperativeId)),
                name: 'Admin charge',
                value: Math.abs(parseFloat(ent.admin_charge) || 0),
                type: ent.admin_charge_is_percent ? 'percentage' : 'fixed'
              });
            }
          }
          charges = defaultCharges;
        }
        
        // Convert loan record to the format expected by loan_info
        return {
          ...detail,
          loan_info: {
            loanData: {
              principalAmount: loan.principal_amount,
              durationMonths: loan.duration_months,
              issueDate: loan.issued_date,
              dueDate: dueDate,
              notes: loan.notes,
              status: loan.status
            },
            guarantors: (loan.guarantors || []).map(g => ({
              ...g,
              amount: g.guarantee_amount || g.amount || 0
            })),
            charges: charges
          }
        };
      }
      // Fallback: use loan_info stored in the detail record (new request flow)
      if (detail.loan_info) {
        return { ...detail, loan_info: detail.loan_info };
      }
      return detail;
    }) : [];
    
    // If there are loans but no details were found/matched, create a dummy detail to hold the loan info
    if (processedDetails.length === 0 && remit.loans && remit.loans.length > 0) {
      const loan = remit.loans[0];
      let dueDate = loan.due_date;
      if (!dueDate && loan.duration_months && loan.issued_date) {
        const issueDate = new Date(loan.issued_date);
        issueDate.setMonth(issueDate.getMonth() + loan.duration_months);
        dueDate = issueDate.toISOString().split('T')[0];
      }
      processedDetails.push({
        id: 'dummy_' + Math.random().toString(36).substr(2, 9),
        remittance_id: remit.id,
        enterprise_id: loan.enterprise_id,
        item: loan.enterprise_id || 'Loan',
        amount: loan.principal_amount,
        loan_info: {
          loanData: {
            principalAmount: loan.principal_amount,
            durationMonths: loan.duration_months,
            issueDate: loan.issued_date,
            dueDate: dueDate,
            notes: loan.notes,
            status: loan.status
          },
          guarantors: (loan.guarantors || []).map(g => ({
            ...g,
            amount: g.guarantee_amount || g.amount || 0
          })),
          charges: loan.charges || []
        }
      });
    }
    
    // Determine seal (reconciliation) lock BEFORE formData is replaced so the
    // async queries can't interleave with form sync. Locked when the record is
    // linked to an active reconciliation summary, or its (bank, date) falls
    // inside a sealed period.
    sealLocked = false;
    if (remit.reconciliation_summary_id) {
      try {
        const summaryRow = await queryOne(
          'SELECT is_deleted FROM bank_reconciliation_summary WHERE id = ?',
          [remit.reconciliation_summary_id]
        );
        sealLocked = !!(summaryRow && summaryRow.is_deleted !== 1);
      } catch (_) { sealLocked = false; }
    }
    if (!sealLocked && remit.bank_name && remit.remittance_date) {
      try {
        const d = String(remit.remittance_date).slice(0, 10);
        const sealedRow = await queryOne(
          `SELECT id FROM bank_reconciliation_summary
           WHERE cooperative_id = ? AND bank_name = ? AND is_deleted = 0
             AND period_start <= ? AND period_end >= ?
           LIMIT 1`,
          [String(remit.cooperative_id || cooperativeId), remit.bank_name, d, d]
        );
        sealLocked = !!sealedRow;
      } catch (_) { }
    }

    // Set non-detail fields first (details set AFTER balance load to avoid
    // syncFormData reading old DOM during the await and reverting our details).
    // created_at is required: the opening-balance cutoff sums only records
    // created BEFORE this one (< created_on). Without it the cutoff is null
    // and the selected record (plus everything after it) leaks into Opening.
    Object.keys(formData).forEach(k => delete formData[k]);
    Object.assign(formData, {
      id: remit.id,
      remittance_date: remit.remittance_date,
      bank_name: remit.bank_name || '',
      amount: remit.amount || 0,
      description: remit.description || '',
      transaction_type: remit.transaction_type || '',
      member_id: remit.member_id || '',
      created_at: remit.created_at || '',
      isLoanRequest: remit.isLoanRequest || (remit.loans && remit.loans.length > 0),
      status: remit.status
    });
    
    if (formData.member_id && formData.member_id !== '0000000000') {
      await loadMemberBalances(formData.member_id);
    } else {
      openingBalances = {};
      paymentAdvise = {};
    }
    
    // Set details after potential async gap to prevent syncFormData corruption
    formData.details = processedDetails;
    
    render();
  }

  // --- Clear Form ---
  async function clearForm(isFullReset = false) {
    clearSavedForm();
    previewMode = false;
    editMode = false;
    sealLocked = false;
    Object.keys(formData).forEach(k => delete formData[k]);
    Object.assign(formData, {
      id: null,
      remittance_date: new Date().toISOString().split('T')[0],
      bank_name: '',
      amount: 0,
      description: '',
      transaction_type: '',
      member_id: isAdmin ? '' : user.memberId,
      details: [],
      isLoanRequest: false,
      isWithdrawalRequest: false
    });
    initialFormData = JSON.parse(JSON.stringify(formData));
    // Reset all history selection state
    historyState.selectedRemittanceId = null;
    historyState.selectedRemittanceIds = new Set();
    historyState.selectAll = false;

    // Refresh the history table to default (clear search, filters, pagination)
    historyState.searchTerm = '';
    historyState.searchColumn = 'All Columns';
    historyState.filters = {
      status: 'All',
      bank: 'All',
      dateRange: 'All',
      minAmount: null,
      maxAmount: null,
      memberId: (isActualAdmin || isAdmin) ? 'All' : (user.memberId || 'All'),
      transactionType: 'All',
      dateFrom: '',
      dateTo: ''
    };
    await loadHistoryData(true);
    
    // Reset or load balances
    if (formData.member_id && formData.member_id !== '0000000000') {
      await loadMemberBalances(formData.member_id);
    } else {
      openingBalances = {};
      paymentAdvise = {};
    }
    // Reset focus tracking
    activeId = null;
    activeName = null;
    activeRowEntId = null;
    selectionStart = 0;
    selectionEnd = 0;
    render();
  }

  // --- Sync Form Data ---
  function syncFormData() {
    const currentForm = container.querySelector('#payment-form');
    if (!currentForm) return;
    const adminCheck = container.querySelector('#admin-mode-check');
    const fd = new FormData(currentForm);
    const dateVal = fd.get('remittance_date');
    if (dateVal) formData.remittance_date = dateVal;
    const bankVal = fd.get('bank_name');
    if (bankVal !== null) formData.bank_name = bankVal;
    // Disabled (seal-locked) fields are absent from FormData — keep the
    // loaded value instead of collapsing the amount to 0.
    const amtVal = fd.get('amount');
    if (amtVal !== null) formData.amount = parseFloat(amtVal || 0);
    formData.description = fd.get('description') || '';
    if (isAdmin) {
      if (adminCheck && adminCheck.checked) {
        formData.member_id = '0000000000';
      } else {
        formData.member_id = fd.get('member_id');
      }
    }
    formData.transaction_type = fd.get('transaction_type') || '';
    const detailRows = container.querySelectorAll('.detail-item-row');
    if (detailRows.length > 0) {
      formData.details = Array.from(detailRows)
        .map(row => {
          const rowId = row.dataset.id || generateId(String(cooperativeId));
          const entId = String(row.dataset.entid || '');
          const inputValStr = row.querySelector('.detail-amt-grid').value;
          let amount = inputValStr ? parseFloat(inputValStr) : 0;
          if (isNaN(amount)) amount = 0;
          const prevDetail = (formData.details || []).find(d => String(d.enterprise_id || d.item || '') === entId);
          let loanInfo = prevDetail ? prevDetail.loan_info : null;
          if (!loanInfo && row.dataset.loaninfo) {
            try {
              const domLoanInfo = JSON.parse(row.dataset.loaninfo);
              if (domLoanInfo && (domLoanInfo.loanData || domLoanInfo.guarantors || domLoanInfo.charges)) {
                loanInfo = domLoanInfo;
              }
            } catch (e) {}
          }
          if (loanInfo && loanInfo.loanData) {
            const newIssueDate = formData.remittance_date || loanInfo.loanData.issueDate;
            const newPrincipal = Math.abs(amount);
            const dateChanged = newIssueDate !== loanInfo.loanData.issueDate;
            const amountChanged = newPrincipal !== loanInfo.loanData.principalAmount;
            if (dateChanged || amountChanged) {
              loanInfo = JSON.parse(JSON.stringify(loanInfo));
              if (dateChanged) {
                loanInfo.loanData.issueDate = newIssueDate;
                const duration = parseInt(loanInfo.loanData.durationMonths) || 0;
                if (duration > 0 && newIssueDate) {
                  const d = new Date(newIssueDate);
                  if (!isNaN(d.getTime())) {
                    d.setMonth(d.getMonth() + duration);
                    loanInfo.loanData.dueDate = d.toISOString();
                  }
                }
              }
              if (amountChanged) {
                loanInfo.loanData.principalAmount = newPrincipal;
              }
            }
          }
          return {
            id: row.dataset.id || (prevDetail ? prevDetail.id : generateId(String(cooperativeId))),
            enterprise_id: entId,
            item: entId,
            amount: amount,
            loan_info: loanInfo
          };
        });
    }
    const totalDist = (formData.details || []).reduce((sum, d) => sum + (d.amount || 0), 0);
    const totalCell = container.querySelector('#dist-total-cell');
    if (totalCell) {
      totalCell.textContent = totalDist.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      totalCell.style.color = totalDist < 0 ? 'var(--danger)' : 'inherit';
    }
    const diffCell = container.querySelector('#dist-diff-cell');
    if (diffCell) {
      const diff = formData.amount - totalDist;
      diffCell.textContent = diff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      diffCell.style.color = Math.abs(diff) < 0.01 ? 'var(--success)' : 'var(--danger)';
    }
  }

  // --- Check Dirty ---
  function checkDirty() {
    const submitBtn = document.getElementById('submit-log-btn') || document.getElementById('update-log-btn');
    if (!submitBtn) return;
    const isValid = validateEnterpriseInputs();
    submitBtn.disabled = !isValid;
  }

  // --- Validate Enterprise Inputs ---
  function validateEnterpriseInputs() {
    let allValid = true;
    container.querySelectorAll('.detail-item-row').forEach(row => {
      const entId = row.dataset.entid;
      const ent = enterpriseData.find(e => e.id === entId);
      if (!ent) return;

      const input = row.querySelector('.detail-amt-grid');
      let val = parseFloat(input.value || 0);
      const opening = parseFloat(input.dataset.opening || 0);
      const type = (ent.account_type || ent.type || '').toLowerCase();

      let error = null;
      if (formData.member_id !== '0000000000') {
        if (type === 'savings') {
          if (val < -opening) {
            error = "Cannot withdraw more than balance.";
            allValid = false;
          }
        } else if (type === 'loan') {
          const maxRepayment = -opening;
          if (val > maxRepayment) {
            error = "Cannot repay more than owed.";
            allValid = false;
          }

          if (ent.parent_account && ent.loan_multiplier) {
            const parentBal = openingBalances[ent.parent_account] || 0;
            const borrowingLimit = -(parentBal * ent.loan_multiplier);
            const minInput = borrowingLimit - opening;
            if (val < minInput) {
              error = "Exceeds loan limit.";
              allValid = false;
            }
          }
        }
      }

      // Visual feedback for error
      if (error) {
        input.style.borderBottom = '2px solid var(--danger)';
        input.title = error;
      } else {
        input.style.borderBottom = 'none';
        input.title = '';
      }
    });
    return allValid;
  }

  // --- Is Form Valid ---
  function isFormValid() {
    const isCoopWide = isAdmin && formData.member_id === '0000000000';
    const hasDate = !!formData.remittance_date || formData.isLoanRequest;
    const hasBank = !!formData.bank_name || formData.isLoanRequest;
    const hasMember = isCoopWide || (!!formData.member_id && formData.member_id !== '0000000000');
    let hasNote = true;
    if (isCoopWide || (formData.bank_name || '').toLowerCase() === 'internal transfer') {
      hasNote = !!(formData.description || '').trim();
    }

    return hasDate && hasBank && hasMember && hasNote;
  }



  // --- Compulsory Dues & Penalties Popup ---
  // Lists each due/penalty enterprise with an editable amount box.
  // Resolves null when dismissed (abort save), { charge:false } on
  // "Don't Charge", or { charge:true, items:[{enterprise_id,name,amount}] }
  // on "Charge". Amounts are normalized to positive here; the negative
  // sign is applied when the autogen debit children are built.
  function showDuesChargePopup(chargeable) {
    return new Promise(resolve => {
      const modalId = 'dues-charge-modal';
      document.getElementById(modalId)?.remove();

      const overlay = document.createElement('div');
      overlay.id = modalId;
      overlay.className = 'modal-overlay';
      overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center; opacity: 1; pointer-events: auto;';

      const modalContent = document.createElement('div');
      modalContent.style.cssText = 'background: var(--bg-card); border-radius: var(--radius-md); width: 90%; max-width: 500px; margin: 2rem auto; max-height: 90vh; overflow-y: auto; padding: 1.5rem; box-shadow: var(--shadow-xl);';

      const rowsHtml = chargeable.map((c, idx) => `
        <div style="display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem; background: var(--bg-secondary); border-radius: var(--radius-sm);">
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 0.35rem; font-weight: 700; font-size: 0.85rem; color: var(--text-primary);">
              ${c.isDue ? `<span style="background: var(--accent-primary); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1;">C</span>` : ''}
              ${c.isPen ? `<span style="background: var(--danger); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1;">P</span>` : ''}
              <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(c.name)}</span>
            </div>
            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.15rem;">${c.isDue ? `Default ₦${Number(c.defaultAmount || 0).toFixed(2)}` : 'Enter penalty amount'}</div>
          </div>
          <input type="number" step="0.01" min="0" class="dues-charge-input" data-idx="${idx}" value="${Number(c.defaultAmount || 0).toFixed(2)}" style="width: 130px; padding: 0.5rem 0.6rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.9rem; text-align: right;">
        </div>
      `).join('');

      modalContent.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0;">Compulsory Dues & Penalties</h3>
          <button type="button" class="close-dues-btn" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
        </div>
        <p style="margin: 0 0 1rem 0; font-size: 0.85rem; color: var(--text-muted);">Set the amounts to charge. They will be debited from the member and credited to the enterprise-named pickup as linked auto entries.</p>
        <div style="display: flex; flex-direction: column; gap: 0.6rem;">${rowsHtml}</div>
        <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem; border-top: 1px solid var(--border-light); padding-top: 1.5rem;">
          <button type="button" class="btn btn-secondary dues-dont-charge">Don&apos;t Charge</button>
          <button type="button" class="btn btn-primary dues-charge">Charge</button>
        </div>
      `;

      const done = (result) => { overlay.remove(); resolve(result); };
      modalContent.querySelector('.close-dues-btn').addEventListener('click', () => done(null));
      modalContent.querySelector('.dues-dont-charge').addEventListener('click', () => done({ charge: false, items: [] }));
      modalContent.querySelector('.dues-charge').addEventListener('click', () => {
        const items = [];
        modalContent.querySelectorAll('.dues-charge-input').forEach(input => {
          const c = chargeable[parseInt(input.dataset.idx, 10)];
          if (!c) return;
          let val = parseFloat(input.value || 0);
          if (isNaN(val) || val <= 0) return;
          items.push({ enterprise_id: c.enterprise_id, name: c.name, amount: Math.abs(val) });
        });
        done({ charge: true, items });
      });

      overlay.appendChild(modalContent);
      document.body.appendChild(overlay);
      setTimeout(() => modalContent.querySelector('.dues-charge-input')?.focus(), 50);
    });
  }
  // Shared with bulk remittance (ask-once dues decision for the whole batch)
  deps.showDuesChargePopup = showDuesChargePopup;

  // --- Savings Withdrawal Charges Popup ---
  // Lists charges pre-filled from the enterprise settings (interest, form fee,
  // admin charge). User can add/remove/edit charges.
  // Resolves null when dismissed (abort save), { charge:false } on
  // "Don't Charge", or { charge:true, items:[{name,value,type}] } on "Charge".
  function showSavingsChargesPopup(chargeable, principalAmount) {
    return new Promise(resolve => {
      const modalId = 'savings-charges-modal';
      document.getElementById(modalId)?.remove();

      const overlay = document.createElement('div');
      overlay.id = modalId;
      overlay.className = 'modal-overlay';
      overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center; opacity: 1; pointer-events: auto;';

      const modalContent = document.createElement('div');
      modalContent.style.cssText = 'background: var(--bg-card); border-radius: var(--radius-md); width: 90%; max-width: 520px; margin: 2rem auto; max-height: 90vh; overflow-y: auto; padding: 1.5rem; box-shadow: var(--shadow-xl);';

      const renderCharges = () => {
        const rowsHtml = chargeable.map((c, idx) => `
          <div class="savings-charge-row" data-idx="${idx}" style="display: grid; grid-template-columns: 2fr 1fr 1.5fr auto; gap: 0.5rem; align-items: end; padding: 0.5rem; background: var(--bg-secondary); border-radius: var(--radius-sm);">
            <div>
              <label style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-bottom: 0.2rem;">Name</label>
              <input type="text" class="sc-name" value="${escapeHtml(c.name || '')}" placeholder="Charge name" style="width: 100%; padding: 0.4rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.85rem;">
            </div>
            <div>
              <label style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-bottom: 0.2rem;">Type</label>
              <select class="sc-type" style="width: 100%; padding: 0.4rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.85rem;">
                <option value="percentage" ${c.type === 'percentage' ? 'selected' : ''}>%</option>
                <option value="fixed" ${c.type === 'fixed' ? 'selected' : ''}>Fixed (₦)</option>
              </select>
            </div>
            <div>
              <label style="font-size: 0.72rem; color: var(--text-muted); display: block; margin-bottom: 0.2rem;">Value</label>
              <input type="number" step="0.01" min="0" class="sc-value" value="${c.value || 0}" style="width: 100%; padding: 0.4rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.85rem; text-align: right;">
            </div>
            <button type="button" class="sc-remove" data-idx="${idx}" style="padding: 0.4rem; border-radius: var(--radius-sm); border: none; background: transparent; color: var(--danger); font-size: 1.2rem; font-weight: 800; line-height: 1; cursor: pointer; margin-bottom: 0.1rem;" title="Remove">&times;</button>
          </div>
        `).join('');

        const totalC = chargeable.reduce((sum, c) => {
          const val = parseFloat(c.value) || 0;
          return sum + (c.type === 'percentage' ? (val / 100) * principalAmount : val);
        }, 0);

        modalContent.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
            <h3 style="margin: 0;">Savings Withdrawal Charges</h3>
            <button type="button" class="close-sc-btn" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
          </div>
          <p style="margin: 0 0 1rem 0; font-size: 0.85rem; color: var(--text-muted);">Set charges to apply. They will be debited from the member and credited to Income as linked auto entries.</p>
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">${rowsHtml}</div>
          <button type="button" class="sc-add" style="margin-top: 0.75rem; padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); border: 1px dashed var(--border-medium); background: transparent; color: var(--accent-primary); font-weight: 600; font-size: 0.82rem; cursor: pointer;">+ Add Charge</button>
          <div data-total style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border-light); text-align: right; font-weight: 700; font-size: 0.9rem; color: var(--text-primary);">
            Total Estimated Charges: ${formatCurrency(totalC)}
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1rem; border-top: 1px solid var(--border-light); padding-top: 1rem;">
            <button type="button" class="btn btn-secondary sc-dont-charge">Don&apos;t Charge</button>
            <button type="button" class="btn btn-primary sc-charge">Charge</button>
          </div>
        `;

        const done = (result) => { overlay.remove(); resolve(result); };
        modalContent.querySelector('.close-sc-btn').addEventListener('click', () => done(null));
        modalContent.querySelector('.sc-dont-charge').addEventListener('click', () => done({ charge: false, items: [] }));
        modalContent.querySelector('.sc-add').addEventListener('click', () => {
          chargeable.push({ name: '', value: 0, type: 'fixed' });
          renderCharges();
        });
        modalContent.querySelectorAll('.sc-remove').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            chargeable.splice(idx, 1);
            renderCharges();
          });
        });
        modalContent.querySelector('.sc-charge').addEventListener('click', () => {
          const items = [];
          modalContent.querySelectorAll('.savings-charge-row').forEach((row, i) => {
            const c = chargeable[i];
            if (!c) return;
            c.name = row.querySelector('.sc-name').value.trim();
            c.type = row.querySelector('.sc-type').value;
            c.value = parseFloat(row.querySelector('.sc-value').value || 0);
            if (!c.name || isNaN(c.value) || c.value <= 0) return;
            items.push({ name: c.name, value: c.value, type: c.type });
          });
          done({ charge: true, items });
        });

        // Sync inputs back to chargeable on change
        modalContent.querySelectorAll('.savings-charge-row').forEach((row, i) => {
          row.querySelector('.sc-name').addEventListener('input', (e) => { chargeable[i].name = e.target.value; });
          row.querySelector('.sc-type').addEventListener('change', (e) => { chargeable[i].type = e.target.value; });
          row.querySelector('.sc-value').addEventListener('input', (e) => {
            chargeable[i].value = parseFloat(e.target.value || 0);
            // Recalculate total
            const totalEl = modalContent.querySelector('[data-total]');
            if (totalEl) {
              const total = chargeable.reduce((sum, ch) => {
                const v = parseFloat(ch.value) || 0;
                return sum + (ch.type === 'percentage' ? (v / 100) * principalAmount : v);
              }, 0);
              totalEl.textContent = 'Total Estimated Charges: ' + formatCurrency(total);
            }
          });
        });
      };

      renderCharges();
      overlay.appendChild(modalContent);
      document.body.appendChild(overlay);
      setTimeout(() => modalContent.querySelector('.sc-name')?.focus(), 50);
    });
  }

  // --- Handle Submit ---
  const handleSubmit = async () => {
    // First, sync form data from DOM to formData!
    syncFormData();
    
    const clearHighlights = () => {
      container.querySelectorAll('.field-invalid').forEach(el => el.classList.remove('field-invalid'));
    };
    const highlightField = (name) => {
      const el = container.querySelector(`[name="${name}"]`);
      if (el) {
        const wrapper = el.closest('.form-group, .select-wrapper') || el.parentElement;
        if (wrapper) wrapper.classList.add('field-invalid');
      }
    };
    clearHighlights();

    const submitBtn = document.getElementById('submit-log-btn') || document.getElementById('update-log-btn');
    if (submitBtn) {
      if (submitBtn.disabled) return;
      submitBtn.disabled = true;
      submitBtn.innerText = 'Processing...';
    }
    try {
      formData.details = formData.details.filter(d => parseFloat(d.amount || 0) !== 0 || !!d.loan_info);
      
       let txType = formData.transaction_type;
       const lockedTypes = transactionTypes?.filter(t => t.is_locked === 1 || t.is_locked === true).map(t => t.transaction_type) || [];
       // Locked types are disabled in the dropdown, so during an EDIT the only
       // way txType is locked is that the existing record already carries it
       // (e.g. 'Member Deposit'). Reject only manual selection on new records.
       if (!editMode && lockedTypes.includes(txType)) {
        showToast('Validation Error: This transaction type is system-managed and cannot be manually selected.', 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
        highlightField('transaction_type');
        return;
      }
      let memberId = formData.member_id;
      const amountVal = formData.amount;
      const bankName = formData.bank_name;
      const isCoopWide = isAdmin && formData.member_id === '0000000000';
      const detailsSum = formData.details.reduce((sum, d) => sum + (d.amount || 0), 0);
      
      // Bank and date are ALWAYS required except for new loan/withdrawal requests being submitted
      if (!formData.isLoanRequest && !formData.isWithdrawalRequest) {
        if (!formData.remittance_date) {
          highlightField('remittance_date');
          showToast('Validation Error: Transaction Date is required.', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
        if (!bankName) {
          highlightField('bank_name');
          showToast('Validation Error: Bank or Remittance Method is required.', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
      }
      
      if (isCoopWide) {
        if (amountVal === 0) {
          showToast('Validation Error: Total amount cannot be zero.', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
        if (!formData.description.trim()) {
          highlightField('description');
          showToast('Validation Error: Note / Description is required.', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
        if (!txType) {
          highlightField('transaction_type');
          showToast('Validation Error: Transaction Type is required for Admin mode.', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
      } else {
        txType = '';
        // Staff without member-read permission log for themselves when CREATING
        // only — never re-stamp an existing record's member on edit.
        if (!isAdmin && !formData.id) {
          memberId = user.memberId;
          formData.member_id = user.memberId;
        }
        if (!memberId || memberId === '0000000000') {
          highlightField('member_id');
          showToast('Validation Error: Please select a member.', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
        if ((bankName || '').toLowerCase() === 'internal transfer') {
          const lockedTxTypes = transactionTypes.filter(t => t.is_locked === 1 || t.is_locked === true).map(t => t.transaction_type);
          if (lockedTxTypes.includes('Internal Transfer')) {
            showToast('Validation Error: Internal Transfer is system-managed and cannot be manually used.', 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            highlightField('bank_name');
            return;
          }
          if (!formData.description.trim()) {
            highlightField('description');
            showToast('Validation Error: Note / Description is required for Internal Transfer.', 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            return;
          }
          txType = 'Internal Transfer';
          if (Math.abs(detailsSum - amountVal) > 0.01) {
            showToast(`Validation Error: Distribution total (${detailsSum.toFixed(2)}) does not match remittance amount (${amountVal.toFixed(2)}).`, 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            return;
          }
        } else {
          if (amountVal === 0) {
            if (formData.details.length > 1 && Math.abs(detailsSum) < 0.01) {
              const lockedTxTypes = transactionTypes.filter(t => t.is_locked === 1 || t.is_locked === true).map(t => t.transaction_type);
              if (lockedTxTypes.includes('Internal Transfer')) {
                showToast('Validation Error: Internal Transfer is system-managed and cannot be manually used.', 'error');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
                return;
              }
              txType = 'Internal Transfer';
            } else {
              showToast('Validation Error: Amount cannot be zero except for balanced Internal Transfers.', 'error');
              if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
              return;
            }
          }
          const getAccountType = (acc) => (acc?.account_type || acc?.type || acc?.Account_Type || '').toLowerCase();
          let loanEntIds = enterpriseData.filter(e => getAccountType(e) === 'loan').map(e => e.id);
          let savingsEntIds = enterpriseData.filter(e => getAccountType(e) === 'savings').map(e => e.id);
          if (formData.isLoanRequest) {
            const loanReqEntId = formData.details.find(d => d.loan_info)?.enterprise_id;
            if (loanReqEntId && !loanEntIds.includes(loanReqEntId)) {
              loanEntIds.push(loanReqEntId);
            }
          }
          let loanNegCount = 0;
          let missingLoanConfigId = null;
          formData.details.forEach((d, idx) => {
            const entId = d.enterprise_id || d.item;
            const needsConfig = (d.amount < 0) || (formData.isLoanRequest && d.amount !== 0);
            if (loanEntIds.includes(entId) && needsConfig) {
              loanNegCount++;
              const isInternalTransfer = txType === 'Internal Transfer';
              if (!isInternalTransfer && (!d.loan_info || !d.loan_info.loanData?.durationMonths)) {
                if (!missingLoanConfigId) {
                  missingLoanConfigId = d.enterprise_id || d.item;
                }
              }
            }
          });
          if (missingLoanConfigId) {
            showLoanConfigModal(missingLoanConfigId, false, deps);
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            return;
          }
          if (formData.isLoanRequest && !formData.details.some(d => d.loan_info)) {
            showToast('Validation Error: Please enter an amount for a loan account and configure the loan details.', 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            return;
          }
          if (amountVal < 0 && txType !== 'Internal Transfer') {
            if (isAdmin || editMode) {
              if (!isCoopWide) {
                const nonZeroDetails = formData.details;
                const hasLoanDistribution = nonZeroDetails.some(d => loanEntIds.includes(d.enterprise_id || d.item) && d.amount < 0);
                const hasSavingsDistribution = nonZeroDetails.some(d => savingsEntIds.includes(d.enterprise_id || d.item) && d.amount < 0);
                const isLoan = (hasLoanDistribution && nonZeroDetails.length === 1) || (formData.isLoanRequest && nonZeroDetails.some(d => d.loan_info));

                if (isLoan) {
                  txType = 'Member Loan';
                  if (!formData.isLoanRequest) {
                    if (!hasLoanDistribution) {
                      showToast('Validation Error: Negative member payments must be distributed to a Loan account.', 'error');
                      if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
                      return;
                    }
                  }
                } else {
                  txType = 'Savings Withdrawal';
                  if (!hasSavingsDistribution) {
                    showToast('Validation Error: Negative member payments must be distributed to a Savings account.', 'error');
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
                    return;
                  }
                }
              } else {
                txType = 'Withdrawal';
              }
            } else {
              if (formData.isLoanRequest) {
                txType = 'Member Loan';
              } else if (formData.isWithdrawalRequest) {
                txType = 'Savings Withdrawal';
              } else {
                showToast('Validation Error: Members cannot log negative amounts directly. Please use the "Loan Request" or "Withdrawal Request" button.', 'error');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
                return;
              }
            }
          } else if (formData.isLoanRequest) {
            txType = 'Member Loan';
          } else if (amountVal > 0 && txType !== 'Internal Transfer') {
            txType = 'Member Deposit';
          }
          if (txType !== 'Internal Transfer' && Math.abs(detailsSum - amountVal) > 0.01) {
            showToast(`Validation Error: Distribution total (${detailsSum.toFixed(2)}) does not match remittance amount (${amountVal.toFixed(2)}).`, 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            return;
          }
        }
      }
      formData.transaction_type = txType;
      const isLoanRequest = !!formData.isLoanRequest;
      if (canApprove && !isLoanRequest && formData.details.some(d => d.loan_info)) {
        formData.details.forEach(d => {
          if (d.loan_info && d.loan_info.guarantors) {
            d.loan_info.guarantors.forEach(g => {
              g.guarantor_approval = 1;
            });
          }
        });
      } else if (formData.details.some(d => d.loan_info)) {
        formData.details.forEach(d => {
          if (d.loan_info && d.loan_info.guarantors) {
            d.loan_info.guarantors.forEach(g => {
              if (g.guarantor_approval === undefined) g.guarantor_approval = null;
            });
          }
        });
      }
      
      // Compulsory dues & penalties: distribution rows for compulsory dues are
      // disabled (always 0 there), so dues are collected here via popup AFTER
      // the user confirms save. Charge => linked autogen children
      // (member debits + enterprise-named pickup). Don't charge => parent only.
      // Skipped for loan/withdrawal/coop-wide transactions like before.
      const getAccountTypeLocal = (acc) => (acc?.account_type || acc?.type || acc?.Account_Type || '').toLowerCase();
      const localLoanEntIds = enterpriseData.filter(e => getAccountTypeLocal(e) === 'loan').map(e => e.id);
      const localSavingsEntIds = enterpriseData.filter(e => getAccountTypeLocal(e) === 'savings').map(e => e.id);
      const hasLoanDist = formData.details.some(d => localLoanEntIds.includes(d.enterprise_id || d.item) && d.amount < 0);
      const hasSavingsDist = formData.details.some(d => localSavingsEntIds.includes(d.enterprise_id || d.item) && d.amount < 0);
      let duesDecision = null;
      if (!isCoopWide && !hasLoanDist && !hasSavingsDist && amountVal >= 0) {
        const chargeable = [];
        const seenChargeable = new Set();
        enterpriseData.forEach(ent => {
          if (seenChargeable.has(ent.id)) return;
          const isDue = !!ent.compulsory_due && parseFloat(ent.compulsory_amount || 0) > 0;
          const isPen = !!ent.is_penalty;
          if (!isDue && !isPen) return;
          seenChargeable.add(ent.id);
          chargeable.push({
            enterprise_id: ent.id,
            name: ent.account_name || ent.id,
            isDue,
            isPen,
            // Dues default to the enterprise setting; penalties are entered fresh each time
            defaultAmount: isDue ? parseFloat(ent.compulsory_amount || 0) : 0
          });
        });
        if (chargeable.length > 0) {
          duesDecision = await showDuesChargePopup(chargeable);
          if (!duesDecision) {
            // Popup closed without choosing (same as old "Go Back")
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
            return;
          }
        }
      }

      // Rule: dues & penalties can never exceed the savings inside this same
      // payment — reject the remittance (no submission) when they do.
      if (duesDecision && duesDecision.charge && Array.isArray(duesDecision.items) && duesDecision.items.length > 0) {
        const _duePenIds = new Set();
        (enterpriseData || []).forEach(ent => {
          const _isD = !!ent.compulsory_due && parseFloat(ent.compulsory_amount || 0) > 0;
          if (_isD || !!ent.is_penalty) _duePenIds.add(String(ent.id));
        });
        const _savTotal = (formData.details || [])
          .filter(d => parseFloat(d.amount || 0) > 0 && !_duePenIds.has(String(d.enterprise_id || d.item || '')))
          .reduce((s, d) => s + Math.abs(parseFloat(d.amount || 0)), 0);
        const _dueTotal = duesDecision.items.reduce((s, it) => s + Math.abs(parseFloat(it.amount || 0)), 0);
        if (_dueTotal > _savTotal + 1e-9) {
          showToast(`Dues & penalties (₦${_dueTotal.toLocaleString()}) exceed savings in this payment (₦${_savTotal.toLocaleString()}). Reduce the charges or increase the payment.`, 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
          return;
        }
      }

      // Savings withdrawal charges: pre-fill from enterprise settings (interest,
      // form fee, admin charge) and let user choose to charge or not.
      // Charge => linked autogen children (member debits + Other Income pickup).
      // Don't charge => parent only. Skipped for non-savings-withdrawal transactions.
      let savingsChargesDecision = null;
      if (hasSavingsDist && !isCoopWide && amountVal < 0) {
        const savingsDetail = formData.details.find(d =>
          localSavingsEntIds.includes(d.enterprise_id || d.item) && d.amount < 0
        );
        const savingsEnterprise = enterpriseData.find(e =>
          String(e.id) === String(savingsDetail?.enterprise_id || savingsDetail?.item)
        );
        if (savingsEnterprise) {
          const savChargeable = [];
          if (savingsEnterprise.interest_rate !== undefined && savingsEnterprise.interest_rate !== null && savingsEnterprise.interest_rate !== '' && parseFloat(savingsEnterprise.interest_rate) > 0) {
            savChargeable.push({
              name: 'Interest',
              value: Math.abs(parseFloat(savingsEnterprise.interest_rate) || 0),
              type: savingsEnterprise.interest_is_percent ? 'percentage' : 'fixed'
            });
          }
          if (savingsEnterprise.form_fee !== undefined && savingsEnterprise.form_fee !== null && savingsEnterprise.form_fee !== '' && parseFloat(savingsEnterprise.form_fee) > 0) {
            savChargeable.push({
              name: 'Form Fee',
              value: Math.abs(parseFloat(savingsEnterprise.form_fee) || 0),
              type: savingsEnterprise.form_fee_is_percent ? 'percentage' : 'fixed'
            });
          }
          if (savingsEnterprise.admin_charge !== undefined && savingsEnterprise.admin_charge !== null && savingsEnterprise.admin_charge !== '' && parseFloat(savingsEnterprise.admin_charge) > 0) {
            savChargeable.push({
              name: 'Admin Charge',
              value: Math.abs(parseFloat(savingsEnterprise.admin_charge) || 0),
              type: savingsEnterprise.admin_charge_is_percent ? 'percentage' : 'fixed'
            });
          }
          if (savChargeable.length > 0) {
            savingsChargesDecision = await showSavingsChargesPopup(savChargeable, Math.abs(amountVal));
            if (!savingsChargesDecision) {
              if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance'; }
              return;
            }
          }
        }
      }

      // Only handle new remittances
      const isEditing = editMode && formData.id;
      const selectedMember = members.find(m => m.id === formData.member_id);
      // Full name stamped onto the 0000000000 pickup descriptions below.
      const pickupMemberName = [selectedMember?.last_name, selectedMember?.first_name, selectedMember?.middle_name].filter(Boolean).join(' ')
        || selectedMember?.name
        || formData.member_id;
      // Sealed (reconciled) records keep their loaded status so they cannot
      // drop out of the reconciled 'Approved' set behind a non-approver's edit.
      // Mirrors the frozen-field guard inside updateRemittance().
      const status = (sealLocked && formData.status) ? formData.status : (canApprove ? 'Approved' : 'Pending');      const finalDescription = (status === 'Approved' && formData.description === 'Loan Request') ? '' : formData.description;

      // EDIT MODE: reverse old payment advise BEFORE cleanup (cleanup
      // soft-deletes loans, which makes loadDoc return empty loans array),
      // then delete all old children/loans/guarantors, then recreate fresh.
      if (isEditing) {
        // 1) Reverse old loan payment advise while loans are still live
        const oldRemit = await (await import('../../services/sqliteService.js')).getDocById_Global('remittance', formData.id);
        if (oldRemit && oldRemit.loans && oldRemit.loans.length > 0) {
          const memberDoc = await fetchMemberDoc(formData.member_id);
          if (memberDoc) {
            let existingAdvise = memberDoc.payment_advise || [];
            let adviseChanged = false;
            for (const oldLoan of oldRemit.loans) {
              if (oldLoan.principal_amount && oldLoan.duration_months && oldLoan.duration_months > 0) {
                const oldMonthly = parseFloat((oldLoan.principal_amount / oldLoan.duration_months).toFixed(2));
                if (oldMonthly > 0) {
                  const idx = existingAdvise.findIndex(a => String(a.enterprise_id) === String(oldLoan.enterprise_id));
                  if (idx >= 0) {
                    existingAdvise[idx].amount = (parseFloat(existingAdvise[idx].amount) || 0) - oldMonthly;
                    if (existingAdvise[idx].amount <= 0) existingAdvise.splice(idx, 1);
                    adviseChanged = true;
                  }
                }
              }
            }
            if (adviseChanged) {
              await updateMemberPaymentAdvice(formData.member_id, existingAdvise, user.username, user.cooperativeId);
            }
          }
        }
        // 2) Now cleanup old family (children, loans, guarantors)
        await cleanupRemittanceFamily(formData.id, user.username);
      }
      
      formData.loans = [];
      const autogenRemittances = [];
      // Per-loan charge totals for the income pickup below (one pickup child
      // per loan totalling the charges created in this same run).
      const loanPickupTotals = {};

      formData.details.forEach(d => {
        if (d.loan_info) {
          const entId = d.enterprise_id || d.item;
          if (!localLoanEntIds.includes(entId)) return;
          const lInfo = d.loan_info;
          const loanId = generateId(String(cooperativeId));
          formData.loans.push({
            id: loanId,
            member_id: formData.member_id,
            enterprise_id: d.enterprise_id || d.item,
            principal_amount: lInfo.loanData.principalAmount,
            issued_date: lInfo.loanData.issueDate || formData.remittance_date,
            due_date: lInfo.loanData.dueDate,
            status: lInfo.loanData.status || (status === 'Approved' ? 'Active' : 'Pending'),
            notes: lInfo.loanData.notes || '',
            duration_months: lInfo.loanData.durationMonths || 0,
            guarantors: lInfo.guarantors
          });
          
          if (lInfo.charges && lInfo.charges.length > 0) {
            lInfo.charges.forEach((c, chargeIdx) => {
              let val = parseFloat(c.value) || 0;
              if (c.type === 'percentage') {
                val = (val / 100) * (lInfo.loanData.principalAmount || 0);
              }
              val = -Math.abs(val);
              const singleDetail = [{
                id: generateId(String(cooperativeId)),
                enterprise_id: d.enterprise_id || d.item,
                amount: val,
                notes: c.name
              }];
              autogenRemittances.push({
                member_id: formData.member_id,
                amount: val,
                remittance_date: formData.remittance_date,
                bank_name: 'Internal Transfer',
                transaction_type: 'Loan Charges',
                category: 'Loan Asset',
                description: 'Loan Charge: ' + (c.name || 'Charge'),
                autogen: 1,
                loan_id: loanId,
                details: singleDetail,
                chargeIndex: chargeIdx
              });
              loanPickupTotals[loanId] = (loanPickupTotals[loanId] || 0) + Math.abs(val);
            });
          }
        }
      });

      // Loan income pickup (one per loan): +ve Internal Transfer to admin
      // 0000000000 totalling that loan's charges above. Header only (no
      // details on admin remittances); classification resolves inside
      // addRemittance like the dues pickup. Ids/status flow through the
      // same autogen save loop below.
      for (const [pickupLoanId, pickupTotal] of Object.entries(loanPickupTotals)) {
        if (!(pickupTotal > 0)) continue;
        autogenRemittances.push({
          member_id: '0000000000',
          amount: pickupTotal,
          remittance_date: formData.remittance_date,
          bank_name: 'Internal Transfer',
          transaction_type: 'Loan Charges',
          description: `Auto Loan Charges Income - ${pickupMemberName}`,
          autogen: 1,
          loan_id: pickupLoanId,
        });
      }

      // Pre-generate the parent id so dues/penalty autogen children can link
      // back to it (loan_id = parent id, same convention as loan charges).
      // In edit mode, reuse the existing parent id to update in-place.
      const parentRemId = isEditing ? formData.id : generateRemittanceId(user.cooperativeId);
      if (isEditing) {
        // Update existing parent (preserves created_at)
        await updateRemittance(parentRemId, {
          ...formData,
          id: parentRemId,
          description: finalDescription,
          status,
          cooperative_id: user.cooperativeId,
          user_role: user.role || 'member',
          user_roles: [user.role || 'member'],
          loan_status: status === 'Approved' ? 'Active' : 'Pending'
        }, user.username);
      } else {
        await addRemittance({
          ...formData,
          id: parentRemId,
          description: finalDescription,
          status,
          cooperative_id: user.cooperativeId,
          user_role: user.role || 'member',
          user_roles: [user.role || 'member'],
          loan_status: status === 'Approved' ? 'Active' : 'Pending'
        }, isMember ? 'self' : user.username);
      }
      
      // Save autogen remittances
      for (let idx = 0; idx < autogenRemittances.length; idx++) {
          const autoRem = autogenRemittances[idx];
          const baseId = generateRemittanceId(user.cooperativeId);
          const suffix = String(idx + 1).padStart(2, '0');
          autoRem.id = `${baseId}-${suffix}`;
          await addRemittance({
              ...autoRem,
              parent_remittance_id: parentRemId,
              status,
              cooperative_id: user.cooperativeId,
              user_role: user.role || 'member',
              user_roles: [user.role || 'member']
          }, isMember ? 'self' : user.username);
      }

      // Save dues/penalty autogen remittances (Charge path only). Four records:
      // Child A (per enterprise, member debit): negative amount + negative
      // detail on that enterprise, Internal Transfer. Typing 100 or -100
      // both store -100. Child B (single pickup): positive header-only total
      // to the enterprise name (transaction_type = enterprise name, category
      // = Operating Income or Member Liability per the enterprise's revenue flag)
      // under admin 0000000000 with NO details (header
      // carries the credit; same convention as the loan income pickup).
      // Child C (single settlement transfer): header 0 on the member, -side
      // peeled from this payment's savings lines + +side split per due
      // enterprise (one record covers all charges). Validation above already
      // guaranteed dues <= savings, so the peel cannot shortfall here.
      if (duesDecision && duesDecision.charge && Array.isArray(duesDecision.items) && duesDecision.items.length > 0) {
          const validItems = duesDecision.items.filter(it => parseFloat(it.amount || 0) > 0);
          let dueIndex = 0;
          for (const item of validItems) {
              dueIndex++;
              const dueVal = -Math.abs(parseFloat(item.amount));
              await addRemittance({
                  id: `${parentRemId}-DUE-${String(dueIndex).padStart(2, '0')}`,
                  cooperative_id: user.cooperativeId,
                  member_id: formData.member_id,
                  amount: dueVal,
                  remittance_date: formData.remittance_date,
                  bank_name: 'Internal Transfer',
                  transaction_type: 'Internal Transfer',
                  description: `Auto Internal Charges (${item.name})`,
                  autogen: 1,
                  loan_id: parentRemId,
                  status,
                  user_role: user.role || 'member',
                  user_roles: [user.role || 'member'],
                  details: [{
                      id: generateId(String(cooperativeId)),
                      enterprise_id: item.enterprise_id,
                      amount: dueVal,
                      notes: item.name
                  }]
              }, isMember ? 'self' : user.username);
          }
           const _pickupMemberName = pickupMemberName || '';
           const _pickupDate = formData.remittance_date;
           const _pickupActor = isMember ? 'self' : user.username;
           const _pickupRole = user.role || 'member';
           await createDuesIncomePickup({
               cooperativeId: user.cooperativeId,
               parentId: parentRemId,
               duesItems: validItems,
               enterpriseData: enterpriseData || [],
               memberName: _pickupMemberName,
               date: _pickupDate,
               status,
               actor: _pickupActor,
               role: _pickupRole
           });
           // Child C: settlement transfer (header 0). Funded from this
              // payment's own savings lines (due/penalty lines excluded).
              const _duePenIdsC = new Set();
              (enterpriseData || []).forEach(ent => {
                  const _isD = !!ent.compulsory_due && parseFloat(ent.compulsory_amount || 0) > 0;
                  if (_isD || !!ent.is_penalty) _duePenIdsC.add(String(ent.id));
              });
              const _savLines = (formData.details || [])
                  .filter(d => parseFloat(d.amount || 0) > 0 && !_duePenIdsC.has(String(d.enterprise_id || d.item || '')))
                  .map(d => ({ enterprise_id: d.enterprise_id || d.item, amount: Math.abs(parseFloat(d.amount || 0)) }));
              await createDuesTransfer({
                  cooperativeId: user.cooperativeId,
                  parentId: parentRemId,
                  memberId: formData.member_id,
                  memberName: pickupMemberName,
                  date: formData.remittance_date,
                  status,
                  actor: isMember ? 'self' : user.username,
                  role: user.role || 'member',
                  savingsLines: _savLines,
                  duesItems: validItems
               });
       }

       // Save savings withdrawal charges autogen remittances (Charge path only).
       // Child A (per charge, member debit): negative amount + negative detail
       // on the savings enterprise, Internal Transfer. Child B (single pickup):
       // positive header-only total to Other Income under admin 0000000000.
       if (savingsChargesDecision && savingsChargesDecision.charge && Array.isArray(savingsChargesDecision.items) && savingsChargesDecision.items.length > 0) {
          const savEntId = formData.details.find(d =>
              localSavingsEntIds.includes(d.enterprise_id || d.item) && d.amount < 0
          );
          const savEnterpriseId = savEntId ? (savEntId.enterprise_id || savEntId.item) : null;
          if (savEnterpriseId) {
              const validItems = savingsChargesDecision.items.filter(it => parseFloat(it.value || 0) > 0);
              let chgIndex = 0;
              let totalSavCharges = 0;
              for (const item of validItems) {
                  chgIndex++;
                  let val = parseFloat(item.value) || 0;
                  if (item.type === 'percentage') {
                      val = (val / 100) * Math.abs(amountVal);
                  }
                  val = -Math.abs(val);
                  totalSavCharges += Math.abs(val);
                  await addRemittance({
                      id: `${parentRemId}-CHG-${String(chgIndex).padStart(2, '0')}`,
                      cooperative_id: user.cooperativeId,
                      member_id: formData.member_id,
                      amount: val,
                      remittance_date: formData.remittance_date,
                      bank_name: 'Internal Transfer',
                      transaction_type: 'Internal Transfer',
                      description: `Auto Savings Charge (${item.name})`,
                      autogen: 1,
                      parent_remittance_id: parentRemId,
                      status,
                      user_role: user.role || 'member',
                      user_roles: [user.role || 'member'],
                      details: [{
                          id: generateId(String(cooperativeId)),
                          enterprise_id: savEnterpriseId,
                          amount: val,
                          notes: item.name
                      }]
                  }, isMember ? 'self' : user.username);
              }
              // Child B: income pickup (single, header only)
              if (totalSavCharges > 0) {
                  await addRemittance({
                      id: `${parentRemId}-CHG-INCOME`,
                      cooperative_id: user.cooperativeId,
                      member_id: '0000000000',
                      amount: totalSavCharges,
                      remittance_date: formData.remittance_date,
                      bank_name: 'Internal Transfer',
                      transaction_type: 'Other Income',
                      description: `Auto Savings Charges Income - ${pickupMemberName}`,
                      autogen: 1,
                      parent_remittance_id: parentRemId,
                      status,
                      user_role: user.role || 'member',
                      user_roles: [user.role || 'member']
                  }, isMember ? 'self' : user.username);
              }
          }
      }
      
      if (formData.loans && formData.loans.length > 0 && status === 'Approved') {
          const { fetchMemberDoc, updateMemberPaymentAdvice } = await import('../../services/dataService.js');
          const memberId = formData.member_id;
          const memberDoc = await fetchMemberDoc(memberId);
          if (memberDoc) {
              let existingAdvise = memberDoc.payment_advise || [];
              let adviseChanged = false;
              
              for (const loan of formData.loans) {
                  if (loan.principal_amount && loan.duration_months && loan.duration_months > 0) {
                      const monthlyPayment = parseFloat((loan.principal_amount / loan.duration_months).toFixed(2));
                      if (monthlyPayment > 0) {
                          const existingIndex = existingAdvise.findIndex(a => String(a.enterprise_id) === String(loan.enterprise_id));
                          if (existingIndex >= 0) {
                              existingAdvise[existingIndex].amount = (parseFloat(existingAdvise[existingIndex].amount) || 0) + monthlyPayment;
                          } else {
                              existingAdvise.push({
                                  enterprise_id: String(loan.enterprise_id),
                                  amount: monthlyPayment,
                                  created_at: new Date().toISOString()
                              });
                          }
                          adviseChanged = true;
                      }
                  }
              }
              
              if (adviseChanged) {
                  await updateMemberPaymentAdvice(memberId, existingAdvise, user.username, user.cooperativeId);
              }
          }
      }
      
      clearSavedForm();
      await loadHistoryData(true);
      await clearForm(true);
      showToast(isEditing ? 'Remittance updated successfully!' : 'Remittance record saved successfully!', 'success');
      window.dispatchEvent(new CustomEvent('remittance-saved'));
    } catch (err) {
      showToast('Error saving remittance: ' + err.message, 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = editMode ? 'Update Remittance' : 'Save Remittance';
      }
    }
  };

  // --- Show Loan Config Modal (extracted to remittanceLoanConfig.js) ---
  // --- Render ---
  const render = () => {
    const savedScrollTop = container.querySelector('.history-table-container')?.scrollTop ?? null;
    Object.assign(deps, { formData, openingBalances, paymentAdvise, previewMode, editMode, sealLocked, historyState });
    _render(container, deps);
    setupHistoryScrollListener();
    if (savedScrollTop !== null) {
      const el = container.querySelector('.history-table-container');
      if (el) el.scrollTop = savedScrollTop;
    }
  };

  // --- Restore Focus ---
  function restoreFocus() {
    try {
      let targetEl = null;
      if (activeId) targetEl = document.getElementById(activeId);
      else if (activeName) targetEl = container.querySelector(`[name="${activeName}"]`);
      else if (activeRowEntId) {
        const row = container.querySelector(`.detail-item-row[data-entid="${activeRowEntId}"]`);
        if (row) targetEl = row.querySelector('.detail-amt-grid');
      }
      if (targetEl && targetEl !== document.body) {
        targetEl.focus();
        const supportedSelection = ['text', 'search', 'url', 'tel', 'password'];
        if (typeof selectionStart === 'number' && (supportedSelection.includes(targetEl.type) || targetEl.tagName === 'TEXTAREA')) {
          try {
            targetEl.setSelectionRange(selectionStart, selectionEnd);
          } catch (e) {}
        } else if (targetEl.type === 'number') {
          const val = targetEl.value;
          targetEl.value = '';
          targetEl.value = val;
        }
      }
    } catch (e) {}
  }

  // --- Attach Event Listeners (extracted to remittanceEventListeners.js) ---
  function attachImagePreview(member) {
    const avatarWrap = container.querySelector('#up-avatar-wrap');
    if (!avatarWrap || !member) return;
    let previewEl = null;
    let escHandler = null;

    const hidePreview = () => {
      if (previewEl) { previewEl.remove(); previewEl = null; }
      if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    };

    const showPreview = () => {
      if (previewEl) return;
      previewEl = document.createElement('div');
      previewEl.id = 'md-img-preview';
      const initials = getInitials(member.name);
      const color = getAvatarColor(member.name);
      if (member.image_path) {
        previewEl.innerHTML = `
          <div class="md-preview-image-wrap">
            <img src="${member.image_path}" alt="${escapeHtml(member.name)}" draggable="false">
            <div class="md-preview-meta">
              <div class="md-preview-initials-sm" style="background-color: ${color}">${escapeHtml(initials)}</div>
              <div class="md-preview-name">${escapeHtml(member.name)}</div>
            </div>
          </div>
        `;
      } else {
        previewEl.innerHTML = `
          <div class="md-preview-initials-wrap" style="display: flex; flex-direction: column; align-items: center; gap: 1rem;">
            <div class="md-preview-initials-circle" style="width: 120px; height: 120px; border-radius: 50%; background-color: ${color}; display: flex; align-items: center; justify-content: center; font-size: 3rem; font-weight: 800; color: white; text-transform: uppercase; letter-spacing: 0.08em;">${escapeHtml(initials)}</div>
            <div class="md-preview-name">${escapeHtml(member.name)}</div>
          </div>
        `;
      }
      previewEl.addEventListener('click', hidePreview);
      document.body.appendChild(previewEl);
      escHandler = (e) => { if (e.key === 'Escape') hidePreview(); };
      document.addEventListener('keydown', escHandler);
    };

    avatarWrap.addEventListener('click', (e) => {
      e.stopPropagation();
      if (previewEl) {
        hidePreview();
      } else {
        showPreview();
      }
    });
  }

  function updateHistoryTable() {
    trackFocus();
    const tbody = container.querySelector('#history-tbody');
    if (!tbody) return;

    const renderRow = (remit, idx, isChild = false) => {
      const member = historyState.membersMap[remit.member_id];
      const isSelected = historyState.selectedRemittanceIds.has(remit.id);
      const childCount = !isChild && remit.children ? remit.children.length : 0;
      const isExpanded = historyState.expandedRemittanceIds.has(remit.id);
      return `
      <tr class="${historyState.selectedRemittanceId === remit.id ? 'selected' : ''} ${isSelected ? 'selected' : ''} ${isChild ? 'child-row' : ''}" data-id="${remit.id}" data-row-index="${idx}" data-status="${remit.status || 'Pending'}" ${isChild ? `data-parent-id="${remit.parent_remittance_id || remit.loan_id}"` : ''} style="${isChild ? 'background: var(--bg-secondary);' : ''}">
        <td>
          ${isChild ? '<span style="display:inline-block;width:12px;"></span>' : `<input type="checkbox" class="remit-checkbox" data-id="${remit.id}" ${isSelected ? 'checked' : ''}>`}
        </td>
        ${!isMember ? `
          <td>
            <div class="member-name-cell" style="color: ${remit.member_id === '0000000000' ? 'var(--accent-primary)' : 'var(--text-primary)'}; ${isChild ? 'font-size:0.82rem;font-weight:500;' : ''}">
              ${isChild ? '<span style="color:var(--text-muted);margin-right:4px;">└</span>' : (childCount > 0 ? `<span class="expand-toggle" data-toggle-id="${remit.id}" style="cursor:pointer;margin-right:4px;color:var(--accent-primary);font-weight:700;user-select:none;">${isExpanded ? '▼' : '▶'}</span>` : '')}
              ${escapeHtml(getFormattedName(remit.member_id, remit.transaction_type))}
              ${childCount > 0 ? `<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;">(${childCount})</span>` : ''}
            </div>
            <div class="member-reg-cell">${timestampTail(remit.id)}</div>
          </td>
        ` : `
          <td>
            <div class="member-name-cell">${timestampTail(remit.id)}</div>
          </td>
        `}
        <td><div style="color: var(--text-muted); font-size: 0.85rem;">${escapeHtml(member?.special_id || '—')}</div></td>
        <td><div>${formatDate(remit.remittance_date)}</div></td>
        <td><div style="font-weight: 600;">${escapeHtml(remit.bank_name || 'Direct')}</div></td>
        <td><div style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted);" title="${escapeHtml(remit.description || '')}">${escapeHtml(remit.description || '')}</div></td>
        <td class="text-right">
          <div style="font-family: 'Outfit', sans-serif; font-weight: 800; font-size: ${isChild ? '0.85rem' : '1rem'}; color: ${remit.amount < 0 ? 'var(--danger)' : 'var(--success)'}; ${isChild ? 'opacity:0.8;' : ''}">${formatCurrency(remit.amount)}</div>
        </td>
        <td><span class="status-badge status-${escapeHtml(remit.status || 'Pending')}" style="${isChild ? 'font-size:0.65rem;padding:0.15rem 0.5rem;' : ''}">${escapeHtml(remit.status || 'Pending')}</span></td>
        <td>
          <div class="modified-by-name">${escapeHtml(remit.created_by || '—')}</div>
          <div class="modified-at-time">${formatDateTime(remit.created_at || remit.remittance_date) || '—'}</div>
        </td>
        <td>
          <div class="modified-by-name">${escapeHtml(remit.modified_by || remit.created_by || '—')}</div>
          <div class="modified-at-time">${formatDateTime(remit.modified_at || remit.created_at || remit.remittance_date) || '—'}</div>
        </td>
      </tr>
      `;
    };

    let html = '';
    historyState.allRemittances.forEach((remit, idx) => {
      html += renderRow(remit, idx, false);
      const children = remit.children || [];
      if (children.length > 0 && historyState.expandedRemittanceIds.has(remit.id)) {
        children.forEach((child) => {
          html += renderRow(child, idx, true);
        });
      }
    });
    tbody.innerHTML = html;

    const scrollIndicator = container.querySelector('#history-scroll-indicator');
    if (scrollIndicator) {
      scrollIndicator.style.display = historyState.isLoading ? 'block' : 'none';
    }

    attachHistoryEventListeners();
    restoreFocus();
  }

  function attachHistoryEventListeners() {
    // Select all checkbox
    const selectAllCheckbox = container.querySelector('#select-all-checkbox');
    if (selectAllCheckbox) {
      selectAllCheckbox.addEventListener('change', (e) => {
        historyState.selectAll = e.target.checked;
        if (e.target.checked) {
          historyState.allRemittances.forEach(r => historyState.selectedRemittanceIds.add(r.id));
        } else {
          historyState.selectedRemittanceIds.clear();
        }
        updateHistoryTable();
        updateDeleteSelectedButton();
      });
    }

    // Individual remittance checkboxes
    container.querySelectorAll('.remit-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const id = e.target.dataset.id;
        if (e.target.checked) {
          historyState.selectedRemittanceIds.add(id);
        } else {
          historyState.selectedRemittanceIds.delete(id);
        }
        historyState.selectAll = historyState.allRemittances.length > 0 && 
          historyState.selectedRemittanceIds.size === historyState.allRemittances.length;
        updateHistoryTable();
        updateDeleteSelectedButton();
      });
    });

    // Expand/collapse child rows
    container.querySelectorAll('.expand-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = toggle.dataset.toggleId;
        if (historyState.expandedRemittanceIds.has(id)) {
          historyState.expandedRemittanceIds.delete(id);
        } else {
          historyState.expandedRemittanceIds.add(id);
        }
        updateHistoryTable();
      });
    });



    // Delete handler — enabled for users with delete_remittance permission.
    const deleteSelectedBtn = container.querySelector('#delete-selected-btn');
    if (deleteSelectedBtn) {
      deleteSelectedBtn.onclick = async () => {
        const count = historyState.selectedRemittanceIds.size;
        if (count === 0) return;
        if (!confirm(`Delete ${count} selected payment${count > 1 ? 's' : ''}?`)) return;
        try {
          console.log('[Delete] Starting deletion of', count, 'remittances:', [...historyState.selectedRemittanceIds]);
          for (const id of historyState.selectedRemittanceIds) {
            console.log('[Delete] Deleting remittance:', id);
            await deleteRemittance(id, user.username);
            console.log('[Delete] Remittance deleted:', id);
          }
          historyState.selectedRemittanceIds.clear();
          historyState.selectAll = false;
          console.log('[Delete] Reloading history...');
          await loadHistoryData(true);
          console.log('[Delete] History reloaded');
          if (historyState.selectedRemittanceId) {
            historyState.selectedRemittanceId = null;
            await clearForm();
          }
          updateDeleteSelectedButton();
          showToast(`${count} payment${count > 1 ? 's' : ''} deleted successfully!`, 'success');
          console.log('[Delete] Done');
        } catch (err) {
          console.error('[Delete] Error:', err);
          showToast('Error deleting payments: ' + err.message, 'error');
        }
      };
    }

    // Reverse selected button (multi-select cascades like delete)
    const reverseSelectedBtn = container.querySelector('#reverse-selected-btn');
    if (reverseSelectedBtn && canReverse) {
      reverseSelectedBtn.onclick = async () => {
        if (historyState.selectedRemittanceIds.size === 0) return;
        // Statically imported above (no runtime chunk fetch) so Reverse
        // opens fully offline. Dynamic fallback only for stale shells.
        try {
          showReverseModal(deps);
        } catch (err) {
          const mod = await import('./remittanceReverse.js');
          mod.showReverseModal(deps);
        }
      };
    }

    // Export button
    const exportBtn = container.querySelector('#export-excel-btn');
    if (exportBtn) {
      exportBtn.onclick = () => exportData(historyState.allRemittances, isAdmin, getFormattedName);
    }

    // Filter controls
    const openFiltersBtn = container.querySelector('#open-filters-btn');
    const closeFiltersBtn = container.querySelector('#close-filters-btn');
    const applyFiltersBtn = container.querySelector('#apply-filters-btn');
    const clearFiltersBtn = container.querySelector('#clear-filters-btn');
    const filterOverlay = container.querySelector('#filter-overlay');
    const filterDateRange = container.querySelector('#filter-date-range');
    const customDateFromContainer = container.querySelector('#custom-date-from-container');
    const customDateToContainer = container.querySelector('#custom-date-to-container');

    if (openFiltersBtn) {
      openFiltersBtn.onclick = () => {
        if (filterOverlay) filterOverlay.classList.add('open');
      };
    }

    if (closeFiltersBtn) {
      closeFiltersBtn.onclick = () => {
        if (filterOverlay) filterOverlay.classList.remove('open');
      };
    }

    if (filterDateRange) {
      filterDateRange.onchange = (e) => {
        if (customDateFromContainer && customDateToContainer) {
          customDateFromContainer.style.display = e.target.value === 'Custom' ? '' : 'none';
          customDateToContainer.style.display = e.target.value === 'Custom' ? '' : 'none';
        }
      };
    }

    if (clearFiltersBtn) {
      clearFiltersBtn.onclick = () => {
        historyState.filters = {
          status: 'All',
          bank: 'All',
          dateRange: 'All',
          minAmount: null,
          maxAmount: null,
          memberId: (isActualAdmin || isAdmin) ? 'All' : (user.memberId || 'All'),
          transactionType: 'All',
          dateFrom: '',
          dateTo: ''
        };
        historyState.searchTerm = '';
        historyState.searchColumn = 'All Columns';
        if (filterOverlay) filterOverlay.classList.remove('open');
        persistState('remit-filters', { ...historyState.filters, searchTerm: '', searchColumn: 'All Columns' });
        loadHistoryData(true);
      };
    }

    if (applyFiltersBtn) {
      applyFiltersBtn.onclick = () => {
        const filterMember = container.querySelector('#filter-member');
        const filterBank = container.querySelector('#filter-bank');
        const filterTransactionType = container.querySelector('#filter-transaction-type');
        const filterStatus = container.querySelector('#filter-status');
        const filterDateRangeEl = container.querySelector('#filter-date-range');
        const filterDateFrom = container.querySelector('#filter-date-from');
        const filterDateTo = container.querySelector('#filter-date-to');
        const filterMinAmount = container.querySelector('#filter-min-amount');
        const filterMaxAmount = container.querySelector('#filter-max-amount');

        historyState.filters.memberId = filterMember?.value || 'All';
        historyState.filters.bank = filterBank?.value || 'All';
        historyState.filters.transactionType = filterTransactionType?.value || 'All';
        historyState.filters.status = filterStatus?.value || 'All';
        historyState.filters.dateRange = filterDateRangeEl?.value || 'All';
        historyState.filters.dateFrom = filterDateFrom?.value || '';
        historyState.filters.dateTo = filterDateTo?.value || '';
        historyState.filters.minAmount = filterMinAmount?.value ? Number(filterMinAmount.value) : null;
        historyState.filters.maxAmount = filterMaxAmount?.value ? Number(filterMaxAmount.value) : null;

        if (filterOverlay) filterOverlay.classList.remove('open');
        persistState('remit-filters', { ...historyState.filters, searchTerm: historyState.searchTerm, searchColumn: historyState.searchColumn });
        loadHistoryData(true);
      };
    }
  }

  function updateDeleteSelectedButton() {
    const deleteBtn = container.querySelector('#delete-selected-btn');
    if (deleteBtn) {
        const hasSelected = historyState.selectedRemittanceIds && historyState.selectedRemittanceIds.size > 0;
        deleteBtn.style.display = hasSelected ? 'inline-block' : 'none';
    }
    const reverseBtn = container.querySelector('#reverse-selected-btn');
    if (reverseBtn) {
        const hasSelected = historyState.selectedRemittanceIds && historyState.selectedRemittanceIds.size > 0;
        reverseBtn.style.display = hasSelected ? 'inline-block' : 'none';
    }
  }

  Object.assign(deps, { formData, enterpriseData, members, selectorMembers, banks, transactionTypes, isMember, user, historyState, loadHistoryData, clearForm, clearSavedForm, render, openingBalances, paymentAdvise, showAllZeros, previewMode, editMode, panelSizes, isAdmin, isActualAdmin, canApprove, canDelete, canReverse, canUpdate, cooperativeId, PANEL_SIZE_KEY, syncFormData, checkDirty, saveSavedForm, handleMemberChange, handleSubmit, updateHistoryTable, updateDeleteSelectedButton, loadRemittanceToForm, attachImagePreview, trackFocus, isFormValid, restoreFocus, getFormattedName, attachHistoryEventListeners, showBulkRemittanceModal, showReverseModal, isMobile });
  render();

  return {
    clearForm,
    applyLoanRequestPrefill
  };
}
