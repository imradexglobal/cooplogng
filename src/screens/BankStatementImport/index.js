import { escapeHtml, escapeAttribute, formatCurrency, formatDate } from '../../utils/formatters.js';
import { fetchBanks, fetchAllMembers, fetchEnterprises, fetchTransactionTypes } from '../../services/dataService.js';
import { extractTransactionsFromFile } from '../../services/bankStatement/extractor.js';
import { classifyTransaction, matchMember, normalizeText } from '../../services/bankStatement/intelligence.js';
import { detectDuplicates } from '../../services/bankStatement/duplicateDetector.js';
import { filterStatementTransactions } from '../../services/bankStatement/reviewFilters.js';
import { commitStatementImport } from '../../services/bankStatement/importer.js';
import { loadStatementDraft, saveStatementDraft, clearStatementDraft } from '../../services/bankStatement/statementDraftService.js';
import { showToast } from '../../services/toastService.js';

export async function renderBankStatementImport(container, user) {
    if (!container) return;
    const coopId = user?.cooperativeId;
    const userId = user?.userId || user?.username || 'admin';

    // State for the dedicated import page
    const state = {
        step: 'upload', // 'upload' | 'analyzing' | 'review' | 'success'
        banks: [],
        members: [],
        enterprises: [],
        loanEnterprises: [],
        transactionTypes: [],
        selectedBank: '',
        selectedFile: null,
        pdfPassword: '',
        fileName: '',
        fileSize: 0,
        transactions: [],
        filter: 'all',
        searchTerm: '',
        activeEditRow: null,
        isCommitting: false,
        importSummary: null,
        extractionInfo: null,
        hasSavedDraft: false,
        savedDraftData: null,
        draftUpdatedAt: null,
        lastSaved: null,
        sortKey: null,
        sortDirection: 'asc',
        tableScrollTop: 0,
        tableScrollLeft: 0
    };

    const reviewSessionKey = `bank_statement_review_active:${String(coopId || '')}:${String(userId || 'unknown')}`;
    let draftSaveTimer = null;

    function setReviewSessionActive(active) {
        try {
            if (active) sessionStorage.setItem(reviewSessionKey, '1');
            else sessionStorage.removeItem(reviewSessionKey);
        } catch (_) {}
    }

    function isReviewSessionActive() {
        try {
            return sessionStorage.getItem(reviewSessionKey) === '1';
        } catch (_) {
            return false;
        }
    }

    function restoreReviewDraft(draft) {
        state.selectedBank = draft.selectedBank || (state.banks[0]?.bank_name || '');
        state.fileName = draft.fileName || 'bank_statement';
        state.fileSize = Number(draft.fileSize) || 0;
        state.transactions = Array.isArray(draft.transactions) ? draft.transactions : [];
        state.extractionInfo = draft.extractionInfo || null;
        state.filter = ['all', 'confident', 'uncertain', 'unknown', 'expense', 'income', 'loan', 'duplicates'].includes(draft.filter)
            ? draft.filter
            : 'all';
        state.searchTerm = String(draft.searchTerm || '');
        state.sortKey = draft.sortKey || null;
        state.sortDirection = draft.sortDirection === 'desc' ? 'desc' : 'asc';
        state.tableScrollTop = Math.max(0, Number(draft.tableScrollTop) || 0);
        state.tableScrollLeft = Math.max(0, Number(draft.tableScrollLeft) || 0);
        state.lastSaved = draft.updated_at ? new Date(draft.updated_at) : null;
        state.step = 'review';
        state.hasSavedDraft = false;
    }

    container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:60vh;color:var(--text-muted);font-size:1rem;">
            <div style="width:36px;height:36px;border:3px solid var(--border-medium);border-top-color:var(--accent-primary);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:12px;"></div>
            Loading Bank Statement Import channel...
            <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        </div>
    `;

    try {
        // Load dependencies in parallel
        const [banks, members, enterprises, transactionTypes] = await Promise.all([
            fetchBanks(coopId).catch(() => []),
            fetchAllMembers(coopId).catch(() => []),
            fetchEnterprises(coopId, true).catch(() => []),
            fetchTransactionTypes(coopId).catch(() => [])
        ]);

        state.banks = banks || [];
        state.members = members || [];
        state.enterprises = enterprises || [];
        state.loanEnterprises = (enterprises || []).filter(e => String(e.account_type || '').toLowerCase() === 'loan');
        state.transactionTypes = transactionTypes || [];

        // Check for saved in-progress draft
        const draft = await loadStatementDraft(coopId, userId);
        if (draft && draft.transactions && draft.transactions.length > 0) {
            state.hasSavedDraft = true;
            state.draftUpdatedAt = draft.updated_at;
            state.savedDraftData = draft;
            if (isReviewSessionActive()) restoreReviewDraft(draft);
        }

        renderMain();
    } catch (err) {
        container.innerHTML = `
            <div style="padding:2rem;color:var(--danger);background:var(--danger-bg);border:1px solid var(--danger);border-radius:0.75rem;margin:2rem auto;max-width:600px;text-align:center;">
                <h3>Error Loading Statement Import</h3>
                <p>${escapeHtml(err.message || 'Failed to initialize channel')}</p>
                <button type="button" class="btn btn-secondary" onclick="window.location.reload()" style="margin-top:1rem;">Retry</button>
            </div>
        `;
    }

    function autoSave() {
        if (state.step === 'review' && state.transactions.length > 0) {
            saveStatementDraft(coopId, userId, {
                step: state.step,
                selectedBank: state.selectedBank,
                fileName: state.fileName,
                fileSize: state.fileSize,
                transactions: state.transactions,
                extractionInfo: state.extractionInfo,
                filter: state.filter,
                searchTerm: state.searchTerm,
                sortKey: state.sortKey,
                sortDirection: state.sortDirection,
                tableScrollTop: state.tableScrollTop,
                tableScrollLeft: state.tableScrollLeft
            }).then(() => {
                state.lastSaved = new Date();
                updateSaveIndicator();
            }).catch(e => console.warn('Draft save error:', e));
        }
    }

    function scheduleAutoSave() {
        if (draftSaveTimer) clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => {
            draftSaveTimer = null;
            autoSave();
        }, 250);
    }

    window.addEventListener('hashchange', () => {
        if (draftSaveTimer) {
            clearTimeout(draftSaveTimer);
            draftSaveTimer = null;
        }
        autoSave();
    }, { once: true, capture: true });

    function updateSaveIndicator() {
        const ind = document.getElementById('bsi-save-indicator');
        if (ind && state.lastSaved) {
            const timeStr = state.lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            ind.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--success);margin-right:6px;"></span>Auto-saved at ${timeStr}`;
        }
    }

    function captureTableScroll() {
        const tableWrap = container.querySelector('.bsi-table-wrap');
        if (!tableWrap) return;
        state.tableScrollTop = tableWrap.scrollTop;
        state.tableScrollLeft = tableWrap.scrollLeft;
    }

    function restoreTableScroll() {
        if (state.step !== 'review') return;
        requestAnimationFrame(() => {
            const tableWrap = container.querySelector('.bsi-table-wrap');
            if (!tableWrap) return;
            tableWrap.scrollTop = state.tableScrollTop;
            tableWrap.scrollLeft = state.tableScrollLeft;
        });
    }

    function setSort(key) {
        captureTableScroll();
        if (state.sortKey === key) {
            state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            state.sortKey = key;
            state.sortDirection = 'asc';
        }
        renderMain();
        autoSave();
    }

    function renderMain() {
        captureTableScroll();
        container.innerHTML = `
            <style>
                .bsi-shell {
                    padding: 1.5rem;
                    background: var(--bg-main);
                    min-height: calc(100vh - 60px);
                    font-family: 'Inter', system-ui, -apple-system, sans-serif;
                    box-sizing: border-box;
                }
                .bsi-card {
                    background: var(--bg-card);
                    border: 1px solid var(--border-light);
                    border-radius: var(--radius-lg);
                    box-shadow: var(--shadow-sm);
                    padding: 1.5rem;
                }
                .bsi-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1.5rem;
                    flex-wrap: wrap;
                    gap: 1rem;
                }
                .bsi-title {
                    font-size: 1.4rem;
                    font-weight: 800;
                    color: var(--text-primary);
                    margin: 0;
                    letter-spacing: -0.02em;
                }
                .bsi-subtitle {
                    font-size: 0.85rem;
                    color: var(--text-muted);
                    margin: 0.25rem 0 0 0;
                }
                .bsi-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.35rem;
                    padding: 0.25rem 0.65rem;
                    border-radius: 999px;
                    font-size: 0.75rem;
                    font-weight: 700;
                    text-transform: uppercase;
                }
                .bsi-badge-pending { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning); }
                .bsi-badge-high { background: var(--success-bg); color: var(--success); }
                .bsi-badge-low { background: var(--warning-bg); color: var(--warning); }
                .bsi-badge-none { background: var(--bg-secondary); color: var(--text-muted); }
                .bsi-badge-dup-new { background: var(--success-bg); color: var(--success); }
                .bsi-badge-dup-possible { background: var(--warning-bg); color: var(--warning); border: 1px solid var(--warning); }
                .bsi-badge-dup-confirmed { background: var(--danger-bg); color: var(--danger); border: 1px solid var(--danger); }
                
                .bsi-stats-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 0.85rem;
                    margin-bottom: 1.25rem;
                }
                .bsi-stat-card {
                    background: var(--bg-card);
                    border: 1px solid var(--border-light);
                    border-radius: var(--radius-md);
                    padding: 0.9rem 1.1rem;
                    box-shadow: var(--shadow-sm);
                    position: relative;
                    overflow: hidden;
                }
                .bsi-stat-card::before {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; width: 4px; height: 100%;
                    background: var(--border-medium);
                }
                .bsi-stat-card.stat-cr::before { background: var(--success); }
                .bsi-stat-card.stat-dr::before { background: var(--danger); }
                .bsi-stat-card.stat-warn::before { background: var(--warning); }
                .bsi-stat-card.stat-accent::before { background: var(--accent-primary); }
                
                .bsi-stat-label {
                    font-size: 0.72rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    color: var(--text-muted);
                    letter-spacing: 0.05em;
                }
                .bsi-stat-val {
                    font-size: 1.35rem;
                    font-weight: 800;
                    color: var(--text-primary);
                    margin-top: 0.25rem;
                    font-variant-numeric: tabular-nums;
                }
                
                .bsi-table-wrap {
                    overflow-x: auto;
                    max-height: 60vh;
                    border: 1px solid var(--border-light);
                    border-radius: var(--radius-md);
                    background: var(--bg-card);
                }
                .bsi-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 0.82rem;
                    text-align: left;
                }
                .bsi-table th {
                    position: sticky;
                    top: 0;
                    background: var(--bg-secondary);
                    color: var(--text-secondary);
                    padding: 0.75rem 0.85rem;
                    font-size: 0.72rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    border-bottom: 1px solid var(--border-medium);
                    white-space: nowrap;
                    z-index: 2;
                }
                .bsi-sort-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3rem;
                    padding: 0;
                    border: 0;
                    background: transparent;
                    color: inherit;
                    font: inherit;
                    text-transform: inherit;
                    letter-spacing: inherit;
                    cursor: pointer;
                }
                .bsi-sort-btn:hover { color: var(--accent-primary); }
                .bsi-sort-indicator { font-size: 0.72rem; opacity: 0.7; }
                .bsi-table td {
                    padding: 0.7rem 0.85rem;
                    border-bottom: 1px solid var(--border-light);
                    color: var(--text-primary);
                    vertical-align: middle;
                }
                .bsi-table tr:hover td {
                    background: var(--bg-secondary);
                }
                .bsi-table tr.row-excluded td {
                    opacity: 0.5;
                    background: var(--bg-secondary);
                }
                
                .bsi-filter-bar {
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                    flex-wrap: wrap;
                    margin-bottom: 1rem;
                }
                .bsi-filter-btn {
                    padding: 0.45rem 0.85rem;
                    border-radius: var(--radius-sm);
                    border: 1px solid var(--border-medium);
                    background: var(--bg-card);
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.15s ease;
                }
                .bsi-filter-btn.active {
                    background: var(--accent-primary);
                    color: #fff;
                    border-color: var(--accent-primary);
                }
                .bsi-filter-btn:hover:not(.active) {
                    background: var(--bg-secondary);
                }
                
                .bsi-upload-zone {
                    border: 2px dashed var(--border-medium);
                    border-radius: var(--radius-lg);
                    padding: 3.5rem 2rem;
                    text-align: center;
                    cursor: pointer;
                    background: var(--bg-secondary);
                    transition: all 0.2s ease;
                }
                .bsi-upload-zone:hover, .bsi-upload-zone.dragover {
                    border-color: var(--accent-primary);
                    background: var(--accent-soft);
                }
                
                .btn {
                    padding: 0.65rem 1.25rem;
                    border-radius: var(--radius-sm);
                    font-weight: 700;
                    cursor: pointer;
                    font-size: 0.85rem;
                    border: none;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.45rem;
                    transition: all 0.15s ease;
                }
                .btn-primary { background: var(--accent-primary); color: white; }
                .btn-primary:hover { background: var(--accent-hover); }
                .btn-secondary { background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border-strong); }
                .btn-secondary:hover { background: var(--bg-secondary); }
                .btn-danger { background: var(--danger-bg); color: var(--danger); border: 1px solid var(--danger); }
                .btn-danger:hover { background: var(--danger); color: white; }
                .btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border-light); }
                .btn-ghost:hover { background: var(--bg-secondary); color: var(--text-primary); }
                .btn:disabled { opacity: 0.55; cursor: not-allowed; }
            </style>

            <div class="bsi-shell">
                ${state.step === 'upload' ? renderUploadView() : ''}
                ${state.step === 'analyzing' ? renderAnalyzingView() : ''}
                ${state.step === 'review' ? renderReviewView() : ''}
                ${state.step === 'success' ? renderSuccessView() : ''}
            </div>

            <!-- Edit Row Mapping Modal -->
            <div id="bsi-edit-modal-wrap"></div>
        `;

        bindEvents();
        restoreTableScroll();
    }

    function renderUploadView() {
        return `
            <div class="bsi-card" style="max-width: 820px; margin: 0 auto;">
                <div class="bsi-header">
                    <div>
                        <h1 class="bsi-title">Bank Statement Import</h1>
                        <p class="bsi-subtitle">Intelligent Bank Statement Remittance Channel for CoopLog</p>
                    </div>
                    <span class="bsi-badge bsi-badge-pending">Pending Approval Workflow</span>
                </div>

                ${state.hasSavedDraft ? `
                    <div style="background: var(--accent-soft); border: 1.5px solid var(--accent-primary); border-radius: var(--radius-md); padding: 1.1rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.8rem;">
                        <div>
                            <div style="font-weight: 700; color: var(--accent-primary); font-size: 0.95rem;">
                                In-Progress Import Session Found
                            </div>
                            <div style="font-size: 0.82rem; color: var(--text-secondary); margin-top: 0.25rem;">
                                File: <strong>${escapeHtml(state.savedDraftData.fileName || 'bank statement')}</strong> (${state.savedDraftData.transactions?.length || 0} transactions) &middot; Last updated: ${state.draftUpdatedAt ? new Date(state.draftUpdatedAt).toLocaleString() : 'recently'}
                            </div>
                        </div>
                        <div style="display: flex; gap: 0.5rem;">
                            <button type="button" class="btn btn-primary" id="bsi-resume-draft-btn">Resume Progress</button>
                            <button type="button" class="btn btn-ghost" id="bsi-discard-draft-btn">Start Fresh</button>
                        </div>
                    </div>
                ` : ''}

                <div style="display: flex; flex-direction: column; gap: 1.25rem;">
                    <div>
                        <label style="display: block; font-size: 0.82rem; font-weight: 700; color: var(--text-primary); margin-bottom: 0.4rem; text-transform: uppercase; letter-spacing: 0.05em;">
                            1. Select Bank Account <span style="color:var(--danger)">*</span>
                        </label>
                        <select id="bsi-bank-select" style="width: 100%; min-height: 44px; padding: 0.6rem 0.85rem; border: 1.5px solid var(--border-medium); border-radius: var(--radius-md); background: var(--bg-card); color: var(--text-primary); font-size: 0.9rem; font-weight: 600;">
                            <option value="">— Select Bank —</option>
                            ${state.banks.map(b => `
                                <option value="${escapeAttribute(b.bank_name)}" ${state.selectedBank === b.bank_name ? 'selected' : ''}>
                                    ${escapeHtml(b.bank_name)} ${b.account_number ? `(${b.account_number})` : ''}
                                </option>
                            `).join('')}
                        </select>
                    </div>

                    <div>
                        <label style="display: block; font-size: 0.82rem; font-weight: 700; color: var(--text-primary); margin-bottom: 0.4rem; text-transform: uppercase; letter-spacing: 0.05em;">
                            2. Upload Bank Statement <span style="color:var(--danger)">*</span>
                        </label>
                        <div class="bsi-upload-zone" id="bsi-dropzone">
                            <input type="file" id="bsi-file-input" accept=".pdf,.xlsx,.xls,.csv" style="display: none;" />
                            <div style="font-size: 2.75rem; margin-bottom: 0.5rem;">📄</div>
                            <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-primary);">
                                ${state.selectedFile ? escapeHtml(state.selectedFile.name) : 'Drag and drop bank statement here, or click to browse'}
                            </div>
                            <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 0.35rem;">
                                Supported formats: PDF, Microsoft Excel (.xlsx, .xls), and CSV
                            </div>
                            ${state.selectedFile ? `
                                <div style="display:inline-block; margin-top: 0.75rem; padding: 0.35rem 0.75rem; background: var(--accent-soft); color: var(--accent-primary); border-radius: 999px; font-size: 0.8rem; font-weight: 600;">
                                    Size: ${(state.selectedFile.size / 1024).toFixed(1)} KB &middot; Ready to extract
                                </div>
                            ` : ''}
                        </div>
                    </div>

                    ${state.selectedFile?.name?.toLowerCase().endsWith('.pdf') ? `
                        <div>
                            <label for="bsi-pdf-password" style="display:block;font-size:0.82rem;font-weight:700;color:var(--text-primary);margin-bottom:0.4rem;">
                                PDF password <span style="font-weight:400;color:var(--text-muted);">(if required)</span>
                            </label>
                            <input type="password" id="bsi-pdf-password" autocomplete="off" value="${escapeAttribute(state.pdfPassword || '')}" placeholder="Enter the password for this PDF" style="width:100%;min-height:44px;padding:0.6rem 0.85rem;border:1.5px solid var(--border-medium);border-radius:var(--radius-md);background:var(--bg-card);color:var(--text-primary);font-size:0.9rem;">
                            <div style="font-size:0.78rem;color:var(--text-muted);margin-top:0.35rem;">Used only to open this PDF; it is not saved with your import draft.</div>
                        </div>
                    ` : ''}

                    <div style="background: var(--bg-secondary); border-radius: var(--radius-md); padding: 1rem; border: 1px solid var(--border-light); font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5;">
                        <strong style="color:var(--text-primary);">Controls and Processing Rules:</strong>
                        <ul style="margin: 0.4rem 0 0 1.25rem; padding: 0;">
                            <li>Intelligently identifies column headers for Date, Description, Reference, Debits, Credits and Balances.</li>
                            <li>Initial member mapping requires exact spelling in at least two of the first, middle and last names; uncertain matches go to Unknown for manual review.</li>
                            <li>Positive member payments prepared for <strong>Auto Distribution</strong>.</li>
                            <li>Negative member outflows prepared for <strong>Loan Enterprise assignment</strong> (no loan records created until approved).</li>
                            <li>All imported transactions remain <strong>Pending</strong> until approved manually by an administrator.</li>
                        </ul>
                    </div>

                    <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 0.5rem;">
                        <button type="button" class="btn btn-primary" id="bsi-start-extract-btn" ${!state.selectedBank || !state.selectedFile ? 'disabled' : ''} style="min-width: 180px;">
                            Start Intelligent Extraction →
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    function renderAnalyzingView() {
        return `
            <div class="bsi-card" style="max-width: 600px; margin: 3rem auto; text-align: center; padding: 3rem 2rem;">
                <div style="width: 56px; height: 56px; border: 4px solid var(--border-medium); border-top-color: var(--accent-primary); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem;"></div>
                <h2 style="font-size: 1.3rem; font-weight: 800; color: var(--text-primary); margin: 0;">Extracting & Analyzing Transactions...</h2>
                <p style="font-size: 0.9rem; color: var(--text-muted); margin: 0.5rem 0 0 0;">
                    Reading statement columns, matching member identities, verifying duplicate history, and preparing distribution mappings.
                </p>
            </div>
        `;
    }

    function renderReviewView() {
        const txns = state.transactions || [];
        const totalCount = txns.length;
        const totalDebitCount = txns.filter(t => t.amount < 0).length;
        const totalCreditCount = txns.filter(t => t.amount > 0).length;
        const totalDebitSum = txns.filter(t => t.amount < 0).reduce((acc, t) => acc + Math.abs(t.amount), 0);
        const totalCreditSum = txns.filter(t => t.amount > 0).reduce((acc, t) => acc + Math.abs(t.amount), 0);
        const confidentCount = txns.filter(t => t.confidence === 'High' && t.classification !== 'Unknown').length;
        const unknownCount = txns.filter(t => t.classification === 'Unknown').length;
        const expenseCount = txns.filter(t => t.classification === 'Expense').length;
        const incomeCount = txns.filter(t => t.classification === 'Income').length;
        const duplicateCount = txns.filter(t => t.duplicateStatus === 'Possible Duplicate' || t.duplicateStatus === 'Confirmed Duplicate').length;
        const readyToImportCount = txns.filter(t => !t.skipImport).length;

        // Use the same shared predicate for displayed rows and the filter's count.
        const filtered = filterStatementTransactions(txns, state.filter, state.searchTerm);
        const countsForSearch = {
            all: filterStatementTransactions(txns, 'all', state.searchTerm).length,
            confident: filterStatementTransactions(txns, 'confident', state.searchTerm).length,
            uncertain: filterStatementTransactions(txns, 'uncertain', state.searchTerm).length,
            unknown: filterStatementTransactions(txns, 'unknown', state.searchTerm).length,
            expense: filterStatementTransactions(txns, 'expense', state.searchTerm).length,
            income: filterStatementTransactions(txns, 'income', state.searchTerm).length,
            loan: filterStatementTransactions(txns, 'loan', state.searchTerm).length,
            duplicates: filterStatementTransactions(txns, 'duplicates', state.searchTerm).length
        };

        const enterpriseNameFor = (txn) => txn.enterpriseId
            ? (state.enterprises.find(e => String(e.id) === String(txn.enterpriseId))?.account_name || 'Selected')
            : (txn.classification === 'Remittance' ? 'Auto Share Distributed' : '—');
        const sortValueFor = (txn, key) => {
            switch (key) {
                case 'date': return String(txn.date || '');
                case 'description': return String(txn.description || '');
                case 'reference': return String(txn.reference || '');
                case 'debit': return Number(txn.debit) || 0;
                case 'credit': return Number(txn.credit) || 0;
                case 'member': return txn.member ? `${txn.member.first_name || ''} ${txn.member.last_name || ''}` : 'Unknown / Cooperative';
                case 'classification': return String(txn.classification || '');
                case 'enterprise': return enterpriseNameFor(txn);
                case 'confidence': return String(txn.confidence || '');
                case 'duplicateStatus': return String(txn.duplicateStatus || '');
                case 'notes': return `${txn.duplicateNote || ''} ${txn.notes || ''}`;
                case 'status': return 'Pending';
                default: return '';
            }
        };
        const sortedFiltered = state.sortKey
            ? [...filtered].sort((a, b) => {
                const aValue = sortValueFor(a, state.sortKey);
                const bValue = sortValueFor(b, state.sortKey);
                let result;
                if (typeof aValue === 'number' && typeof bValue === 'number') {
                    result = aValue - bValue;
                } else {
                    result = String(aValue).localeCompare(String(bValue), undefined, { numeric: true, sensitivity: 'base' });
                }
                return state.sortDirection === 'desc' ? -result : result;
            })
            : filtered;
        const visibleSelectedCount = filtered.filter(t => !t.skipImport).length;
        const sortableHeader = (label, key, style = '') => {
            const isActive = state.sortKey === key;
            const indicator = isActive ? (state.sortDirection === 'asc' ? '▲' : '▼') : '↕';
            return `<th style="${style}"><button type="button" class="bsi-sort-btn" data-sort-key="${key}" title="Sort ${escapeAttribute(label)} ${isActive && state.sortDirection === 'asc' ? 'descending' : 'ascending'}">${label}<span class="bsi-sort-indicator" aria-hidden="true">${indicator}</span></button></th>`;
        };

        return `
            <div>
                <!-- Top Bar -->
                <div class="bsi-header">
                    <div>
                        <div style="display: flex; align-items: center; gap: 0.75rem;">
                            <h1 class="bsi-title">Review & Map Bank Statement</h1>
                            <span class="bsi-badge bsi-badge-pending">All Rows Pending Approval</span>
                        </div>
                        <p class="bsi-subtitle">
                            Bank: <strong>${escapeHtml(state.selectedBank)}</strong> &middot; File: <strong>${escapeHtml(state.fileName)}</strong> (${totalCount} transactions extracted)
                        </p>
                    </div>

                    <div style="display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap;">
                        <span id="bsi-save-indicator" style="font-size: 0.78rem; color: var(--text-muted); display: inline-flex; align-items: center;">
                            ${state.lastSaved ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--success);margin-right:6px;"></span>Auto-saved` : ''}
                        </span>
                        <button type="button" class="btn btn-secondary" id="bsi-manual-save-btn" title="Manually save progress">Save Progress</button>
                        <button type="button" class="btn btn-ghost" id="bsi-restart-btn" title="Start over">Discard & Re-upload</button>
                        <button type="button" class="btn btn-primary" id="bsi-commit-btn" ${readyToImportCount === 0 || state.isCommitting ? 'disabled' : ''} style="min-width: 210px;">
                            ${state.isCommitting ? 'Committing...' : `Commit to Pending Remittances (${readyToImportCount})`}
                        </button>
                    </div>
                </div>

                <!-- Stats Summary -->
                <div class="bsi-stats-grid">
                    <div class="bsi-stat-card stat-accent">
                        <div class="bsi-stat-label">Total Extracted</div>
                        <div class="bsi-stat-val">${totalCount}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">${readyToImportCount} included</div>
                    </div>
                    <div class="bsi-stat-card stat-dr">
                        <div class="bsi-stat-label">Total Debits</div>
                        <div class="bsi-stat-val" style="color:var(--danger)">${formatCurrency(totalDebitSum)}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">${totalDebitCount} transactions</div>
                    </div>
                    <div class="bsi-stat-card stat-cr">
                        <div class="bsi-stat-label">Total Credits</div>
                        <div class="bsi-stat-val" style="color:var(--success)">${formatCurrency(totalCreditSum)}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">${totalCreditCount} transactions</div>
                    </div>
                    <div class="bsi-stat-card stat-cr">
                        <div class="bsi-stat-label">Confident Mappings</div>
                        <div class="bsi-stat-val">${confidentCount}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">High confidence match</div>
                    </div>
                    <div class="bsi-stat-card stat-warn">
                        <div class="bsi-stat-label">Unknown Payments</div>
                        <div class="bsi-stat-val" style="color:var(--warning)">${unknownCount}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">Requires assignment</div>
                    </div>
                    <div class="bsi-stat-card">
                        <div class="bsi-stat-label">Expenses / Income</div>
                        <div class="bsi-stat-val">${expenseCount} / ${incomeCount}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">Confirmed P&L</div>
                    </div>
                    <div class="bsi-stat-card ${duplicateCount > 0 ? 'stat-dr' : ''}">
                        <div class="bsi-stat-label">Duplicate Alerts</div>
                        <div class="bsi-stat-val" style="${duplicateCount > 0 ? 'color:var(--danger)' : ''}">${duplicateCount}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">Possible / Confirmed</div>
                    </div>
                </div>

                <!-- Filters & Search -->
                <div class="bsi-card" style="margin-bottom: 1.25rem; padding: 1rem 1.25rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem;">
                        <div class="bsi-filter-bar" style="margin-bottom: 0;">
                            <button type="button" class="bsi-filter-btn ${state.filter === 'all' ? 'active' : ''}" data-filter="all">All (${countsForSearch.all})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'confident' ? 'active' : ''}" data-filter="confident">Confident (${countsForSearch.confident})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'uncertain' ? 'active' : ''}" data-filter="uncertain">Needs Review (${countsForSearch.uncertain})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'unknown' ? 'active' : ''}" data-filter="unknown">Unknown (${countsForSearch.unknown})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'expense' ? 'active' : ''}" data-filter="expense">Expenses (${countsForSearch.expense})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'income' ? 'active' : ''}" data-filter="income">Income (${countsForSearch.income})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'loan' ? 'active' : ''}" data-filter="loan">Debits/Loans (${countsForSearch.loan})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'duplicates' ? 'active' : ''}" data-filter="duplicates">Duplicates (${countsForSearch.duplicates})</button>
                        </div>

                        <div style="position: relative; min-width: 260px;">
                            <input type="text" id="bsi-search-input" value="${escapeAttribute(state.searchTerm)}" placeholder="Search narration, ref, member..." style="width: 100%; box-sizing: border-box; padding: 0.5rem 0.85rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary); font-size: 0.82rem;">
                        </div>
                    </div>
                </div>

                <!-- Dedicated Data Table -->
                <div class="bsi-table-wrap">
                    <table class="bsi-table">
                        <thead>
                            <tr>
                                <th style="width: 38px; text-align: center;">
                                    <input type="checkbox" id="bsi-select-all-cb" title="Toggle include all" checked />
                                </th>
                                ${sortableHeader('Date', 'date')}
                                ${sortableHeader('Description', 'description', 'min-width: 180px;')}
                                ${sortableHeader('Reference', 'reference')}
                                ${sortableHeader('Debit (Out)', 'debit', 'text-align: right;')}
                                ${sortableHeader('Credit (In)', 'credit', 'text-align: right;')}
                                ${sortableHeader('Member', 'member', 'min-width: 160px;')}
                                ${sortableHeader('Classification', 'classification')}
                                ${sortableHeader('Enterprise', 'enterprise')}
                                ${sortableHeader('Confidence', 'confidence')}
                                ${sortableHeader('Duplicate Status', 'duplicateStatus')}
                                ${sortableHeader('Notes / Warnings', 'notes', 'min-width: 200px;')}
                                ${sortableHeader('Status', 'status')}
                                <th style="text-align: center;">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${filtered.length === 0 ? `
                                <tr>
                                    <td colspan="14" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
                                        No transactions match the selected filter.
                                    </td>
                                </tr>
                            ` : sortedFiltered.map((txn, idx) => {
                                const realIdx = state.transactions.indexOf(txn);
                                const isExcluded = !!txn.skipImport;
                                const isDebit = txn.amount < 0;
                                const memberDisplay = txn.member
                                    ? `<div style="font-weight:700;color:var(--text-primary);">${escapeHtml(txn.member.first_name)} ${escapeHtml(txn.member.last_name)}</div>
                                       <div style="font-size:0.72rem;color:var(--text-muted);">${escapeHtml(txn.member.registration_no || txn.member.mobile || '')}</div>`
                                    : `<span style="color:var(--text-muted);font-style:italic;">Unknown / Cooperative</span>`;

                                const dupBadgeClass = txn.duplicateStatus === 'Confirmed Duplicate'
                                    ? 'bsi-badge-dup-confirmed'
                                    : (txn.duplicateStatus === 'Possible Duplicate' ? 'bsi-badge-dup-possible' : 'bsi-badge-dup-new');

                                const confBadgeClass = txn.confidence === 'High' ? 'bsi-badge-high' : (txn.confidence === 'Low' ? 'bsi-badge-low' : 'bsi-badge-none');

                                const enterpriseName = enterpriseNameFor(txn);

                                return `
                                    <tr class="${isExcluded ? 'row-excluded' : ''}" data-idx="${realIdx}">
                                        <td style="text-align: center;">
                                            <input type="checkbox" class="bsi-row-include-cb" data-idx="${realIdx}" ${!isExcluded ? 'checked' : ''} title="Include in import" />
                                        </td>
                                        <td style="white-space: nowrap; font-variant-numeric: tabular-nums;">
                                            ${formatDate(txn.date)}
                                        </td>
                                        <td style="word-break: break-word; font-size: 0.8rem;" title="${escapeAttribute(txn.description)}">
                                            ${escapeHtml(txn.description)}
                                        </td>
                                        <td style="font-family: monospace; font-size: 0.75rem;">
                                            ${escapeHtml(txn.reference || '—')}
                                        </td>
                                        <td style="text-align: right; font-weight: 700; color: var(--danger); font-variant-numeric: tabular-nums;">
                                            ${txn.debit > 0 ? formatCurrency(txn.debit) : '—'}
                                        </td>
                                        <td style="text-align: right; font-weight: 700; color: var(--success); font-variant-numeric: tabular-nums;">
                                            ${txn.credit > 0 ? formatCurrency(txn.credit) : '—'}
                                        </td>
                                        <td>
                                            ${memberDisplay}
                                        </td>
                                        <td>
                                            <span style="font-weight: 600; font-size: 0.78rem;">${escapeHtml(txn.classification)}</span>
                                        </td>
                                        <td style="font-size: 0.76rem; color: var(--text-secondary);">
                                            ${escapeHtml(enterpriseName)}
                                        </td>
                                        <td>
                                            <span class="bsi-badge ${confBadgeClass}">${txn.confidence}</span>
                                        </td>
                                        <td>
                                            <span class="bsi-badge ${dupBadgeClass}">${txn.duplicateStatus}</span>
                                        </td>
                                        <td style="font-size: 0.74rem; color: var(--text-secondary); max-width: 240px; line-height: 1.35;">
                                            ${txn.duplicateNote ? `<div style="color:var(--danger);font-weight:600;margin-bottom:2px;">⚠️ ${escapeHtml(txn.duplicateNote)}</div>` : ''}
                                            ${escapeHtml(txn.notes || '')}
                                        </td>
                                        <td>
                                            <span class="bsi-badge bsi-badge-pending">Pending</span>
                                        </td>
                                        <td style="text-align: center; white-space: nowrap;">
                                            <div style="display:flex; flex-direction:column; gap:0.35rem; align-items:center;">
                                                <button type="button" class="btn btn-secondary bsi-edit-row-btn" data-idx="${realIdx}" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                                                    Edit / Map
                                                </button>
                                                <button type="button" class="btn btn-ghost bsi-remap-row-btn" data-idx="${realIdx}" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                                                    Re-map
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1.25rem; flex-wrap: wrap; gap: 1rem;">
                    <div style="font-size: 0.82rem; color: var(--text-muted);">
                        Showing ${filtered.length} of ${totalCount} transactions &middot; ${visibleSelectedCount} visible selected &middot; ${readyToImportCount} selected overall
                    </div>

                    <div style="display: flex; gap: 0.75rem;">
                        <button type="button" class="btn btn-secondary" id="bsi-manual-save-bottom-btn">Save Progress</button>
                        <button type="button" class="btn btn-primary" id="bsi-commit-bottom-btn" ${readyToImportCount === 0 || state.isCommitting ? 'disabled' : ''} style="min-width: 210px;">
                            ${state.isCommitting ? 'Committing...' : `Commit to Pending Remittances (${readyToImportCount})`}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    function renderSuccessView() {
        const s = state.importSummary || {};
        return `
            <div class="bsi-card" style="max-width: 650px; margin: 3rem auto; text-align: center; padding: 3rem 2rem;">
                <div style="width: 72px; height: 72px; border-radius: 50%; background: var(--success-bg); color: var(--success); display: grid; place-items: center; font-size: 2.2rem; margin: 0 auto 1.25rem;">
                    ✓
                </div>
                <h2 style="font-size: 1.6rem; font-weight: 800; color: var(--text-primary); margin: 0 0 0.5rem 0;">
                    Bank Statement Successfully Imported!
                </h2>
                <p style="font-size: 0.95rem; color: var(--text-secondary); margin: 0 0 1.5rem 0; line-height: 1.5;">
                    <strong>${s.totalImported || 0}</strong> transactions have been imported into CoopLog as <strong>Pending</strong> remittances. All accounting controls and distribution rules have been prepared.
                </p>

                <div style="background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 2rem; text-align: left; font-size: 0.85rem; line-height: 1.6;">
                    <div><strong>Bank:</strong> ${escapeHtml(state.selectedBank)}</div>
                    <div><strong>File:</strong> ${escapeHtml(state.fileName)}</div>
                    <div><strong>Pending Remittances Created:</strong> ${s.totalImported || 0}</div>
                    <div style="color:var(--text-muted); font-size: 0.8rem; margin-top: 0.5rem;">
                        * Every imported transaction remains <strong>Pending</strong>. You can now review, inspect, edit distribution, or approve each transaction individually in the Remittance approval workspace.
                    </div>
                </div>

                <div style="display: flex; justify-content: center; gap: 0.75rem;">
                    <button type="button" class="btn btn-primary" id="bsi-go-remittance-btn" style="min-height: 44px; padding: 0 1.5rem;">
                        Go to Remittance Page →
                    </button>
                    <button type="button" class="btn btn-secondary" id="bsi-import-another-btn" style="min-height: 44px; padding: 0 1.5rem;">
                        Import Another Statement
                    </button>
                </div>
            </div>
        `;
    }

    function renderRemapModal(idx) {
        const txn = state.transactions[idx];
        if (!txn) return;

        const modalWrap = document.getElementById('bsi-edit-modal-wrap');
        if (!modalWrap) return;

        const previousMember = txn.member;
        const previousMemberLabel = previousMember
            ? [previousMember.first_name, previousMember.middle_name, previousMember.last_name].filter(Boolean).join(' ')
            : 'Unknown / Cooperative';

        modalWrap.innerHTML = `
            <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 1rem;">
                <div style="background: var(--bg-card); border-radius: var(--radius-lg); width: min(94vw, 560px); max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-xl); border: 1px solid var(--border-light); padding: 1.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; border-bottom: 1px solid var(--border-light); padding-bottom: 0.75rem;">
                        <div>
                            <h3 style="margin: 0; font-size: 1.15rem; font-weight: 800; color: var(--text-primary);">Re-map Selected Transaction</h3>
                            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;">Row #${txn.rowNumber || idx + 1} &middot; ${formatDate(txn.date)} &middot; ${escapeHtml(txn.description || '')}</div>
                        </div>
                        <button type="button" id="bsi-remap-close-btn" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
                    </div>

                    <div style="padding: 0.75rem; background: var(--bg-secondary); border-radius: var(--radius-sm); font-size: 0.82rem; margin-bottom: 1rem;">
                        <strong>Current mapping:</strong> ${escapeHtml(previousMemberLabel)}
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 0.85rem; font-size: 0.85rem;">
                        <div>
                            <label for="bsi-remap-method" style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Find member using</label>
                            <select id="bsi-remap-method" style="width: 100%; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary);">
                                <option value="fullname">Full Name</option>
                                <option value="special_id">Special ID</option>
                                <option value="mobile">Mobile</option>
                            </select>
                        </div>
                        <div>
                            <label for="bsi-remap-query" style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Search value</label>
                            <input type="text" id="bsi-remap-query" autocomplete="off" placeholder="Type a member name, special ID, or mobile" style="width: 100%; box-sizing: border-box; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary);" />
                            <div id="bsi-remap-suggestions" role="listbox" style="display:none; position:relative; max-height:220px; overflow-y:auto; margin-top:0.25rem; border:1px solid var(--border-medium); border-radius:var(--radius-sm); background:var(--bg-card); box-shadow:var(--shadow-md);"></div>
                        </div>
                        <button type="button" class="btn btn-secondary" id="bsi-remap-find-btn" style="align-self: flex-start;">Find Member</button>
                        <div id="bsi-remap-result" style="min-height: 2.5rem; padding: 0.75rem; border-radius: var(--radius-sm); background: var(--bg-secondary); color: var(--text-muted);">
                            Enter a value and select Find Member.
                        </div>
                        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem; border-top: 1px solid var(--border-light); padding-top: 1rem;">
                            <button type="button" class="btn btn-secondary" id="bsi-remap-reject-btn">Reject / Cancel</button>
                            <button type="button" class="btn btn-primary" id="bsi-remap-accept-btn" disabled>Accept Mapping</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        let proposedMember = null;
        const methodSelect = document.getElementById('bsi-remap-method');
        const queryInput = document.getElementById('bsi-remap-query');
        const suggestionsBox = document.getElementById('bsi-remap-suggestions');
        const resultBox = document.getElementById('bsi-remap-result');
        const acceptBtn = document.getElementById('bsi-remap-accept-btn');
        const closeModal = () => { modalWrap.innerHTML = ''; state.activeEditRow = null; };

        document.getElementById('bsi-remap-close-btn')?.addEventListener('click', closeModal);
        document.getElementById('bsi-remap-reject-btn')?.addEventListener('click', closeModal);
        const activeMembers = state.members.filter(m => m && m.id !== '0000000000' && !m.is_deleted && String(m.status || '').toLowerCase() !== 'archived');
        const showRemapSuggestions = () => {
            if (!suggestionsBox || methodSelect?.value !== 'fullname') return;
            const query = normalizeText(queryInput?.value || '');
            if (!query) {
                suggestionsBox.style.display = 'none';
                suggestionsBox.innerHTML = '';
                return;
            }
            const queryParts = query.split(/\s+/).filter(Boolean);
            const matches = activeMembers.filter(member => {
                const name = normalizeText([member.first_name, member.middle_name, member.last_name].filter(Boolean).join(' '));
                return queryParts.every(part => name.includes(part));
            }).slice(0, 10);
            suggestionsBox.innerHTML = matches.map(member => {
                const name = [member.first_name, member.middle_name, member.last_name].filter(Boolean).join(' ');
                const detail = [member.registration_no ? `Reg: ${member.registration_no}` : '', member.mobile || ''].filter(Boolean).join(' · ');
                return `<button type="button" role="option" data-member-id="${escapeAttribute(member.id)}" style="display:block;width:100%;text-align:left;padding:0.55rem 0.7rem;border:0;border-bottom:1px solid var(--border-light);background:var(--bg-card);color:var(--text-primary);cursor:pointer;"><strong>${escapeHtml(name)}</strong><div style="font-size:0.72rem;color:var(--text-muted);">${escapeHtml(detail)}</div></button>`;
            }).join('');
            suggestionsBox.style.display = matches.length ? 'block' : 'none';
            suggestionsBox.querySelectorAll('[data-member-id]').forEach(option => {
                option.onclick = () => {
                    proposedMember = activeMembers.find(member => String(member.id) === option.dataset.memberId) || null;
                    const selectedName = proposedMember ? [proposedMember.first_name, proposedMember.middle_name, proposedMember.last_name].filter(Boolean).join(' ') : '';
                    if (queryInput) queryInput.value = selectedName;
                    suggestionsBox.style.display = 'none';
                    if (proposedMember && resultBox) {
                        resultBox.innerHTML = `<strong>Proposed mapping:</strong> ${escapeHtml(selectedName)}<br><span style="font-size:0.75rem;color:var(--text-muted);">Special ID: ${escapeHtml(proposedMember.special_id || '—')} &middot; Mobile: ${escapeHtml(proposedMember.mobile || '—')}</span><br><span style="font-size:0.75rem;color:var(--warning);">Review this match, then accept or reject it.</span>`;
                    }
                    if (acceptBtn) acceptBtn.disabled = !proposedMember;
                };
            });
        };
        queryInput?.addEventListener('input', () => {
            proposedMember = null;
            if (acceptBtn) acceptBtn.disabled = true;
            showRemapSuggestions();
        });
        methodSelect?.addEventListener('change', () => {
            if (suggestionsBox) suggestionsBox.style.display = 'none';
            proposedMember = null;
            if (acceptBtn) acceptBtn.disabled = true;
        });
        document.getElementById('bsi-remap-find-btn')?.addEventListener('click', () => {
            const method = methodSelect?.value || 'fullname';
            const query = String(queryInput?.value || '').trim();
            proposedMember = null;
            if (!query) {
                if (resultBox) resultBox.innerHTML = '<span style="color:var(--danger);">Enter a search value first.</span>';
                if (acceptBtn) acceptBtn.disabled = true;
                return;
            }

            const normalizedQuery = normalizeText(query);
            let candidate = null;

            if (method === 'fullname') {
                candidate = activeMembers.find(m => normalizeText([m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ')) === normalizedQuery);
            } else if (method === 'special_id') {
                candidate = activeMembers.find(m => normalizeText(m.special_id) === normalizedQuery);
            } else if (method === 'mobile') {
                const digits = query.replace(/\D/g, '');
                candidate = activeMembers.find(m => String(m.mobile || '').replace(/\D/g, '') === digits && digits.length > 0);
            }

            // Use the shared matcher as a fallback for formatting variations,
            // but only accept a confident and unambiguous result.
            if (!candidate) {
                const matched = matchMember(query, activeMembers);
                if (matched.member && matched.confidence === 'High') candidate = matched.member;
            }

            if (!candidate) {
                if (resultBox) resultBox.innerHTML = '<span style="color:var(--danger);">No unique active member was found. Check the value and try again.</span>';
                if (acceptBtn) acceptBtn.disabled = true;
                return;
            }

            proposedMember = candidate;
            if (resultBox) {
                const candidateName = [candidate.first_name, candidate.middle_name, candidate.last_name].filter(Boolean).join(' ');
                resultBox.innerHTML = `<strong>Proposed mapping:</strong> ${escapeHtml(candidateName)}<br><span style="font-size:0.75rem;color:var(--text-muted);">Special ID: ${escapeHtml(candidate.special_id || '—')} &middot; Mobile: ${escapeHtml(candidate.mobile || '—')}</span><br><span style="font-size:0.75rem;color:var(--warning);">Review this match, then accept or reject it.</span>`;
            }
            if (acceptBtn) acceptBtn.disabled = false;
        });

        acceptBtn?.addEventListener('click', () => {
            if (!proposedMember) return;
            txn.memberId = proposedMember.id;
            txn.member = proposedMember;
            txn.confidence = 'High';
            closeModal();
            autoSave();
            renderMain();
            showToast('Mapping accepted for the selected transaction.', 'success');
        });
    }

    function renderEditModal(idx) {
        const txn = state.transactions[idx];
        if (!txn) return;
        state.activeEditRow = idx;

        const isDebit = txn.amount < 0;
        const modalWrap = document.getElementById('bsi-edit-modal-wrap');
        if (!modalWrap) return;

        modalWrap.innerHTML = `
            <div style="position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 10000; display: flex; align-items: center; justify-content: center; padding: 1rem;">
                <div style="background: var(--bg-card); border-radius: var(--radius-lg); width: min(94vw, 560px); max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-xl); border: 1px solid var(--border-light); padding: 1.5rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; border-bottom: 1px solid var(--border-light); padding-bottom: 0.75rem;">
                        <div>
                            <h3 style="margin: 0; font-size: 1.15rem; font-weight: 800; color: var(--text-primary);">Edit / Map Transaction</h3>
                            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;">Row #${txn.rowNumber || idx + 1} &middot; ${formatDate(txn.date)} &middot; Amount: ${formatCurrency(txn.amount)}</div>
                        </div>
                        <button type="button" id="bsi-modal-close-btn" style="background: transparent; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted);">&times;</button>
                    </div>

                    <div style="display: flex; flex-direction: column; gap: 1rem; font-size: 0.85rem;">
                        <div>
                            <label style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Original Narration</label>
                            <div style="padding: 0.6rem; background: var(--bg-secondary); border-radius: var(--radius-sm); font-size: 0.8rem; word-break: break-word;">
                                ${escapeHtml(txn.description)}
                            </div>
                        </div>

                        <div>
                            <label style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Classification</label>
                            <select id="bsi-modal-class-select" style="width: 100%; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary); font-weight: 600;">
                                <option value="Remittance" ${txn.classification === 'Remittance' ? 'selected' : ''}>Member Remittance (Inflow / Deposit)</option>
                                <option value="Loan" ${txn.classification === 'Loan' ? 'selected' : ''}>Member Loan (Outflow / Debit)</option>
                                <option value="Expense" ${txn.classification === 'Expense' ? 'selected' : ''}>Confirmed Expense (Bank fee, levy, charge)</option>
                                <option value="Income" ${txn.classification === 'Income' ? 'selected' : ''}>Confirmed Income (Bank interest, yield)</option>
                                <option value="Unknown" ${txn.classification === 'Unknown' ? 'selected' : ''}>Unknown Payment (Unassigned)</option>
                            </select>
                        </div>

                        <div id="bsi-modal-member-section" style="${txn.classification === 'Expense' || txn.classification === 'Income' || txn.classification === 'Unknown' ? 'display:none;' : ''}">
                            <label style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Assigned Member</label>
                            <div style="position:relative;">
                                <input type="text" id="bsi-modal-member-search" autocomplete="off" value="${escapeAttribute(txn.member ? [txn.member.first_name, txn.member.middle_name, txn.member.last_name].filter(Boolean).join(' ') : '')}" placeholder="Type a member name, registration number, or mobile" style="width: 100%; box-sizing: border-box; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary);" />
                                <div id="bsi-modal-member-suggestions" role="listbox" style="display:none; position:absolute; z-index:10001; top:calc(100% + 2px); left:0; right:0; max-height:220px; overflow-y:auto; border:1px solid var(--border-medium); border-radius:var(--radius-sm); background:var(--bg-card); box-shadow:var(--shadow-md);"></div>
                            </div>
                            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.25rem;">Type to search, then select a member from the suggestions.</div>
                        </div>

                        <div id="bsi-modal-loan-enterprise-section" style="${txn.classification !== 'Loan' ? 'display:none;' : ''}">
                            <label style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Loan Enterprise <span style="color:var(--danger)">*</span></label>
                            <select id="bsi-modal-loan-ent-select" style="width: 100%; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary); font-weight: 600;">
                                <option value="">— Select Loan Enterprise —</option>
                                ${state.loanEnterprises.map(e => `
                                    <option value="${escapeAttribute(e.id)}" ${txn.enterpriseId === e.id ? 'selected' : ''}>
                                        ${escapeHtml(e.account_name)}
                                    </option>
                                `).join('')}
                            </select>
                            <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem;">
                                Select which Loan account this member debit belongs to. Loan records and duration will be configured upon approval.
                            </div>
                        </div>

                        <div id="bsi-modal-expense-type-section" style="${txn.classification !== 'Expense' ? 'display:none;' : ''}">
                            <label style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Expense Type</label>
                            <select id="bsi-modal-expense-select" style="width: 100%; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary);">
                                <option value="Financial & Banking Expenses" ${txn.transactionType === 'Financial & Banking Expenses' ? 'selected' : ''}>Financial & Banking Expenses (Finance Expense)</option>
                                <option value="Admin Expenses" ${txn.transactionType === 'Admin Expenses' ? 'selected' : ''}>Admin Expenses (Administrative Expense)</option>
                                <option value="Misc. Expenses" ${txn.transactionType === 'Misc. Expenses' ? 'selected' : ''}>Misc. Expenses (Other Operating Expense)</option>
                                <option value="Other Expenses" ${txn.transactionType === 'Other Expenses' ? 'selected' : ''}>Other Expenses</option>
                            </select>
                        </div>

                        <div>
                            <label style="font-weight: 700; display: block; margin-bottom: 0.25rem;">Notes / Warnings</label>
                            <textarea id="bsi-modal-notes-input" rows="2" style="width: 100%; box-sizing: border-box; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary); font-size: 0.82rem;">${escapeHtml(txn.notes || '')}</textarea>
                        </div>

                        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; border-top: 1px solid var(--border-light); padding-top: 1rem;">
                            <button type="button" class="btn btn-secondary" id="bsi-modal-cancel-btn">Cancel</button>
                            <button type="button" class="btn btn-primary" id="bsi-modal-save-btn">Save Changes</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Wire modal events
        const closeBtn = document.getElementById('bsi-modal-close-btn');
        const cancelBtn = document.getElementById('bsi-modal-cancel-btn');
        const saveBtn = document.getElementById('bsi-modal-save-btn');
        const classSelect = document.getElementById('bsi-modal-class-select');
        const memberSearch = document.getElementById('bsi-modal-member-search');
        const memberSuggestions = document.getElementById('bsi-modal-member-suggestions');
        let selectedMemberId = state.members.some(member => String(member.id) === String(txn.memberId)) ? String(txn.memberId) : '';
        const memberSec = document.getElementById('bsi-modal-member-section');
        const loanEntSec = document.getElementById('bsi-modal-loan-enterprise-section');
        const expenseSec = document.getElementById('bsi-modal-expense-type-section');

        const closeModal = () => { modalWrap.innerHTML = ''; state.activeEditRow = null; };
        if (closeBtn) closeBtn.onclick = closeModal;
        if (cancelBtn) cancelBtn.onclick = closeModal;

        if (classSelect) {
            classSelect.onchange = () => {
                const val = classSelect.value;
                if (memberSec) memberSec.style.display = (val === 'Remittance' || val === 'Loan') ? 'block' : 'none';
                if (loanEntSec) loanEntSec.style.display = val === 'Loan' ? 'block' : 'none';
                if (expenseSec) expenseSec.style.display = val === 'Expense' ? 'block' : 'none';
            };
        }

        const searchableMembers = state.members.filter(member => member && member.id !== '0000000000' && !member.is_deleted && String(member.status || '').toLowerCase() !== 'archived');
        const renderMemberSuggestions = (clearSelection = false) => {
            if (!memberSearch || !memberSuggestions) return;
            const query = normalizeText(memberSearch.value);
            if (clearSelection) selectedMemberId = '';
            if (!query) {
                memberSuggestions.innerHTML = '';
                memberSuggestions.style.display = 'none';
                return;
            }
            const parts = query.split(/\s+/).filter(Boolean);
            const matches = searchableMembers.filter(member => {
                const searchable = normalizeText([
                    member.first_name, member.middle_name, member.last_name,
                    member.registration_no, member.mobile, member.special_id
                ].filter(Boolean).join(' '));
                return parts.every(part => searchable.includes(part));
            }).slice(0, 12);
            memberSuggestions.innerHTML = matches.map(member => {
                const name = [member.first_name, member.middle_name, member.last_name].filter(Boolean).join(' ');
                const details = [member.registration_no ? `Reg: ${member.registration_no}` : '', member.mobile || ''].filter(Boolean).join(' · ');
                return `<button type="button" role="option" data-member-id="${escapeAttribute(member.id)}" style="display:block;width:100%;text-align:left;padding:0.6rem 0.75rem;border:0;border-bottom:1px solid var(--border-light);background:var(--bg-card);color:var(--text-primary);cursor:pointer;"><strong>${escapeHtml(name)}</strong><div style="font-size:0.72rem;color:var(--text-muted);">${escapeHtml(details)}</div></button>`;
            }).join('');
            memberSuggestions.style.display = matches.length ? 'block' : 'none';
            memberSuggestions.querySelectorAll('[data-member-id]').forEach(option => {
                option.onclick = () => {
                    const selectedMember = searchableMembers.find(member => String(member.id) === option.dataset.memberId);
                    if (!selectedMember) return;
                    selectedMemberId = String(selectedMember.id);
                    memberSearch.value = [selectedMember.first_name, selectedMember.middle_name, selectedMember.last_name].filter(Boolean).join(' ');
                    memberSuggestions.style.display = 'none';
                };
            });
        };
        memberSearch?.addEventListener('input', () => renderMemberSuggestions(true));
        memberSearch?.addEventListener('focus', () => renderMemberSuggestions(false));
        memberSearch?.addEventListener('keydown', event => {
            if (event.key === 'Escape' && memberSuggestions) memberSuggestions.style.display = 'none';
        });
        memberSearch?.addEventListener('blur', () => {
            setTimeout(() => { if (memberSuggestions) memberSuggestions.style.display = 'none'; }, 150);
        });

        if (saveBtn) {
            saveBtn.onclick = () => {
                const newClass = classSelect?.value || txn.classification;
                const loanEntSel = document.getElementById('bsi-modal-loan-ent-select');
                const expSel = document.getElementById('bsi-modal-expense-select');
                const notesInput = document.getElementById('bsi-modal-notes-input');

                txn.classification = newClass;
                txn.notes = notesInput?.value || txn.notes;

                if (newClass === 'Remittance' || newClass === 'Loan') {
                    const mId = selectedMemberId;
                    if (mId) {
                        const m = state.members.find(x => x.id === mId);
                        txn.memberId = mId;
                        txn.member = m || null;
                        txn.confidence = 'High';
                    } else {
                        txn.memberId = '0000000000';
                        txn.member = null;
                        txn.confidence = 'None';
                    }

                    if (newClass === 'Loan') {
                        txn.enterpriseId = loanEntSel?.value || (state.loanEnterprises[0]?.id || '');
                        txn.transactionType = 'Member Loan';
                        txn.category = 'Loan Asset';
                    } else {
                        txn.enterpriseId = '';
                        txn.transactionType = 'Member Deposit';
                        txn.category = 'Member Liability';
                    }
                } else if (newClass === 'Expense') {
                    txn.memberId = '0000000000';
                    txn.member = null;
                    txn.enterpriseId = '';
                    txn.transactionType = expSel?.value || 'Financial & Banking Expenses';
                    txn.category = 'Finance Expense';
                    txn.confidence = 'High';
                } else if (newClass === 'Income') {
                    txn.memberId = '0000000000';
                    txn.member = null;
                    txn.enterpriseId = '';
                    txn.transactionType = 'Other Income';
                    txn.category = 'Other Income';
                    txn.confidence = 'High';
                } else {
                    txn.memberId = '0000000000';
                    txn.member = null;
                    txn.enterpriseId = '';
                    txn.transactionType = 'Unknown Payments';
                    txn.category = 'Member Liability';
                    txn.confidence = 'None';
                }

                closeModal();
                autoSave();
                renderMain();
                showToast('Transaction mapping updated.', 'success');
            };
        }
    }

    function bindEvents() {
        // Upload Step Events
        const bankSelect = document.getElementById('bsi-bank-select');
        if (bankSelect) {
            bankSelect.onchange = (e) => {
                state.selectedBank = e.target.value;
                const extractBtn = document.getElementById('bsi-start-extract-btn');
                if (extractBtn) extractBtn.disabled = !state.selectedBank || !state.selectedFile;
            };
        }

        const pdfPasswordInput = document.getElementById('bsi-pdf-password');
        if (pdfPasswordInput) pdfPasswordInput.oninput = (e) => { state.pdfPassword = e.target.value; };

        const dropzone = document.getElementById('bsi-dropzone');
        const fileInput = document.getElementById('bsi-file-input');
        if (dropzone && fileInput) {
            dropzone.onclick = () => fileInput.click();
            fileInput.onchange = (e) => {
                const f = e.target.files[0];
                if (f) handleSelectedFile(f);
            };

            dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
            dropzone.ondragleave = () => dropzone.classList.remove('dragover');
            dropzone.ondrop = (e) => {
                e.preventDefault();
                dropzone.classList.remove('dragover');
                const f = e.dataTransfer.files[0];
                if (f) handleSelectedFile(f);
            };
        }

        const resumeBtn = document.getElementById('bsi-resume-draft-btn');
        if (resumeBtn) {
            resumeBtn.onclick = () => {
                const d = state.savedDraftData;
                restoreReviewDraft(d || {});
                setReviewSessionActive(true);
                renderMain();
                showToast('Resumed in-progress statement import.', 'info');
            };
        }

        const discardDraftBtn = document.getElementById('bsi-discard-draft-btn');
        if (discardDraftBtn) {
            discardDraftBtn.onclick = async () => {
                await clearStatementDraft(coopId, userId);
                setReviewSessionActive(false);
                state.hasSavedDraft = false;
                state.savedDraftData = null;
                renderMain();
                showToast('Draft discarded.', 'info');
            };
        }

        const startExtractBtn = document.getElementById('bsi-start-extract-btn');
        if (startExtractBtn) {
            startExtractBtn.onclick = () => processExtraction();
        }

        // Review Step Events
        const reviewTableWrap = container.querySelector('.bsi-table-wrap');
        if (reviewTableWrap) {
            reviewTableWrap.addEventListener('scroll', () => {
                captureTableScroll();
                scheduleAutoSave();
            }, { passive: true });
        }

        container.querySelectorAll('.bsi-sort-btn').forEach(btn => {
            btn.onclick = () => setSort(btn.dataset.sortKey);
        });

        container.querySelectorAll('.bsi-filter-btn').forEach(btn => {
            btn.onclick = () => {
                state.filter = btn.dataset.filter;
                autoSave();
                renderMain();
            };
        });

        const searchInput = document.getElementById('bsi-search-input');
        if (searchInput) {
            searchInput.oninput = (e) => {
                state.searchTerm = e.target.value;
                scheduleAutoSave();
                renderMain();
                const newInput = document.getElementById('bsi-search-input');
                if (newInput) {
                    newInput.focus();
                    newInput.setSelectionRange(newInput.value.length, newInput.value.length);
                }
            };
        }

        const selectAllCb = document.getElementById('bsi-select-all-cb');
        if (selectAllCb) {
            selectAllCb.onchange = (e) => {
                const checked = e.target.checked;
                state.transactions.forEach(t => t.skipImport = !checked);
                autoSave();
                renderMain();
            };
        }

        container.querySelectorAll('.bsi-row-include-cb').forEach(cb => {
            cb.onchange = (e) => {
                const idx = parseInt(cb.dataset.idx, 10);
                if (state.transactions[idx]) {
                    state.transactions[idx].skipImport = !e.target.checked;
                    autoSave();
                    renderMain();
                }
            };
        });

        container.querySelectorAll('.bsi-edit-row-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx, 10);
                renderEditModal(idx);
            };
        });

        container.querySelectorAll('.bsi-remap-row-btn').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx, 10);
                renderRemapModal(idx);
            };
        });

        const manualSaveBtn = document.getElementById('bsi-manual-save-btn');
        const manualSaveBottomBtn = document.getElementById('bsi-manual-save-bottom-btn');
        const doManualSave = () => {
            autoSave();
            showToast('Progress saved successfully.', 'success');
        };
        if (manualSaveBtn) manualSaveBtn.onclick = doManualSave;
        if (manualSaveBottomBtn) manualSaveBottomBtn.onclick = doManualSave;

        const restartBtn = document.getElementById('bsi-restart-btn');
        if (restartBtn) {
            restartBtn.onclick = async () => {
                if (confirm('Are you sure you want to discard this preview and re-upload?')) {
                    await clearStatementDraft(coopId, userId);
                    setReviewSessionActive(false);
                    state.step = 'upload';
                    state.transactions = [];
                    state.extractionInfo = null;
                    state.selectedFile = null;
                    state.pdfPassword = '';
                    renderMain();
                }
            };
        }

        const commitBtn = document.getElementById('bsi-commit-btn');
        const commitBottomBtn = document.getElementById('bsi-commit-bottom-btn');
        const doCommit = () => handleCommit();
        if (commitBtn) commitBtn.onclick = doCommit;
        if (commitBottomBtn) commitBottomBtn.onclick = doCommit;

        // Success View Buttons
        const goRemittanceBtn = document.getElementById('bsi-go-remittance-btn');
        if (goRemittanceBtn) {
            goRemittanceBtn.onclick = () => {
                window.location.hash = 'payments';
            };
        }

        const importAnotherBtn = document.getElementById('bsi-import-another-btn');
        if (importAnotherBtn) {
            importAnotherBtn.onclick = () => {
                state.step = 'upload';
                state.selectedFile = null;
                state.pdfPassword = '';
                state.transactions = [];
                state.extractionInfo = null;
                state.importSummary = null;
                renderMain();
            };
        }
    }

    function handleSelectedFile(file) {
        state.selectedFile = file;
        state.pdfPassword = '';
        state.fileName = file.name;
        state.fileSize = file.size;
        renderMain();
    }

    async function processExtraction() {
        if (!state.selectedFile || !state.selectedBank) {
            showToast('Please select a bank and bank statement file.', 'error');
            return;
        }

        state.step = 'analyzing';
        state.extractionInfo = null;
        renderMain();

        try {
            // 1. Extract raw transactions from file
            const rawExtracted = await extractTransactionsFromFile(state.selectedFile, { password: state.pdfPassword });
            state.pdfPassword = '';
            state.extractionInfo = rawExtracted?.extractionInfo || null;

            if (!rawExtracted || rawExtracted.length === 0) {
                throw new Error('No transaction rows could be extracted from this statement file. Please verify the file format.');
            }

            // 2. Classify and map transactions intelligently
            const classified = rawExtracted.map(t => {
                const c = classifyTransaction(t, {
                    members: state.members,
                    loanEnterprises: state.loanEnterprises
                });
                return {
                    ...t,
                    ...c
                };
            });

            // 3. Duplicate detection against remittances already saved in the database
            const withDuplicates = await detectDuplicates(classified, {
                cooperativeId: coopId,
                bankName: state.selectedBank
            });

            state.transactions = withDuplicates;
            state.step = 'review';
            setReviewSessionActive(true);
            autoSave();
            renderMain();
            showToast(`Extracted ${state.transactions.length} transactions successfully.`, 'success');
        } catch (err) {
            console.error('[BankStatementImport] Extraction error:', err);
            state.step = 'upload';
            renderMain();
            if (err.code === 'PDF_PASSWORD_REQUIRED' || err.code === 'PDF_PASSWORD_INCORRECT') {
                requestAnimationFrame(() => {
                    const passwordInput = document.getElementById('bsi-pdf-password');
                    passwordInput?.focus();
                    if (err.code === 'PDF_PASSWORD_INCORRECT') passwordInput?.select();
                });
            }
            showToast(err.message || 'Failed to extract transactions.', 'error');
        }
    }

    async function handleCommit() {
        const eligible = state.transactions.filter(t => !t.skipImport);
        if (eligible.length === 0) {
            showToast('No transactions are selected for import.', 'warning');
            return;
        }

        const duplicateCount = eligible.filter(t => t.duplicateStatus === 'Possible Duplicate' || t.duplicateStatus === 'Confirmed Duplicate').length;
        let confirmMsg = `Ready to import ${eligible.length} transactions from "${state.selectedBank}" as PENDING remittances?\n\n` +
            `• All ${eligible.length} transactions will enter the approval queue as Pending.\n` +
            `• Positive member remittances will be Auto-Distributed.\n` +
            `• Negative member outflows will be prepared for Loan assignment.\n`;

        if (duplicateCount > 0) {
            confirmMsg += `\n⚠️ WARNING: ${duplicateCount} potential duplicate transactions are included in this batch.`;
        }

        confirmMsg += `\n\nDo you want to proceed?`;

        if (!confirm(confirmMsg)) return;

        state.isCommitting = true;
        renderMain();

        try {
            const result = await commitStatementImport({
                transactions: eligible,
                cooperativeId: coopId,
                bankName: state.selectedBank,
                fileName: state.fileName,
                uploadedBy: userId,
                enterprises: state.enterprises
            });

            await clearStatementDraft(coopId, userId);
            setReviewSessionActive(false);
            state.isCommitting = false;
            state.importSummary = result;
            state.step = 'success';
            renderMain();
            showToast(`Successfully created ${result.totalImported} Pending remittances.`, 'success');
        } catch (err) {
            console.error('[BankStatementImport] Commit error:', err);
            state.isCommitting = false;
            renderMain();
            showToast(`Import failed: ${err.message}`, 'error');
        }
    }
}
