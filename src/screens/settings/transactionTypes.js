import { getTransactionTypes, createTransactionType, updateTransactionType, deleteTransactionType, isTransactionTypeUsed, queryRows } from '../../services/sqliteService.js';
import { showToast } from '../../services/toastService.js';
import { escapeHtml } from '../../utils/formatters.js';
import { CLASSIFICATION_OPTIONS } from '../../utils/constants.js';

function classificationBadgeStyle(classification) {
    const incomeColors = 'background: var(--accent-soft); color: var(--accent-primary);';
    const expenseColors = 'background: var(--danger-bg); color: var(--danger);';
    const assetColors = 'background: #e0f2fe; color: #0369a1;';
    const liabilityColors = 'background: #fef3c7; color: #b45309;';
    const equityColors = 'background: #d1fae5; color: #065f46;';
    const transferColors = 'background: #f3e8ff; color: #7c3aed;';
    const suspenseColors = 'background: #f5f5f4; color: #78716c;';

    if (classification === 'Operating Income' || classification === 'Loan Income' || classification === 'Other Income') return incomeColors;
    if (classification === 'Operating Expense' || classification === 'Administrative Expense' || classification === 'Finance Expense' || classification === 'Welfare Expense' || classification === 'Other Operating Expense' || classification === 'Other Expenses') return expenseColors;
    if (classification === 'Asset' || classification === 'Fixed Asset' || classification === 'General Asset' || classification === 'Loan Asset') return assetColors;
    if (classification === 'Liability' || classification === 'Member Liability') return liabilityColors;
    if (classification === 'Equity') return equityColors;
    if (classification === 'Transfer') return transferColors;
    if (classification === 'Suspense') return suspenseColors;
    return 'background: var(--bg-card); color: var(--text-muted);';
}

function renderClassificationBadge(classification) {
    return `<span style="padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; ${classificationBadgeStyle(classification)}">${escapeHtml(classification)}</span>`;
}

