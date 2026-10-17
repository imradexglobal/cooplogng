import { 
    REPORT_TYPES,
    REPORT_TYPE_FILTER_GROUPS,
    REPORT_TYPE_OPTIONS,
    memberFieldOptions,
    DEFAULT_MEMBER_FIELDS,
    buildAccountingPack,
    exportAccountingPack,
    exportToExcel,
    exportToPDF
} from '../services/reportsService.js';
import { fetchBanks, fetchEnterprises, fetchAllMembers } from '../services/dataService.js';
import { getTransactionTypes } from '../services/sqlite/transactionTypes.js';
import { queryOne, queryRows } from '../services/sqliteService.js';
import { escapeHtml, formatDate, formatNumber, wrapDateInput } from '../utils/formatters.js';
import { showToast } from '../services/toastService.js';
import { showWorkspaceSpinner } from '../components/workspaceSpinner.js';
import { save as persistState, load as loadPersisted } from '../services/statePersistence.js';
import { SHEETS } from '../services/reports/accountingPackExcel.js';

// Rows per preview page; exports always use the full result set.
const PREVIEW_PAGE_SIZE = 100;

export async function renderReports(container, user) {
    showWorkspaceSpinner(container);
    const cooperativeId = user?.cooperativeId;
    const isAdmin = user.role === 'admin' || (user.permissions || '').includes('admin');
    
    // Fetch Coop Info
    let cooperativeFullName = user.cooperativeName || 'Cooperative';
    try {
        const coops = await queryRows('SELECT id, full_name FROM cooperatives', []);
        if (coops && coops.length > 0) {
            // Find the one matching current user's coop ID if possible, otherwise first non-empty
            const myCoop = coops.find(c => String(c.id) === String(user?.cooperativeId));
            const firstWithName = myCoop || coops.find(c => c.full_name && c.full_name.trim().length > 0);
            if (firstWithName) cooperativeFullName = firstWithName.full_name;
        }
    } catch (e) {
        console.warn('Failed to fetch cooperative name from SQLite:', e);
    }

    container.innerHTML = `
        <style>
            .reports-container { padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
            .reports-controls { 
                background: var(--bg-card); 
                padding: 1.5rem; 
                border-radius: var(--radius-lg); 
                border: 1px solid var(--border-light);
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
            }
            .controls-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                gap: 1rem;
                align-items: flex-end;
            }
            .control-group { display: flex; flex-direction: column; gap: 0.5rem; }
            .control-group label { font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; }
            .control-group select, .control-group input { 
                height: 2.75rem; 
                padding: 0 0.75rem; 
                border-radius: var(--radius-md); 
                border: 1px solid var(--border-medium); 
                background: var(--bg-input); 
                color: var(--text-primary);
                font-size: 0.9rem;
            }
            .reports-preview { 
                background: var(--bg-card); 
                border-radius: var(--radius-lg); 
                border: 1px solid var(--border-light);
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            .preview-header {
                padding: 1rem 1.5rem;
                border-bottom: 1px solid var(--border-light);
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: var(--bg-card); /* Match card background */
            }
            .preview-title { font-weight: 700; color: var(--text-primary); }
            .preview-body { 
                overflow: auto; 
                min-height: 300px; 
                max-height: 600px; 
                position: relative; 
            }
            .preview-placeholder { 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                height: 300px; 
                color: var(--text-muted); 
                font-style: italic;
            }

            #preview-toolbar {
                position: sticky;
                top: 0;
                z-index: 40;
                min-height: 44px;
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: space-between;
                flex-wrap: wrap;
                gap: 0.75rem;
                padding: 0.5rem 1rem;
                background: var(--bg-card);
                border-bottom: 1px solid var(--border-light);
            }
            #preview-toolbar input[type="search"] {
                height: 2rem;
                min-width: 200px;
                padding: 0 0.6rem;
                border-radius: var(--radius-md);
                border: 1px solid var(--border-medium);
                background: var(--bg-input);
                color: var(--text-primary);
                font-size: 0.8rem;
            }
            #preview-toolbar button {
                height: 1.8rem;
                min-width: 1.8rem;
                padding: 0 0.4rem;
                border: 1px solid var(--border-medium);
                background: var(--bg-input);
                color: var(--text-primary);
                border-radius: var(--radius-md);
                cursor: pointer;
                font-size: 0.9rem;
                line-height: 1;
            }
            #preview-toolbar button:disabled { opacity: 0.4; cursor: default; }
            .styled-table thead th[data-sort-idx] { cursor: pointer; user-select: none; }

            .styled-table { 
                width: auto !important;
                min-width: 100%;
                border-collapse: separate; 
                border-spacing: 0; 
                font-family: 'Inter', system-ui, sans-serif;
                table-layout: auto !important;
            }
            
            .styled-table thead tr th {
                position: sticky;
                top: 44px;
                background: var(--bg-card) !important;
                z-index: 30;
                box-shadow: 0 1px 0 var(--border-light);
                padding: 1rem 1.5rem;
                color: var(--text-muted);
                font-size: 0.75rem;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                text-align: left;
                white-space: nowrap !important;
                word-break: keep-all !important;
                overflow-wrap: normal !important;
            }

            .styled-table tbody tr td {
                padding: 1rem 1.5rem;
                border-bottom: 1px solid var(--border-light);
                color: var(--text-primary);
                white-space: nowrap !important;
                word-break: keep-all !important;
                overflow-wrap: normal !important;
            }
            
            /* Zebra Striping */
            .styled-table tbody tr:nth-child(even) {
                background-color: var(--bg-secondary);
            }
            
            /* Hover State */
            .styled-table tbody tr {
                transition: all 0.2s ease;
            }
            .styled-table tbody tr:hover {
                background-color: var(--bg-input);
            }
            .btn-generate { 
                background: var(--accent-primary); 
                color: white; 
                border: none; 
                padding: 0 1.5rem; 
                height: 2.75rem; 
                border-radius: var(--radius-md); 
                font-weight: 700; 
                cursor: pointer;
                transition: opacity 0.2s;
            }
            .btn-generate:hover { opacity: 0.9; }
            .btn-export { 
                background: #059669; 
                color: white; 
                border: none; 
                padding: 0 1rem; 
                height: 2.25rem; 
                border-radius: var(--radius-md); 
                font-weight: 600; 
                cursor: pointer; 
                font-size: 0.85rem; 
                display: none;
            }
            .btn-pdf {
                background: #dc2626; 
                color: white; 
                border: none; 
                padding: 0 1rem; 
                height: 2.25rem; 
                border-radius: var(--radius-md); 
                font-weight: 600; 
                cursor: pointer; 
                font-size: 0.85rem; 
                display: none;
                margin-left: 0.5rem;
            }
            .field-checkbox-group {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                gap: 0.5rem;
                padding: 0.5rem;
                background: var(--bg-main);
                border-radius: var(--radius-md);
                border: 1px solid var(--border-light);
            }
            .checkbox-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: var(--text-primary); cursor: pointer; }
            .checkbox-item input { width: auto; height: auto; }

            .field-chips-container {
                border: 1px solid var(--border-medium);
                border-radius: var(--radius-md);
                padding: 0.5rem;
                min-height: 2.75rem;
                background: var(--bg-input);
                display: flex;
                flex-wrap: wrap;
                gap: 0.4rem;
                align-items: center;
            }
            .field-chip {
                background: var(--bg-secondary);
                color: var(--text-primary);
                padding: 0.25rem 0.6rem;
                border-radius: 999px;
                display: flex;
                align-items: center;
                gap: 0.4rem;
                font-size: 0.8rem;
                font-weight: 600;
                border: 1px solid var(--border-light);
            }
            .remove-field { cursor: pointer; color: var(--text-muted); font-size: 1rem; line-height: 1; }
            .field-dropdown {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: var(--bg-card);
                border: 1px solid var(--border-medium);
                border-radius: var(--radius-md);
                box-shadow: var(--shadow-lg);
                z-index: 100;
                padding: 0.75rem;
                width: 300px;
            }
            .field-option { 
                display: flex; 
                align-items: center; 
                gap: 0.75rem; 
                padding: 0.5rem 0.75rem; 
                cursor: pointer; 
                border-radius: 6px;
                transition: background 0.2s; 
                font-size: 0.85rem; 
                color: var(--text-primary); 
            }
            .field-option:hover { background: var(--bg-secondary); }
            .field-option input[type="checkbox"] { 
                cursor: pointer; 
                width: 16px !important; 
                height: 16px !important; 
                margin: 0;
                flex-shrink: 0;
            }

            .dropdown-btn {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0.5rem 0.75rem;
                border-radius: var(--radius-md);
                border: 1px solid var(--border-medium);
                background: var(--bg-input);
                color: var(--text-primary);
                font-size: 0.85rem;
                cursor: pointer;
                min-width: 180px;
                height: 2.75rem;
            }
            .pack-hint {
                margin: 0;
                font-size: 0.8rem;
                line-height: 1.5;
                color: var(--text-muted);
                border-left: 3px solid var(--accent-primary);
                padding-left: 0.75rem;
            }
        </style>
        <div class="reports-container">
            <div class="page-header">
                <h2>Reports & Exports</h2>
                <p class="subtitle">Generate and export cooperative financial and member data</p>
            </div>

            <div class="reports-controls">
                <div class="controls-grid">
                    <div class="control-group">
                        <label>Report Type</label>
                        <select id="report-type">
                            <option value="">Select Report Type...</option>
                            ${REPORT_TYPE_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
                        </select>
                    </div>
                    
                    <div class="control-group filter-eod-date-from" style="display: none;">
                        <label>Date From</label>
                        <input type="date" id="eod-date-from">
                    </div>
                    <div class="control-group filter-eod-date-to" style="display: none;">
                        <label>Date To</label>
                        <input type="date" id="eod-date-to">
                    </div>

                    <div class="control-group filter-personal-member" style="display: none;">
                        <label>Member</label>
                        <select id="personal-member">
                        </select>
                    </div>

                    <div class="control-group filter-networth-date" style="display: none;">
                        <label>As At Date</label>
                        <input type="date" id="networth-date">
                    </div>

                    <div class="control-group filter-schedule-type" style="display: none;">
                        <label>Schedule Type</label>
                        <select id="schedule-type">
                            <option value="positive">Deposit (+ve)</option>
                            <option value="negative">Loan (-ve)</option>
                        </select>
                    </div>

                    <div class="control-group filter-schedule-member-name" style="display: none;">
                        <label>Columns</label>
                        <label class="checkbox-item" for="schedule-show-member-name">
                            <input type="checkbox" id="schedule-show-member-name" checked>
                            <span>Show Member Name</span>
                        </label>
                    </div>

                    <div class="control-group filter-date" style="display: none;">
                        <label>Date From</label>
                        <input type="date" id="date-from">
                    </div>
                    <div class="control-group filter-date" style="display: none;">
                        <label>Date To</label>
                        <input type="date" id="date-to">
                    </div>

                    <div class="control-group filter-bank" style="display: none;">
                        <label>Bank</label>
                        <select id="bank-filter">
                            <option value="All">All Banks</option>
                        </select>
                    </div>

                    <div class="control-group filter-txn-type" style="display: none;">
                        <label>Transaction Type</label>
                        <select id="txn-type-filter">
                            <option value="All">All Types</option>
                        </select>
                    </div>

                    <div class="control-group filter-enterprise" style="display: none;">
                        <label>Enterprise</label>
                        <select id="ent-filter"></select>
                    </div>

                    <div class="control-group filter-advise-ent" style="display: none;">
                        <label>Enterprise</label>
                        <select id="advise-ent-filter">
                            <option value="">All Enterprises</option>
                        </select>
                    </div>

                    <div class="control-group filter-fiscal-year" style="display: none;">
                        <label>Fiscal Year</label>
                        <select id="fy-filter"></select>
                    </div>

                    <div class="control-group filter-ent-date" style="display: none;">
                        <label>Date From (optional)</label>
                        <input type="date" id="ent-date-from">
                    </div>
                    <div class="control-group filter-ent-date" style="display: none;">
                        <label>Date To (optional)</label>
                        <input type="date" id="ent-date-to">
                    </div>

                    <div class="control-group filter-ent-options" style="display: none;">
                        <label>Options</label>
                        <div class="field-checkbox-group" style="grid-template-columns: 1fr;">
                            <label class="checkbox-item"><input type="checkbox" id="ent-show-name"> Show member name</label>
                            <label class="checkbox-item"><input type="checkbox" id="ent-include-inactive"> Include inactive members</label>
                        </div>
                    </div>

                    <div class="control-group filter-monthly-summary-fy" style="display: none;">
                        <label>Fiscal Year</label>
                        <select id="monthly-summary-fy"></select>
                    </div>

                    <div class="control-group filter-monthly-summary-type" style="display: none;">
                        <label>Transaction Type</label>
                        <select id="monthly-summary-type">
                            <option value="cr">Cr (+ve)</option>
                            <option value="dr">Dr (-ve)</option>
                        </select>
                    </div>

                    <div class="control-group filter-schedule-month" style="display: none;">
                        <label>Month</label>
                        <select id="schedule-month">
                            ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => `<option value="${i + 1}" ${new Date().getMonth() === i ? 'selected' : ''}>${m}</option>`).join('')}
                        </select>
                    </div>

                    <div class="control-group filter-schedule-year" style="display: none;">
                        <label>Year</label>
                        <select id="schedule-year">
                            ${[0, 1, 2, 3, 4, 5].map(i => {
                                const y = new Date().getFullYear() - 2 + i;
                                return `<option value="${y}" ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`;
                            }).join('')}
                        </select>
                    </div>

                    <div class="control-group filter-member-status" style="display: none;">
                        <label>Status</label>
                        <select id="member-status">
                            <option value="All">All</option>
                            <option value="Active">Active</option>
                            <option value="Inactive">Inactive</option>
                            <option value="Suspended">Suspended</option>
                        </select>
                    </div>

                    <div id="member-fields-container" class="control-group" style="display: none; position: relative;">
                        <label>Include Fields</label>
                        <button class="dropdown-btn" id="field-dropdown-trigger">
                            <span id="field-trigger-text">Select Fields...</span>
                            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                        </button>
                        <div id="field-dropdown" class="field-dropdown hidden">
                            <!-- Rendered by renderFieldDropdown() -->
                        </div>
                    </div>

                    <div class="control-group">
                        <button id="btn-generate" class="btn-generate">Generate Preview</button>
                    </div>
                </div>
                <p id="pack-hint" class="pack-hint" style="display: none;">
                    The Accounting Pack is generated and downloaded as a single Excel workbook with ${SHEETS.length} worksheets,
                    including a Statement of Financial Position, an Income and Expenditure Statement, a Cash Flow Statement,
                    a full general ledger, a journal-entry balance proof and the control checks that tie them together.
                    There is no preview step — press the button once and the file is produced straight from the
                    approved records for the selected dates.
                </p>
            </div>

            <div class="reports-preview">
                <div class="preview-header">
                    <div class="preview-title" id="preview-title">Report Preview</div>
                    <div style="display: flex;">
                        <button id="btn-export" class="btn-export">Export to Excel</button>
                        <button id="btn-pdf" class="btn-pdf">Print to PDF</button>
                    </div>
                </div>
                <div class="preview-body" id="preview-body">
                    <div class="preview-placeholder">Select a report type and filters, then click Generate Preview</div>
                </div>
            </div>
        </div>
    `;

    const reportTypeSelect = container.querySelector('#report-type');
    const btnGenerate = container.querySelector('#btn-generate');
    const btnExport = container.querySelector('#btn-export');
    const btnPdf = container.querySelector('#btn-pdf');
    const previewBody = container.querySelector('#preview-body');
    const previewTitle = container.querySelector('#preview-title');

    // Restore State Helper — merge persisted state with defaults
    const _savedReports = loadPersisted('reports-state') || {};
    const reportsState = {
        type: _savedReports.type || user.reports?.type || '',
        filters: _savedReports.filters || user.reports?.filters || {},
        selectedFields: _savedReports.selectedFields || user.reports?.selectedFields || DEFAULT_MEMBER_FIELDS,
    };
    const filters = reportsState.filters || {};
    
    let selectedFieldKeys = reportsState.selectedFields || DEFAULT_MEMBER_FIELDS;
    let pendingFieldKeys = [...selectedFieldKeys]; // Temporary selection before apply
    
    const fieldOptions = memberFieldOptions();

    const renderFieldDropdown = () => {
        const dropdown = container.querySelector('#field-dropdown');
        if (!dropdown) return;

        const triggerText = container.querySelector('#field-trigger-text');
        if (triggerText) {
            triggerText.textContent = selectedFieldKeys.length > 0 
                ? `${selectedFieldKeys.length} Fields Selected` 
                : 'Select Fields...';
        }

        dropdown.innerHTML = `
            <div style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); margin-bottom: 0.75rem; text-transform: uppercase;">
                Select Fields
            </div>
            <div style="margin-bottom: 0.75rem;">
                <input type="text" id="field-dropdown-search" placeholder="Search fields..." 
                    style="width: 100%; padding: 0.4rem; border-radius: 4px; border: 1px solid var(--border-medium); font-size: 0.8rem; background: var(--bg-input); color: var(--text-primary);">
            </div>
            <div class="fields-list" style="max-height: 250px; overflow-y: auto; margin-bottom: 0.75rem;">
                <label class="field-option" data-key="all">
                    <input type="checkbox" id="field-chk-all" ${pendingFieldKeys.length === fieldOptions.length ? 'checked' : ''}>
                    <span style="font-weight: 700;">All Fields</span>
                </label>
                ${fieldOptions.map(f => `
                    <label class="field-option field-item" data-key="${f.key}" data-search="${f.label.toLowerCase()}">
                        <input type="checkbox" class="field-chk" value="${f.key}" ${pendingFieldKeys.includes(f.key) ? 'checked' : ''}>
                        <span>${escapeHtml(f.label)}</span>
                    </label>
                `).join('')}
            </div>
            <div style="display: flex; gap: 0.5rem;">
                <button class="primary-button" id="apply-fields" style="flex: 1; height: 1.85rem; font-size: 0.7rem; border-radius: 999px;">Apply</button>
                <button class="secondary-button" id="cancel-fields" style="flex: 1; height: 1.85rem; font-size: 0.7rem; border-radius: 999px; background: white; color: black;">Cancel</button>
            </div>
        `;

        const searchInput = dropdown.querySelector('#field-dropdown-search');
        searchInput?.addEventListener('input', (e) => {
            const val = e.target.value.toLowerCase();
            dropdown.querySelectorAll('.field-item').forEach(item => {
                const text = item.dataset.search || '';
                item.style.display = text.includes(val) ? 'flex' : 'none';
            });
        });

        dropdown.querySelector('#field-chk-all')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                // All selected -> prefer short_name over full_name
                pendingFieldKeys = fieldOptions.map(f => f.key).filter(k => k !== 'full_name');
            } else {
                pendingFieldKeys = [];
            }
            // Update individual checkboxes
            dropdown.querySelectorAll('.field-chk').forEach(cb => {
                cb.checked = pendingFieldKeys.includes(cb.value);
            });
        });

        dropdown.querySelectorAll('.field-chk').forEach(cb => {
            cb.addEventListener('change', () => {
                const key = cb.value;
                if (cb.checked) {
                    if (!pendingFieldKeys.includes(key)) {
                        // Conflict rule: Full Name vs Short Name
                        if (key === 'full_name') {
                            pendingFieldKeys = pendingFieldKeys.filter(k => k !== 'short_name');
                        } else if (key === 'short_name') {
                            pendingFieldKeys = pendingFieldKeys.filter(k => k !== 'full_name');
                        }
                        pendingFieldKeys.push(key);
                    }
                } else {
                    pendingFieldKeys = pendingFieldKeys.filter(k => k !== key);
                }
                
                // Re-sync all checkboxes for conflicts
                dropdown.querySelectorAll('.field-chk').forEach(chk => {
                    chk.checked = pendingFieldKeys.includes(chk.value);
                });

                // Update "All" checkbox
                const allChk = dropdown.querySelector('#field-chk-all');
                if (allChk) allChk.checked = pendingFieldKeys.length >= (fieldOptions.length - 1);
            });
        });

        dropdown.querySelector('#apply-fields')?.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedFieldKeys = [...pendingFieldKeys];
            dropdown.classList.add('hidden');
            if (triggerText) {
                triggerText.textContent = selectedFieldKeys.length > 0 
                    ? `${selectedFieldKeys.length} Fields Selected` 
                    : 'Select Fields...';
            }
            updateGlobalState();
            maybeAutoGenerate();
        });

        dropdown.querySelector('#cancel-fields')?.addEventListener('click', (e) => {
            e.stopPropagation();
            pendingFieldKeys = [...selectedFieldKeys];
            dropdown.classList.add('hidden');
        });
    };

    const trigger = container.querySelector('#field-dropdown-trigger');
    const menu = container.querySelector('#field-dropdown');
    
    trigger?.addEventListener('click', (e) => {
        e.stopPropagation();
        menu?.classList.toggle('hidden');
        if (!menu?.classList.contains('hidden')) {
            renderFieldDropdown();
            menu.querySelector('#field-dropdown-search')?.focus();
        }
    });

    // Bound once: per-render closures here stacked a document listener on
    // every Reports visit and retained the whole container in memory.
    if (!window._reportsFieldOutside) {
        window._reportsFieldOutside = (e) => {
            const m = document.getElementById('field-dropdown');
            if (m && !m.classList.contains('hidden') && !document.getElementById('member-fields-container')?.contains(e.target)) {
                m.classList.add('hidden');
            }
        };
        document.addEventListener('click', window._reportsFieldOutside);
    }

    const updateGlobalState = () => {
        const reportConfig = {
            type: reportTypeSelect.value,
            filters: {
                dateFrom: container.querySelector('#date-from').value,
                dateTo: container.querySelector('#date-to').value,
                bank: container.querySelector('#bank-filter').value,
                transactionType: container.querySelector('#txn-type-filter').value,
                enterprise: container.querySelector('#ent-filter').value,
                adviseEnterprise: container.querySelector('#advise-ent-filter').value,
                fiscalYear: container.querySelector('#fy-filter').value,
                entDateFrom: container.querySelector('#ent-date-from').value,
                entDateTo: container.querySelector('#ent-date-to').value,
                entShowName: container.querySelector('#ent-show-name').checked,
                entIncludeInactive: container.querySelector('#ent-include-inactive').checked,
                monthlySummaryFy: container.querySelector('#monthly-summary-fy').value,
                monthlySummaryType: container.querySelector('#monthly-summary-type').value,
                scheduleMonth: container.querySelector('#schedule-month').value,
                scheduleYear: container.querySelector('#schedule-year').value,
                scheduleType: container.querySelector('#schedule-type').value,
                scheduleShowMemberName: container.querySelector('#schedule-show-member-name').checked,
                memberStatus: container.querySelector('#member-status').value
            },
            selectedFields: selectedFieldKeys,
        };
        if (user.onReportsStateChange) {
            user.onReportsStateChange({ ...reportConfig, currentReportData });
        }
        // Persist report config (but not the large data) so refresh restores choices
        persistState('reports-state', reportConfig);
    };

    // Populate Banks
    const banks = await fetchBanks(cooperativeId);
    const bankFilter = container.querySelector('#bank-filter');
    banks.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.bank_name;
        opt.textContent = b.bank_name;
        if (filters.bank === b.bank_name) opt.selected = true;
        bankFilter.appendChild(opt);
    });

    // Populate transaction types for the Transaction Journal filter
    const txnTypeFilter = container.querySelector('#txn-type-filter');
    try {
        const txnTypes = await getTransactionTypes(cooperativeId);
        txnTypes.filter(t => t.is_active !== 0 && t.is_active !== false).forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.transaction_type;
            opt.textContent = t.transaction_type;
            txnTypeFilter.appendChild(opt);
        });
    } catch (e) {
        console.warn('Failed to load transaction types:', e);
    }
    if (filters.transactionType && [...txnTypeFilter.options].some(o => o.value === filters.transactionType)) {
        txnTypeFilter.value = filters.transactionType;
    }

    // Populate Enterprises for enterprise_account
    const enterprises = await fetchEnterprises(cooperativeId, true);
    const entFilter = container.querySelector('#ent-filter');
    enterprises.sort((a, b) => a.account_name.localeCompare(b.account_name)).forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.account_name;
        if (filters.enterprise === e.id) opt.selected = true;
        entFilter.appendChild(opt);
    });

    // Populate Enterprises for the Payment Advice matrix (All Enterprises default)
    const adviseEntFilter = container.querySelector('#advise-ent-filter');
    enterprises.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.account_name;
        adviseEntFilter.appendChild(opt);
    });
    
    // Populate Members for Member Account Statement
    const members = await fetchAllMembers(cooperativeId, user.username, user.role === 'admin' || (user.permissions || '').includes('admin'));
    const memberFilter = container.querySelector('#personal-member');
    members.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (Reg: ${m.registration_no ? String(m.registration_no).padStart(4, '0') : 'N/A'})`;
        memberFilter.appendChild(opt);
    });

    // Status options come from the data, so every status actually in use can be
    // filtered (Member Register and Payment Advice both key off this select).
    const statusFilter = container.querySelector('#member-status');
    const statuses = [...new Set(members.map(m => m.status).filter(Boolean))].sort();
    if (filters.memberStatus && filters.memberStatus !== 'All' && !statuses.includes(filters.memberStatus)) {
        statuses.push(filters.memberStatus);
    }
    statusFilter.innerHTML = ['All', ...statuses]
        .map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
        .join('');
    
    // Set default EOD dates to today
    const today = new Date().toISOString().split('T')[0];
    container.querySelector('#eod-date-from').value = today;
    container.querySelector('#eod-date-to').value = today;

    // Populate Fiscal Years
    const fyFilter = container.querySelector('#fy-filter');
    const currentYear = new Date().getFullYear();
    for (let i = -2; i <= 2; i++) {
        const y = currentYear + i;
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = `${y}/${y+1}`;
        if (filters.fiscalYear ? (filters.fiscalYear == y) : (y === currentYear)) opt.selected = true;
        fyFilter.appendChild(opt);
    }

    // Populate Fiscal Years for Member Monthly Summary
    const monthlySummaryFyFilter = container.querySelector('#monthly-summary-fy');
    let coopFirstMonth = 1;
    try {
        const coopRows = await queryRows("SELECT coop_first_month FROM cooperatives WHERE id=?", [cooperativeId]);
        if (coopRows[0]?.coop_first_month) {
            const parts = String(coopRows[0].coop_first_month).split('-');
            coopFirstMonth = parseInt(parts[1]) || 1;
        }
    } catch (e) {
        console.warn('Failed to fetch coop_first_month:', e);
    }
    const useSlashFormat = coopFirstMonth !== 1;
    for (let i = -2; i <= 2; i++) {
        const y = currentYear + i;
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = useSlashFormat ? `${y}/${y+1}` : `${y}`;
        if (filters.monthlySummaryFy ? (filters.monthlySummaryFy == y) : (y === currentYear)) opt.selected = true;
        monthlySummaryFyFilter.appendChild(opt);
    }

    // Set other filters
    if (reportsState.type) reportTypeSelect.value = reportsState.type;
    if (filters.dateFrom) container.querySelector('#date-from').value = filters.dateFrom;
    if (filters.dateTo) container.querySelector('#date-to').value = filters.dateTo;
    if (filters.scheduleMonth) container.querySelector('#schedule-month').value = filters.scheduleMonth;
    if (filters.scheduleYear) container.querySelector('#schedule-year').value = filters.scheduleYear;
    if (filters.scheduleType) container.querySelector('#schedule-type').value = filters.scheduleType;
    // Defaults to shown, so state saved before this toggle existed keeps the name column.
    container.querySelector('#schedule-show-member-name').checked = filters.scheduleShowMemberName !== false;
    if (filters.memberStatus) container.querySelector('#member-status').value = filters.memberStatus;
    if (filters.adviseEnterprise && [...adviseEntFilter.options].some(o => o.value === filters.adviseEnterprise)) {
        adviseEntFilter.value = filters.adviseEnterprise;
    }
    if (filters.entDateFrom) container.querySelector('#ent-date-from').value = filters.entDateFrom;
    if (filters.entDateTo) container.querySelector('#ent-date-to').value = filters.entDateTo;
    container.querySelector('#ent-show-name').checked = !!filters.entShowName;
    container.querySelector('#ent-include-inactive').checked = !!filters.entIncludeInactive;
    if (filters.monthlySummaryType) container.querySelector('#monthly-summary-type').value = filters.monthlySummaryType;
    
    // Report results are never persisted (they are large), so the preview always
    // starts empty on a fresh visit.
    let currentReportData = null;

    const buildCtx = () => ({
        cooperativeId,
        cooperativeFullName,
        user,
        selectedFields: selectedFieldKeys,
        read: (sel) => container.querySelector(sel)?.value ?? '',
        el: (sel) => container.querySelector(sel)
    });

    const updateUIForType = () => {
        const cfg = REPORT_TYPES[reportTypeSelect.value];

        REPORT_TYPE_FILTER_GROUPS.forEach(sel => {
            container.querySelectorAll(sel).forEach(el => { el.style.display = 'none'; });
        });
        (cfg?.filterGroups || []).forEach(sel => {
            container.querySelectorAll(sel).forEach(el => { el.style.display = 'flex'; });
        });

        cfg?.prefill?.(buildCtx());

        const triggerText = container.querySelector('#field-trigger-text');
        if (triggerText) {
            triggerText.textContent = selectedFieldKeys.length > 0 
                ? `${selectedFieldKeys.length} Fields Selected` 
                : 'Select Fields...';
        }

        // The Accounting Pack is produced directly as a workbook, so it needs
        // no preview surface and no separate export buttons.
        btnGenerate.textContent = cfg?.buttonLabel || 'Generate Preview';
        const packHint = container.querySelector('#pack-hint');
        if (packHint) packHint.style.display = cfg?.showHint ? 'block' : 'none';
        if (cfg?.directDownload) {
            btnExport.style.display = 'none';
            btnPdf.style.display = 'none';
        }
    };

    // Types flagged autoGenerate (Member Register) refresh themselves when a
    // filter or field selection changes, so the preview never goes stale.
    const maybeAutoGenerate = () => {
        if (REPORT_TYPES[reportTypeSelect.value]?.autoGenerate) btnGenerate.click();
    };

    updateUIForType();

    // Wrap all date inputs to show DD MMM, YYYY format
    container.querySelectorAll('input[type="date"]').forEach(wrapDateInput);

    // Add listeners to all controls for state update
    container.querySelectorAll('select, input').forEach(el => {
        el.addEventListener('change', updateGlobalState);
    });
    container.querySelector('#member-status')?.addEventListener('change', maybeAutoGenerate);

    reportTypeSelect.addEventListener('change', () => {
        updateUIForType();
        const cfg = REPORT_TYPES[reportTypeSelect.value];
        btnExport.style.display = 'none';
        btnPdf.style.display = 'none';
        previewBody.innerHTML = cfg?.directDownload
            ? '<div class="preview-placeholder">The Accounting Pack has no preview. Choose your dates and press Generate Accounting Pack to download the workbook.</div>'
            : '<div class="preview-placeholder">Select filters and click Generate Preview</div>';
        previewTitle.textContent = 'Report Preview';
        currentReportData = null;
        updateGlobalState();
        if (cfg?.autoGenerate) btnGenerate.click();
    });

    btnGenerate.addEventListener('click', async () => {
        const type = reportTypeSelect.value;
        if (!type) return showToast('Please select a report type', 'warning');
        const cfg = REPORT_TYPES[type];
        if (!cfg) return showToast('Unknown report type', 'warning');

        const ctx = buildCtx();
        const validationError = cfg.validate ? cfg.validate(ctx) : null;
        if (validationError) return showToast(validationError, 'warning');
        if (cfg.fieldPicker && selectedFieldKeys.length === 0) {
            return showToast('Select at least one field to include', 'warning');
        }

        // Accounting Pack: build and download the workbook in one action.
        // No preview is produced and no separate export step is offered.
        if (cfg.directDownload) {
            const dateFrom = ctx.read('#date-from');
            const dateTo = ctx.read('#date-to');

            const originalText = btnGenerate.textContent;
            btnGenerate.textContent = 'Building workbook...';
            btnGenerate.disabled = true;
            try {
                const pack = await buildAccountingPack({
                    cooperativeId,
                    startDate: dateFrom,
                    endDate: dateTo,
                    cooperativeName: cooperativeFullName,
                    generatedBy: user.username || user.fullName || 'System'
                });
                const info = await exportAccountingPack(pack);
                const failed = pack.controlChecks.filter(c => c.status === 'REVIEW');
                showToast(
                    `Accounting Pack downloaded (${info.sheets} sheets, ${pack.meta.postedRows} transactions).`
                    + (failed.length
                        ? ` ${failed.length} control check${failed.length > 1 ? 's' : ''} need review — see the Control Checks sheet.`
                        : ' All control checks passed.'),
                    failed.length ? 'warning' : 'success'
                );
            } catch (err) {
                console.error(err);
                showToast('Accounting Pack failed: ' + err.message, 'error');
            } finally {
                btnGenerate.textContent = originalText;
                btnGenerate.disabled = false;
            }
            return;
        }

        previewBody.innerHTML = '<div class="preview-placeholder">Generating report...</div>';
        btnExport.style.display = 'none';
        btnPdf.style.display = 'none';

        try {
            const result = await cfg.build(ctx);

            if (!result || !result.data || result.data.length === 0) {
                previewBody.innerHTML = '<div class="preview-placeholder">No data found for the selected criteria</div>';
                return;
            }

            const title = cfg.title || result.title || 'Report';
            currentReportData = { ...result, title };
            previewTitle.textContent = title;
            btnExport.style.display = 'block';
            btnPdf.style.display = 'block';
            renderPreviewTable(result.headers, result.data, result.footerCount || 0);
            updateGlobalState();

        } catch (err) {
            console.error(err);
            previewBody.innerHTML = `<div class="preview-placeholder" style="color: var(--danger)">Error: ${err.message}</div>`;
        }
    });

    btnExport.addEventListener('click', async () => {
        if (!currentReportData) return;
        const originalText = btnExport.textContent;
        btnExport.textContent = 'Exporting...';
        btnExport.disabled = true;
        try {
            await exportToExcel(cooperativeFullName, currentReportData.title, currentReportData.headers, currentReportData.data);
            showToast('Excel export completed successfully!', 'success');
        } catch (err) {
            showToast('Export failed: ' + err.message, 'error');
        } finally {
            btnExport.textContent = originalText;
            btnExport.disabled = false;
        }
    });

    btnPdf.addEventListener('click', async () => {
        if (!currentReportData) return;
        const originalText = btnPdf.textContent;
        btnPdf.textContent = 'Printing...';
        btnPdf.disabled = true;
        try {
            const type = reportTypeSelect.value;
            await exportToPDF(
                cooperativeFullName, 
                currentReportData.title, 
                currentReportData.headers, 
                currentReportData.data,
                'l', // Landscape
                user.username,
                type === 'enterprise_account' || type === 'payment_advise'
            );
            showToast('PDF print completed successfully!', 'success');
        } catch (err) {
            showToast('PDF Print failed: ' + err.message, 'error');
        } finally {
            btnPdf.textContent = originalText;
            btnPdf.disabled = false;
        }
    });

    const previewView = { page: 1, search: '', sortIdx: null, sortDir: 1, footerCount: 0 };
    let previewSource = { headers: [], data: [], footerCount: 0 };
    let previewSearchTimer = null;

    const previewCells = (row, headers) => (Array.isArray(row) ? row : headers.map(h => row[h]));

    const comparePreviewValues = (a, b) => {
        const sa = String(a ?? '').trim();
        const sb = String(b ?? '').trim();
        const na = sa === '' ? NaN : Number(sa);
        const nb = sb === '' ? NaN : Number(sb);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
    };

    const isTotalRow = (cells) => typeof cells[0] === 'string' && /^total\b/i.test(cells[0].trim());

    function renderPreviewTable(headers, data, footerCount = 0) {
        previewView.page = 1;
        previewView.search = '';
        previewView.sortIdx = null;
        previewView.sortDir = 1;
        renderPreviewGrid(headers, data, footerCount);
    }

    function renderPreviewGrid(headers, data, footerCount = 0) {
        previewSource = { headers, data, footerCount };
        previewView.footerCount = footerCount;

        const bodyEnd = Math.max(0, data.length - footerCount);
        const body = data.slice(0, bodyEnd);
        const footerRows = data.slice(bodyEnd);

        const query = previewView.search.trim().toLowerCase();
        const matches = query
            ? body.filter(row => previewCells(row, headers).some(v => String(v ?? '').toLowerCase().includes(query)))
            : body;

        const totalPages = Math.max(1, Math.ceil(matches.length / PREVIEW_PAGE_SIZE));
        if (previewView.page > totalPages) previewView.page = totalPages;
        const start = (previewView.page - 1) * PREVIEW_PAGE_SIZE;
        const pageRows = matches.slice(start, start + PREVIEW_PAGE_SIZE);

        if (!previewBody.querySelector('#preview-toolbar')) {
            previewBody.innerHTML = `
                <div id="preview-toolbar">
                    <div style="display: flex; align-items: center; gap: 0.75rem;">
                        <input id="preview-search" type="search" placeholder="Search rows..." autocomplete="off">
                        <span id="preview-count" style="font-size: 0.75rem; color: var(--text-muted);"></span>
                    </div>
                    <div id="preview-pager" style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted);">
                        <button id="preview-prev" type="button" aria-label="Previous page">&#8249;</button>
                        <span id="preview-page-info"></span>
                        <button id="preview-next" type="button" aria-label="Next page">&#8250;</button>
                    </div>
                </div>
                <div id="preview-table-wrap"></div>
            `;

            const searchInput = previewBody.querySelector('#preview-search');
            searchInput.value = previewView.search;
            searchInput.addEventListener('input', () => {
                clearTimeout(previewSearchTimer);
                previewSearchTimer = setTimeout(() => {
                    previewView.search = searchInput.value;
                    previewView.page = 1;
                    const src = previewSource;
                    renderPreviewGrid(src.headers, src.data, src.footerCount);
                }, 150);
            });

            previewBody.querySelector('#preview-prev').addEventListener('click', () => {
                if (previewView.page <= 1) return;
                previewView.page -= 1;
                const src = previewSource;
                renderPreviewGrid(src.headers, src.data, src.footerCount);
            });
            previewBody.querySelector('#preview-next').addEventListener('click', () => {
                previewView.page += 1;
                const src = previewSource;
                renderPreviewGrid(src.headers, src.data, src.footerCount);
            });
        }

        const countEl = previewBody.querySelector('#preview-count');
        countEl.textContent = query
            ? `${formatNumber(matches.length)} of ${formatNumber(body.length)} rows match`
            : `${formatNumber(body.length)} rows`;

        const pager = previewBody.querySelector('#preview-pager');
        pager.style.display = totalPages > 1 ? 'flex' : 'none';
        previewBody.querySelector('#preview-page-info').textContent = `Page ${previewView.page} of ${totalPages}`;
        previewBody.querySelector('#preview-prev').disabled = previewView.page <= 1;
        previewBody.querySelector('#preview-next').disabled = previewView.page >= totalPages;

        let html = `
            <table class="styled-table" style="width: auto !important; min-width: 100% !important; border-collapse: separate !important;">
                <thead>
                    <tr>
                        ${headers.map((h, i) => {
                            const arrow = previewView.sortIdx === i ? (previewView.sortDir === 1 ? ' &#9650;' : ' &#9660;') : '';
                            return `<th data-sort-idx="${i}" title="Click to sort" style="white-space: nowrap !important; word-break: keep-all !important; overflow-wrap: normal !important;">${escapeHtml(h).replace(/ /g, '&nbsp;')}${arrow}</th>`;
                        }).join('')}
                    </tr>
                </thead>
                <tbody>
        `;

        const renderRows = (rows) => rows.map(row => {
            const rowArray = Array.isArray(row) ? row : headers.map(h => row[h]);
            return `
                <tr>
                    ${rowArray.map((val, idx) => {
                        const header = headers[idx];
                        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        const commonAmountHeaders = ['Amount', 'Total', 'Principal', 'Bal B/F', 'DR', 'CR', 'BL', 'Balance'];
                        const isAmount = typeof val === 'number' || ((val !== null && val !== undefined && val !== '') && (commonAmountHeaders.includes(header) || monthNames.includes(header)));

                        const shouldWrap = header === 'Description' || header === 'Notes' || header === 'Note';

                        // Force no-wrap on all non-wrap-friendly cells globally with !important
                        const baseStyle = shouldWrap
                            ? 'white-space: normal !important; word-break: break-word !important; min-width: 150px; max-width: 250px;'
                            : 'white-space: nowrap !important; word-break: keep-all !important; overflow-wrap: normal !important;';

                        if (isAmount) {
                            const numVal = (val === null || val === undefined || val === '') ? 0 : Number(val);
                            const formatted = isNaN(numVal) ? escapeHtml(String(val)).replace(/ /g, '&nbsp;') : formatNumber(numVal).replace(/ /g, '&nbsp;');
                            const style = `style="${baseStyle} ${!isNaN(numVal) && numVal < 0 ? 'color: #dc2626; font-weight: 700;' : ''} text-align: right;"`;
                            return `<td ${style}>${formatted}</td>`;
                        }

                        const rawText = String(val ?? '');
                        const text = shouldWrap ? escapeHtml(rawText) : escapeHtml(rawText).replace(/ /g, '&nbsp;');
                        return `<td style="${baseStyle}">${text}</td>`;
                    }).join('')}
                </tr>
            `;
        }).join('');

        if (pageRows.length === 0) {
            html += `
                <tr>
                    <td colspan="${headers.length}" style="white-space: normal !important; text-align: center; font-style: italic; color: var(--text-muted); padding: 0.7rem;">
                        No rows match your search.
                    </td>
                </tr>
            `;
        } else {
            html += renderRows(pageRows);
        }

        html += renderRows(footerRows);

        html += `
                </tbody>
            </table>
        `;

        const wrap = previewBody.querySelector('#preview-table-wrap');
        wrap.innerHTML = html;
        wrap.querySelectorAll('th[data-sort-idx]').forEach(th => {
            th.addEventListener('click', () => sortPreview(parseInt(th.dataset.sortIdx, 10)));
        });
    }

    // Sorting reorders the stored result so Excel/PDF exports match what the
    // preview shows. Total rows stay pinned to the bottom.
    function sortPreview(idx) {
        const { headers, data, footerCount } = previewSource;
        if (previewView.sortIdx === idx) {
            previewView.sortDir = -previewView.sortDir;
        } else {
            previewView.sortIdx = idx;
            previewView.sortDir = 1;
        }

        const bodyEnd = Math.max(0, data.length - footerCount);
        const decorated = data.slice(0, bodyEnd).map(row => ({ row, cells: previewCells(row, headers) }));
        decorated.sort((a, b) => {
            const aTotal = isTotalRow(a.cells);
            const bTotal = isTotalRow(b.cells);
            if (aTotal !== bTotal) return aTotal ? 1 : -1;
            if (aTotal) return 0;
            return comparePreviewValues(a.cells[idx], b.cells[idx]) * previewView.sortDir;
        });

        previewSource = {
            ...previewSource,
            data: [...decorated.map(d => d.row), ...data.slice(bodyEnd)]
        };
        currentReportData.data = previewSource.data;
        if (user.onReportsStateChange) {
            user.onReportsStateChange({ currentReportData });
        }
        renderPreviewGrid(previewSource.headers, previewSource.data, footerCount);
    }
}
