import { generateId, generateRemittanceId, escapeHtml, formatDateForInput, formatCurrency, formatNumber } from '../../utils/formatters.js';
import { addRemittance, buildAccountBalance, fetchMemberDoc, updateMemberPaymentAdvice } from '../../services/dataService.js';
import { createDuesTransfer, createDuesIncomePickup, resolveDueFunding, createDueFundingTransfer } from '../../services/data/duesTransfer.js';
import { getRemittances } from '../../services/sqliteService.js';
import { allocateAutoShare } from '../../services/autoShare/index.js';
import { fetchMemberPaymentAdvise } from '../../services/data/members.js';
import { getBulkRemittanceDraftId, loadBulkRemittanceDraft, saveBulkRemittanceDraft, clearBulkRemittanceDraft } from '../../services/bulkRemittanceDraftService.js';
import { hasPermission } from '../../services/permissionService.js';
import { showToast } from '../../services/toastService.js';
import { fetchEnterprises, fetchAllMembers, fetchBanks, fetchTransactionTypes } from '../../services/dataService.js';

let _excelJS = null;
async function loadExcelJS() {
    if (!_excelJS) {
        const mod = await import('exceljs');
        _excelJS = mod.default || mod;
    }
    return _excelJS;
}

function downloadBlob(buffer, filename) {
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function memberFullName(member) {
    return member?.name || [member?.first_name, member?.middle_name, member?.last_name]
        .filter(Boolean).join(' ') || '';
}

function excelCellText(value) {
    if (value instanceof Date) return formatDateForInput(value);
    if (value && typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
        if (value.text !== undefined) return String(value.text);
        if (value.result !== undefined) return String(value.result);
    }
    return String(value ?? '').trim();
}

function excelDateText(value, fallback) {
    if (value instanceof Date) return formatDateForInput(value);
    if (typeof value === 'number' && value > 0) {
        const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
        if (!Number.isNaN(date.getTime())) return formatDateForInput(date);
    }
    return excelCellText(value) || fallback;
}

async function downloadVariedDepositTemplate(members) {
    const ExcelJS = await loadExcelJS();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Varied Deposits');
    sheet.getCell('A1').value = 'COOPLOG-BULK-VARIED';
    sheet.getCell('A2').value = '000000';
    sheet.getRow(1).hidden = true;
    sheet.getRow(2).hidden = true;
    sheet.mergeCells('A3:H3');
    sheet.getCell('A3').value = 'BULK VARIED DEPOSIT TEMPLATE — ADD OR DUPLICATE ROWS AS NEEDED';
    sheet.getCell('A3').font = { bold: true, size: 14 };
    sheet.getCell('A3').alignment = { horizontal: 'center' };
    ['Full Name', 'Registration No', 'Mobile', 'Special ID', 'Amount', 'Date', 'Bank', 'Description'].forEach((header, index) => {
        const cell = sheet.getRow(4).getCell(index + 1);
        cell.value = header;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
    });
    const activeMembers = (members || []).filter(m => m && m.id !== '0000000000');
    activeMembers.forEach((m, index) => {
        const row = sheet.getRow(index + 5);
        row.values = [memberFullName(m), m.registration_no || '', m.mobile || '', m.special_id || '', '', formatDateForInput(new Date()), '', ''];
        row.getCell(5).numFmt = '#,##0.00';
    });
    for (let index = activeMembers.length; index < 1000; index++) {
        const row = sheet.getRow(index + 5);
        row.values = ['', '', '', '', '', formatDateForInput(new Date()), '', ''];
        row.getCell(5).numFmt = '#,##0.00';
    }
    sheet.autoFilter = {
        from: 'A4',
        to: 'H1004'
    };
    sheet.columns = [{ width: 28 }, { width: 20 }, { width: 18 }, { width: 20 }, { width: 16 }, { width: 14 }, { width: 22 }, { width: 34 }];
    for (let rowNumber = 5; rowNumber <= 1004; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        for (let column = 1; column <= 4; column++) row.getCell(column).protection = { locked: true };
        for (let column = 5; column <= 8; column++) row.getCell(column).protection = { locked: false };
    }
    await sheet.protect('000000', {
        selectLockedCells: false,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
        insertRows: false,
        deleteRows: false,
        sort: false,
        autoFilter: true
    });
    downloadBlob(await workbook.xlsx.writeBuffer(), `Bulk_Varied_Deposit_Template_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export async function renderBulkRemittance(container, user) {
    if (!user || user.role === 'member') {
        container.innerHTML = '<div class="alert">Access Restricted: Members cannot use Bulk Remittance.</div>';
        return;
    }
    const isActualAdmin = hasPermission(user.permissions, 'admin') || (user.username || '').toLowerCase() === 'admin';
    const isAdmin = isActualAdmin || user.isAdmin || hasPermission(user.permissions, 'read_member');
    container.innerHTML = '<div style="padding: 2rem; color: var(--text-muted);">Loading Bulk Remittance...</div>';
    try {
        const loadData = Promise.all([
            fetchEnterprises(user.cooperativeId, true, true),
            fetchAllMembers(user.cooperativeId, user.username, isAdmin),
            fetchBanks(user.cooperativeId),
            fetchTransactionTypes(user.cooperativeId)
        ]);
        let timeoutId;
        const [enterpriseData, members, banks, transactionTypes] = await Promise.race([
            loadData,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Loading took too long. Check that the app is responsive, then try again.')), 30000);
            })
        ]).finally(() => clearTimeout(timeoutId));
        const selectorMembers = !isActualAdmin && isAdmin
            ? await fetchAllMembers(user.cooperativeId, user.username, false)
            : members;
        const historyState = { cooperativeId: user.cooperativeId, banks: banks || [], transactionTypes: (transactionTypes || []).filter(t => t.is_active), members: members || [], membersMap: {} };
        (members || []).forEach(m => { historyState.membersMap[m.id] = m; });
        showBulkRemittanceModal({
            enterpriseData: enterpriseData || [],
            selectorMembers: selectorMembers || [],
            user,
            historyState,
            loadHistoryData: async () => {},
            standalone: true,
            hostContainer: container
        });
    } catch (error) {
        container.innerHTML = `<div class="alert">Unable to load Bulk Remittance: ${escapeHtml(error.message || 'An unexpected error occurred.')} <button type="button" data-action="retry-bulk-remittance" style="margin-left: 0.75rem;">Try again</button></div>`;
        container.querySelector('[data-action="retry-bulk-remittance"]')?.addEventListener('click', () => renderBulkRemittance(container, user));
    }
}

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
    let variedRows = pickable.map(m => ({ key: String(m.id), memberId: String(m.id), amount: '', date: today, bank: '', desc: '' }));
    const isTransferDir = () => direction === 'transfer' || direction === 'one_to_many' || direction === 'one_to_one' || direction === 'to_admin';
    const showMultiList = () => direction !== 'one_to_one';
    const showFromSingle = () => direction === 'one_to_many' || direction === 'one_to_one';
    const showToSingle = () => direction === 'transfer' || direction === 'one_to_one';
    let checkedIds = new Set(pickable.map(m => String(m.id)));
    let searchTerm = '';
    const draftKey = getBulkRemittanceDraftId({ cooperativeId: user.cooperativeId, userId: user.id || user.username });
    let draftSaveTimer = null;
    let draftRestored = false;

    const draftSnapshot = () => ({
        direction,
        selectedEntId,
        selectedCreditEntId,
        selectedFundingEntId,
        selectedTxType,
        toMemberId,
        fromMemberId,
        checkedIds: [...checkedIds],
        rowAmounts,
        variedRows,
        date: overlay?.querySelector?.('#bulk-date')?.value || today,
        bank: overlay?.querySelector?.('#bulk-bank')?.value || '',
        desc: overlay?.querySelector?.('#bulk-desc')?.value || '',
        amount: overlay?.querySelector?.('#bulk-amount')?.value || '0'
    });
    const scheduleDraftSave = () => {
        if (draftRestored || direction !== 'deposit_varied') return;
        clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => saveBulkRemittanceDraft(draftKey, {
            cooperative_id: user.cooperativeId,
            user_id: user.id || user.username,
            payload: draftSnapshot()
        }).catch(err => console.warn('[Bulk] draft save failed:', err?.message)), 250);
    };

    const overlay = document.createElement('div');
    overlay.id = 'bulk-remit-modal';
    overlay.className = deps.standalone ? 'bulk-remittance-page' : 'modal-overlay open';
    overlay.style.cssText = deps.standalone
        ? 'position: relative; width: 100%; height: 100%; min-height: 100dvh; background: var(--bg-main); display: flex; align-items: stretch; justify-content: stretch; padding: 0; box-sizing: border-box; overflow: hidden;'
        : 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center;';

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
            out.push({ id: generateId(String(user.cooperativeId)), name: 'Interest', value: Math.abs(parseFloat(ent.interest_rate) || 0), type: ent.interest_is_percent ? 'percentage' : 'fixed' });
        }
        if (ent.form_fee !== undefined && ent.form_fee !== null && ent.form_fee !== '') {
            out.push({ id: generateId(String(user.cooperativeId)), name: 'Form Fee', value: Math.abs(parseFloat(ent.form_fee) || 0), type: ent.form_fee_is_percent ? 'percentage' : 'fixed' });
        }
        if (ent.admin_charge !== undefined && ent.admin_charge !== null && ent.admin_charge !== '') {
            out.push({ id: generateId(String(user.cooperativeId)), name: 'Admin Charge', value: Math.abs(parseFloat(ent.admin_charge) || 0), type: ent.admin_charge_is_percent ? 'percentage' : 'fixed' });
        }
        return out;
    };
    let charges = defaultCharges();
    const bankOptions = banks.map(b => `<option value="${escapeHtml(b.bank_name || b.id)}">${escapeHtml(b.bank_name || b.id)}</option>`).join('');

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
        if (varied) {
            return list.map(m => {
                const id = String(m.id);
                const label = [m.name, m.registration_no || m.mobile].filter(Boolean).join(' / ');
                const rows = variedRows.filter(r => r.memberId === id);
                return rows.map((entry, index) => `<div class="bulk-varied-row">
                    <input type="checkbox" class="bulk-member-chk bulk-varied-chk bulk-select-checkbox" value="${escapeHtml(id)}" data-row-key="${escapeHtml(entry.key)}" ${checkedIds.has(id) ? 'checked' : ''} aria-label="Select ${escapeHtml(label)}">
                    <span class="bulk-member-name">${escapeHtml(label)}${index ? ` <small>(${index + 1})</small>` : ''}</span>
                    <input type="number" step="0.01" min="0" class="bulk-amt-input" data-row-key="${escapeHtml(entry.key)}" value="${entry.amount || ''}" placeholder="0.00" aria-label="Amount">
                    <input type="date" class="bulk-row-date" data-row-key="${escapeHtml(entry.key)}" value="${escapeHtml(entry.date || today)}" aria-label="Date">
                    <select class="bulk-row-bank" data-row-key="${escapeHtml(entry.key)}" aria-label="Bank">
                        <option value="">Select bank</option>
                        ${entry.bank && !banks.some(b => String(b.bank_name || b.id) === String(entry.bank)) ? `<option value="${escapeHtml(entry.bank)}" selected>${escapeHtml(entry.bank)}</option>` : ''}
                        ${banks.map(b => { const value = String(b.bank_name || b.id); return `<option value="${escapeHtml(value)}" ${value === String(entry.bank || '') ? 'selected' : ''}>${escapeHtml(value)}</option>`; }).join('')}
                    </select>
                    <input type="text" class="bulk-row-desc" data-row-key="${escapeHtml(entry.key)}" value="${escapeHtml(entry.desc || '')}" placeholder="Description" aria-label="Description">
                    <button type="button" class="bulk-duplicate-row" data-member-id="${escapeHtml(id)}" title="Add another row for this member" aria-label="Duplicate row">＋</button>
                </div>`).join('');
            }).join('');
        }
        return list.map(m => {
            const id = String(m.id);
            const label = [m.name, m.registration_no || m.mobile].filter(Boolean).join(' / ');
            return `<label style="display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.5rem; border-radius: var(--radius-sm); cursor: pointer; font-size: 0.85rem;" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
                <input type="checkbox" class="bulk-member-chk bulk-select-checkbox" value="${escapeHtml(id)}" ${checkedIds.has(id) ? 'checked' : ''} aria-label="Select ${escapeHtml(label)}">
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
            variedRows.forEach(row => {
                if (!checkedIds.has(row.memberId)) return;
                const v = parseFloat(row.amount || 0) || 0;
                if (v > 0) { n++; sum += v; }
            });
            el.innerHTML = `<strong>${n}</strong> row${n === 1 ? '' : 's'} with amounts = <strong>${formatCurrency(sum)}</strong>`;
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
      ${deps.standalone ? `<style>
        .bulk-page-shell { color: var(--text-primary); height: 100%; min-height: 100dvh; overflow: hidden; }
        .bulk-page-shell .bulk-topbar { padding: 1.35rem clamp(1rem, 3vw, 2.5rem); background: linear-gradient(135deg, var(--bg-card), var(--bg-secondary)); border-bottom: 1px solid var(--border-light); display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
        .bulk-page-shell .bulk-title { display: flex; align-items: flex-start; gap: .85rem; }
        .bulk-page-shell .bulk-title-mark { width: 2.6rem; height: 2.6rem; display: grid; place-items: center; border-radius: .8rem; background: color-mix(in srgb, var(--accent-primary) 16%, transparent); color: var(--accent-primary); font-size: 1.25rem; font-weight: 800; }
        .bulk-page-shell .bulk-topbar h3 { margin: 0; font-size: 1.2rem; letter-spacing: -.02em; }
        .bulk-page-shell .bulk-topbar p { margin: .25rem 0 0; color: var(--text-muted); font-size: .8rem; }
        .bulk-page-shell .bulk-save-badge { display: inline-flex; align-items: center; gap: .4rem; padding: .4rem .65rem; border: 1px solid var(--border-light); border-radius: 999px; color: var(--text-muted); font-size: .72rem; background: var(--bg-card); white-space: nowrap; }
        .bulk-page-shell .bulk-save-dot { width: .42rem; height: .42rem; border-radius: 50%; background: #22c55e; }
        .bulk-page-shell #bulk-body { background: var(--bg-main); min-height: 0; }
        .bulk-page-shell .bulk-section { width: min(100%, 1180px); margin: 0 auto; }
        .bulk-page-shell .bulk-settings-card, .bulk-page-shell .bulk-members-card { background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 1rem; box-shadow: 0 8px 28px rgba(15, 23, 42, .06); }
        .bulk-page-shell .bulk-settings-card { padding: clamp(1rem, 2vw, 1.4rem); }
        .bulk-page-shell .bulk-section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
        .bulk-page-shell .bulk-section-heading h4 { margin: 0; font-size: .95rem; }
        .bulk-page-shell .bulk-section-heading p { margin: .25rem 0 0; color: var(--text-muted); font-size: .78rem; }
        .bulk-page-shell .bulk-settings-grid { display: grid; grid-template-columns: minmax(180px, 1.15fr) minmax(160px, 1fr) minmax(160px, 1fr) minmax(190px, 1.2fr); gap: 1rem; align-items: start; }
        .bulk-page-shell .bulk-settings-card .field { min-width: 0; min-height: 0; margin: 0 !important; position: relative; display: flex; flex-direction: column; align-items: stretch; gap: .42rem; }
        .bulk-page-shell .bulk-settings-card .field > label { position: static !important; inset: auto !important; transform: none !important; display: block; width: auto; margin: 0; padding: 0 !important; background: transparent !important; color: var(--text-muted); font-size: .7rem; line-height: 1.2; font-weight: 800; text-transform: uppercase; letter-spacing: .055em; pointer-events: auto; }
        .bulk-page-shell .bulk-settings-card .field > input:not([type="checkbox"]), .bulk-page-shell .bulk-settings-card .field > select { box-sizing: border-box; display: block; width: 100% !important; min-width: 0; height: 2.75rem !important; min-height: 2.75rem !important; margin: 0; padding: .65rem .8rem !important; border: 1px solid var(--border-medium); border-radius: .65rem; background: var(--bg-input); color: var(--text-primary); font-size: .86rem; line-height: 1.2; }
        .bulk-page-shell .bulk-settings-card .field > input[type="date"] { padding-right: 2.35rem !important; }
        .bulk-page-shell .bulk-description-field { margin: 1rem 0 0 !important; }
        .bulk-page-shell .bulk-description-field > input { width: 100% !important; }
        .bulk-page-shell .bulk-apply-toggle { position: static !important; top: auto !important; left: auto !important; transform: none !important; display: inline-flex; align-items: center; gap: .4rem; width: auto !important; height: auto !important; margin-top: .42rem; padding: 0 !important; border: 0 !important; border-radius: 0 !important; background: transparent !important; color: var(--text-muted); font-size: .7rem; font-weight: 650; line-height: 1.1; text-transform: none; letter-spacing: 0; white-space: nowrap; pointer-events: auto !important; }
        .bulk-page-shell .bulk-inline-checkbox { appearance: none; -webkit-appearance: none; position: relative; display: inline-grid; place-items: center; width: .95rem !important; height: .95rem !important; min-width: .95rem; min-height: .95rem !important; margin: 0; padding: 0 !important; border: 1.5px solid var(--border-medium); border-radius: .28rem; background: var(--bg-input); cursor: pointer; }
        .bulk-page-shell .bulk-inline-checkbox:hover { border-color: var(--accent-primary); }
        .bulk-page-shell .bulk-inline-checkbox:checked { border-color: var(--accent-primary); background: var(--accent-primary); }
        .bulk-page-shell .bulk-inline-checkbox:checked::after { content: ''; width: .28rem; height: .5rem; border: solid #fff; border-width: 0 1.5px 1.5px 0; transform: translateY(-.05rem) rotate(45deg); }
        .bulk-page-shell .bulk-inline-checkbox:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent-primary) 28%, transparent); outline-offset: 2px; }
        .bulk-page-shell .bulk-apply-toggle.is-active { color: var(--accent-primary); }
        .bulk-page-shell #bulk-charges-wrap { margin-top: .8rem; padding-top: .8rem; border-top: 1px solid var(--border-light); }
        .bulk-page-shell #bulk-multi-wrap { width: min(100%, 1180px); margin: 0 auto; }
        .bulk-page-shell .bulk-members-card { overflow: hidden; }
        .bulk-page-shell .bulk-members-toolbar { padding: 1rem 1.1rem; display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; border-bottom: 1px solid var(--border-light); }
        .bulk-page-shell .bulk-members-toolbar input { flex: 1 1 240px; padding: 0 .8rem; }
        .bulk-page-shell .bulk-toolbar-btn { min-height: 2.35rem; padding: 0 .8rem; border: 1px solid var(--border-medium); border-radius: .6rem; background: var(--bg-card); color: var(--text-primary); font-size: .75rem; font-weight: 700; cursor: pointer; }
        .bulk-page-shell .bulk-toolbar-btn:hover { border-color: var(--accent-primary); color: var(--accent-primary); background: var(--bg-secondary); }
        .bulk-page-shell .bulk-toolbar-btn:disabled { opacity: .5; cursor: not-allowed; border-color: var(--border-light); color: var(--text-muted); background: var(--bg-secondary); }
        .bulk-page-shell .bulk-toolbar-btn:disabled:hover { border-color: var(--border-light); color: var(--text-muted); background: var(--bg-secondary); }
        .bulk-page-shell .bulk-toolbar-link { border: 0; background: transparent; color: var(--accent-primary); font-size: .75rem; font-weight: 700; cursor: pointer; padding: .45rem .2rem; }
        .bulk-page-shell .bulk-toolbar-link.muted { color: var(--text-muted); }
        .bulk-page-shell .bulk-table-head, .bulk-page-shell .bulk-varied-row { display: grid; grid-template-columns: 24px minmax(190px, 1.5fr) minmax(110px, .75fr) minmax(135px, .8fr) minmax(140px, .9fr) minmax(180px, 1.25fr) 28px; gap: .55rem; align-items: center; }
        .bulk-page-shell .bulk-table-head { padding: .65rem .85rem; color: var(--text-muted); background: var(--bg-secondary); font-size: .68rem; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
        .bulk-page-shell .bulk-varied-row { padding: .62rem .85rem; border-bottom: 1px solid var(--border-light); }
        .bulk-page-shell .bulk-varied-row:last-child { border-bottom: 0; }
        .bulk-page-shell .bulk-varied-row:hover { background: color-mix(in srgb, var(--accent-primary) 4%, transparent); }
        .bulk-page-shell .bulk-varied-row input, .bulk-page-shell .bulk-varied-row select { width: 100%; min-width: 0; min-height: 2.25rem; padding: 0 .55rem; border: 1px solid var(--border-light); border-radius: .55rem; background: var(--bg-input); color: var(--text-primary); font-size: .78rem; }
        .bulk-page-shell .bulk-varied-row .bulk-row-date { padding-right: 2rem; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2364748b'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5v14z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right .55rem center; background-size: 1rem; cursor: pointer; }
        .bulk-page-shell .bulk-varied-row .bulk-row-bank { padding-right: 1.8rem; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2364748b'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right .45rem center; background-size: .9rem; }
        .bulk-page-shell .bulk-varied-row input:disabled, .bulk-page-shell .bulk-varied-row select:disabled { opacity: .5; cursor: not-allowed; background: var(--bg-secondary); }
        .bulk-page-shell .bulk-varied-row input:focus, .bulk-page-shell .bulk-members-toolbar input:focus { outline: 2px solid color-mix(in srgb, var(--accent-primary) 25%, transparent); border-color: var(--accent-primary); }
        .bulk-page-shell .bulk-varied-row input[type=checkbox] { width: 1rem; min-height: 1rem; accent-color: var(--accent-primary); }
        .bulk-page-shell .bulk-select-checkbox { appearance: none; -webkit-appearance: none; position: relative; display: inline-grid; place-items: center; width: 1.25rem !important; height: 1.25rem; min-width: 1.25rem; min-height: 1.25rem !important; margin: 0; padding: 0 !important; border: 1.5px solid var(--border-medium); border-radius: .38rem; background: var(--bg-input); color: #fff; cursor: pointer; transition: background .16s ease, border-color .16s ease, box-shadow .16s ease, transform .12s ease; }
        .bulk-page-shell .bulk-select-checkbox:hover { border-color: var(--accent-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 12%, transparent); }
        .bulk-page-shell .bulk-select-checkbox:active { transform: scale(.92); }
        .bulk-page-shell .bulk-select-checkbox:checked { border-color: var(--accent-primary); background: var(--accent-primary); box-shadow: 0 3px 8px color-mix(in srgb, var(--accent-primary) 25%, transparent); }
        .bulk-page-shell .bulk-select-checkbox:checked::after { content: ''; width: .38rem; height: .68rem; border: solid #fff; border-width: 0 2px 2px 0; transform: translateY(-.08rem) rotate(45deg); }
        .bulk-page-shell .bulk-select-checkbox:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-primary) 28%, transparent); outline-offset: 2px; }
        .bulk-page-shell .bulk-varied-row:has(.bulk-select-checkbox:checked) { background: color-mix(in srgb, var(--accent-primary) 5%, transparent); }
        .bulk-page-shell .bulk-member-name { font-size: .8rem; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .bulk-page-shell .bulk-member-name small { color: var(--text-muted); font-weight: 500; }
        .bulk-page-shell .bulk-duplicate-row { border: 0; background: transparent; color: var(--accent-primary); font-size: 1.2rem; cursor: pointer; border-radius: .4rem; }
        .bulk-page-shell .bulk-duplicate-row:hover { background: var(--bg-secondary); }
        .bulk-page-shell #bulk-member-list { max-height: min(52vh, 620px); border: 0; border-radius: 0; padding: 0; }
        .bulk-page-shell .bulk-count-line { padding: .8rem 1rem; background: var(--bg-secondary); color: var(--text-muted); font-size: .78rem; }
        .bulk-page-shell .bulk-bottom-bar { flex: 0 0 auto; min-height: 4.7rem; padding: .85rem clamp(1rem, 3vw, 2.5rem) !important; background: color-mix(in srgb, var(--bg-card) 96%, var(--accent-primary)); border-top: 1px solid var(--border-light); box-shadow: 0 -10px 26px rgba(15, 23, 42, .12); position: sticky; bottom: 0; z-index: 10; }
        .bulk-page-shell .bulk-bottom-note { display: inline-flex; align-items: center; gap: .6rem; max-width: 42rem; font-size: .76rem; line-height: 1.35; color: var(--text-muted); }
        .bulk-page-shell .bulk-bottom-note-icon { display: inline-grid; place-items: center; flex: 0 0 auto; width: 1.55rem; height: 1.55rem; border: 1px solid color-mix(in srgb, var(--accent-primary) 25%, var(--border-light)); border-radius: 50%; color: var(--accent-primary); font-size: .72rem; font-weight: 800; }
        .bulk-page-shell .bulk-bottom-actions { display: flex; align-items: center; gap: .65rem; flex: 0 0 auto; }
        .bulk-page-shell .bulk-bottom-actions #bulk-create { min-width: 10.5rem; min-height: 2.65rem; border-radius: .7rem; font-weight: 800; box-shadow: 0 5px 14px color-mix(in srgb, var(--accent-primary) 22%, transparent); }
        @media (max-width: 900px) { .bulk-page-shell .bulk-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .bulk-page-shell .bulk-table-head, .bulk-page-shell .bulk-varied-row { grid-template-columns: 24px minmax(150px, 1.2fr) 100px 125px 130px minmax(130px, 1fr) 28px; } }
        @media (min-width: 681px) { .bulk-page-shell #bulk-body { display: grid !important; grid-template-columns: minmax(320px, .85fr) minmax(0, 1.35fr); align-items: start; gap: 1.25rem; } .bulk-page-shell #bulk-panel-tabs { display: none !important; } .bulk-page-shell #bulk-multi-wrap { min-width: 0; width: 100%; margin: 0; } }
        @media (max-width: 680px) { .bulk-page-shell #bulk-body { display: flex !important; } .bulk-page-shell #bulk-panel-tabs { display: flex; gap: .5rem; position: sticky; top: -1px; z-index: 2; padding: .35rem; border: 1px solid var(--border-light); border-radius: .75rem; background: var(--bg-card); } .bulk-page-shell #bulk-panel-tabs button { flex: 1; min-height: 2.6rem; border: 0; border-radius: .55rem; background: transparent; color: var(--text-muted); font-weight: 750; cursor: pointer; } .bulk-page-shell #bulk-panel-tabs button[aria-selected="true"] { background: var(--accent-primary); color: #fff; } .bulk-page-shell #bulk-body[data-mobile-panel="setup"] #bulk-multi-wrap, .bulk-page-shell #bulk-body[data-mobile-panel="members"] .bulk-settings-card { display: none !important; } .bulk-page-shell .bulk-settings-grid { grid-template-columns: 1fr; } .bulk-page-shell .bulk-table-head { display: none; } .bulk-page-shell .bulk-varied-row { grid-template-columns: 24px 1fr 1fr 1fr; gap: .45rem; padding: .8rem; } .bulk-page-shell .bulk-member-name { grid-column: 2 / -1; } .bulk-page-shell .bulk-row-desc { grid-column: 2 / -1; } .bulk-page-shell .bulk-duplicate-row { grid-column: 1; grid-row: 3; } .bulk-page-shell .bulk-bottom-bar { flex-direction: column; align-items: stretch !important; } .bulk-page-shell .bulk-bottom-bar > div { justify-content: stretch; } .bulk-page-shell .bulk-bottom-bar button { flex: 1; } }
      </style>` : ''}
      <div class="${deps.standalone ? 'bulk-page-shell' : 'modal-content'}" style="${deps.standalone ? 'width: 100%; min-height: 100%; display: flex; flex-direction: column; background: var(--bg-main);' : 'max-width: 640px; width: 94%; max-height: 92vh; display: flex; flex-direction: column; background: var(--bg-card); border-radius: var(--radius-md); box-shadow: var(--shadow-xl);'}">
        <div class="${deps.standalone ? 'bulk-topbar' : ''}" style="${deps.standalone ? '' : 'display: flex; justify-content: space-between; align-items: center; padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--border-light);'}">
          <div class="${deps.standalone ? 'bulk-title' : ''}">
            ${deps.standalone ? '<div class="bulk-title-mark">↗</div>' : ''}
            <div><h3>Bulk Remittance</h3>${deps.standalone ? '<p>Create many member remittances with one controlled workflow.</p>' : ''}</div>
          </div>
          ${deps.standalone ? '<div class="bulk-save-badge"><span class="bulk-save-dot"></span> Draft saves automatically</div>' : ''}
          ${deps.standalone ? '' : '<button type="button" id="bulk-close" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>'}
        </div>
        <div id="bulk-body" style="padding: ${deps.standalone ? '1.5rem clamp(1rem, 3vw, 2.5rem)' : '1.1rem 1.25rem'}; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; flex: 1;">
          ${deps.standalone ? '<div id="bulk-panel-tabs" role="tablist" aria-label="Bulk remittance panels"><button type="button" role="tab" data-bulk-panel="setup" aria-selected="true">Remittance setup</button><button type="button" role="tab" data-bulk-panel="members" aria-selected="false">Members</button></div>' : ''}
          <section class="bulk-section bulk-settings-card">
            <div class="bulk-section-heading"><div><h4>Remittance setup</h4><p>Choose the transaction type and shared details for this batch.</p></div><span class="bulk-save-badge">Step 1 of 2</span></div>
          <div class="bulk-settings-grid">
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
            <div class="field" id="bulk-enterprise-wrap"><label id="bulk-ent-label">Enterprise</label>
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
              <span id="bulk-apply-amount-wrap" class="bulk-apply-toggle" style="display: none;"><input id="bulk-apply-amount" class="bulk-inline-checkbox" type="checkbox"><span>Apply to all rows</span></span>
            </div>
            <div class="field"><label>Date</label>
              <input id="bulk-date" type="date" value="${today}">
              <span id="bulk-apply-date-wrap" class="bulk-apply-toggle" style="display: none;"><input id="bulk-apply-date" class="bulk-inline-checkbox" type="checkbox"><span>Apply to all rows</span></span>
            </div>
            <div class="field"><label>Bank</label>
              <select id="bulk-bank">
                <option value="">-- Select --</option>
                ${bankOptions}
              </select>
              <span id="bulk-apply-bank-wrap" class="bulk-apply-toggle" style="display: none;"><input id="bulk-apply-bank" class="bulk-inline-checkbox" type="checkbox"><span>Apply to all rows</span></span>
            </div>
            <div class="field" id="bulk-duration-wrap"><label>Duration (months)</label>
              <input id="bulk-duration" type="number" step="1" min="1" value="12">
            </div>
          </div>
          <div class="field bulk-description-field"><label>Note / Description</label>
            <input id="bulk-desc" type="text" placeholder="e.g. March group loans">
            <span id="bulk-apply-desc-wrap" class="bulk-apply-toggle" style="display: none;"><input id="bulk-apply-desc" class="bulk-inline-checkbox" type="checkbox"><span>Apply to all rows</span></span>
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
          </section>
          <div id="bulk-multi-wrap">
            <div class="bulk-members-card">
            <div class="bulk-section-heading" style="padding: 1rem 1.1rem 0; margin-bottom: 0;"><div><h4 id="bulk-from-label">Members</h4><p>Review each member’s amount before creating remittances.</p></div><span class="bulk-save-badge">Step 2 of 2</span></div>
            <div class="bulk-members-toolbar">
              <input id="bulk-member-search" type="text" placeholder="Search by name, registration, mobile or special ID...">
              <button type="button" id="bulk-template-btn" class="bulk-toolbar-btn" style="display: none;" disabled aria-disabled="true" title="Excel export is temporarily unavailable">Export template</button>
              <button type="button" id="bulk-import-btn" class="bulk-toolbar-btn" style="display: none;" disabled aria-disabled="true" title="Excel import is temporarily unavailable">Import Excel</button>
              <input type="file" id="bulk-import-file" accept=".xlsx" style="display: none;">
              <button type="button" id="bulk-select-all" class="bulk-toolbar-link">Select all</button>
              <button type="button" id="bulk-clear-all" class="bulk-toolbar-link muted">Clear</button>
            </div>
            <div id="bulk-varied-head" class="bulk-table-head" style="display: none;"><span></span><span>Member</span><span>Amount</span><span>Date</span><span>Bank</span><span>Description</span><span></span></div>
            <div id="bulk-member-list" style="max-height: ${deps.standalone ? 'min(52vh, 620px)' : '220px'}; overflow: auto; border: 1px solid var(--border-light); border-radius: var(--radius-sm); padding: 0.4rem;"></div>
            <div id="bulk-count-line" class="bulk-count-line" style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-muted);"></div>
            </div>
          </div>
        </div>
        <div class="${deps.standalone ? 'bulk-bottom-bar' : ''}" style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding: 1rem ${deps.standalone ? 'clamp(1rem, 3vw, 2.5rem)' : '1.25rem'}; border-top: 1px solid var(--border-light);">
          <span class="bulk-bottom-note" style="font-size: 0.75rem; color: var(--text-muted);">${deps.standalone ? '<span class="bulk-bottom-note-icon">i</span>' : ''}<span>Guarantors skipped in bulk. Each member gets an independent remittance.</span></span>
          <div class="${deps.standalone ? 'bulk-bottom-actions' : ''}" style="display: flex; gap: 0.6rem;">
            ${deps.standalone ? '' : '<button type="button" id="bulk-cancel" class="btn btn-secondary">Cancel</button>'}
            <button type="button" id="bulk-create" class="btn btn-primary">Review &amp; Create</button>
          </div>
        </div>
      </div>
    `;
    (deps.hostContainer || document.body).appendChild(overlay);
    const close = () => {
        if (direction === 'deposit_varied') {
            saveBulkRemittanceDraft(draftKey, { cooperative_id: user.cooperativeId, user_id: user.id || user.username, payload: draftSnapshot() }).catch(() => {});
        }
        overlay.remove();
    };
    overlay.querySelector('#bulk-close')?.addEventListener('click', close);
    overlay.querySelector('#bulk-cancel')?.addEventListener('click', close);
    const bulkBody = overlay.querySelector('#bulk-body');
    overlay.querySelectorAll('[data-bulk-panel]').forEach(tab => tab.addEventListener('click', () => {
        const panel = tab.dataset.bulkPanel;
        bulkBody.dataset.mobilePanel = panel;
        overlay.querySelectorAll('[data-bulk-panel]').forEach(item => item.setAttribute('aria-selected', String(item === tab)));
    }));

    const applyOverrideState = () => {
        const fieldMap = { amount: '.bulk-amt-input', date: '.bulk-row-date', bank: '.bulk-row-bank', desc: '.bulk-row-desc' };
        Object.entries(fieldMap).forEach(([field, selector]) => {
            const checked = overlay.querySelector(`#bulk-apply-${field}`)?.checked === true;
            const sharedValue = field === 'amount'
                ? (overlay.querySelector('#bulk-amount')?.value || '')
                : field === 'date'
                    ? (overlay.querySelector('#bulk-date')?.value || '')
                    : field === 'bank'
                        ? (overlay.querySelector('#bulk-bank')?.value || '')
                        : (overlay.querySelector('#bulk-desc')?.value || '');
            overlay.querySelectorAll(`#bulk-member-list ${selector}`).forEach(input => {
                input.disabled = checked;
                input.setAttribute('aria-disabled', checked ? 'true' : 'false');
                if (checked) input.value = sharedValue;
            });
            const wrap = overlay.querySelector(`#bulk-apply-${field}-wrap`);
            if (wrap) wrap.classList.toggle('is-active', checked);
        });
    };
    const paintMembers = () => {
        overlay.querySelector('#bulk-member-list').innerHTML = memberRows();
        overlay.querySelectorAll('.bulk-member-chk').forEach(chk => {
            chk.addEventListener('change', () => {
                if (chk.checked) checkedIds.add(chk.value);
                else checkedIds.delete(chk.value);
                refreshCounts();
                scheduleDraftSave();
            });
        });
        const term = searchTerm.trim().toLowerCase();
        const visible = pickable.filter(m => !term
            || String(m.registration_no || '').toLowerCase().includes(term)
            || String(m.name || '').toLowerCase().includes(term)
            || String(m.special_id || '').toLowerCase().includes(term)
            || String(m.mobile || '').includes(term));
        overlay.querySelector('#bulk-select-all').textContent = visible.length && visible.every(m => checkedIds.has(String(m.id)))
            ? 'Deselect all' : 'Select all';
        applyOverrideState();
    };
    const syncDirectionUI = () => {
        refreshEntOptions();
        const list = entListFor();
        overlay.querySelector('#bulk-enterprise').innerHTML = entOptions(list, selectedEntId);
        overlay.querySelector('#bulk-enterprise-wrap').style.display = direction === 'deposit_varied' ? 'none' : 'flex';
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
        const variedHead = overlay.querySelector('#bulk-varied-head');
        if (variedHead) variedHead.style.display = direction === 'deposit_varied' ? 'grid' : 'none';
        overlay.querySelector('#bulk-amount-wrap').style.display = 'flex';
        ['amount', 'date', 'bank', 'desc'].forEach(field => {
            const wrap = overlay.querySelector(`#bulk-apply-${field}-wrap`);
            if (wrap) wrap.style.display = direction === 'deposit_varied' ? 'inline-flex' : 'none';
        });
        overlay.querySelector('#bulk-import-btn').style.display = direction === 'deposit_varied' ? 'block' : 'none';
        overlay.querySelector('#bulk-template-btn').style.display = direction === 'deposit_varied' ? 'block' : 'none';
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
    overlay.querySelector('#bulk-template-btn').addEventListener('click', () => downloadVariedDepositTemplate(pickable).catch(err => showToast(`Template export failed: ${err.message}`, 'error')));
    overlay.querySelector('#bulk-import-btn').addEventListener('click', () => overlay.querySelector('#bulk-import-file').click());
    overlay.querySelector('#bulk-import-file').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const ExcelJS = await loadExcelJS();
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(file);
            const sheet = workbook.worksheets[0];
            if (sheet.getCell('A1').value !== 'COOPLOG-BULK-VARIED' || String(sheet.getCell('A2').value) !== '000000') throw new Error('This is not a valid CoopLog varied-deposit template.');
            const headers = ['Full Name', 'Registration No', 'Mobile', 'Special ID', 'Amount', 'Date', 'Bank', 'Description'];
            const actual = headers.map((_, i) => String(sheet.getRow(4).getCell(i + 1).value || '').trim());
            if (actual.some((v, i) => v !== headers[i])) throw new Error('The template columns do not match the required format.');
            const byField = (field) => new Map(pickable.filter(m => m[field] !== undefined && m[field] !== '').map(m => [String(m[field]).trim().toLowerCase(), m]));
            const bySpecial = byField('special_id');
            const byReg = byField('registration_no');
            const byMobile = byField('mobile');
            let imported = 0;
            const errors = [];
            sheet.eachRow((row, rowNumber) => {
                if (rowNumber < 5) return;
                const fullName = excelCellText(row.getCell(1).value);
                const reg = excelCellText(row.getCell(2).value);
                const mobile = excelCellText(row.getCell(3).value);
                const special = excelCellText(row.getCell(4).value);
                const amount = parseFloat(excelCellText(row.getCell(5).value)) || 0;
                const importedDate = excelDateText(row.getCell(6).value, today);
                const importedBank = excelCellText(row.getCell(7).value);
                const importedDesc = excelCellText(row.getCell(8).value);
                if (!fullName && !reg && !mobile && !special && !amount && !importedBank && !importedDesc) return;
                const member = (special && bySpecial.get(special.toLowerCase())) || (reg && byReg.get(reg.toLowerCase())) || (mobile && byMobile.get(mobile.toLowerCase()));
                if (!member) { errors.push(`Row ${rowNumber}: member identity was not found.`); return; }
                const entry = { key: `${member.id}-import-${rowNumber}`, memberId: String(member.id), amount: amount || '', date: importedDate, bank: importedBank, desc: importedDesc };
                variedRows.push(entry);
                checkedIds.add(String(member.id));
                if (amount > 0) imported++;
            });
            paintMembers();
            refreshCounts();
            scheduleDraftSave();
            showToast(`Imported ${imported} amount${imported === 1 ? '' : 's'}.${errors.length ? ` ${errors.length} row${errors.length === 1 ? '' : 's'} skipped.` : ''}`, errors.length ? 'warning' : 'success');
        } catch (err) {
            showToast(`Excel import failed: ${err.message}`, 'error');
        } finally {
            event.target.value = '';
        }
    });
    overlay.querySelector('#bulk-amount').addEventListener('input', () => { applyOverrideState(); refreshCounts(); scheduleDraftSave(); });
    ['#bulk-date', '#bulk-bank', '#bulk-desc'].forEach(selector => {
        const field = overlay.querySelector(selector);
        field.addEventListener('input', () => { applyOverrideState(); scheduleDraftSave(); });
        field.addEventListener('change', () => { applyOverrideState(); scheduleDraftSave(); });
    });
    ['amount', 'date', 'bank', 'desc'].forEach(field => {
        overlay.querySelector(`#bulk-apply-${field}`)?.addEventListener('change', (event) => {
            if (event.currentTarget.checked) applyOverrideState();
            else paintMembers();
            scheduleDraftSave();
        });
    });
    overlay.querySelector('#bulk-date')?.addEventListener('click', (event) => {
        try { event.currentTarget.showPicker?.(); } catch (e) { /* browser may already have opened it */ }
    });
    overlay.querySelector('#bulk-member-search').addEventListener('input', (e) => {
        searchTerm = e.target.value || '';
        paintMembers();
    });
    // Varied-amount rows: typing an amount auto-checks the member
    overlay.querySelector('#bulk-member-list').addEventListener('input', (e) => {
        const inp = e.target.closest?.('.bulk-amt-input');
        const rowKey = inp?.dataset.rowKey;
        if (rowKey) {
            const row = variedRows.find(r => r.key === rowKey);
            if (row) row.amount = parseFloat(inp.value || 0) || '';
            if (row?.amount > 0) checkedIds.add(row.memberId);
            refreshCounts();
            scheduleDraftSave();
            return;
        }
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
        scheduleDraftSave();
    });
    overlay.querySelector('#bulk-select-all').addEventListener('click', () => {
        const term = searchTerm.trim().toLowerCase();
        const visible = pickable.filter(m => {
            if (!term || String(m.registration_no || '').toLowerCase().includes(term)
                || String(m.name || '').toLowerCase().includes(term)
                || String(m.special_id || '').toLowerCase().includes(term)
                || String(m.mobile || '').includes(term)) return true;
            return false;
        });
        const allSelected = visible.length > 0 && visible.every(m => checkedIds.has(String(m.id)));
        visible.forEach(m => allSelected ? checkedIds.delete(String(m.id)) : checkedIds.add(String(m.id)));
        overlay.querySelector('#bulk-select-all').textContent = allSelected ? 'Select all' : 'Deselect all';
        paintMembers();
        refreshCounts();
        scheduleDraftSave();
    });
    overlay.querySelector('#bulk-member-list').addEventListener('change', (e) => {
        const field = e.target.closest?.('.bulk-row-date, .bulk-row-bank, .bulk-row-desc');
        if (!field) return;
        const row = variedRows.find(r => r.key === field.dataset.rowKey);
        if (row) row[field.classList.contains('bulk-row-date') ? 'date' : field.classList.contains('bulk-row-bank') ? 'bank' : 'desc'] = field.value;
        scheduleDraftSave();
    });
    overlay.querySelector('#bulk-member-list').addEventListener('click', (e) => {
        const dateInput = e.target.closest?.('.bulk-row-date');
        if (dateInput && !dateInput.disabled) {
            try { dateInput.showPicker?.(); } catch (err) { /* native picker may already be open */ }
            return;
        }
        const button = e.target.closest?.('.bulk-duplicate-row');
        if (!button) return;
        const source = variedRows.find(r => r.memberId === String(button.dataset.memberId));
        if (!source) return;
        variedRows.push({ key: `${source.memberId}-duplicate-${Date.now()}-${variedRows.length}`, memberId: source.memberId, amount: '', date: today, bank: '', desc: '' });
        paintMembers();
        refreshCounts();
        scheduleDraftSave();
    });
    overlay.querySelector('#bulk-clear-all').addEventListener('click', () => {
        checkedIds.clear();
        rowAmounts = {};
        variedRows = pickable.map(m => ({ key: String(m.id), memberId: String(m.id), amount: '', date: today, bank: '', desc: '' }));
        paintMembers();
        refreshCounts();
        scheduleDraftSave();
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

    loadBulkRemittanceDraft(draftKey).then(draft => {
        const p = draft?.payload;
        if (!p || p.direction !== 'deposit_varied') return;
        draftRestored = true;
        direction = 'deposit_varied';
        selectedEntId = p.selectedEntId || selectedEntId;
        selectedCreditEntId = p.selectedCreditEntId || selectedCreditEntId;
        selectedFundingEntId = p.selectedFundingEntId || selectedFundingEntId;
        selectedTxType = p.selectedTxType || selectedTxType;
        toMemberId = p.toMemberId || '';
        fromMemberId = p.fromMemberId || '';
        checkedIds = new Set((p.checkedIds || []).map(String));
        rowAmounts = p.rowAmounts || {};
        if (Array.isArray(p.variedRows) && p.variedRows.length) variedRows = p.variedRows;
        else variedRows = variedRows.map(row => ({ ...row, amount: p.rowAmounts?.[row.memberId] || '' }));
        overlay.querySelector('#bulk-direction').value = direction;
        overlay.querySelector('#bulk-date').value = p.date || today;
        overlay.querySelector('#bulk-bank').value = p.bank || '';
        overlay.querySelector('#bulk-desc').value = p.desc || '';
        overlay.querySelector('#bulk-amount').value = p.amount || '0';
        syncDirectionUI();
        draftRestored = false;
        showToast('Your unfinished varied deposit was restored.', 'info');
    }).catch(() => {});

    overlay.querySelector('#bulk-create').addEventListener('click', async () => {
        const amount = Math.abs(parseFloat(overlay.querySelector('#bulk-amount').value || 0) || 0);
        const date = overlay.querySelector('#bulk-date').value || today;
        const bank = overlay.querySelector('#bulk-bank').value || '';
        const desc = overlay.querySelector('#bulk-desc').value.trim();
        const applyAmount = overlay.querySelector('#bulk-apply-amount')?.checked === true;
        const applyDate = overlay.querySelector('#bulk-apply-date')?.checked === true;
        const applyBank = overlay.querySelector('#bulk-apply-bank')?.checked === true;
        const applyDesc = overlay.querySelector('#bulk-apply-desc')?.checked === true;
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
            variedList = variedRows
                .filter(row => checkedIds.has(row.memberId))
                .map(row => ({
                    id: row.memberId,
                    amt: applyAmount ? amount : (parseFloat(row.amount || 0) || 0),
                    date: applyDate ? date : row.date,
                    bank: applyBank ? bank : row.bank,
                    desc: applyDesc ? desc : row.desc,
                    rowKey: row.key
                }))
                .filter(x => x.amt > 0);
        }

        if (!isVaried && !ent) { showToast('Select an enterprise.', 'error'); return; }
        if (!isVaried && !(amount > 0)) { showToast('Enter an amount greater than zero.', 'error'); return; }
        if (!isVaried && !bank) { showToast('Select a bank.', 'error'); return; }
        if (direction === 'loan' && !(duration > 0)) { showToast('Enter loan duration in months.', 'error'); return; }
        if (!memberIds.length) { showToast('Select at least one member.', 'error'); return; }
        if (isVaried && applyAmount && !(amount > 0)) { showToast('Enter a shared amount greater than zero.', 'error'); return; }
        if (isVaried && applyDate && !date) { showToast('Select the shared date.', 'error'); return; }
        if (isVaried && applyBank && !bank) { showToast('Select the shared cooperative bank.', 'error'); return; }
        if (isVaried && !variedList.length) { showToast('Enter an amount for at least one member.', 'error'); return; }
        if (isVaried) {
            const incomplete = variedList.find(row => !row.date || !row.bank);
            if (incomplete) { showToast('Every varied-deposit row must have an amount, date, and bank before proceeding.', 'error'); return; }
        }
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
        const progressCancelBtn = overlay.querySelector('#bulk-cancel');
        if (progressCancelBtn) progressCancelBtn.disabled = true;

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
            : isVaried ? variedList.map(x => ({ mid: x.id, amt: x.amt, date: x.date, bank: x.bank, desc: x.desc, rowKey: x.rowKey }))
            : memberIds.map(mid => ({ mid, amt: amount }));
        const debitIsLoan = isTransferDir() && getAccountType(ent) === 'loan';
        const successes = [];
        const failures = [];
        const coopId = user.cooperativeId;
        const autoShareEnterprises = (enterpriseData || []).filter(x => !(x.is_deleted === 1 || x.deleted === 1));
        const autoShareDetailsFor = async (memberId, remittanceAmount) => {
            const adviceRows = await fetchMemberPaymentAdvise(memberId).catch(() => []);
            const adviceByEnterprise = {};
            (adviceRows || []).forEach(row => {
                if (!row.is_deleted && row.enterprise_id && parseFloat(row.amount) > 0) adviceByEnterprise[String(row.enterprise_id)] = parseFloat(row.amount);
            });
            const allocation = allocateAutoShare({
                remittanceAmount,
                enterprises: autoShareEnterprises,
                adviceByEnterprise,
                member: pickable.find(m => String(m.id) === String(memberId))
            });
            return allocation.allocations.filter(a => parseFloat(a.allocatedAmount) > 0).map(a => ({
                id: generateId(String(coopId)),
                enterprise_id: String(a.enterpriseId),
                amount: parseFloat(a.allocatedAmount),
                auto_description: 'Auto Share allocation (priority-based, version v1)',
                notes: `Auto Share: allocated at priority ${a.priority || 0}`
            }));
        };
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
            const rowDate = isVaried ? u.date : date;
            const rowBank = isVaried ? u.bank : bank;
            const rowDesc = isVaried ? (u.desc || desc) : desc;
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
                            remittance_date: rowDate,
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
                        remittance_date: rowDate,
                        bank_name: rowBank,
                        transaction_type: 'Member Loan',
                        description: rowDesc,
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
                                remittance_date: rowDate,
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
                        remittance_date: rowDate,
                        bank_name: rowBank,
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
                            remittance_date: rowDate,
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
                            remittance_date: rowDate,
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
                    const depositDetails = isVaried
                        ? await autoShareDetailsFor(mid, Math.abs(curAmt))
                        : [{ id: generateId(String(coopId)), enterprise_id: ent.id, amount: Math.abs(curAmt) }];
                    await addRemittance({
                        id: parentRemId,
                        cooperative_id: coopId,
                        member_id: mid,
                        amount: Math.abs(curAmt),
                        remittance_date: rowDate,
                        bank_name: rowBank,
                        transaction_type: 'Member Deposit',
                        description: rowDesc,
                        status,
                        user_role: user.role || 'member',
                        user_roles: [user.role || 'member'],
                        loan_status: status === 'Approved' ? 'Active' : 'Pending',
                        details: depositDetails
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
                                remittance_date: rowDate,
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
                        remittance_date: rowDate,
                        bank_name: 'Internal Transfer',
                        transaction_type: 'Internal Transfer',
                        description: rowDesc || `Bulk ${kindLabel} Charge (${ent.account_name || ent.id})`,
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
        createBtn.onclick = async () => {
            if (!deps.standalone) overlay.remove();
            try { await loadHistoryData(true); } catch (e) {}
            if (deps.standalone && deps.hostContainer) renderBulkRemittance(deps.hostContainer, user);
        };
        const finalCancelBtn = overlay.querySelector('#bulk-cancel');
        if (finalCancelBtn) finalCancelBtn.disabled = false;
        try { await loadHistoryData(true); } catch (e) {}
        if (!failures.length && isVaried) await clearBulkRemittanceDraft(draftKey);
        if (!failures.length) showToast(`Bulk complete: ${successes.length} remittances created.`, 'success');
        else showToast(`Bulk complete: ${successes.length} created, ${failures.length} failed.`, 'warning');
    }
}
