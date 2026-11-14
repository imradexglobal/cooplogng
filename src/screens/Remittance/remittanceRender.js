import { escapeHtml, formatCurrency, formatDate, formatDateTime, formatDateForInput, getInitials, generateId, timestampTail } from '../../utils/formatters.js';
import { getAvatarColor, isMobile } from './constants.js';
import { attachEventListeners } from './remittanceEventListeners.js';

export function render(container, deps) {
    const { formData, historyState, enterpriseData, members, selectorMembers, banks, transactionTypes, openingBalances, paymentAdvise, showAllZeros, previewMode, editMode, sealLocked = false, isAdmin, isMember, canApprove, canDelete, canReverse, trackFocus, restoreFocus, getFormattedName, attachHistoryEventListeners, user } = deps;
    trackFocus();
    const selectedMember = formData.member_id ? historyState.membersMap[formData.member_id] : null;
    const autoShareNeedsNote = String(formData.bank_name || '').toLowerCase() === 'internal transfer';
    const autoShareReady = !previewMode
      && !!formData.remittance_date
      && !!formData.bank_name
      && Number(formData.amount) > 0
      && !!formData.member_id
      && formData.member_id !== '0000000000'
      && (!autoShareNeedsNote || !!String(formData.description || '').trim());

    container.innerHTML = `
      <style>
        /* Modal styles */
        .field-invalid { background: #fef2f2; border: 1px solid #dc2626 !important; border-radius: 4px; }
        .modal-overlay.open { display: flex; }
        .modal-overlay { display: none; }
        .modal-content { background: var(--bg-card); border-radius: 1rem; box-shadow: var(--shadow-xl); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid var(--border-light); }
        .modal-header h3 { margin: 0; font-weight: 700; color: var(--text-primary); }
        .close-btn { background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted); }
        .close-btn:hover { color: var(--text-primary); }
        .modal-body { padding: 1rem 1.25rem; }
        .modal-footer { display: flex; justify-content: flex-end; gap: 0.75rem; padding: 1rem; border-top: 1px solid var(--border-light); }
        .primary-button { background: var(--accent-primary); color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 0.5rem; font-weight: 700; cursor: pointer; }
        .primary-button:hover { background: var(--accent-hover); }
        .secondary-button { background: transparent; border: 1px solid var(--border-medium); color: var(--text-primary); padding: 0.6rem 1.2rem; border-radius: 0.5rem; font-weight: 700; cursor: pointer; }
        .secondary-button:hover { background: var(--bg-secondary); }
        .ghost-button { background: transparent; border: 1px solid var(--border-light); color: var(--text-muted); padding: 0.4rem 0.8rem; border-radius: 0.5rem; font-weight: 600; cursor: pointer; }

        /* Created/Last Modified column styles (same as members table) */
        .modified-by-name {
            font-size: 0.82rem;
            font-weight: 600;
            color: var(--text-primary);
            line-height: 1.4;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 160px;
        }
        .modified-at-time {
            font-size: 0.72rem;
            color: var(--text-muted);
            font-variant-numeric: tabular-nums;
            margin-top: 0.18rem;
            white-space: nowrap;
        }

        /* Image preview styles */
        #md-img-preview {
          position: fixed; inset: 0; z-index: 9999;
          background: rgba(0,0,0,0.84);
          display: flex; align-items: center; justify-content: center;
          animation: mdFadeIn 0.18s ease-out;
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
        }
        @keyframes mdFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .md-preview-image-wrap {
          display: flex; flex-direction: column; align-items: center; gap: 1.25rem;
          animation: mdScaleIn 0.22s cubic-bezier(0.34,1.3,0.64,1);
        }
        @keyframes mdScaleIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .md-preview-image-wrap img {
          width: min(88vw, 144px * 4); max-width: min(88vw, 576px); max-height: 80vh;
          object-fit: contain; border-radius: 14px;
          box-shadow: 0 24px 80px rgba(0,0,0,0.65);
        }
        .md-preview-initials-sm {
          width: 32px; height: 32px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 0.8rem; font-weight: 800; color: #fff; text-transform: uppercase;
          letter-spacing: 0.04em; flex-shrink: 0;
          border: 2px solid rgba(255,255,255,0.25);
        }
        .md-preview-name {
          color: rgba(255,255,255,0.92); font-size: 1.05rem; font-weight: 600;
          letter-spacing: 0.02em; text-shadow: 0 1px 6px rgba(0,0,0,0.6);
        }

        /* Main container */
        .unified-container {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: var(--bg-main);
          font-family: 'Inter', system-ui, sans-serif;
          overflow: hidden;
        }

        /* Top Section */
        .top-section {
          display: flex;
          flex: 0 0 auto;
          min-height: 320px;
          border-bottom: 1px solid var(--border-light);
        }

        /* Form Panel */
        .form-panel {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg-card);
          border-right: 1px solid var(--border-light);
          overflow: hidden;
        }

        /* Breakdown Panel */
        .breakdown-panel {
          flex: 1;
          min-width: 300px;
          display: flex;
          flex-direction: column;
          background: var(--bg-card);
          overflow: hidden;
        }

        /* Resizer */
        .resizer-v {
          width: 8px;
          background: var(--bg-secondary);
          cursor: col-resize;
          transition: background 0.15s ease;
        }
        .resizer-v:hover {
          background: var(--accent-primary);
        }
        .resizer-h {
          height: 8px;
          background: var(--bg-secondary);
          cursor: row-resize;
          transition: background 0.15s ease;
        }
        .resizer-h:hover {
          background: var(--accent-primary);
        }

        /* History Section */
        .history-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: var(--bg-card);
        }

        /* Panel Headers */
        .panel-header {
          padding: 0.65rem 1rem;
          background: var(--bg-secondary);
          border-bottom: 1px solid var(--border-light);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .panel-title {
          font-size: 0.85rem;
          font-weight: 700;
          color: var(--text-primary);
          margin: 0;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        /* Form Content */
        .form-content {
          padding: 0.75rem 1rem;
          overflow-y: auto;
          flex: 1;
        }

        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 0.3rem;
        }
        .form-grid-3 {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 0.3rem;
        }

        /* Inherits global .field styling from style.css for Material Outlined Fields */

        /* Member Selector Row */
        .member-row {
          display: flex;
          align-items: flex-start;
          gap: 0.6rem;
          grid-column: 1 / -1;
        }

        .member-avatar-wrap {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: var(--bg-secondary);
          overflow: hidden;
          flex-shrink: 0;
          cursor: pointer;
          user-select: none;
          -webkit-user-select: none;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          border: 2px solid var(--border-medium);
        }
        .member-avatar-wrap:hover { transform: scale(1.12); box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
        .member-avatar-wrap img { width:100%; height:100%; object-fit:cover; }
        .member-avatar-initials {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          color: #fff;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .member-selector-wrapper {
          flex: 1;
          position: relative;
          overflow: visible;
          z-index: 9999;
        }

        .member-search-row {
          display: flex;
          gap: 0.5rem;
        }

        .member-search-input {
          flex: 1;
        }

        .selected-member-display {
          font-size: 0.8rem;
          color: var(--accent-primary);
          font-weight: 600;
          margin-top: 0.25rem;
        }

        /* Form Actions */
        .form-actions {
          display: flex;
          gap: 0.75rem;
          justify-content: flex-end;
          padding: 0.6rem 1rem;
          background: var(--bg-secondary);
          border-top: 1px solid var(--border-light);
        }

        .btn {
          padding: 0.65rem 1.25rem;
          border-radius: var(--radius-sm);
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
          border: none;
          font-size: 0.85rem;
        }

        .btn-primary {
          background: var(--accent-primary);
          color: white;
        }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; background: var(--border-medium); }

        .btn-secondary {
          background: transparent;
          color: var(--text-primary);
          border: 1px solid var(--border-strong);
        }
        .btn-secondary:hover { background: var(--bg-secondary); }

        .btn-ghost {
          background: transparent;
          color: var(--text-muted);
          border: 1px solid var(--border-light);
        }
        .btn-ghost:hover { background: var(--bg-secondary); }

        .btn-danger {
          background: var(--danger-bg);
          color: var(--danger);
          border: 1px solid var(--danger);
        }
        .btn-danger:hover { background: var(--danger); color: white; }

        /* Breakdown Content */
        .breakdown-content {
          flex: 1;
          overflow-y: auto;
          padding: 0.5rem 0.75rem;
        }

        .breakdown-table-container {
          overflow-x: auto;
          background: var(--bg-card);
          border: 1px solid var(--border-light);
          border-radius: var(--radius-sm);
        }

        .breakdown-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.85rem;
        }

        .breakdown-table th {
          position: sticky;
          top: 0;
          background: var(--bg-header);
          padding: 0.45rem 0.55rem;
          text-align: right;
          border-bottom: 1px solid var(--border-light);
          color: var(--text-muted);
          font-weight: 700;
          font-size: 0.68rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          z-index: 10;
        }
        .breakdown-table th:first-child { text-align: left; }

        .breakdown-table td {
          padding: 0.3rem 0.55rem;
          border-bottom: 1px solid var(--border-light);
          text-align: right;
          font-size: 0.8rem;
        }
        .breakdown-table td:first-child { text-align: left; }

        .detail-amt-grid {
          width: 100%;
          box-sizing: border-box;
          text-align: right;
          border: none;
          background: var(--accent-soft);
          color: inherit;
          outline: none;
          font-size: 0.8rem;
          padding: 0.25rem 0.35rem;
          border-radius: 4px;
        }

        .detail-item-row {
          transition: background 0.15s ease;
        }
        .detail-item-row:hover {
          background: var(--bg-secondary);
        }

        /* History Header */
        .history-header {
          display: flex;
          gap: 0.75rem;
          padding: 1rem 1.25rem;
          background: var(--bg-secondary);
          border-bottom: 1px solid var(--border-light);
          align-items: center;
        }

        .search-select {
          padding: 0.65rem 0.85rem;
          border-radius: var(--radius-sm);
          border: 1px solid var(--border-medium);
          background: var(--bg-input);
          color: var(--text-primary);
          font-size: 0.85rem;
          cursor: pointer;
        }

        .search-input {
          flex: 1;
          padding: 0.65rem 0.85rem;
          border-radius: var(--radius-sm);
          border: 1px solid var(--border-medium);
          background: var(--bg-input);
          color: var(--text-primary);
          font-size: 0.85rem;
        }
        .search-input:focus {
          outline: none;
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }

        /* History Table */
        .history-table-container {
          flex: 1;
          overflow: auto;
        }

        .history-table {
          width: 100%;
          border-collapse: collapse;
        }

        .history-table th {
          position: sticky;
          top: 0;
          background: var(--bg-header);
          padding: 0.85rem 1.25rem;
          text-align: left;
          border-bottom: 1px solid var(--border-light);
          color: var(--text-muted);
          font-weight: 700;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          z-index: 10;
        }

        .history-table td {
          padding: 0.75rem 1.25rem;
          border-bottom: 1px solid var(--border-light);
          font-size: 0.875rem;
          color: var(--text-primary);
        }

        .history-table tbody tr {
          cursor: pointer;
          transition: background 0.15s ease;
        }
        .history-table tbody tr:hover {
          background: var(--bg-secondary);
        }
        .history-table tbody tr.selected {
          background: var(--accent-soft);
        }

        .status-badge {
          padding: 0.25rem 0.75rem;
          border-radius: 999px;
          font-size: 0.75rem;
          font-weight: 700;
          display: inline-block;
        }
        .status-Approved { background: var(--success-bg); color: var(--success); }
        .status-Pending { background: var(--warning-bg); color: var(--warning); }
        .status-Rejected { background: var(--danger-bg); color: var(--danger); }

        .member-name-cell {
          font-weight: 600;
        }
        .member-reg-cell {
          font-size: 0.75rem;
          color: var(--text-muted);
          margin-top: 0.15rem;
        }

        /* Child row (autogen group) */
        .history-table tbody tr.child-row {
          cursor: pointer;
        }
        .history-table tbody tr.child-row:hover {
          background: var(--bg-secondary);
        }
        .expand-toggle {
          color: var(--accent-primary);
          font-weight: 700;
          transition: text-shadow 0.15s ease;
        }
        .expand-toggle:hover {
          color: var(--accent-primary) !important;
          text-shadow: 0 0 4px var(--accent-primary);
        }

        /* Admin Mode Row */
        .admin-mode-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem;
          background: var(--bg-secondary);
          border-radius: var(--radius-sm);
        }
        .admin-mode-row input[type="checkbox"] {
          width: 1.25rem;
          height: 1.25rem;
          cursor: pointer;
        }
        .admin-mode-row label {
          font-weight: 700;
          color: var(--text-primary);
          cursor: pointer;
          margin: 0;
          font-size: 0.85rem;
        }

        /* Config Loan Button */
        .config-loan-btn {
          padding: 0.25rem 0.5rem;
          border-radius: 0.5rem;
          border: 1px solid var(--accent-primary);
          background: var(--accent-soft);
          color: var(--accent-primary);
          font-size: 0.75rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .config-loan-btn:hover {
          background: var(--accent-primary);
          color: white;
        }
        .config-loan-btn.configured {
          border-color: var(--success);
          background: var(--success-bg);
          color: var(--success);
        }

        /* ===== Mobile Tabbed Layout ===== */
        .mobile-tab-bar { display: none; }

        @media (max-width: 999px) {
          .unified-container { height: auto !important; overflow: visible !important; }

          .mobile-tab-bar {
            display: flex !important; position: sticky; top: 0; z-index: 50;
            background: var(--bg-card); border-bottom: 1px solid var(--border-light);
          }
          .mobile-tab-btn {
            flex: 1; padding: 0.65rem 0.5rem; border: none; background: transparent;
            font-size: 0.78rem; font-weight: 700; color: var(--text-muted); cursor: pointer;
            border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s;
            text-align: center; white-space: nowrap;
          }
          .mobile-tab-btn.active { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }
          .mobile-tab-btn:active { opacity: 0.7; }

          .top-section { flex-direction: column !important; min-height: 0 !important; border-bottom: none !important; height: auto !important; }
          .form-panel { border-right: none !important; min-height: 0; }
          .breakdown-panel { min-width: 0 !important; min-height: 0; }
          .resizer-v, .resizer-h { display: none !important; }

          .form-panel { overflow: visible !important; }

          .form-grid-3 { grid-template-columns: 1fr 1fr !important; }
          .form-grid-3 .field:nth-child(3) { grid-column: 1 / -1; }
          .form-actions { flex-wrap: wrap; }
          .form-actions .btn { flex: 1; min-width: 0; }

          .history-controls { flex-direction: column !important; gap: 0.5rem !important; padding: 0.5rem 0.75rem !important; }
          .history-controls > div { width: 100%; }
          .history-controls .search-select { width: 100%; }
          .history-controls .search-input { width: 100%; flex: none; }

          /* Compact 2x2 card layout for history on mobile */
          .history-section .history-table tr {
            grid-template-columns: 1fr 1fr !important;
            gap: 0 !important;
            padding: 0.6rem 0.75rem !important;
            border-left: 4px solid transparent !important;
            align-items: start !important;
          }
          .history-section .history-table td {
            padding: 0.15rem 0 !important;
            align-self: start !important;
          }
          /* Kill the ::before labels from global style.css */
          .history-section .history-table td::before { display: none !important; }

          /* Status color indicator */
          .history-section .history-table tr[data-status="Approved"] { border-left-color: var(--success) !important; }
          .history-section .history-table tr[data-status="Pending"] { border-left-color: var(--warning) !important; }
          .history-section .history-table tr[data-status="Rejected"] { border-left-color: var(--danger) !important; }

          /* Hide non-essential cells */
          .history-section .history-table td:nth-child(1),
          .history-section .history-table td:nth-child(3),
          .history-section .history-table td:nth-child(6),
          .history-section .history-table td:nth-child(8),
          .history-section .history-table td:nth-child(9),
          .history-section .history-table td:nth-child(10) { display: none !important; }

          /* Right-aligned cells using flex: Date(4), Amount(7) */
          .history-section .history-table td:nth-child(4),
          .history-section .history-table td:nth-child(7) {
            align-items: flex-end !important;
            text-align: right !important;
          }

          /* Tab: form */
          .unified-container[data-mobile-tab="form"] .breakdown-panel,
          .unified-container[data-mobile-tab="form"] .resizer-v,
          .unified-container[data-mobile-tab="form"] .resizer-h,
          .unified-container[data-mobile-tab="form"] .history-section { display: none !important; }
          .unified-container[data-mobile-tab="form"] .form-panel { display: flex !important; }

          /* Tab: breakdown */
          .unified-container[data-mobile-tab="breakdown"] .form-panel,
          .unified-container[data-mobile-tab="breakdown"] .resizer-v,
          .unified-container[data-mobile-tab="breakdown"] .resizer-h,
          .unified-container[data-mobile-tab="breakdown"] .history-section { display: none !important; }
          .unified-container[data-mobile-tab="breakdown"] .breakdown-panel {
            display: flex !important; flex: none; min-height: 0; overflow: visible;
          }
          .unified-container[data-mobile-tab="breakdown"] .breakdown-content { display: flex !important; }

          /* Tab: history */
          .unified-container[data-mobile-tab="history"] .top-section,
          .unified-container[data-mobile-tab="history"] .resizer-h { display: none !important; }
          .unified-container[data-mobile-tab="history"] .history-section { display: flex !important; }
        }

        @media (max-width: 480px) {
          .form-grid-3 { grid-template-columns: 1fr !important; }
          .form-grid-3 .field:nth-child(3) { grid-column: auto; }
        }
      </style>

      <div class="unified-container" data-mobile-tab="form">
        <!-- Mobile Tab Bar -->
        <div class="mobile-tab-bar">
          <button type="button" class="mobile-tab-btn active" data-tab="form">Form</button>
          <button type="button" class="mobile-tab-btn" data-tab="breakdown">Breakdown</button>
          <button type="button" class="mobile-tab-btn" data-tab="history">History</button>
        </div>

        <!-- Top Section -->
        <div class="top-section" id="top-section">
          <!-- Form Panel -->
          <div class="form-panel">
            <div class="panel-header">
              <h3 class="panel-title">${editMode ? 'Edit Remittance' : previewMode ? 'Remittance Preview' : 'Log Remittance'}</h3>
              ${previewMode ? '' : isAdmin && !formData.isLoanRequest ? `
                <div class="admin-mode-row" style="padding: 0; background: transparent;">
                  <input type="checkbox" id="admin-mode-check" ${formData.member_id === '0000000000' ? 'checked' : ''}>
                  <label for="admin-mode-check">Admin Mode</label>
                </div>
              ` : ''}
            </div>
            ${editMode && sealLocked ? `
              <div class="seal-lock-notice" style="margin: 0 0 0.5rem; padding: 0.5rem 0.75rem; background: var(--bg-secondary); border: 1px solid var(--border-medium); border-left: 3px solid var(--accent-primary); border-radius: var(--radius-sm); font-size: 0.78rem; font-weight: 600; color: var(--text-muted); line-height: 1.45;">
                Reconciled record: Bank, Date and Amount are locked. Member, breakdown and note remain editable.
              </div>
            ` : ''}
            <div class="form-content">
              <form id="payment-form" onsubmit="return false;">
                <!-- Row 1: Date, Bank, Amount -->
                <div class="form-grid-3">
                  <div class="field">
                    <label>Transaction Date</label>
                    <input type="date" name="remittance_date" value="${formatDateForInput(formData.remittance_date)}" required ${(previewMode && !editMode) || sealLocked ? 'disabled' : ''}>
                  </div>
                  <div class="field">
                    <label>Bank or Payment Method</label>
                    <select name="bank_name" required ${(previewMode && !editMode) || sealLocked ? 'disabled' : ''}>
                      <option value="">-- Select Bank --</option>
                      ${(() => {
                        let bankOptions = [...banks];
                        if (formData.bank_name && !bankOptions.find(b => b.bank_name === formData.bank_name)) {
                          bankOptions.push({ bank_name: formData.bank_name });
                        }
                        return bankOptions.map(b => `<option value="${escapeHtml(b.bank_name)}" ${b.bank_name === formData.bank_name ? 'selected' : ''}>${escapeHtml(b.bank_name)}</option>`).join('');
                      })()}
                    </select>
                  </div>
                  <div class="field">
                    <label>Total Amount (₦)</label>
                    <input type="number" step="0.01" name="amount" id="total-amount-input" data-allow-negative="true" value="${formData.amount}" required style="font-size: 1.25rem; font-weight: 700;" class="clear-on-zero" ${(previewMode && !editMode) || sealLocked ? 'disabled' : ''}>
                  </div>
                </div>

                <!-- Row 2: Note -->
                <div class="field" style="margin-top: 0.3rem;">
                  <label>Note / Description</label>
                  <textarea name="description" rows="1" style="width: 100%; min-height: 3.25rem; height: 3.25rem; padding: 1.15rem 1rem 0.35rem 1rem; resize: none; overflow: hidden;" oninput="this.style.height='';this.style.height=this.scrollHeight+2+'px'" ${previewMode && !editMode ? 'disabled' : ''}>${escapeHtml(formData.description)}</textarea>
                </div>

                <!-- Row 3: Member Name (full width) -->
                ${isAdmin ? `
                  <div class="member-row" style="display: ${formData.member_id === '0000000000' && !editMode ? 'none' : 'flex'}; margin-top: 0.5rem;">
                    <div class="member-avatar-wrap" id="up-avatar-wrap" ${selectedMember && !selectedMember.image_path ? 'style="background-color: ${getAvatarColor(selectedMember.name)}"' : ''}">
                      ${selectedMember && selectedMember.image_path
                        ? `<img src="${selectedMember.image_path}" alt="${escapeHtml(selectedMember.name)}">`
                        : selectedMember
                          ? `<div class="member-avatar-initials">${getInitials(selectedMember.name)}</div>`
                          : `<div class="member-avatar-initials" style="color: var(--text-muted);">?</div>`}
                    </div>
                    <div class="member-selector-wrapper">
                      <div class="field">
                        <label>Select Member</label>
                        ${members.length === 0 ? `
                          <input type="text" name="member_id" value="${formData.member_id}" placeholder="Enter Member ID manually" required>
                        ` : `
                          <div class="member-search-row">
                            <input type="text" id="member-search-input" class="member-search-input" placeholder="Search by Reg No, Name, Mobile, or Special ID..." value="${escapeHtml(selectedMember ? (selectedMember.name || [selectedMember.first_name, selectedMember.middle_name, selectedMember.last_name].filter(Boolean).join(' ')) : '')}" ${previewMode && !editMode ? 'disabled' : ''}>
                            ${(previewMode && !editMode) ? '' : `<button type="button" id="reset-member-btn" class="btn btn-ghost">Reset</button>`}
                          </div>
                          <div id="member-search-suggestions" class="search-suggestions" style="display: none; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: var(--radius-sm); box-shadow: var(--shadow-xl); z-index: 999999; max-height: 200px; overflow-y: auto;"></div>
                          <input type="hidden" name="member_id" id="member-id-select" value="${formData.member_id}" required>
                          <div class="selected-member-display" id="selected-member-display" style="border: 2px solid var(--accent-primary); margin-top: 0.5rem; padding: 0.5rem; border-radius: var(--radius-sm);">
                            ${formData.member_id ? (() => {
                              const mem = selectorMembers.find(m => String(m.id) === String(formData.member_id)) || members.find(m => String(m.id) === String(formData.member_id));
                              if (!mem) {
                                if (String(formData.member_id) === '0000000000') {
                                  return '<div class="selected-member-card" style="color: var(--text-muted); font-style: italic; padding: 0.5rem;">No member assigned (Admin Mode). Search above to assign this transaction to a member.</div>';
                                }
                                return '<div class="selected-member-card" style="color: var(--danger); font-weight: 700;">⚠ Member ID found but no member data: ' + escapeHtml(formData.member_id) + '</div>';
                              }
                              const networthVal = Object.values(openingBalances || {}).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
                              const networth = networthVal !== 0 ? networthVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
                              const networthColor = networthVal < 0 ? 'var(--danger)' : 'var(--success)';
                              return `
                                <div class="selected-member-card" style="background: var(--bg-card); border: 1px solid var(--border-light); border-radius: var(--radius-md); padding: 0.85rem; margin-top: 0.5rem;">
                                  <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
                                    <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--accent-primary); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.9rem; flex-shrink: 0;">
                                      ${escapeHtml((mem.name || 'U').charAt(0).toUpperCase())}
                                    </div>
                                    <div>
                                      <div style="font-weight: 700; font-size: 1rem; color: var(--text-primary);">${escapeHtml(mem.name || [mem.first_name, mem.middle_name, mem.last_name].filter(Boolean).join(' ') || 'Unknown')}</div>
                                      <div style="font-size: 0.75rem; color: var(--text-muted);">Member ID: ${escapeHtml(mem.id || '—')}</div>
                                    </div>
                                  </div>
                                  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem; font-size: 0.8rem;">
                                    ${mem.special_id ? `<div style="display: flex; flex-direction: column; gap: 0.15rem;"><span style="font-weight: 700; color: var(--accent-primary); font-size: 0.7rem; text-transform: uppercase;">Special ID</span><span style="font-weight: 600; color: var(--text-primary);">${escapeHtml(mem.special_id)}</span></div>` : ''}
                                    ${mem.registration_no ? `<div style="display: flex; flex-direction: column; gap: 0.15rem;"><span style="font-weight: 700; color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase;">Reg No</span><span style="font-weight: 600; color: var(--text-primary);">${escapeHtml(mem.registration_no)}</span></div>` : ''}
                                    ${mem.mobile ? `<div style="display: flex; flex-direction: column; gap: 0.15rem;"><span style="font-weight: 700; color: var(--text-muted); font-size: 0.7rem; text-transform: uppercase;">Mobile</span><span style="font-weight: 600; color: var(--text-primary);">${escapeHtml(mem.mobile)}</span></div>` : ''}
                                    <div style="display: flex; flex-direction: column; gap: 0.15rem;"><span style="font-weight: 700; color: ${networthColor}; font-size: 0.7rem; text-transform: uppercase;">Networth</span><span style="font-weight: 700; color: ${networthColor};">${networth !== '—' ? escapeHtml(networth) : '—'}</span></div>
                                  </div>
                                </div>
                              `;
                            })() : '<div class="selected-member-card" style="color: var(--text-muted); font-style: italic; padding: 0.5rem;">No member selected (formData.member_id: ' + escapeHtml(formData.member_id || 'empty') + ')</div>'}
                          </div>
                        `}
                      </div>
                    </div>
                  </div>
                ` : ''}

                <!-- Transaction Type -->
                <div id="transaction-type-container" class="field" style="display: ${formData.member_id === '0000000000' ? 'block' : 'none'}; margin-top: 0.5rem;">
                  <label>Transaction Type</label>
                  <select name="transaction_type" style="width: 100%;" ${previewMode && !editMode ? 'disabled' : ''}>
                    <option value="">-- Select Transaction Type --</option>
                    ${transactionTypes.filter(t => t.is_active).map(t => {
                        const locked = t.is_locked === 1 || t.is_locked === true;
                        return `<option value="${t.transaction_type}" ${formData.transaction_type === t.transaction_type ? 'selected' : ''} ${locked ? 'disabled title="This transaction type is system-managed and cannot be manually selected"' : ''}>${t.transaction_type}${locked ? ' Ⓒ' : ''}</option>`;
                    }).join('')}
                  </select>
                </div>
              </form>
            </div>
            <div class="form-actions">
              ${!isMember ? `<button type="button" id="auto-share-btn" class="btn btn-secondary" ${autoShareReady ? '' : 'disabled'} title="${autoShareReady ? 'Preview an automatic allocation of this remittance using the member’s payment advice' : 'Complete the required remittance fields before using Auto Share'}">Auto Share</button>` : ''}
              <button type="button" id="clear-log-btn" class="btn btn-secondary">${previewMode ? 'Add New Remittance' : 'Clear Form'}</button>
              ${editMode ?
                `<button type="button" id="update-log-btn" class="btn btn-primary">Update Remittance</button>` :
                previewMode ? (canApprove && formData.status === 'Pending' ?
                  `<button type="button" id="review-log-btn" class="btn btn-primary">Review</button>`
                  : '') : `<button type="button" id="submit-log-btn" class="btn btn-primary">Save Remittance</button>`
              }
            </div>
          </div>

              <!-- Vertical Resizer -->
              <div class="resizer-v" id="resizer-v"></div>

          <!-- Breakdown Panel -->
          <div class="breakdown-panel" id="breakdown-panel">
            <div class="panel-header">
              <h3 class="panel-title">Detailed Breakdown</h3>
              <label style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; cursor: pointer; color: var(--text-muted); font-weight: 600;">
                <input type="checkbox" id="toggle-show-zeros-check" ${showAllZeros ? 'checked' : ''} style="cursor: pointer;">
                Show All
              </label>
            </div>
            <div class="breakdown-content" style="display: ${formData.member_id === '0000000000' ? 'none' : 'flex'}; flex-direction: column; height: 100%;">
              <div class="breakdown-table-container" style="flex: 1; overflow: auto;">
                <table class="breakdown-table">
                  <thead>
                    <tr>
                      <th style="width: 45%;">Enterprise</th>
                      <th style="width: 15%;">Opening</th>
                      <th style="width: 15%;">Advise</th>
                      <th style="width: 15%;">Input</th>
                      <th style="width: 10%;">Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${(() => {
                      const detailsMap = (formData.details || []).reduce((acc, d) => ({ ...acc, [d.enterprise_id || d.item]: d }), {});
                      let rowsHtml = '';
                      enterpriseData.forEach((e, idx) => {
                        const opening = parseFloat(openingBalances[e.id] || 0);
                        const advise = parseFloat(paymentAdvise[e.id] || 0);
                        const existingDetail = detailsMap[e.id];
                        let inputAmt = existingDetail ? parseFloat(existingDetail.amount || 0) : 0;
                        const isFinanciallyActive = !formData.status || formData.status === 'Approved';
                        const closing = isFinanciallyActive ? opening + inputAmt : opening;
                        const hasLoanInfo = !!existingDetail?.loan_info;
                        const getAccountType = (acc) => (acc?.account_type || acc?.type || '').toLowerCase();
                        const isLoan = getAccountType(e) === 'loan';
                        const isInternalTransfer = (formData.bank_name || '').toLowerCase() === 'internal transfer';
                        const isCoopWide = formData.member_id === '0000000000';
                        const isLoanCondition = isLoan && !isInternalTransfer && !isCoopWide && (inputAmt < 0 || hasLoanInfo);
                        if (!showAllZeros && opening === 0 && advise === 0 && inputAmt === 0 && !hasLoanInfo && !e.compulsory_due) return;
                        rowsHtml += `
                          <tr class="detail-item-row" data-entid="${e.id}" data-id="${existingDetail?.id || generateId(String(user.cooperativeId))}" data-loaninfo='${JSON.stringify(existingDetail?.loan_info || {})}' data-row-index="${idx}">
                            <td style="padding: 0.4rem 0.6rem; text-align: left; ${isLoanCondition || hasLoanInfo ? 'color: var(--accent-primary); font-weight: 600; text-decoration: underline;' : ''}">
                              <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
                                <span style="display: flex; align-items: center; gap: 0.35rem;">
                                  ${e.compulsory_due ? `<span style="background: var(--accent-primary); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1; text-decoration: none; display: inline-block;">C</span>` : ''}
                                  ${e.revenue ? `<span style="background: var(--success); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1; text-decoration: none; display: inline-block;">R</span>` : ''}
                                  
                                  ${e.is_penalty ? `<span style="background: var(--danger); color: white; font-size: 0.6rem; font-weight: 800; padding: 0.1rem 0.35rem; border-radius: 999px; line-height: 1; text-decoration: none; display: inline-block;">P</span>` : ''}
                                  ${escapeHtml(e.account_name || e.id)}
                                </span>
                                ${isLoan ? `
                                  <button type="button" class="config-loan-btn ${hasLoanInfo ? 'configured' : ''}" data-entid="${e.id}" data-readonly="${previewMode && !editMode}">
                                    ${hasLoanInfo ? 'View Details' : (previewMode && !editMode) ? 'View Details' : 'Configure'}
                                  </button>
                                ` : ''}
                              </div>
                            </td>
                            <td style="padding: 0.4rem 0.6rem; color: ${opening < 0 ? 'var(--danger)' : 'inherit'}">
                              ${opening === 0 ? '-' : opening.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
                            </td>
                            <td style="padding: 0.4rem 0.6rem; color: var(--text-muted)">
                              ${advise === 0 ? '-' : advise.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
                            </td>
                            <td style="padding: 0.2rem;">
                              <input type="number" step="0.01" class="detail-amt-grid clear-on-zero" data-allow-negative="true" data-opening="${opening}" value="${inputAmt}" data-row-index="${idx}" ${(previewMode && !editMode) || e.compulsory_due ? 'disabled' : ''} ${!(previewMode && !editMode) && e.compulsory_due ? 'title="Compulsory due — charged separately on save"' : ''}>
                            </td>
                            <td class="row-closing-bal" style="padding: 0.4rem 0.6rem; font-weight: 600; color: ${closing < 0 ? 'var(--danger)' : 'inherit'}">
                              ${closing === 0 ? '-' : closing.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}
                            </td>
                          </tr>
                        `;
                      });
                      if (!rowsHtml) {
                        rowsHtml = '<tr><td colspan="5" style="padding: 1.5rem; text-align: center; color: #94a3b8; font-style: italic;">No active balances to display. Check "Show All" to view hidden accounts.</td></tr>';
                      }
                      return rowsHtml;
                    })()}
                  </tbody>
                  <tfoot style="position: sticky; bottom: 0; z-index: 10;">
                    <tr style="background: var(--bg-header); border-top: 1px solid var(--border-light);">
                      <td colspan="4" style="padding: 0.75rem; font-weight: 700; color: var(--text-primary);">
                        <div style="position: relative; display: flex; justify-content: space-between; align-items: center;">
                          <span style="font-size: 0.85rem; color: var(--text-muted); font-weight: 600;">Diff: <span id="dist-diff-cell" style="color: ${Math.abs(formData.amount - (formData.details || []).reduce((s, d) => s + (d.amount || 0), 0)) < 0.01 ? 'var(--success)' : 'var(--danger)'}">${(formData.amount - (formData.details || []).reduce((s, d) => s + (d.amount || 0), 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                          <span>Total Distributed:</span>
                          <span style="position: absolute; left: 58.333%; transform: translateX(-50%); white-space: nowrap; color: var(--text-muted);">Total Advise: <span id="dist-advise-total-cell">${Object.values(paymentAdvise || {}).reduce((sum, amount) => sum + (parseFloat(amount) || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}</span></span>
                        </div>
                      </td>
                      <td id="dist-total-cell" style="padding: 0.75rem; font-weight: 700; font-size: 1.05rem; text-align: right; color: ${(formData.details || []).reduce((s, d) => s + (d.amount || 0), 0) < 0 ? 'var(--danger)' : 'inherit'}">${(formData.details || []).reduce((s, d) => s + (d.amount || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        </div>

        ${(formData.linkedChildren || []).length ? `
          <div class="linked-remittance-children" style="margin:0.75rem 1rem;padding:0.75rem 1rem;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--bg-secondary);">
            <div style="font-weight:700;margin-bottom:0.5rem;">Linked entries (${formData.linkedChildren.length})</div>
            <div style="display:flex;flex-direction:column;gap:0.35rem;">
              ${formData.linkedChildren.map(child => `
                <div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;font-size:0.82rem;">
                  <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(child.description || child.transaction_type || child.id)}</span>
                  <span style="white-space:nowrap;font-weight:700;color:${Number(child.amount) < 0 ? 'var(--danger)' : 'var(--success)'};">${formatCurrency(child.amount)} · ${escapeHtml(child.status || 'Pending')}</span>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Horizontal Resizer -->
        <div class="resizer-h" id="resizer-h"></div>

        <!-- History Section -->
        <div class="history-section">
          <!-- History Controls -->
          <div class="history-controls" style="display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 4px 1rem 4px 1rem; flex-wrap: wrap;">
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              ${(() => {
                const hasSelected = historyState.selectedRemittanceIds.size > 0;
                const hasPendingSelected = historyState.allRemittances.filter(r =>
                  historyState.selectedRemittanceIds.has(r.id) && r.status === 'Pending'
                ).length > 0;

                let html = '';
                if (hasSelected) {
                  html += `<button type="button" id="toggle-selection-mode-btn" class="btn btn-primary" style="padding: 0.5rem 1rem;">Selected (${historyState.selectedRemittanceIds.size})</button>`;
                }
                // Delete shown when user has delete_remittance permission.
                if (canDelete) {
                  html += `<button type="button" id="delete-selected-btn" class="btn btn-secondary" style="padding: 0.5rem 1rem; display: ${hasSelected ? 'inline-block' : 'none'};" title="Delete the selected transaction(s)">Delete</button>`;
                }
                if (canReverse) {
                  html += `<button type="button" id="reverse-selected-btn" class="btn btn-secondary" style="padding: 0.5rem 1rem; display: ${hasSelected ? 'inline-block' : 'none'};" title="Mirror the selected transaction(s) with opposite amounts">Reverse</button>`;
                }
                return html;
              })()}
            </div>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              ${!isMember ? `
              <button type="button" onclick="window.location.hash='bank-statement-import'" class="btn btn-secondary" style="padding: 0.5rem 0.85rem; display: inline-flex; align-items: center; gap: 0.35rem;" title="Import transactions from bank statement (PDF, Excel, CSV)">
                <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                <span>Import Statement</span>
              </button>
              ` : ''}
              <button type="button" id="export-excel-btn" class="btn btn-secondary" style="padding: 0.5rem 1rem;">
                Export to Excel
              </button>
              <button type="button" id="open-filters-btn" class="btn btn-secondary" style="padding: 0.5rem 1rem;">
                Filters
              </button>
              <select id="search-column-select" class="search-select" style="padding: 0.5rem;">
                <option value="All Columns" ${historyState.searchColumn === 'All Columns' ? 'selected' : ''}>All Columns</option>
                <option value="Remittance ID" ${historyState.searchColumn === 'Remittance ID' ? 'selected' : ''}>Remittance ID</option>
                <option value="Member Name" ${historyState.searchColumn === 'Member Name' ? 'selected' : ''}>Member Name</option>
                <option value="Member Number" ${historyState.searchColumn === 'Member Number' ? 'selected' : ''}>Member Number</option>
                <option value="Special ID" ${historyState.searchColumn === 'Special ID' ? 'selected' : ''}>Special ID</option>
                <option value="Mobile" ${historyState.searchColumn === 'Mobile' ? 'selected' : ''}>Mobile</option>
                <option value="Registration No" ${historyState.searchColumn === 'Registration No' ? 'selected' : ''}>Registration No</option>
                <option value="Transaction Date" ${historyState.searchColumn === 'Transaction Date' ? 'selected' : ''}>Transaction Date</option>
                <option value="Bank" ${historyState.searchColumn === 'Bank' ? 'selected' : ''}>Bank</option>
                <option value="Amount" ${historyState.searchColumn === 'Amount' ? 'selected' : ''}>Amount</option>
                <option value="Status" ${historyState.searchColumn === 'Status' ? 'selected' : ''}>Status</option>
                <option value="Note/Description" ${historyState.searchColumn === 'Note/Description' ? 'selected' : ''}>Note/Description</option>
              </select>
              <input type="text" id="history-search-input" class="search-input" placeholder="Search remittances..." value="${escapeHtml(historyState.searchTerm)}" style="padding: 0.5rem;">
            </div>
          </div>
          <div class="history-table-container">
            <table class="history-table">
              <thead>
                <tr>
                  <th style="width: 40px;">
                    <input type="checkbox" id="select-all-checkbox" ${historyState.selectAll ? 'checked' : ''}>
                  </th>
                  ${!isMember ? '<th>Member</th>' : '<th>Record ID</th>'}
                  <th>Special ID</th>
                  <th>Date</th>
                  <th>Bank</th>
                  <th>Description</th>
                  <th class="text-right">Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last Modified</th>
                </tr>
              </thead>
              <tbody id="history-tbody">
                ${(() => {
                  let rowsHtml = '';
                  historyState.allRemittances.forEach((remit, idx) => {
                    const member = historyState.membersMap[remit.member_id];
                    const isSelected = historyState.selectedRemittanceIds.has(remit.id);
                    const childCount = remit.children ? remit.children.length : 0;
                    const isExpanded = historyState.expandedRemittanceIds.has(remit.id);
                    rowsHtml += `
                    <tr class="${historyState.selectedRemittanceId === remit.id ? 'selected' : ''} ${isSelected ? 'selected' : ''}" data-id="${remit.id}" data-row-index="${idx}" data-status="${remit.status || 'Pending'}">
                      <td>
                        <input type="checkbox" class="remit-checkbox" data-id="${remit.id}" ${isSelected ? 'checked' : ''}>
                      </td>
                      ${!isMember ? `
                        <td>
                          <div class="member-name-cell" style="color: ${remit.member_id === '0000000000' ? 'var(--accent-primary)' : 'var(--text-primary)'}">
                            ${childCount > 0 ? `<span class="expand-toggle" data-toggle-id="${remit.id}" style="cursor:pointer;margin-right:4px;color:var(--accent-primary);font-weight:700;user-select:none;">${isExpanded ? '▼' : '▶'}</span>` : ''}
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
                        <div style="font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 1rem; color: ${remit.amount < 0 ? 'var(--danger)' : 'var(--success)'};">${formatCurrency(remit.amount)}</div>
                      </td>
                      <td><span class="status-badge status-${escapeHtml(remit.status || 'Pending')}">${escapeHtml(remit.status || 'Pending')}</span></td>
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
                    if (remit.children && remit.children.length > 0 && isExpanded) {
                      remit.children.forEach((child) => {
                        const cMember = historyState.membersMap[child.member_id];
                        rowsHtml += `
                        <tr class="child-row" data-id="${child.id}" data-parent-id="${remit.id}" data-status="${child.status || 'Pending'}" style="background: var(--bg-secondary);">
                          <td><span style="display:inline-block;width:12px;"></span></td>
                          ${!isMember ? `
                            <td>
                              <div class="member-name-cell" style="color: ${child.member_id === '0000000000' ? 'var(--accent-primary)' : 'var(--text-primary)'}; font-size:0.82rem;font-weight:500;">
                                <span style="color:var(--text-muted);margin-right:4px;">└</span>
                                ${escapeHtml(getFormattedName(child.member_id, child.transaction_type))}
                              </div>
                              <div class="member-reg-cell">${timestampTail(child.id)}</div>
                            </td>
                          ` : `
                            <td>
                              <div class="member-name-cell">${timestampTail(child.id)}</div>
                            </td>
                          `}
                          <td><div style="color: var(--text-muted); font-size: 0.85rem;">${escapeHtml(cMember?.special_id || '—')}</div></td>
                          <td><div>${formatDate(child.remittance_date)}</div></td>
                          <td><div style="font-weight: 600;">${escapeHtml(child.bank_name || 'Direct')}</div></td>
                          <td><div style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted);" title="${escapeHtml(child.description || '')}">${escapeHtml(child.description || '')}</div></td>
                          <td class="text-right">
                            <div style="font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 0.85rem; color: ${child.amount < 0 ? 'var(--danger)' : 'var(--success)'}; opacity:0.8;">${formatCurrency(child.amount)}</div>
                          </td>
                          <td><span class="status-badge status-${escapeHtml(child.status || 'Pending')}" style="font-size:0.65rem;padding:0.15rem 0.5rem;">${escapeHtml(child.status || 'Pending')}</span></td>
                          <td>
                            <div class="modified-by-name">${escapeHtml(child.created_by || '—')}</div>
                            <div class="modified-at-time">${formatDateTime(child.created_at || child.remittance_date) || '—'}</div>
                          </td>
                          <td>
                            <div class="modified-by-name">${escapeHtml(child.modified_by || child.created_by || '—')}</div>
                            <div class="modified-at-time">${formatDateTime(child.modified_at || child.created_at || child.remittance_date) || '—'}</div>
                          </td>
                        </tr>
                        `;
                      });
                    }
                  });
                  return rowsHtml;
                })()}
              </tbody>
            </table>
            <div id="history-scroll-indicator" style="text-align:center;padding:1rem;color:var(--text-muted);font-size:0.85rem;display:none;">
              <div class="spinner" style="display:inline-block;width:18px;height:18px;border:2px solid var(--border-medium);border-top-color:var(--accent-primary);border-radius:50%;animation:spin .6s linear infinite;margin-right:0.5rem;vertical-align:middle;"></div>
              Loading more...
            </div>
          </div>
        </div>
      </div>
      <!-- Filter Overlay -->
      <div id="filter-overlay" class="modal-overlay" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 9999;">
        <div class="modal-content" style="background: var(--bg-card); border-radius: var(--radius-md); width: 90%; max-width: 500px; margin: 2rem auto; max-height: 90vh; overflow-y: auto; padding: 1.5rem;">
          <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
            <h3 style="margin: 0;">Filters</h3>
            <button type="button" id="close-filters-btn" class="close-btn" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer;">&times;</button>
          </div>
          <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem;">
            <!-- Member Filter -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Member</label>
              <select id="filter-member" class="search-select" style="width: 100%; padding: 0.5rem;">
                <option value="All" ${historyState.filters.memberId === 'All' ? 'selected' : ''}>All Members</option>
                ${historyState.members.map(m => `<option value="${m.id}" ${historyState.filters.memberId === m.id ? 'selected' : ''}>${escapeHtml(m.name || m.registration_no)}</option>`).join('')}
              </select>
            </div>
            <!-- Bank Filter -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Bank</label>
              <select id="filter-bank" class="search-select" style="width: 100%; padding: 0.5rem;">
                <option value="All" ${historyState.filters.bank === 'All' ? 'selected' : ''}>All Banks</option>
                ${(banks || []).map(b => `<option value="${escapeHtml(b.bank_name)}" ${historyState.filters.bank === b.bank_name ? 'selected' : ''}>${escapeHtml(b.bank_name)}</option>`).join('')}
              </select>
            </div>
            <!-- Transaction Type Filter -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Transaction Type</label>
              <select id="filter-transaction-type" class="search-select" style="width: 100%; padding: 0.5rem;">
                <option value="All" ${historyState.filters.transactionType === 'All' ? 'selected' : ''}>All Types</option>
                ${(transactionTypes || []).map(t => `<option value="${t.transaction_type}" ${historyState.filters.transactionType === t.transaction_type ? 'selected' : ''}>${t.transaction_type}</option>`).join('')}
              </select>
            </div>
            <!-- Status Filter -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Status</label>
              <select id="filter-status" class="search-select" style="width: 100%; padding: 0.5rem;">
                <option value="All" ${historyState.filters.status === 'All' ? 'selected' : ''}>All Statuses</option>
                <option value="Pending" ${historyState.filters.status === 'Pending' ? 'selected' : ''}>Pending</option>
                <option value="Approved" ${historyState.filters.status === 'Approved' ? 'selected' : ''}>Approved</option>
                <option value="Rejected" ${historyState.filters.status === 'Rejected' ? 'selected' : ''}>Rejected</option>
              </select>
            </div>
            <!-- Date Range Filter -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Date Range</label>
              <select id="filter-date-range" class="search-select" style="width: 100%; padding: 0.5rem;">
                <option value="All" ${historyState.filters.dateRange === 'All' ? 'selected' : ''}>All Time</option>
                <option value="Today" ${historyState.filters.dateRange === 'Today' ? 'selected' : ''}>Today</option>
                <option value="This Week" ${historyState.filters.dateRange === 'This Week' ? 'selected' : ''}>This Week</option>
                <option value="This Month" ${historyState.filters.dateRange === 'This Month' ? 'selected' : ''}>This Month</option>
                <option value="This Year" ${historyState.filters.dateRange === 'This Year' ? 'selected' : ''}>This Year</option>
                <option value="Custom" ${historyState.filters.dateRange === 'Custom' ? 'selected' : ''}>Custom Range</option>
              </select>
            </div>
            <!-- Custom Date From -->
            <div class="field" id="custom-date-from-container" style="${historyState.filters.dateRange === 'Custom' ? '' : 'display: none;'}">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">From Date</label>
              <input type="date" id="filter-date-from" value="${historyState.filters.dateFrom}" style="width: 100%; padding: 0.5rem;">
            </div>
            <!-- Custom Date To -->
            <div class="field" id="custom-date-to-container" style="${historyState.filters.dateRange === 'Custom' ? '' : 'display: none;'}">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">To Date</label>
              <input type="date" id="filter-date-to" value="${historyState.filters.dateTo}" style="width: 100%; padding: 0.5rem;">
            </div>
            <!-- Min Amount -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Minimum Amount</label>
              <input type="number" id="filter-min-amount" value="${historyState.filters.minAmount || ''}" placeholder="Min Amount" style="width: 100%; padding: 0.5rem;">
            </div>
            <!-- Max Amount -->
            <div class="field">
              <label style="font-size: 0.875rem; font-weight: 600; margin-bottom: 0.5rem; display: block;">Maximum Amount</label>
              <input type="number" id="filter-max-amount" value="${historyState.filters.maxAmount || ''}" placeholder="Max Amount" style="width: 100%; padding: 0.5rem;">
            </div>
          </div>
          <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 1.5rem;">
            <button type="button" id="clear-filters-btn" class="btn btn-secondary" style="padding: 0.5rem 1rem;">Clear All</button>
            <button type="button" id="apply-filters-btn" class="btn btn-primary" style="padding: 0.5rem 1rem;">Apply Filters</button>
          </div>
        </div>
      </div>
    `;

    attachEventListeners(container, deps);
    attachHistoryEventListeners();
    restoreFocus();

    // Auto-adjust description textarea height if there is content on load
    const descTextarea = container.querySelector('textarea[name="description"]');
    if (descTextarea) {
        descTextarea.style.height = '';
        descTextarea.style.height = descTextarea.scrollHeight + 2 + 'px';
    }
}
