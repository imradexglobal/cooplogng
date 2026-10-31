import { generateId, generateRemittanceId, escapeHtml, formatDateForInput, formatCurrency, formatNumber } from '../../utils/formatters.js';
import { addRemittance, buildAccountBalance, fetchMemberDoc, updateMemberPaymentAdvice } from '../../services/dataService.js';
import { createDuesTransfer, createDuesIncomePickup, resolveDueFunding, createDueFundingTransfer } from '../../services/data/duesTransfer.js';
import { getRemittances } from '../../services/sqliteService.js';
import { hasPermission } from '../../services/permissionService.js';
import { showToast } from '../../services/toastService.js';

// --- Bulk Remittance (Method 1: identical parameters for every member) ---
// Loans skip guarantors entirely. Dues (deposits only) use one ask-once
// decision applied to the whole batch. Failures skip-and-continue with
// reasons. Single enterprise only.
export function showBulkRemittanceModal(deps) {
    const { enterpriseData, selectorMembers, user, historyState, loadHistoryData } = deps;
    if (document.getElementById('bulk-remit-modal')) document.getElementById('bulk-remit-modal').remove();

    const isActualAdmin = hasPermission(user.permissions, 'admin') || (user.username || '').toLowerCase() === 'admin';
    const canApprove = isActualAdmin || hasPermission(user.permissions, 'approve_remittance');
    const createdBy = user.role === 'member' ? 'self' : user.username;
    const status = canApprove ? 'Approved' : 'Pending';
    const banks = historyState?.banks || [];
    const txTypes = (historyState?.transactionTypes || []).filter(t => t == null || t.is_active === undefined || t.is_active);
    const today = new Date().toISOString().split('T')[0];

    const getAccountType = (acc) => (acc?.account_type || acc?.type || acc?.Account_Type || '').toLowerCase();
    const isChargeableEnt = (e) => !e.compulsory_due && !e.is_penalty;
    const loanEnts = (enterpriseData || []).filter(e => getAccountType(e) === 'loan' && isChargeableEnt(e));
    const savingsEnts = (enterpriseData || []).filter(e => getAccountType(e) === 'savings' && isChargeableEnt(e));
    const dueEnts = (enterpriseData || []).filter(e => !!e.compulsory_due);
    const penaltyEnts = (enterpriseData || []).filter(e => !!e.is_penalty);
    const transferEnts = (enterpriseData || []).filter(e => !e.compulsory_due && !e.is_penalty);
    const pickable = Array.isArray(selectorMembers) ? selectorMembers.filter(m => m && m.id !== '0000000000') : [];

    let direction = 'loan';
    let selectedEntId = loanEnts[0]?.id || '';
    let selectedCreditEntId = transferEnts[0]?.id || '';
    let selectedFundingEntId = savingsEnts[0]?.id || '';
    // Member → Admin credit side is a transaction type (House header-only).
    let selectedTxType = (txTypes.find(t => t.transaction_type === 'Other Income') || txTypes[0])?.transaction_type || '';
    let toMemberId = '';
    let fromMemberId = '';
    let rowAmounts = {};
    const isTransferDir = () => direction === 'transfer' || direction === 'one_to_many' || direction === 'one_to_one' || direction === 'to_admin';
    const showMultiList = () => direction !== 'one_to_one';
    const showFromSingle = () => direction === 'one_to_many' || direction === 'one_to_one';
    const showToSingle = () => direction === 'transfer' || direction === 'one_to_one';
    let checkedIds = new Set(pickable.map(m => String(m.id)));
    let searchTerm = '';

    const overlay = document.createElement('div');
    overlay.id = 'bulk-remit-modal';
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center;';

    const entOptions = (list, current) => {
        return list.map(e => `<option value="${escapeHtml(String(e.id))}" ${String(e.id) === String(current) ? 'selected' : ''}>${escapeHtml(e.account_name || e.id)}</option>`).join('');
    };
    const entListFor = () => direction === 'loan' ? loanEnts
        : direction === 'deposit' || direction === 'deposit_varied' ? savingsEnts
        : direction === 'due' ? dueEnts
        : direction === 'penalty' ? penaltyEnts : transferEnts;
    const refreshEntOptions = () => {
        const list = entListFor();
        if (!list.some(e => String(e.id) === String(selectedEntId))) selectedEntId = list[0]?.id || '';
        if (direction === 'transfer' && !list.some(e => String(e.id) === String(selectedCreditEntId))) {
            selectedCreditEntId = list[0]?.id || '';
        }
    };

    const defaultCharges = () => {
        const ent = (enterpriseData || []).find(e => String(e.id) === String(selectedEntId));
        const out = [];
        if (!ent) return out;
        if (ent.interest_rate !== undefined && ent.interest_rate !== null && ent.interest_rate !== '') {
            out.push({ id: generateId(String(cooperativeId)), name: 'Interest', value: Math.abs(parseFloat(ent.interest_rate) || 0), type: ent.interest_is_percent ? 'percentage' : 'fixed' });
        }
        if (ent.form_fee !== undefined && ent.form_fee !== null && ent.form_fee !== '') {
            out.push({ id: generateId(String(cooperativeId)), name: 'Form Fee', value: Math.abs(parseFloat(ent.form_fee) || 0), type: ent.form_fee_is_percent ? 'percentage' : 'fixed' });
        }
        if (ent.admin_charge !== undefined && ent.admin_charge !== null && ent.admin_charge !== '') {
            out.push({ id: generateId(String(cooperativeId)), name: 'Admin Charge', value: Math.abs(parseFloat(ent.admin_charge) || 0), type: ent.admin_charge_is_percent ? 'percentage' : 'fixed' });
        }
        return out;
    };
    let charges = defaultCharges();

    const memberRows = () => {
        const term = searchTerm.trim().toLowerCase();
        const list = pickable.filter(m => {
            if (!term) return true;
            return String(m.registration_no || '').toLowerCase().includes(term)
                || String(m.name || '').toLowerCase().includes(term)
                || String(m.mobile || '').includes(term)
                || String(m.special_id || '').toLowerCase().includes(term);
        });
        if (!list.length) return '<div style="padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.82rem;">No members match.</div>';
        const varied = direction === 'deposit_varied';
        return list.map(m => {
            const id = String(m.id);
            const label = [m.name, m.registration_no || m.mobile].filter(Boolean).join(' / ');
            return `<label style="display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.5rem; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.85rem;" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
                <input type="checkbox" class="bulk-member-chk" value="${escapeHtml(id)}" ${checkedIds.has(id) ? 'checked' : ''} style="width: 16px; height: 16px; accent-color: var(--accent-primary);">
                <span style="color: var(--text-primary); flex: 1;">${escapeHtml(label)}</span>
                ${varied ? `<input type="number" step="0.01" min="0" class="bulk-amt-input" data-id="${escapeHtml(id)}" value="${rowAmounts[id] || ''}" placeholder="0.00" style="width: 110px; padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem; text-align: right;">` : ''}
            </label>`;
        }).join('');
    };

    const refreshCounts = () => {
        const el = overlay.querySelector('#bulk-count-line');
        if (!el) return;
        if (direction === 'deposit_varied') {
            let n = 0, sum = 0;
            checkedIds.forEach(id => {
                const v = parseFloat(rowAmounts[id] || 0) || 0;
                if (v > 0) { n++; sum += v; }
            });
            el.innerHTML = `<strong>${n}</strong> member${n === 1 ? '' : 's'} with amounts = <strong>${formatCurrency(sum)}</strong>`;
            return;
        }
        const n = direction === 'one_to_one' ? 1 : checkedIds.size;
        const amt = parseFloat(overlay.querySelector('#bulk-amount')?.value || 0) || 0;
        el.innerHTML = `<strong>${n}</strong> selected &times; ${formatCurrency(amt)} = <strong>${formatCurrency(n * amt)}</strong>`;
    };

    // Searchable single-member picker (From / To). includeHouse pins the
    // House (0000000000) option on top for 1-to-1 recipient selection.
    const singlePickerHTML = (prefix, label) => `
        <div class="field">
          <label>${label}</label>
          <input id="${prefix}-search" type="text" placeholder="Search Reg No, name, mobile..." autocomplete="off">
          <div id="${prefix}-sugg" style="display: none; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); max-height: 160px; overflow-y: auto; background: var(--bg-card);"></div>
          <div id="${prefix}-picked" style="font-size: 0.82rem; color: var(--text-muted); font-weight: 400;"></div>
        </div>
    `;
    const singlePickedLabel = (mid) => {
        if (!mid) return 'None selected';
        if (String(mid) === '0000000000') return 'Selected: <strong>House (Cooperative)</strong>';
        const m = pickable.find(x => String(x.id) === String(mid));
        if (!m) return 'Selected: <strong>Unknown</strong>';
        return `Selected: <strong>${escapeHtml([m.name, m.registration_no || m.mobile].filter(Boolean).join(' / '))}</strong>`;
    };
    const attachSinglePicker = (prefix, get, set, includeHouse) => {
        const input = overlay.querySelector(`#${prefix}-search`);
        const sugg = overlay.querySelector(`#${prefix}-sugg`);
        const picked = overlay.querySelector(`#${prefix}-picked`);
        const paintPicked = () => { picked.innerHTML = singlePickedLabel(get()); };
        paintPicked();
        input.addEventListener('input', () => {
            const withHouse = typeof includeHouse === 'function' ? includeHouse() : includeHouse;
            const term = input.value.trim().toLowerCase();
            let list = pickable.filter(m =>
                !term || String(m.registration_no || '').toLowerCase().includes(term)
                || String(m.name || '').toLowerCase().includes(term)
                || String(m.mobile || '').includes(term)
                || String(m.special_id || '').toLowerCase().includes(term)
            ).slice(0, 8);
            let html = '';
            if (withHouse && (!term || 'house'.includes(term) || 'cooperative'.includes(term) || '0000000000'.includes(term))) {
                html += `<div data-single-pick="0000000000" style="padding: 0.55rem 0.7rem; cursor: pointer; border-bottom: 1px solid var(--border-light);"><div style="font-weight: 700; color: var(--accent-primary); font-size: 0.85rem;">House (Cooperative)</div></div>`;
            }
            html += list.length ? list.map(m => `
                <div data-single-pick="${escapeHtml(String(m.id))}" style="padding: 0.55rem 0.7rem; cursor: pointer; border-bottom: 1px solid var(--border-light);">
                  <div style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary);">${escapeHtml(m.name || '')}</div>
                  <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(m.registration_no || m.mobile || '')}</div>
                </div>
            `).join('') : (withHouse ? '' : '<div style="padding: 0.6rem; font-size: 0.8rem; color: var(--text-muted);">No matches.</div>');
            sugg.innerHTML = html;
            sugg.style.display = 'block';
            sugg.querySelectorAll('[data-single-pick]').forEach(row => {
                row.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    set(row.dataset.singlePick);
                    const m = pickable.find(x => String(x.id) === String(get()));
                    input.value = get() === '0000000000' ? 'House (Cooperative)' : (m?.name || '');
                    sugg.style.display = 'none';
                    paintPicked();
                });
            });
        });
        input.addEventListener('blur', () => setTimeout(() => { sugg.style.display = 'none'; }, 150));
        input.addEventListener('focus', () => { if (sugg.innerHTML) sugg.style.display = 'block'; });
    };

    const renderCharges = () => {
        const wrap = overlay.querySelector('#bulk-charges-list');
        if (!wrap) return;
        wrap.innerHTML = charges.length ? charges.map((c, i) => `
            <div style="display: flex; gap: 0.5rem; align-items: center;">
                <input type="text" data-cidx="${i}" data-cfield="name" value="${escapeHtml(c.name)}" style="flex: 2; padding: 0.45rem 0.6rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem;">
                <input type="number" step="0.01" min="0" data-cidx="${i}" data-cfield="value" value="${c.value}" style="flex: 1; padding: 0.45rem 0.6rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem; text-align: right;">
                <select data-cidx="${i}" data-cfield="type" style="flex: 1; padding: 0.45rem 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem;">
                    <option value="fixed" ${c.type !== 'percentage' ? 'selected' : ''}>Fixed</option>
                    <option value="percentage" ${c.type === 'percentage' ? 'selected' : ''}>%</option>
                </select>
                <button type="button" data-cremove="${i}" style="background: transparent; border: none; color: var(--danger); font-size: 1.2rem; cursor: pointer;">&times;</button>
            </div>
        `).join('') : '<div style="font-size: 0.8rem; color: var(--text-muted);">No charges — loans post without extra charges.</div>';
    };

    overlay.innerHTML = `
      <div class="modal-content" style="max-width: 640px; width: 94%; max-height: 92vh; display: flex; flex-direction: column; background: var(--bg-card); border-radius: var(--radius-md); box-shadow: var(--shadow-xl);">
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--border-light);">
          <h3 style="margin: 0;">Bulk Remittance</h3>
          <button type="button" id="bulk-close" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
        </div>
        <div id="bulk-body" style="padding: 1.1rem 1.25rem; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div class="field"><label>Type</label>
              <select id="bulk-direction">
                <option value="loan">Loan (disburse)</option>
                <option value="deposit">Deposit (savings)</option>
                <option value="due">Due (compulsory)</option>
                <option value="penalty">Penalty</option>
                <option value="transfer">Transfer (many → one)</option>
                <option value="one_to_many">Transfer (one → many)</option>
                <option value="one_to_one">Transfer (1-to-1)</option>
                <option value="to_admin">Collection → Admin (members → house)</option>
                <option value="deposit_varied">Deposit (varied amounts)</option>
              </select>
            </div>
            <div class="field"><label id="bulk-ent-label">Enterprise</label>
              <select id="bulk-enterprise"></select>
            </div>
            <div class="field" id="bulk-creditent-wrap" style="display: none;"><label id="bulk-creditent-label">Credit enterprise (to)</label>
              <select id="bulk-credit-enterprise"></select>
            </div>
            <div class="field" id="bulk-fund-source-wrap" style="display: none;"><label id="bulk-fund-source-label">Fund from (savings account)</label>
              <select id="bulk-fund-source"></select>
            </div>
            <div class="field" id="bulk-amount-wrap"><label>Amount (per member)</label>
              <input id="bulk-amount" type="number" step="0.01" min="0" value="0">
            </div>
            <div class="field"><label>Date</label>
              <input id="bulk-date" type="date" value="${today}">
            </div>
            <div class="field"><label>Bank</label>
              <select id="bulk-bank">
                <option value="">-- Select --</option>
                ${banks.map(b => `<option value="${escapeHtml(b.bank_name || b.id)}">${escapeHtml(b.bank_name || b.id)}</option>`).join('')}
              </select>
            </div>
            <div class="field" id="bulk-duration-wrap"><label>Duration (months)</label>
              <input id="bulk-duration" type="number" step="1" min="1" value="12">
            </div>
          </div>
          <div class="field"><label>Note / Description</label>
            <input id="bulk-desc" type="text" placeholder="e.g. March group loans">
          </div>
          <div id="bulk-charges-wrap">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
              <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted);">CHARGES (applies to every loan)</span>
              <button type="button" id="bulk-charge-add" style="background: transparent; border: 1px solid var(--border-medium); border-radius: 999px; padding: 0.2rem 0.7rem; font-size: 0.75rem; cursor: pointer; color: var(--text-primary);">+ Add</button>
            </div>
            <div id="bulk-charges-list" style="display: flex; flex-direction: column; gap: 0.4rem;"></div>
          </div>
          <div id="bulk-from-single-wrap" style="display: none; margin-bottom: 0.75rem;">${singlePickerHTML('bulk-from', 'From (single sender)')}</div>
          <div id="bulk-to-wrap" style="display: none; margin-bottom: 0.75rem;">${singlePickerHTML('bulk-to', 'To (single recipient)')}</div>
          <div id="bulk-multi-wrap">
            <div id="bulk-from-label" style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); margin-bottom: 0.4rem;">MEMBERS</div>
            <div style="display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.4rem;">
              <input id="bulk-member-search" type="text" placeholder="Search members..." style="flex: 1; padding: 0.5rem 0.6rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.85rem;">
              <button type="button" id="bulk-import-btn" style="display: none; background: transparent; border: 1px solid var(--border-medium); border-radius: 999px; padding: 0.25rem 0.7rem; font-size: 0.75rem; cursor: pointer; color: var(--text-primary); white-space: nowrap;">Import Excel</button>
              <button type="button" id="bulk-select-all" style="background: transparent; border: none; color: var(--accent-primary); font-size: 0.78rem; font-weight: 700; cursor: pointer;">Select all</button>
              <button type="button" id="bulk-clear-all" style="background: transparent; border: none; color: var(--text-muted); font-size: 0.78rem; cursor: pointer;">Clear</button>
            </div>
            <div id="bulk-member-list" style="max-height: 220px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: 0.4rem;"></div>
            <div id="bulk-count-line" style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-muted);"></div>
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 1rem 1.25rem; border-top: 1px solid var(--border-light);">
          <span style="font-size: 0.75rem; color: var(--text-muted);">Gu­arantors skipped in bulk. Each member gets an independent remittance.</span>
          <div style="display: flex; gap: 0.6rem;">
            <button type="button" id="bulk-cancel" class="btn btn-secondary">Cancel</button>
            <button type="button" id="bulk-create" class="btn btn-primary">Review &amp; Create</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#bulk-close').addEventListener('click', close);
    overlay.querySelector('#bulk-cancel').addEventListener('click', close);

    const paintMembers = () => {
        overlay.querySelector('#bulk-member-list').innerHTML = memberRows();
        overlay.querySelectorAll('.bulk-member-chk').forEach(chk => {
            chk.addEventListener('change', () => {
                if (chk.checked) checkedIds.add(chk.value);
                else checkedIds.delete(chk.value);
                refreshCounts();
            });
        });
    };
    const syncDirectionUI = () => {
        refreshEntOptions();
        const list = entListFor();
        overlay.querySelector('#bulk-enterprise').innerHTML = entOptions(list, selectedEntId);
        const entLabel = overlay.querySelector('#bulk-ent-label');
        if (entLabel) entLabel.textContent = isTransferDir() ? 'Debit enterprise (from)' : 'Enterprise';
        overlay.querySelector('#bulk-creditent-wrap').style.display = isTransferDir() ? 'flex' : 'none';
        const creditLabel = overlay.querySelector('#bulk-creditent-label');
        if (direction === 'to_admin') {
            if (creditLabel) creditLabel.textContent = 'Admin transaction type (to House)';
            overlay.querySelector('#bulk-credit-enterprise').innerHTML = txTypes.map(t => {
                    const locked = t.is_locked === 1 || t.is_locked === true;
                    return `<option value="${escapeHtml(t.transaction_type)}" ${t.transaction_type === selectedTxType ? 'selected' : ''}" ${locked ? 'disabled' : ''}>${escapeHtml(t.transaction_type)}${locked ? ' Ⓒ' : ''}</option>`;
                }).join('') || '<option value="">-- No types --</option>';
        } else {
            if (creditLabel) creditLabel.textContent = 'Credit enterprise (to)';
            if (isTransferDir()) overlay.querySelector('#bulk-credit-enterprise').innerHTML = entOptions(list, selectedCreditEntId);
        }
        const showFundSource = direction === 'due' || direction === 'penalty';
        const fundWrap = overlay.querySelector('#bulk-fund-source-wrap');
        if (fundWrap) {
            fundWrap.style.display = showFundSource ? 'flex' : 'none';
            if (showFundSource) {
                if (!savingsEnts.some(e => String(e.id) === String(selectedFundingEntId))) {
                    selectedFundingEntId = savingsEnts[0]?.id || '';
                }
                overlay.querySelector('#bulk-fund-source').innerHTML = entOptions(savingsEnts, selectedFundingEntId);
            }
        }
        overlay.querySelector('#bulk-from-single-wrap').style.display = showFromSingle() ? 'block' : 'none';
        overlay.querySelector('#bulk-to-wrap').style.display = showToSingle() ? 'block' : 'none';
        overlay.querySelector('#bulk-multi-wrap').style.display = showMultiList() ? 'block' : 'none';
        overlay.querySelector('#bulk-amount-wrap').style.display = direction === 'deposit_varied' ? 'none' : 'flex';
        overlay.querySelector('#bulk-import-btn').style.display = direction === 'deposit_varied' ? 'block' : 'none';
        const fromLabel = overlay.querySelector('#bulk-from-label');
        if (fromLabel) fromLabel.textContent = direction === 'transfer' ? 'FROM MEMBERS (each debited)'
            : direction === 'to_admin' ? 'MEMBERS (each debited → House)'
            : direction === 'one_to_many' ? 'RECIPIENTS (each credited)'
            : direction === 'deposit_varied' ? 'MEMBERS (amount each)' : 'MEMBERS';
        const isLoan = direction === 'loan';
        overlay.querySelector('#bulk-duration-wrap').style.display = isLoan ? 'flex' : 'none';
        overlay.querySelector('#bulk-charges-wrap').style.display = isLoan ? 'block' : 'none';
        const descInput = overlay.querySelector('#bulk-desc');
        if (descInput && !descInput.value) {
            descInput.placeholder = direction === 'due' ? 'e.g. March welfare dues'
                : direction === 'penalty' ? 'e.g. Late payment penalties'
                : direction === 'deposit' ? 'e.g. March savings'
                : direction === 'deposit_varied' ? 'e.g. March contributions'
                : isTransferDir() ? 'e.g. September welfare collection (required)'
                : 'e.g. March group loans';
        }
        paintMembers();
        refreshCounts();
    };

    overlay.querySelector('#bulk-direction').addEventListener('change', (e) => {
        direction = e.target.value;
        charges = direction === 'loan' ? defaultCharges() : [];
        syncDirectionUI();
        renderCharges();
    });
    overlay.querySelector('#bulk-enterprise').addEventListener('change', (e) => {
        selectedEntId = e.target.value;
        if (direction === 'loan') { charges = defaultCharges(); renderCharges(); }
    });
    overlay.querySelector('#bulk-credit-enterprise').addEventListener('change', (e) => {
        if (direction === 'to_admin') selectedTxType = e.target.value;
        else selectedCreditEntId = e.target.value;
    });
    overlay.querySelector('#bulk-fund-source').addEventListener('change', (e) => {
        selectedFundingEntId = e.target.value;
    });
    attachSinglePicker('bulk-from', () => fromMemberId, (v) => { fromMemberId = v || ''; }, false);
    attachSinglePicker('bulk-to', () => toMemberId, (v) => { toMemberId = v || ''; }, () => direction === 'one_to_one');
    overlay.querySelector('#bulk-import-btn').addEventListener('click', () => {
        showToast('Update in progress — Excel import coming in a future update.', 'warning');
    });
    overlay.querySelector('#bulk-amount').addEventListener('input', refreshCounts);
    overlay.querySelector('#bulk-member-search').addEventListener('input', (e) => {
        searchTerm = e.target.value || '';
        paintMembers();
    });
    // Varied-amount rows: typing an amount auto-checks the member
    overlay.querySelector('#bulk-member-list').addEventListener('input', (e) => {
        const inp = e.target.closest?.('.bulk-amt-input');
        if (!inp) return;
        const v = parseFloat(inp.value || 0) || 0;
        if (v > 0) {
            rowAmounts[inp.dataset.id] = v;
            checkedIds.add(inp.dataset.id);
            const chk = inp.closest('label')?.querySelector('.bulk-member-chk');
            if (chk) chk.checked = true;
        } else {
            delete rowAmounts[inp.dataset.id];
        }
        refreshCounts();
    });
    overlay.querySelector('#bulk-select-all').addEventListener('click', () => {
        const term = searchTerm.trim().toLowerCase();
        pickable.forEach(m => {
            if (!term || String(m.registration_no || '').toLowerCase().includes(term)
                || String(m.name || '').toLowerCase().includes(term)
                || String(m.special_id || '').toLowerCase().includes(term)
                || String(m.mobile || '').includes(term)) checkedIds.add(String(m.id));
        });
        paintMembers();
        refreshCounts();
    });
    overlay.querySelector('#bulk-clear-all').addEventListener('click', () => {
        checkedIds.clear();
        paintMembers();
        refreshCounts();
    });
    overlay.querySelector('#bulk-charge-add').addEventListener('click', () => {
        charges.push({ id: generateId(String(user.cooperativeId)), name: 'Charge', value: 0, type: 'fixed' });
        renderCharges();
    });
    overlay.querySelector('#bulk-charges-list').addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.cidx, 10);
        const field = e.target.dataset.cfield;
        if (isNaN(idx) || !charges[idx]) return;
        if (field === 'value') charges[idx].value = parseFloat(e.target.value || 0) || 0;
        else if (field === 'name' || field === 'type') charges[idx][field] = e.target.value;
    });
    overlay.querySelector('#bulk-charges-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cremove]');
        if (!btn) return;
        charges.splice(parseInt(btn.dataset.cremove, 10), 1);
        renderCharges();
    });

    paintMembers();
    renderCharges();
    syncDirectionUI();
    refreshCounts();

    overlay.querySelector('#bulk-create').addEventListener('click', async () => {
        const amount = Math.abs(parseFloat(overlay.querySelector('#bulk-amount').value || 0) || 0);
        const date = overlay.querySelector('#bulk-date').value || today;
        const bank = overlay.querySelector('#bulk-bank').value || '';
        const desc = overlay.querySelector('#bulk-desc').value.trim();
        const duration = Math.max(1, parseInt(overlay.querySelector('#bulk-duration').value || 0, 10) || 0);
        const ent = (enterpriseData || []).find(x => String(x.id) === String(selectedEntId));
        const isToAdminMode = direction === 'to_admin';
        const creditTxType = isToAdminMode ? selectedTxType : null;
        const creditEnt = isTransferDir() && !isToAdminMode
            ? (enterpriseData || []).find(x => String(x.id) === String(selectedCreditEntId))
            : null;
        const fundingEntId = selectedFundingEntId;
        const isVaried = direction === 'deposit_varied';
        const is121 = direction === 'one_to_one';
        const is1MN = direction === 'one_to_many';
        let memberIds = [...checkedIds];
        let variedList = [];
        if (is121) memberIds = fromMemberId ? [fromMemberId] : [];
        if (isVaried) {
            variedList = memberIds
                .map(id => ({ id, amt: parseFloat(rowAmounts[id] || 0) || 0 }))
                .filter(x => x.amt > 0);
        }

        if (!ent) { showToast('Select an enterprise.', 'error'); return; }
        if (!isVaried && !(amount > 0)) { showToast('Enter an amount greater than zero.', 'error'); return; }
        if (!bank) { showToast('Select a bank.', 'error'); return; }
        if (direction === 'loan' && !(duration > 0)) { showToast('Enter loan duration in months.', 'error'); return; }
        if (!memberIds.length) { showToast('Select at least one member.', 'error'); return; }
        if (isVaried && !variedList.length) { showToast('Enter an amount for at least one member.', 'error'); return; }
        if (isTransferDir()) {
            if (isToAdminMode) {
                if (!creditTxType) { showToast('Select an admin transaction type.', 'error'); return; }
            } else {
                if (!creditEnt) { showToast('Select a credit enterprise.', 'error'); return; }
            }
            if (is121 || direction === 'transfer') {
                if (!toMemberId) { showToast('Select the recipient (To).', 'error'); return; }
            }
            if (is1MN || is121) {
                if (!fromMemberId) { showToast('Select the sender (From).', 'error'); return; }
            }
            if (!desc) { showToast('Note is required for transfers.', 'error'); return; }
        }

        // Dues ask-once for deposits only. Loans skip (negative loan
        // distribution, same as single flow); due/penalty batches ARE the
        // charge, so no popup (avoids charging dues on top of dues).
        let duesDecision = null;
        if (direction === 'deposit' && typeof deps.showDuesChargePopup === 'function') {
            const chargeable = [];
            const seen = new Set();
            (enterpriseData || []).forEach(x => {
                if (seen.has(x.id)) return;
                const isDue = !!x.compulsory_due && parseFloat(x.compulsory_amount || 0) > 0;
                const isPen = !!x.is_penalty;
                if (!isDue && !isPen) return;
                seen.add(x.id);
                chargeable.push({
                    enterprise_id: x.id,
                    name: x.account_name || x.id,
                    isDue, isPen,
                    defaultAmount: isDue ? parseFloat(x.compulsory_amount || 0) : 0
                });
            });
            if (chargeable.length) {
                duesDecision = await deps.showDuesChargePopup(chargeable);
                if (!duesDecision) return; // dismissed => abort batch, back to bulk modal
            }
        }

        const typeLabel = direction === 'loan' ? 'loan' : direction === 'deposit' ? 'deposit' : direction === 'due' ? 'due' : direction === 'penalty' ? 'penalty' : direction === 'deposit_varied' ? 'varied deposit' : 'transfer';
        const toNameForConfirm = (mid) => String(mid) === '0000000000' ? 'House' : (pickable.find(m => String(m.id) === String(mid))?.name || 'recipient');
        if (isVaried) {
            const sum = variedList.reduce((s, x) => s + x.amt, 0);
            if (!confirm(`Create varied deposits for ${variedList.length} member${variedList.length === 1 ? '' : 's'} totalling ${formatCurrency(sum)}?`)) return;
        } else if (isTransferDir()) {
            const pairCount = is121 ? 1 : memberIds.length;
            if (direction === 'to_admin') {
                if (!confirm(`Collect ${formatCurrency(amount)} each from ${pairCount} member${pairCount === 1 ? '' : 's'} → House (${creditTxType})?`)) return;
            } else {
                const counterparts = is1MN ? `${pairCount} recipient${pairCount === 1 ? '' : 's'}`
                    : is121 ? toNameForConfirm(toMemberId)
                    : `${pairCount} sender${pairCount === 1 ? '' : 's'} → ${toNameForConfirm(toMemberId)}`;
                if (!confirm(`Transfer ${formatCurrency(amount)} each (${counterparts})?`)) return;
            }
        } else {
            if (!confirm(`Create ${typeLabel} of ${formatCurrency(amount)} for ${memberIds.length} member${memberIds.length === 1 ? '' : 's'}${duesDecision?.charge ? ' (plus dues/penalties)' : ''}?`)) return;
        }

        // 1-to-many upfront total check: reject the whole batch before anything
        // is written when the sender cannot cover amount x recipients (loans exempt).
        if (is1MN) {
            const total = amount * memberIds.length;
            try {
                const bal = await buildAccountBalance(user.cooperativeId, { ...user, memberId: fromMemberId }, null, null);
                const opening = parseFloat((bal.accountBalance || []).find(b => String(b.id) === String(ent.id))?.sum_of_amount || 0);
                if (getAccountType(ent) !== 'loan' && total > opening) {
                    showToast(`Insufficient balance: need ${formatCurrency(total)} but sender has ${formatCurrency(opening)}. Batch rejected.`, 'error');
                    return;
                }
            } catch (e) { console.warn('[Bulk] upfront balance check failed:', e?.message); }
        }

        await runBulk({ ent, creditEnt, creditTxType, toMemberId, fromMemberId, amount, date, bank, desc, duration, memberIds, variedList, duesDecision, fundingEntId, overlay });
    });

    async function runBulk({ ent, creditEnt, creditTxType, toMemberId, fromMemberId, amount, date, bank, desc, duration, memberIds, variedList, duesDecision, fundingEntId, overlay }) {
        const body = overlay.querySelector('#bulk-body');
        body.innerHTML = `
          <div style="padding: 1.5rem 0.5rem; text-align: center;">
            <div id="bulk-prog-label" style="font-weight: 700; margin-bottom: 0.75rem;">Preparing...</div>
            <div style="height: 10px; background: var(--bg-secondary); border-radius: 999px; overflow: hidden;">
              <div id="bulk-prog-bar" style="height: 100%; width: 0%; background: var(--accent-primary); transition: width 0.2s;"></div>
            </div>
            <div id="bulk-prog-count" style="margin-top: 0.5rem; font-size: 0.8rem; color: var(--text-muted);"></div>
          </div>
        `;
        overlay.querySelector('#bulk-create').disabled = true;
        overlay.querySelector('#bulk-cancel').disabled = true;

        // Preload remittances once; per-member balances computed locally (cheap)
        let preloaded = null;
        try {
            const allRems = await getRemittances(user.cooperativeId, null);
            preloaded = { remittances: allRems };
        } catch (e) { console.warn('[Bulk] preload failed, balances per member:', e?.message); }

        const isLoan = direction === 'loan';
        const isDuePenalty = direction === 'due' || direction === 'penalty';
        const isVaried = direction === 'deposit_varied';
        const is121 = direction === 'one_to_one';
        const is1MN = direction === 'one_to_many';
        const isMany1 = direction === 'transfer';
        const isToAdmin = direction === 'to_admin';
        const nameOf = (mid) => String(mid) === '0000000000' ? 'House'
            : (pickable.find(m => String(m.id) === String(mid))?.name || mid || '');
        // One unit per record: transfers carry {from, to}, singles carry {mid}.
        // Varied deposits carry their own amount; all other modes share `amount`.
        const units = is121 ? [{ mid: fromMemberId, from: fromMemberId, to: toMemberId, amt: amount }]
            : is1MN ? memberIds.map(to => ({ mid: fromMemberId, from: fromMemberId, to, amt: amount }))
            : isMany1 ? memberIds.map(mid => ({ mid, from: mid, to: toMemberId, amt: amount }))
            : isToAdmin ? memberIds.map(mid => ({ mid, from: mid, to: '0000000000', amt: amount }))
            : isVaried ? variedList.map(x => ({ mid: x.id, amt: x.amt }))
            : memberIds.map(mid => ({ mid, amt: amount }));
        const debitIsLoan = isTransferDir() && getAccountType(ent) === 'loan';
        const successes = [];
        const failures = [];
        const coopId = user.cooperativeId;
        // generateRemittanceId is second-precision: a machine-speed loop mints
        // identical ids and each saveDoc upserts over the last (1 survivor).
        // Batch tag + index keeps every parent unique.
        const batchTag = Math.random().toString(36).slice(2, 6).toUpperCase();
        const baseRemId = generateRemittanceId(coopId);

        const setProgress = (done, total, label) => {
            const bar = overlay.querySelector('#bulk-prog-bar');
            const lab = overlay.querySelector('#bulk-prog-label');
            const cnt = overlay.querySelector('#bulk-prog-count');
            if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
            if (lab && label) lab.textContent = label;
            if (cnt) cnt.textContent = `${done} / ${total}`;
        };

        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            const mid = u.mid;
            const curAmt = u.amt;
            const mem = pickable.find(m => String(m.id) === String(mid));
            const memName = mem?.name || mid;
            const uFrom = u.from !== undefined ? u.from : mid;
            const uTo = u.to;
            setProgress(i, units.length, `Creating for ${memName}...`);
            try {
                // Per-member opening balances (needed for the loan-limit check)
                let openings = {};
                try {
                    const bal = await buildAccountBalance(coopId, { ...user, memberId: mid }, null, preloaded);
                    (bal.accountBalance || []).forEach(b => openings[b.id] = b.sum_of_amount);
                } catch (e) { openings = {}; }

                const parentRemId = `${baseRemId}-B${batchTag}-${i + 1}`;

                if (isLoan) {
                    // Mirror single-form loan validation (clamp rules)
                    const opening = parseFloat(openings[ent.id] || 0);
                    const val = -Math.abs(curAmt);
                    const maxRepayment = -opening;
                    if (val > maxRepayment) throw new Error('Cannot repay more than owed.');
                    if (ent.parent_account && ent.loan_multiplier) {
                        let parentBal = 0;
                        try {
                            const pbal = await buildAccountBalance(coopId, { ...user, memberId: mid }, null, preloaded);
                            (pbal.accountBalance || []).forEach(b => { if (String(b.id) === String(ent.parent_account)) parentBal = b.sum_of_amount; });
                            parentBal = parseFloat(parentBal || 0);
                        } catch (e) { parentBal = 0; }
                        const borrowingLimit = -(parentBal * parseFloat(ent.loan_multiplier));
                        if (val < borrowingLimit - opening) throw new Error('Exceeds loan limit.');
                    }
                }

                const issueD = new Date(date);
                const dueD = new Date(issueD);
                if (isLoan) dueD.setMonth(dueD.getMonth() + duration);

                if (isLoan) {
                    const loanId = generateId(String(coopId));
                    const loanInfo = {
                        loanData: {
                            principalAmount: curAmt,
                            durationMonths: duration,
                            issueDate: date,
                            dueDate: isNaN(dueD.getTime()) ? '' : dueD.toISOString(),
                            notes: desc,
                            status: status === 'Approved' ? 'Active' : 'Pending'
                        },
                        guarantors: [],
                        charges: (charges || []).map(c => ({ ...c }))
                    };
                    // Charge autogens (same math as single flow: % of principal, stored negative)
                    const chargeAutos = [];
                    (loanInfo.charges || []).forEach((c) => {
                        let v = parseFloat(c.value) || 0;
                        if (c.type === 'percentage') v = (v / 100) * curAmt;
                        if (!(v > 0)) return;
                        const neg = -Math.abs(v);
                        chargeAutos.push({
                            member_id: mid,
                            amount: neg,
                            remittance_date: date,
                            bank_name: 'Internal Transfer',
                            transaction_type: 'Loan Charges',
                            category: 'Loan Asset',
                            description: 'Loan Charge: ' + (c.name || 'Charge'),
                            autogen: 1,
                            loan_id: loanId,
                            details: [{ id: generateId(String(coopId)), enterprise_id: ent.id, amount: neg, notes: c.name }]
                        });
                    });

                    await addRemittance({
                        id: parentRemId,
                        cooperative_id: coopId,
                        member_id: mid,
                        amount: -Math.abs(amount),
                        remittance_date: date,
                        bank_name: bank,
                        transaction_type: 'Member Loan',
                        description: desc,
                        status,
                        user_role: user.role || 'member',
                        user_roles: [user.role || 'member'],
                        loan_status: status === 'Approved' ? 'Active' : 'Pending',
                        details: [{
id: generateId(String(coopId)),
                            enterprise_id: ent.id,
                            amount: -Math.abs(curAmt),
                            loan_info: loanInfo
                        }],
                        loans: [{
                            id: loanId,
                            member_id: mid,
                            enterprise_id: ent.id,
                            principal_amount: Math.abs(curAmt),
                            issued_date: date,
                            due_date: isNaN(dueD.getTime()) ? '' : dueD.toISOString(),
                            status: status === 'Approved' ? 'Active' : 'Pending',
                            notes: desc,
                            duration_months: duration,
                            guarantors: []
                        }]
                    }, createdBy);

                    for (let ci = 0; ci < chargeAutos.length; ci++) {
                        await addRemittance({
                            ...chargeAutos[ci],
                            id: `${parentRemId}-CHARGE-${String(ci + 1).padStart(2, '0')}`,
                            parent_remittance_id: parentRemId,
                                status,
                            cooperative_id: coopId,
                            user_role: user.role || 'member',
                            user_roles: [user.role || 'member']
                        }, createdBy);
                    }

                    // Loan income pickup (one per loan): +ve Internal Transfer to
                    // admin 0000000000 totalling this loan's charges above.
                    // Header only (no details on admin remittances).
                    if (chargeAutos.length > 0) {
                        const pickupTotal = chargeAutos.reduce((s, c) => s + Math.abs(parseFloat(c.amount || 0)), 0);
                        if (pickupTotal > 0) {
                            await addRemittance({
                                id: `${parentRemId}-LOANPICKUP`,
                                cooperative_id: coopId,
                                member_id: '0000000000',
                                amount: pickupTotal,
                                remittance_date: date,
                                bank_name: 'Internal Transfer',
                                transaction_type: 'Loan Charges',
                                category: 'Loan Income',
                                description: `Auto Loan Charges Income - ${nameOf(mid)}`,
                                autogen: 1,
                                loan_id: loanId,
                                parent_remittance_id: parentRemId,
                                        status,
                                user_role: user.role || 'member',
                                user_roles: [user.role || 'member']
                            }, createdBy);
                        }
                    }

                    // Monthly advice update (same as single flow) — only on Approval
                    if (status === 'Approved' && duration > 0) {
                        try {
                            const monthlyPayment = parseFloat((curAmt / duration).toFixed(2));
                            if (monthlyPayment > 0) {
                                const memberDoc = await fetchMemberDoc(mid);
                                if (memberDoc) {
                                    let existingAdvise = memberDoc.payment_advise || [];
                                    const ix = existingAdvise.findIndex(a => String(a.enterprise_id) === String(ent.id));
                                    if (ix >= 0) existingAdvise[ix].amount = (parseFloat(existingAdvise[ix].amount) || 0) + monthlyPayment;
                                    else existingAdvise.push({ enterprise_id: String(ent.id), amount: monthlyPayment, created_at: new Date().toISOString() });
                                    await updateMemberPaymentAdvice(mid, existingAdvise, user.username, coopId);
                                }
                            }
                        } catch (e) { console.warn('[Bulk] advice update failed for', mid, e?.message); }
                    }
                } else if (isTransferDir()) {
                    // Pair transfer 1:1 (many-to-1, one-to-many, 1-to-1). Debit
                    // parent on the from-member, credit child on the recipient.
                    // Savings debit must cover the amount (no overdraft); loan
                    // debit may go negative with no charges and no loan record.
                    const fromName = nameOf(uFrom);
                    const pairToName = nameOf(uTo);
                    if (String(uFrom) === String(uTo)) throw new Error('Cannot transfer to self.');
                    const opening = parseFloat(openings[ent.id] || 0);
                    if (!debitIsLoan && curAmt > opening) {
                        throw new Error(`Insufficient ${ent.account_name || 'enterprise'} balance (${formatCurrency(opening)}).`);
                    }
                    const neg = -Math.abs(curAmt);
                    const pos = Math.abs(curAmt);
                    const outLabel = is121 ? 'Transfer Out' : isToAdmin ? 'Admin Collection Out' : 'Bulk Transfer Out';
                    const inLabel = is121 ? 'Transfer In' : isToAdmin ? 'Admin Collection In' : 'Bulk Transfer In';
                    await addRemittance({
                        id: parentRemId,
                        cooperative_id: coopId,
                        member_id: uFrom,
                        amount: neg,
                        remittance_date: date,
                        bank_name: bank,
                        transaction_type: 'Internal Transfer',
                        description: `${outLabel} (${ent.account_name || ent.id}) → ${pairToName}: ${desc}`,
                        status,
                        user_role: user.role || 'member',
                        user_roles: [user.role || 'member'],
                        loan_status: status === 'Approved' ? 'Active' : 'Pending',
                        details: [{ id: generateId(String(coopId)), enterprise_id: ent.id, amount: neg, notes: `To ${pairToName}` }]
                    }, createdBy);
                    if (isToAdmin) {
                        // Admin collection: House credit is header-only under
                        // the chosen transaction type (Detail = none — same
                        // convention as dues/loan income pickups). Category
                        // resolves from the type inside addRemittance.
                        await addRemittance({
                            id: `${parentRemId}-TR`,
                            cooperative_id: coopId,
                            member_id: '0000000000',
                            amount: pos,
                            remittance_date: date,
                            bank_name: 'Internal Transfer',
                            transaction_type: creditTxType,
                            description: `${inLabel} (${creditTxType}) ← ${fromName}: ${desc}`,
                            autogen: 1,
                            loan_id: parentRemId,
                            status,
                            user_role: user.role || 'member',
                            user_roles: [user.role || 'member']
                        }, createdBy);
                    } else {
                        await addRemittance({
                            id: `${parentRemId}-TR`,
                            cooperative_id: coopId,
                            member_id: uTo,
                            amount: pos,
                            remittance_date: date,
                            bank_name: 'Internal Transfer',
                            transaction_type: 'Internal Transfer',
                            description: `${inLabel} (${creditEnt.account_name || creditEnt.id}) ← ${fromName}: ${desc}`,
                            autogen: 1,
                            loan_id: parentRemId,
                            status,
                            user_role: user.role || 'member',
                            user_roles: [user.role || 'member'],
                            details: [{ id: generateId(String(coopId)), enterprise_id: creditEnt.id, amount: pos, notes: `From ${fromName}` }]
                        }, createdBy);
                    }
                } else if (!isDuePenalty) {
                    // Deposit (fixed or varied): positive distribution, Member Deposit
                    await addRemittance({
                        id: parentRemId,
                        cooperative_id: coopId,
                        member_id: mid,
                        amount: Math.abs(curAmt),
                        remittance_date: date,
                        bank_name: bank,
                        transaction_type: 'Member Deposit',
                        description: desc,
                        status,
                        user_role: user.role || 'member',
                        user_roles: [user.role || 'member'],
                        loan_status: status === 'Approved' ? 'Active' : 'Pending',
                        details: [{ id: generateId(String(coopId)), enterprise_id: ent.id, amount: Math.abs(curAmt) }]
                    }, createdBy);

                    // Dues/penalty children (ask-once decision, per-member parents).
                    // Four records: DUE debits + header-only INCOME pickup +
                    // zero-header settlement transfer funded from this deposit.
                    // Rule: dues can never exceed this member's deposit — that
                    // member is skipped with a reason (rest of batch continues).
                    if (duesDecision?.charge && Array.isArray(duesDecision.items) && duesDecision.items.length) {
                        const validItems = duesDecision.items.filter(it => parseFloat(it.amount || 0) > 0);
                        const _bulkDueTotal = validItems.reduce((s, it) => s + Math.abs(parseFloat(it.amount || 0)), 0);
                        const _entIsDuePen = !!ent.compulsory_due || !!ent.is_penalty;
                        const _bulkSavLines = (!_entIsDuePen && curAmt > 0)
                            ? [{ enterprise_id: ent.id, amount: Math.abs(curAmt) }]
                            : [];
                        const _bulkSavTotal = _bulkSavLines.reduce((s, l) => s + l.amount, 0);
                        if (_bulkDueTotal > _bulkSavTotal + 1e-9) {
                            throw new Error(`Dues & penalties (${formatCurrency(_bulkDueTotal)}) exceed this deposit (${formatCurrency(_bulkSavTotal)}).`);
                        }
                        let di = 0;
                        for (const item of validItems) {
                            di++;
                            const neg = -Math.abs(parseFloat(item.amount));
                            await addRemittance({
                                id: `${parentRemId}-DUE-${String(di).padStart(2, '0')}`,
                                cooperative_id: coopId,
                                member_id: mid,
                                amount: neg,
                                remittance_date: date,
                                bank_name: 'Internal Transfer',
                                transaction_type: 'Internal Transfer',
                                description: `Auto Internal Charges (${item.name})`,
                                autogen: 1,
                                loan_id: parentRemId,
                                        status,
                                user_role: user.role || 'member',
                                user_roles: [user.role || 'member'],
                                details: [{ id: generateId(String(coopId)), enterprise_id: item.enterprise_id, amount: neg, notes: item.name }]
                            }, createdBy);
                        }
                         await createDuesIncomePickup({
                             cooperativeId: coopId,
                             parentId: parentRemId,
                             duesItems: validItems,
                             enterpriseData: enterpriseData || [],
                             memberName: nameOf(mid),
                             date,
                             status,
                             actor: createdBy,
                             role: user.role || 'member'
                         });
                         // Settlement transfer (header 0): -side from this
                         // deposit, +side split per due enterprise.
                         await createDuesTransfer({
                                cooperativeId: coopId,
                                parentId: parentRemId,
                                memberId: mid,
                                memberName: nameOf(mid),
                                date,
                                status,
                                actor: createdBy,
                                role: user.role || 'member',
                                savingsLines: _bulkSavLines,
                                duesItems: validItems
                             });
                     }
                 } else {
                    // Due / Penalty bulk charge (per-member pickups): the member
                    // is debited negative on the due/penalty enterprise and the
                    // same value is credited positive to the enterprise-named
                    // header-only pickup under admin 0000000000
                    // (Detail = none — same convention as
                    // the normal remittance dues flow and loan income pickup).
                    // No dues popup (the batch IS the charge), no advice.
                    // Funding child (Child D): the charge must be funded from a
                    // savings account (wizard pick, else the first funded
                    // savings), else the first chargeable loan account. Resolved
                    // BEFORE any record is written so an unfundable member is
                    // skipped cleanly (no parent/income orphaned with a
                    // negative due/penalty balance).
                    const funding = resolveDueFunding({
                        selectedEntId: fundingEntId,
                        amount: Math.abs(curAmt),
                        openings,
                        savingsEnts,
                        loanEnts
                    });
                    if (!funding) {
                        throw new Error('No funded savings or loan account to fund this charge.');
                    }
                    const chargeVal = -Math.abs(amount);
                    const creditVal = Math.abs(amount);
                    const kindLabel = direction === 'due' ? 'Due' : 'Penalty';
                    await addRemittance({
                        id: parentRemId,
                        cooperative_id: coopId,
                        member_id: mid,
                        amount: chargeVal,
                        remittance_date: date,
                        bank_name: 'Internal Transfer',
                        transaction_type: 'Internal Transfer',
                        description: desc || `Bulk ${kindLabel} Charge (${ent.account_name || ent.id})`,
                        status,
                        user_role: user.role || 'member',
                        user_roles: [user.role || 'member'],
                        loan_status: status === 'Approved' ? 'Active' : 'Pending',
                        details: [{ id: generateId(String(coopId)), enterprise_id: ent.id, amount: chargeVal, notes: ent.account_name || ent.id }]
                    }, createdBy);
                    const _elseValidItems = (duesDecision?.items || []).filter(it => parseFloat(it.amount || 0) > 0);
                    await createDuesIncomePickup({
                        cooperativeId: coopId,
                        parentId: parentRemId,
                        duesItems: _elseValidItems,
                        enterpriseData: enterpriseData || [],
                        memberName: nameOf(mid),
                        date,
                        status,
                        actor: createdBy,
                        role: user.role || 'member'
                    });
                    // Funding transfer child (header 0): -side (full amount) on
                    // the resolved savings/loan account, +side back onto the
                    // charge enterprise so the due/penalty balance nets to zero.
                    await createDueFundingTransfer({
                        cooperativeId: coopId,
                        parentId: parentRemId,
                        memberId: mid,
                        memberName: nameOf(mid),
                        date,
                        status,
                        actor: createdBy,
                        role: user.role || 'member',
                        fundingEntId: funding.enterprise_id,
                        fundingKind: funding.kind,
                        amount: Math.abs(curAmt),
                        chargeEntId: ent.id,
                        chargeEntName: ent.account_name || ent.id
                    });
                }
                successes.push({ name: memName, amt: curAmt });
            } catch (err) {
                failures.push({ name: memName, reason: err?.message || 'Failed' });
            }
            setProgress(i + 1, memberIds.length);
        }

        const postedTotal = successes.reduce((s, x) => s + (parseFloat(x.amt) || 0), 0);
        const summaryLine = isVaried
            ? `${successes.length} created totalling <strong>${formatCurrency(postedTotal)}</strong>`
            : `${successes.length} created &times; ${formatCurrency(amount)} = <strong>${formatCurrency(postedTotal)}</strong>`;
        body.innerHTML = `
          <div style="padding: 0.5rem;">
            <div style="font-size: 1.05rem; font-weight: 800; color: var(--text-primary); margin-bottom: 0.25rem;">Batch complete</div>
            <div style="font-size: 0.88rem; color: var(--text-muted); margin-bottom: 1rem;">${summaryLine} ${failures.length ? `&bull; <span style="color: var(--danger); font-weight: 700;">${failures.length} failed</span>` : ''}</div>
            ${failures.length ? `<div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border-light); border-radius: var(--radius-sm); margin-bottom: 0.5rem;">
              ${failures.map(f => `<div style="padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border-light); font-size: 0.82rem;"><strong>${escapeHtml(f.name)}</strong> — <span style="color: var(--danger);">${escapeHtml(f.reason)}</span></div>`).join('')}
            </div>` : `<div style="font-size: 0.85rem; color: var(--success); font-weight: 700; margin-bottom: 0.5rem;">All members processed successfully.</div>`}
          </div>
        `;
        const createBtn = overlay.querySelector('#bulk-create');
        if (createBtn) createBtn.textContent = 'Done';
        if (createBtn) createBtn.disabled = false;
        createBtn.onclick = async () => { overlay.remove(); try { await loadHistoryData(true); } catch (e) {} };
        overlay.querySelector('#bulk-cancel').disabled = false;
        try { await loadHistoryData(true); } catch (e) {}
        if (!failures.length) showToast(`Bulk complete: ${successes.length} remittances created.`, 'success');
        else showToast(`Bulk complete: ${successes.length} created, ${failures.length} failed.`, 'warning');
    }
}
