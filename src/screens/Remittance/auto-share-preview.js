// Auto Share Preview function for remittancePage.js
// This function should be called from the Auto Share button click handler

function showAutoSharePreview(preview, memberId, cooperativeId, deps) {
  const { formData, user, handleSubmit, clearForm } = deps;
  
  // Create preview modal
  const modalId = 'auto-share-preview-modal';
  let modal = document.getElementById(modalId);
  if (modal) modal.remove();
  
  const modalContainer = document.createElement('div');
  modalContainer.id = modalId;
  modalContainer.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 999999; display: flex; align-items: center; justify-content: center;';
  
  modal = document.createElement('div');
  modal.style.cssText = 'background: var(--bg-card); border-radius: var(--radius-md); width: min(90%, 800px); max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-xl);';
  
  // Build preview table
  let tableHtml = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
      <h3 style="margin: 0;">Auto Share Allocation Preview</h3>
      <button type="button" class="close-preview-btn" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
    </div>
    
    <p style="margin: 0.5rem 0; font-size: 0.85rem; color: var(--text-muted);">
      Total remittance amount: <strong>₦${preview.totalRemittance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
    </p>
    
    <p style="margin: 0.5rem 0; font-size: 0.85rem; color: var(--text-muted);">
      Total allocated: <strong>₦${preview.allocatedTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
    </p>
    
    <p style="margin: 0.5rem 0; font-size: 0.85rem; color: var(--text-muted);">
      Unallocated balance: <strong>₦${preview.remainder.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
    </p>
  `;
  
  // Allocation table
  if (preview.rows.length > 0) {
    tableHtml += `
      <table style="width: 100%; border-collapse: collapse; margin: 1rem 0;">
        <thead>
          <tr style="background: var(--bg-header);">
            <th style="padding: 0.5rem; text-align left; font-size: 0.75rem;">Enterprise</th>
            <th style="padding: 0.5rem; text-align center; font-size: 0.75rem;">Priority</th>
            <th style="padding: 0.5rem; text-align right; font-size: 0.75rem;">Required</th>
            <th style="padding: 0.5rem; text-align right; font-size: 0.75rem;">Allocated</th>
            <th style="padding: 0.5rem; text-align center; font-size: 0.75rem;">Status</th>
          </tr>
        </thead>
        <tbody>
    `;
    
    preview.rows.forEach((row, idx) => {
      const statusColor = row.status === 'Allocated' ? 'var(--success)' : row.status === 'Partially Allocated' ? 'var(--warning)' : 'var(--text-muted)';
      tableHtml += `
        <tr style="border-bottom: 1px solid var(--border-light);">
          <td style="padding: 0.5rem; font-size: 0.85rem;">${row.enterpriseName}</td>
          <td style="padding: 0.5rem; text-align center; font-size: 0.75rem;">${row.priority}</td>
          <td style="padding: 0.5rem; text-align right; font-size: 0.75rem;">₦${row.requiredAmount}</td>
          <td style="padding: 0.5rem; text-align right; font-size: 0.75rem;">₦${row.allocatedAmount}</td>
          <td style="padding: 0.5rem; text-align center; font-size: 0.75rem; color: ${statusColor};">
            ${row.status}
          </td>
        </tr>
      `;
    });
    
    tableHtml += `
          </tbody>
        </table>
      `;
  } else {
    tableHtml += `
      <p style="margin: 1rem 0; color: var(--text-muted);">No eligible enterprises found for allocation.</p>
    `;
  }
  
  // Warnings
  if (preview.warnings && preview.warnings.length > 0) {
    tableHtml += `
      <div style="margin: 1rem 0; padding: 0.75rem; background: var(--bg-warning); border-radius: var(--radius-sm); border: 1px solid var(--border-light);">
        <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">Warnings:</p>
        <ul style="margin: 0.5rem 0 0 1rem; padding: 0;">
    `;
    preview.warnings.forEach(warning => {
      tableHtml += `<li style="margin: 0.25rem 0; font-size: 0.8rem; color: var(--text-primary);">${warning}</li>`;
    });
    tableHtml += `
        </ul>
      </div>
    `;
  }
  
  modal.innerHTML = `
    <div style="padding: 1.5rem 2rem 0; overflow-y: auto; flex: 1 1 auto; min-height: 0;">${tableHtml}</div>
    <div style="position: sticky; bottom: 0; display: flex; gap: 0.75rem; padding: 1rem 2rem; border-top: 1px solid var(--border-light); background: var(--bg-card); flex: 0 0 auto;">
      <button type="button" id="confirm-auto-share" class="btn btn-primary" style="flex: 1; min-height: 44px; font-size: 0.95rem;">Confirm Allocation</button>
      <button type="button" id="cancel-auto-share" class="btn btn-secondary" style="flex: 1; min-height: 44px; font-size: 0.95rem;">Cancel</button>
    </div>
  `;
  
  modalContainer.appendChild(modal);
  document.body.appendChild(modalContainer);
  setTimeout(() => modal.querySelector('.close-preview-btn')?.focus(), 100);
  
  // Close button
  modal.querySelector('.close-preview-btn').addEventListener('click', () => {
    modalContainer.remove();
  });
  
  // Confirm button
  modal.querySelector('#confirm-auto-share').addEventListener('click', async () => {
    modalContainer.remove();
    
    // Confirm the Auto Share allocation
    try {
      const result = await deps.confirmAutoShare({
        cooperativeId,
        memberId,
        remittanceAmount: formData.amount,
        allocations: preview.rows.map(row => ({
          enterprise_id: row.enterpriseId,
          allocated_amount: row.allocatedAmount,
          priority: row.priority
        })),
        remittanceDate: formData.remittance_date,
        bankName: formData.bank_name,
        description: formData.description || 'Auto Share Remittance',
        createdBy: user.username || 'system'
      });
      
      // Use deps.showToast if available, otherwise fallback
      if (deps.showToast) {
        deps.showToast(`Auto Share allocation confirmed! Remittance ID: ${result.remittanceId}`, 'success');
      } else {
        showToast(`Auto Share allocation confirmed! Remittance ID: ${result.remittanceId}`, 'success');
      }
      
      // Reset the auto share trigger and clear form
      formData.autoShareTriggered = false;
      clearForm();
      
    } catch (err) {
      if (deps.showToast) {
        deps.showToast('Error confirming Auto Share: ' + err.message, 'error');
      } else {
        showToast('Error confirming Auto Share: ' + err.message, 'error');
      }
      console.error('[autoShare] Confirm error:', err);
    }
  });
  
  // Cancel button
  modal.querySelector('#cancel-auto-share').addEventListener('click', () => {
    modalContainer.remove();
  });
}

export { showAutoSharePreview };
