import { fetchEnterprises, addEnterprise, updateEnterprise, deleteEnterprise } from '../../services/dataService.js';
import { showToast } from '../../services/toastService.js';
import { queryRows } from '../../services/sqliteService.js';
import { escapeHtml } from '../../utils/formatters.js';

export function renderEnterpriseSection(area) {
  area.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem;">
        <div>
          <h3 style="margin:0;">Enterprise Accounts</h3>
          <p class="section-desc" style="margin: 0.35rem 0 0 0;">Configure the enterprise accounts used in remittance distribution.</p>
        </div>
        <button id="show-add-ent-btn" class="primary-button" style="padding: 0.6rem 1.5rem; font-size: 0.85rem; border-radius: var(--radius-md); width: ${window.innerWidth < 1000 ? '100%' : 'auto'};">+ Add Account</button>
      </div>
      <div id="ent-table-container" class="table-responsive"><p style="color: var(--text-muted); font-style: italic;">Loading enterprise accounts...</p></div>
    `;
}

export function setupEnterpriseListeners(user, cooperativeId) {
  let editingEnt = null;

  const showEntForm = (ent = null) => {
    editingEnt = ent;
    const overlay = document.createElement('div');
    overlay.className = 'settings-modal-overlay';
    overlay.innerHTML = `
        <div class="settings-modal-content">
          <div class="modal-header">
            <div>
              <h3>${ent ? 'Edit Enterprise Account' : 'Add Enterprise Account'}</h3>
              <p class="modal-sub">${ent ? `Update <strong>${escapeHtml(ent.account_name || '')}</strong> and how it behaves in remittance.` : 'Create a savings or loan account used in remittance distribution.'}</p>
            </div>
            <button id="close-modal-x" style="background:var(--bg-secondary); border:1px solid var(--border-light); color:var(--text-muted); font-size:1.1rem; cursor:pointer; width:32px; height:32px; border-radius:50%; flex-shrink:0; line-height:1;">&times;</button>
          </div>
          <div class="modal-body">
            <div class="stg-section">
              <div class="stg-section-title">Basic Information</div>
              <div class="stg-grid">
                <div class="field">
                  <span>Account Name *</span>
                  <input type="text" id="ent-name-input" value="${escapeHtml(ent?.account_name || '')}" placeholder="e.g. Savings Account" required>
                </div>
                <div class="field">
                  <span>Account Type *</span>
                  <select id="ent-type-input">
                    <option value="Savings" ${(ent?.account_type || '') === 'Savings' ? 'selected' : ''}>Savings</option>
                    <option value="Loan" ${(ent?.account_type || '') === 'Loan' ? 'selected' : ''}>Loan</option>
                  </select>
                  <div class="stg-helper">Loan accounts support multipliers and interest on loans.</div>
                </div>
              </div>
            </div>
            <div class="stg-section">
              <div class="stg-section-title">Charges &amp; Interest</div>
              <div class="stg-grid">
                <div class="field">
                  <span>Interest Rate</span>
                  <div class="input-with-toggle">
                    <input type="number" step="0.01" id="ent-interest-input" value="${ent?.interest_rate ?? 0}" min="0">
                    <label class="input-toggle-wrap">
                      <input type="checkbox" id="ent-interest-percent" ${ent?.interest_is_percent ? 'checked' : ''}> %
                    </label>
                  </div>
                  <div class="stg-helper">Tick % for percentage, else flat amount.</div>
                </div>
                <div class="field">
                  <span>Loan Multiplier</span>
                  <input type="number" step="0.01" id="ent-multiplier-input" value="${ent?.loan_multiplier ?? 0}" min="0">
                  <div class="stg-helper">e.g. 2 means member can borrow 2x savings.</div>
                </div>
                <div class="field">
                  <span>Form Fee</span>
                  <div class="input-with-toggle">
                    <input type="number" step="0.01" id="ent-formfee-input" value="${ent?.form_fee ?? 0}" min="0">
                    <label class="input-toggle-wrap">
                      <input type="checkbox" id="ent-formfee-percent" ${ent?.form_fee_is_percent ? 'checked' : ''}> %
                    </label>
                  </div>
                </div>
                <div class="field">
                  <span>Admin Charge</span>
                  <div class="input-with-toggle">
                    <input type="number" step="0.01" id="ent-admin-input" value="${ent?.admin_charge ?? 0}" min="0">
                    <label class="input-toggle-wrap">
                      <input type="checkbox" id="ent-admin-percent" ${ent?.admin_charge_is_percent ? 'checked' : ''}> %
                    </label>
                  </div>
                </div>
              </div>
            </div>
            <div class="stg-section">
              <div class="stg-section-title">Distribution &amp; Rules</div>
              <div class="stg-grid" style="margin-bottom: 1rem;">
                <div class="field">
                  <span>Distribution Priority</span>
                  <input type="number" id="ent-priority-input" value="${ent?.distribution_priority ?? 0}" min="0">
                  <div class="stg-helper">Lower numbers are settled first.</div>
                </div>
                <div class="field">
                  <span>Auto remainder (Savings %)</span>
                  <input type="number" step="0.01" id="ent-auto-rem-input" value="${ent?.auto_rem ?? 0}" min="0" max="100" ${(ent?.account_type || 'Savings').toLowerCase() !== 'savings' ? 'disabled' : ''}>
                  <div class="stg-helper">Savings accounts only. Used to split any balance left after advice allocations.</div>
                </div>
                <div class="field">
                  <span>Compulsory Amount</span>
                  <input type="number" step="0.01" id="ent-compulsory-amount" value="${ent?.compulsory_amount ?? 0.00}" min="0">
                </div>
              </div>
              <div style="display:flex; flex-direction:column; gap:0.75rem;">
                <label class="stg-check-card">
                  <input type="checkbox" id="ent-compulsory-due" ${ent?.compulsory_due ? 'checked' : ''}>
                  <div><div class="stg-check-title">Compulsory due account</div><div class="stg-check-desc">Every member must contribute to this account each cycle.</div></div>
                </label>
                <label class="stg-check-card">
                  <input type="checkbox" id="ent-revenue" ${ent?.revenue ? 'checked' : ''}>
                  <div><div class="stg-check-title">Classify as Revenue</div><div class="stg-check-desc">Count collections here as cooperative income.</div></div>
                </label>
                <label class="stg-check-card">
                  <input type="checkbox" id="ent-is-penalty" ${ent?.is_penalty ? 'checked' : ''}>
                  <div><div class="stg-check-title">Penalty account</div><div class="stg-check-desc">Used for fines and default charges.</div></div>
                </label>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button id="cancel-ent-btn" class="secondary-button" style="padding:0.7rem 1.5rem; border-radius:var(--radius-md);">Cancel</button>
            <button id="save-ent-btn" class="primary-button" style="padding:0.7rem 2rem; border-radius:var(--radius-md);">${ent ? 'Update' : 'Add Account'}</button>
          </div>
        </div>
      `;
    document.body.appendChild(overlay);

    const closeModal = () => { overlay.remove(); editingEnt = null; };
    overlay.querySelector('#close-modal-x').onclick = closeModal;
    overlay.querySelector('#cancel-ent-btn').onclick = closeModal;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    const typeSelect = overlay.querySelector('#ent-type-input');
    const autoRemInput = overlay.querySelector('#ent-auto-rem-input');
    typeSelect.addEventListener('change', () => {
      const isSavings = typeSelect.value.toLowerCase() === 'savings';
      autoRemInput.disabled = !isSavings;
      if (!isSavings) autoRemInput.value = '0';
    });

    overlay.querySelector('#save-ent-btn').addEventListener('click', async () => {
      const name = overlay.querySelector('#ent-name-input').value.trim();
      const type = overlay.querySelector('#ent-type-input').value;
      if (!name || !type) { showToast('Account Name and Type are required.', 'warning'); return; }
      const autoRemValue = parseFloat(autoRemInput.value || 0);
      if (type.toLowerCase() !== 'savings' && autoRemValue > 0) { showToast('Auto remainder can only be set for a Savings account.', 'warning'); return; }
      if (!Number.isFinite(autoRemValue) || autoRemValue < 0 || autoRemValue > 100) { showToast('Savings % must be between 0 and 100.', 'warning'); return; }
      const payload = {
        account_name: name,
        account_type: type,
        auto_rem: type.toLowerCase() === 'savings' ? autoRemValue : 0,
        interest_rate: parseFloat(overlay.querySelector('#ent-interest-input').value || 0),
        interest_is_percent: overlay.querySelector('#ent-interest-percent').checked ? 1 : 0,
        loan_multiplier: parseFloat(overlay.querySelector('#ent-multiplier-input').value || 0),
        form_fee: parseFloat(overlay.querySelector('#ent-formfee-input').value || 0),
        form_fee_is_percent: overlay.querySelector('#ent-formfee-percent').checked ? 1 : 0,
        admin_charge: parseFloat(overlay.querySelector('#ent-admin-input').value || 0),
        admin_charge_is_percent: overlay.querySelector('#ent-admin-percent').checked ? 1 : 0,
        distribution_priority: parseInt(overlay.querySelector('#ent-priority-input').value || 0),
        compulsory_due: overlay.querySelector('#ent-compulsory-due').checked ? 1 : 0,
        compulsory_amount: parseFloat(overlay.querySelector('#ent-compulsory-amount').value || 0),
        revenue: overlay.querySelector('#ent-revenue').checked ? 1 : 0,
        is_penalty: overlay.querySelector('#ent-is-penalty').checked ? 1 : 0,
        cooperative_id: cooperativeId
      };
      const saveBtn = overlay.querySelector('#save-ent-btn');
      if (!saveBtn) return;
      try {
        saveBtn.disabled = true; saveBtn.innerText = 'Saving...';
        if (editingEnt) {
          await updateEnterprise(editingEnt.id, payload, user.username);
        } else {
          await addEnterprise(payload, user.username);
        }
        closeModal();
        loadEnterprises();
      } catch (err) { showToast('Error: ' + err.message, 'error'); saveBtn.disabled = false; saveBtn.innerText = editingEnt ? 'Update' : 'Add Account'; }
    });
  };

  const fmtRate = (val, isPercent) => {
    if (val === undefined || val === null || val === '' || val === 0) return '—';
    return isPercent ? `${parseFloat(val).toFixed(2)}%` : `₦${parseFloat(val).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  };

  const loadEnterprises = async () => {
    const tc = document.getElementById('ent-table-container');
    if (!tc) return;
    try {
      const ents = await fetchEnterprises(cooperativeId, true);
      const active = ents.filter(e => !e.is_deleted || e.is_deleted === 0);
      if (active.length === 0) {
        tc.innerHTML = '<p style="color: var(--text-muted); font-style: italic;">No enterprise accounts registered yet.</p>';
        return;
      }
      // Sort by priority
      active.sort((a, b) => (a.distribution_priority || 0) - (b.distribution_priority || 0));
      // Fetch enterprises currently in use by remittance details
      const inUseDetails = await queryRows('SELECT DISTINCT enterprise_id FROM remittance_detail WHERE cooperative_id = ? AND is_deleted = 0 AND amount != 0', [cooperativeId]);
      const usedEntIds = new Set(inUseDetails.map(d => d.enterprise_id));

      tc.innerHTML = `
          <div style="overflow-x: auto;">
          <table class="crud-table">
            <thead><tr>
              <th>Priority</th><th>Account Name</th><th>Type</th><th>Savings %</th><th>Interest</th><th>Form Fee</th><th>Admin Charge</th><th style="width: 120px;">Actions</th>
            </tr></thead>
            <tbody>
              ${active.map(e => {
                const isInUse = usedEntIds.has(e.id);
                return `
                    <tr>
                      <td>${e.distribution_priority || 0}</td>
                      <td style="font-weight: 600;">${escapeHtml(e.account_name || e.id)} ${isInUse ? '<span style="font-size: 0.7rem; color: var(--text-muted); font-style: italic; margin-left: 0.5rem;">(In Use)</span>' : ''}</td>
                      <td><span style="padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; background: ${(e.account_type || '').toLowerCase() === 'loan' ? 'var(--warning-bg)' : 'var(--success-bg)'}; color: ${(e.account_type || '').toLowerCase() === 'loan' ? 'var(--warning)' : 'var(--success)'};">${e.account_type || '—'}</span></td>
                      <td>${(e.account_type || '').toLowerCase() === 'savings' && Number(e.auto_rem) > 0 ? `${Number(e.auto_rem).toLocaleString('en-NG', { maximumFractionDigits: 2 })}%` : '—'}</td>
                      <td>${fmtRate(e.interest_rate, e.interest_is_percent)}</td>
                      <td>${fmtRate(e.form_fee, e.form_fee_is_percent)}</td>
                      <td>${fmtRate(e.admin_charge, e.admin_charge_is_percent)}</td>
                      <td>
                        <button class="crud-action-btn edit" data-id="${e.id}">Edit</button>
                        ${!isInUse ? `
                            <button class="crud-action-btn delete" data-id="${e.id}" data-name="${escapeHtml(e.account_name || e.id)}">Delete</button>
                          ` : '<span style="font-size: 0.75rem; color: var(--text-muted); font-style:italic;">Delete Locked</span>'}
                      </td>
                    </tr>
                  `;
              }).join('')}
            </tbody>
          </table>
          </div>
        `;
      tc.querySelectorAll('.crud-action-btn.edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const ent = active.find(e => e.id === btn.dataset.id);
          if (ent) showEntForm(ent);
        });
      });
      tc.querySelectorAll('.crud-action-btn.delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Delete enterprise "${btn.dataset.name}"? This cannot be undone.`)) return;
          try {
            await deleteEnterprise(btn.dataset.id, cooperativeId, user.username);
            loadEnterprises();
          } catch (err) { showToast(err.message, 'error'); }
        });
      });
    } catch (err) {
      tc.innerHTML = `<p style="color: var(--danger);">Error loading accounts: ${err.message}</p>`;
    }
  };

  document.getElementById('show-add-ent-btn')?.addEventListener('click', () => showEntForm());
  loadEnterprises();
}
