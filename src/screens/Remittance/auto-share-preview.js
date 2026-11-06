import { escapeHtml, formatCurrency } from '../../utils/formatters.js';

function showAutoSharePreview(preview, memberId, cooperativeId, deps) {
  const { formData, user, clearForm } = deps;
  const totalUnits = Math.max(0, Math.round((Number(formData.amount) || Number(preview.totalRemittance) || 0) * 100));
  const rows = (preview.rows || []).map(row => ({
    ...row,
    amountUnits: Math.max(0, Math.round((Number(row.allocatedAmount) || 0) * 100))
  }));
  const money = units => formatCurrency(units / 100);
  const formatInputAmount = units => (units / 100).toFixed(2).replace(/\.?0+$/, '');
  const modalId = 'auto-share-preview-modal';
  document.getElementById(modalId)?.remove();

  const modalContainer = document.createElement('div');
  modalContainer.id = modalId;
  modalContainer.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999999;display:flex;align-items:center;justify-content:center;padding:1rem;';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg-card);border-radius:var(--radius-md);width:min(96%,900px);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow-xl);';

  const tableRows = rows.map((row, index) => {
    const statusLabel = row.status || 'Allocated';
    const statusColor = statusLabel.toLowerCase().includes('allocated') ? 'var(--success,#16803c)' : '#fff';
    return `
    <tr class="auto-share-preview-row" data-index="${index}" style="border-bottom:1px solid var(--border-light);${row.amountUnits === 0 ? 'display:none;' : ''}">
      <td style="padding:.55rem;font-size:.85rem;">${escapeHtml(row.enterpriseName || 'Enterprise')}</td>
      <td style="padding:.55rem;text-align:center;font-size:.8rem;">${Number(row.priority) || 0}</td>
      <td style="padding:.55rem;text-align:right;font-size:.8rem;white-space:nowrap;">${money(Math.round((Number(row.requiredAmount) || 0) * 100))}</td>
      <td style="padding:.4rem;text-align:right;"><input type="number" min="0" step="0.01" inputmode="decimal" class="auto-share-amount" data-index="${index}" value="${formatInputAmount(row.amountUnits)}" style="width:145px;max-width:100%;padding:.5rem;border:1px solid var(--border-medium);border-radius:6px;background:var(--bg-input);color:var(--text-primary);text-align:right;"></td>
      <td style="padding:.55rem;text-align:center;font-size:.75rem;color:${statusColor};font-weight:600;">${escapeHtml(statusLabel)}</td>
    </tr>`;
  }).join('');
  const warningItems = (preview.warnings || []).map(w => `<li style="margin:.25rem 0;font-size:.8rem;">${escapeHtml(w?.message || String(w))}</li>`).join('');

  modal.innerHTML = `
    <div style="padding:1.25rem 1.5rem 0;overflow-y:auto;flex:1 1 auto;min-height:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:.75rem;">
        <h3 style="margin:0;">Auto Share Allocation Preview</h3>
        <button type="button" class="close-preview-btn" aria-label="Close" style="background:transparent;border:0;font-size:1.5rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <p style="margin:.4rem 0;font-size:.88rem;color:var(--text-muted);">Remittance amount: <strong id="auto-share-remittance-total">${money(totalUnits)}</strong></p>
      <p style="margin:.4rem 0;font-size:.88rem;color:var(--text-muted);">Detail total: <strong id="auto-share-detail-total">${money(rows.reduce((sum, row) => sum + row.amountUnits, 0))}</strong></p>
      <p style="margin:.4rem 0 .8rem;font-size:.88rem;color:var(--text-muted);">Unallocated balance: <strong id="auto-share-unallocated">${money(Math.max(0, totalUnits - rows.reduce((sum, row) => sum + row.amountUnits, 0)))}</strong></p>
      <p style="margin:.4rem 0;font-size:.8rem;color:var(--text-muted);">Edit any allocation; the remaining row is automatically balanced so the details always equal the remittance.</p>
      ${rows.length ? `<label style="display:flex;align-items:center;gap:.45rem;margin:.6rem 0;font-size:.82rem;color:var(--text-muted);"><input type="checkbox" id="auto-share-show-zeroes"> Show zero allocations</label><div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;margin:.5rem 0 1rem;">
        <thead><tr style="background:var(--bg-header);"><th style="padding:.55rem;text-align:left;font-size:.75rem;">Enterprise</th><th style="padding:.55rem;text-align:center;font-size:.75rem;">Priority</th><th style="padding:.55rem;text-align:right;font-size:.75rem;">Required</th><th style="padding:.55rem;text-align:right;font-size:.75rem;">Allocated (editable)</th><th style="padding:.55rem;text-align:center;font-size:.75rem;">Status</th></tr></thead>
        <tbody>${tableRows}</tbody></table></div>` : '<p style="margin:1rem 0;color:var(--danger);">No eligible enterprise is available. Add an eligible enterprise before confirming this remittance.</p>'}
      ${warningItems ? `<div style="margin:1rem 0;padding:.75rem;background:var(--bg-warning);border-radius:var(--radius-sm);border:1px solid var(--border-light);"><strong style="font-size:.83rem;">Allocation notes</strong><ul style="margin:.5rem 0 0 1rem;padding:0;">${warningItems}</ul></div>` : ''}
    </div>
    <div style="display:flex;gap:.75rem;padding:1rem 1.5rem;border-top:1px solid var(--border-light);background:var(--bg-card);">
      <button type="button" id="confirm-auto-share" class="btn btn-primary" style="flex:1;min-height:44px;font-size:.95rem;" ${rows.length ? '' : 'disabled'}>Confirm Allocation</button>
      <button type="button" id="cancel-auto-share" class="btn btn-secondary" style="flex:1;min-height:44px;font-size:.95rem;">Cancel</button>
    </div>`;

  modalContainer.appendChild(modal);
  document.body.appendChild(modalContainer);
  const close = () => modalContainer.remove();
  const zeroToggle = modal.querySelector('#auto-share-show-zeroes');
  const updateZeroVisibility = () => {
    const showZeros = !!zeroToggle?.checked;
    modal.querySelectorAll('.auto-share-preview-row').forEach(rowElement => {
      const row = rows[Number(rowElement.dataset.index)];
      const isBeingEdited = rowElement.contains(document.activeElement);
      rowElement.style.display = row?.amountUnits === 0 && !showZeros && !isBeingEdited ? 'none' : '';
    });
  };
  zeroToggle?.addEventListener('change', updateZeroVisibility);
  modal.querySelector('.close-preview-btn').addEventListener('click', close);
  modal.querySelector('#cancel-auto-share').addEventListener('click', close);
  setTimeout(() => modal.querySelector('.close-preview-btn')?.focus(), 100);

  const renderTotals = () => {
    const allocatedUnits = rows.reduce((sum, row) => sum + row.amountUnits, 0);
    const remaining = totalUnits - allocatedUnits;
    const detailTotalEl = modal.querySelector('#auto-share-detail-total');
    const remainingEl = modal.querySelector('#auto-share-unallocated');
    detailTotalEl.textContent = money(allocatedUnits);
    remainingEl.textContent = money(Math.max(0, remaining));
    detailTotalEl.style.color = remaining === 0 ? 'var(--success)' : 'var(--danger)';
    const confirmButton = modal.querySelector('#confirm-auto-share');
    confirmButton.disabled = rows.length === 0 || remaining !== 0 || rows.some(row => row.amountUnits < 0);
  };

  modal.querySelectorAll('.auto-share-amount').forEach(input => {
    input.addEventListener('focus', updateZeroVisibility);
    input.addEventListener('blur', updateZeroVisibility);
    input.addEventListener('input', () => {
      const editedIndex = Number(input.dataset.index);
      const enteredAmount = Number(input.value);
      const requestedUnits = Math.max(0, Math.round((Number.isFinite(enteredAmount) ? enteredAmount : 0) * 100));
      let editedUnits = requestedUnits;
      const otherIndexes = rows.map((_, i) => i).filter(i => i !== editedIndex);
      if (otherIndexes.length === 0) {
        editedUnits = totalUnits;
      } else {
        const balanceIndex = otherIndexes[otherIndexes.length - 1];
        const fixedUnits = otherIndexes.filter(i => i !== balanceIndex).reduce((sum, i) => sum + rows[i].amountUnits, 0);
        editedUnits = Math.min(editedUnits, Math.max(0, totalUnits - fixedUnits));
        rows[editedIndex].amountUnits = editedUnits;
        rows[balanceIndex].amountUnits = totalUnits - fixedUnits - editedUnits;
        const balancingInput = modal.querySelector(`.auto-share-amount[data-index="${balanceIndex}"]`);
        if (balancingInput && balancingInput !== document.activeElement) balancingInput.value = formatInputAmount(rows[balanceIndex].amountUnits);
      }
      rows[editedIndex].amountUnits = editedUnits;
      if (editedUnits !== requestedUnits || (Number.isFinite(enteredAmount) && Math.abs(enteredAmount - editedUnits / 100) > 1e-8)) {
        input.value = formatInputAmount(editedUnits);
      }
      renderTotals();
      updateZeroVisibility();
    });
  });
  renderTotals();

  modal.querySelector('#confirm-auto-share').addEventListener('click', async () => {
    const allocatedUnits = rows.reduce((sum, row) => sum + row.amountUnits, 0);
    if (allocatedUnits !== totalUnits || rows.some(row => row.amountUnits < 0)) {
      renderTotals();
      deps.showToast?.('Allocation details must equal the remittance amount.', 'error');
      return;
    }
    const confirmButton = modal.querySelector('#confirm-auto-share');
    confirmButton.disabled = true;
    confirmButton.textContent = 'Saving...';
    try {
      const result = await deps.confirmAutoShare({
        cooperativeId,
        memberId,
        remittanceAmount: totalUnits / 100,
        allocations: rows.filter(row => row.amountUnits > 0).map(row => ({
          enterprise_id: row.enterpriseId,
          allocated_amount: (row.amountUnits / 100).toFixed(2),
          priority: row.priority
        })),
        remittanceDate: formData.remittance_date,
        bankName: formData.bank_name,
        description: formData.description || 'Auto Share Remittance',
        createdBy: user.username || 'system',
        canApprove: deps.canApprove === true
      });
      close();
      const statusMessage = result.status === 'Approved' ? 'approved' : 'submitted for approval';
      (deps.showToast || (() => {}))(`Auto Share ${statusMessage}. Remittance ID: ${result.remittanceId}`, 'success');
      formData.autoShareTriggered = false;
      clearForm();
    } catch (err) {
      deps.showToast?.(`Error confirming Auto Share: ${err.message}`, 'error');
      console.error('[autoShare] Confirm error:', err);
      confirmButton.disabled = false;
      confirmButton.textContent = 'Confirm Allocation';
    }
  });
}

export { showAutoSharePreview };