export function renderTransactionTypesSection(area) {
  area.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem;">
        <div>
          <h3 style="margin:0;">Transaction Types</h3>
          <p class="section-desc" style="margin: 0.35rem 0 0 0;">Manage transaction types for remittances and financial tracking.</p>
        </div>
        <button id="show-add-transaction-type-btn" class="primary-button" style="padding: 0.6rem 1.5rem; font-size: 0.85rem; border-radius: var(--radius-md); width: ${window.innerWidth < 1000 ? '100%' : 'auto'};">+ Add Transaction Type</button>
      </div>
      <div id="transaction-type-table-container" class="table-responsive"><p style="color: var(--text-muted); font-style: italic;">Loading transaction types...</p></div>
    `;
}

export async function setupTransactionTypesListeners(user, cooperativeId) {
  let editingTransactionType = null;
  let usedTransactionTypeNames = new Set();

  const showTransactionTypeForm = async (transactionType = null) => {
    editingTransactionType = transactionType;

    let isInUse = false;
    let isSystemDefault = false;
    if (transactionType) {
      isSystemDefault = transactionType.is_system_default === 1 || transactionType.is_system_default === true;
      isInUse = await isTransactionTypeUsed(cooperativeId, transactionType.id);
    }
    const locked = isInUse || isSystemDefault;

    const overlay = document.createElement('div');
    overlay.className = 'settings-modal-overlay';
    overlay.innerHTML = `
        <div class="settings-modal-content" style="max-width: 560px;">
          <div class="modal-header">
            <div>
              <h3>${transactionType ? 'Edit Transaction Type' : 'Add Transaction Type'}</h3>
              <p class="modal-sub">${transactionType ? `Update <strong>${escapeHtml(transactionType.transaction_type || '')}</strong>.` : 'Define a new type used across remittances and ledgers.'}</p>
            </div>
            <button id="close-tt-modal-x" style="background:var(--bg-secondary); border:1px solid var(--border-light); color:var(--text-muted); font-size:1.1rem; cursor:pointer; width:32px; height:32px; border-radius:50%; flex-shrink:0; line-height:1;">&times;</button>
          </div>
          <div class="modal-body">
            ${isSystemDefault ? '<div class="stg-notice muted" style="margin-bottom: 1.25rem;">This is a system default type. It cannot be modified or deleted.</div>' : ''}
            ${(!isSystemDefault && isInUse) ? '<div class="stg-notice muted" style="margin-bottom: 1.25rem;">This type is already used in remittances. Only Active status can be changed.</div>' : ''}
            <div class="stg-section">
              <div class="stg-section-title">Type Details</div>
              <div style="display:flex; flex-direction:column; gap:1rem;">
                <div class="field">
                  <span>Transaction Type Name *</span>
                  <input type="text" id="transaction-type-name-input" value="${escapeHtml(transactionType?.transaction_type || '')}" placeholder="e.g. Monthly Dues" required ${locked ? 'disabled' : ''}>
                </div>
                <div class="field">
                  <span>Classification</span>
                  <select id="transaction-type-classification-input" ${locked ? 'disabled' : ''}>
                    ${CLASSIFICATION_OPTIONS.map(c => `<option value="${c}" ${transactionType?.classification === c ? 'selected' : ''}>${c}</option>`).join('')}
                  </select>
                  <div class="stg-helper">Determines how this type appears in financial reports.</div>
                </div>
              </div>
            </div>
            ${!isSystemDefault ? `
            <div class="stg-section">
              <div class="stg-section-title">Status</div>
              <label class="stg-check-card">
                <input type="checkbox" id="transaction-type-active-input" ${(transactionType?.is_active ?? true) ? 'checked' : ''}>
                <div><div class="stg-check-title">Active</div><div class="stg-check-desc">Inactive types are hidden from new remittances.</div></div>
              </label>
            </div>` : ''}
          </div>
          <div class="modal-footer">
            <button id="cancel-transaction-type-btn" class="secondary-button" style="padding: 0.7rem 1.5rem; border-radius: var(--radius-md);">Cancel</button>
            ${!isSystemDefault ? `<button id="save-transaction-type-btn" class="primary-button" style="padding: 0.7rem 2rem; border-radius: var(--radius-md);">${transactionType ? 'Update' : 'Add Type'}</button>` : ''}
          </div>
        </div>
      `;
    document.body.appendChild(overlay);

    const closeModal = () => { overlay.remove(); editingTransactionType = null; };
    overlay.querySelector('#close-tt-modal-x').onclick = closeModal;
    overlay.querySelector('#cancel-transaction-type-btn')?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#save-transaction-type-btn')?.addEventListener('click', async () => {
      const name = overlay.querySelector('#transaction-type-name-input').value.trim();
      const classification = overlay.querySelector('#transaction-type-classification-input').value;
      const isActive = overlay.querySelector('#transaction-type-active-input')?.checked ?? true;

      if (!name) { showToast('Transaction type name is required.', 'warning'); return; }
      const saveBtn = overlay.querySelector('#save-transaction-type-btn');

      try {
        saveBtn.disabled = true; saveBtn.innerText = 'Saving...';
        if (editingTransactionType) {
          if (isInUse) {
            await updateTransactionType(cooperativeId, editingTransactionType.id, { is_active: isActive ? 1 : 0 }, user.username);
          } else {
            await updateTransactionType(cooperativeId, editingTransactionType.id, { transaction_type: name, classification, is_active: isActive ? 1 : 0 }, user.username);
          }
        } else {
          await createTransactionType(cooperativeId, name, classification, user.username);
        }
        closeModal();
        loadTransactionTypes();
      } catch (err) { showToast('Error: ' + err.message, 'error'); saveBtn.disabled = false; saveBtn.innerText = editingTransactionType ? 'Update' : 'Add Type'; }
    });
  };

  const loadTransactionTypes = async () => {
    const tc = document.getElementById('transaction-type-table-container');
    if (!tc) return;
    try {
      const transactionTypes = await getTransactionTypes(cooperativeId);

      if (transactionTypes.length === 0) {
        tc.innerHTML = '<p style="color: var(--text-muted); font-style: italic;">No transaction types yet.</p>';
        return;
      }

      const inUseRemittances = await queryRows('SELECT DISTINCT transaction_type FROM remittance WHERE cooperative_id = ? AND is_deleted = 0', [cooperativeId]);
      usedTransactionTypeNames = new Set(inUseRemittances.map(r => r.transaction_type?.toLowerCase()));

      const defaults = transactionTypes.filter(t => t.is_system_default === 1 || t.is_system_default === true);
      const custom = transactionTypes.filter(t => t.is_system_default !== 1 && t.is_system_default !== true);

      tc.innerHTML = `
          <table class="crud-table">
            <thead><tr><th>#</th><th>Name</th><th>Classification</th><th>Type</th><th>Active</th><th style="width: 120px;">Actions</th></tr></thead>
            <tbody>
              ${defaults.map((t, i) => `
                  <tr style="opacity: 0.85;">
                    <td>${i + 1}</td>
                    <td>${escapeHtml(t.transaction_type)}</td>
                    <td>${renderClassificationBadge(t.classification)}</td>
                    <td><span style="font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: #e2e8f0; color: #475569;">System Default</span></td>
                    <td>Yes</td>
                    <td><span style="font-size: 0.75rem; color: var(--text-muted);">Read Only</span></td>
                  </tr>
                `).join('')}
              ${custom.map((t, i) => {
                const isInUse = usedTransactionTypeNames.has(t.transaction_type?.toLowerCase());
                const canEdit = !isInUse;
                const showDelete = !isInUse;
                return `
                    <tr>
                      <td>${defaults.length + i + 1}</td>
                      <td>${escapeHtml(t.transaction_type)} ${isInUse ? '<span style="font-size: 0.7rem; color: var(--text-muted); font-style: italic; margin-left: 0.5rem;">(In Use)</span>' : ''}</td>
                      <td>${renderClassificationBadge(t.classification)}</td>
                      <td><span style="font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: #dbeafe; color: #1d4ed8;">Custom</span></td>
                      <td>${t.is_active ? 'Yes' : 'No'}</td>
                      <td>
                        <button class="crud-action-btn edit" data-id="${t.id}" data-name="${escapeHtml(t.transaction_type)}" ${canEdit ? '' : 'disabled style="opacity:0.5; cursor:not-allowed;"'}>Edit</button>
                        ${showDelete ? `<button class="crud-action-btn delete" data-id="${t.id}" data-name="${escapeHtml(t.transaction_type)}">Delete</button>` : ''}
                      </td>
                    </tr>
                  `;
              }).join('')}
            </tbody>
          </table>
        `;

      tc.querySelectorAll('.crud-action-btn.edit:not([disabled])').forEach(btn => {
        const transactionType = transactionTypes.find(t => t.id === btn.dataset.id);
        btn.addEventListener('click', () => showTransactionTypeForm(transactionType));
      });
      tc.querySelectorAll('.crud-action-btn.delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete transaction type "${btn.dataset.name}"? This cannot be undone.`)) return;
          try {
            await deleteTransactionType(cooperativeId, btn.dataset.id, user.username);
            loadTransactionTypes();
          } catch (err) { showToast(err.message, 'error'); }
        });
      });
    } catch (err) {
      tc.innerHTML = `<p style="color: var(--danger);">Error loading transaction types: ${err.message}</p>`;
    }
  };

  document.getElementById('show-add-transaction-type-btn')?.addEventListener('click', () => showTransactionTypeForm());
  await loadTransactionTypes();
}
