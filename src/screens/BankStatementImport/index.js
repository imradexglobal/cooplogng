import { escapeHtml, escapeAttribute, formatCurrency, formatDate } from '../../utils/formatters.js';
import { fetchBanks, fetchAllMembers, fetchEnterprises, fetchTransactionTypes } from '../../services/dataService.js';
import { extractTransactionsFromFile } from '../../services/bankStatement/extractor.js';
import { classifyTransaction } from '../../services/bankStatement/intelligence.js';
import { detectDuplicates } from '../../services/bankStatement/duplicateDetector.js';
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
        fileName: '',
        fileSize: 0,
        transactions: [],
        filter: 'all',
        searchTerm: '',
        activeEditRow: null,
        isCommitting: false,
        importSummary: null,
        hasSavedDraft: false,
        draftUpdatedAt: null,
        lastSaved: null
    };

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
            fetchEnterprises(coopId).catch(() => []),
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
                transactions: state.transactions
            }).then(() => {
                state.lastSaved = new Date();
                updateSaveIndicator();
            }).catch(e => console.warn('Draft save error:', e));
        }
    }

    function updateSaveIndicator() {
        const ind = document.getElementById('bsi-save-indicator');
        if (ind && state.lastSaved) {
            const timeStr = state.lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            ind.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--success);margin-right:6px;"></span>Auto-saved at ${timeStr}`;
        }
    }

    function renderMain() {
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

                    <div style="background: var(--bg-secondary); border-radius: var(--radius-md); padding: 1rem; border: 1px solid var(--border-light); font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5;">
                        <strong style="color:var(--text-primary);">Controls and Processing Rules:</strong>
                        <ul style="margin: 0.4rem 0 0 1.25rem; padding: 0;">
                            <li>Intelligently identifies column headers for Date, Description, Reference, Debits, Credits and Balances.</li>
                            <li>Multi-factor member identification (Name, Registration number, Special ID, Phone).</li>
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

        // Apply filters
        const filtered = txns.filter(t => {
            if (state.filter === 'confident' && (t.confidence !== 'High' || t.classification === 'Unknown')) return false;
            if (state.filter === 'uncertain' && t.confidence === 'High' && t.classification !== 'Unknown') return false;
            if (state.filter === 'unknown' && t.classification !== 'Unknown') return false;
            if (state.filter === 'expense' && t.classification !== 'Expense') return false;
            if (state.filter === 'income' && t.classification !== 'Income') return false;
            if (state.filter === 'loan' && (t.classification !== 'Loan' || t.amount >= 0)) return false;
            if (state.filter === 'duplicates' && t.duplicateStatus === 'New') return false;

            if (state.searchTerm) {
                const term = state.searchTerm.toLowerCase();
                const desc = String(t.description || '').toLowerCase();
                const ref = String(t.reference || '').toLowerCase();
                const memberName = t.member ? `${t.member.first_name} ${t.member.last_name}`.toLowerCase() : '';
                const regNo = String(t.member?.registration_no || '').toLowerCase();
                if (!desc.includes(term) && !ref.includes(term) && !memberName.includes(term) && !regNo.includes(term)) {
                    return false;
                }
            }
            return true;
        });

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
                            <button type="button" class="bsi-filter-btn ${state.filter === 'all' ? 'active' : ''}" data-filter="all">All (${totalCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'confident' ? 'active' : ''}" data-filter="confident">Confident (${confidentCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'uncertain' ? 'active' : ''}" data-filter="uncertain">Needs Review (${totalCount - confidentCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'unknown' ? 'active' : ''}" data-filter="unknown">Unknown (${unknownCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'expense' ? 'active' : ''}" data-filter="expense">Expenses (${expenseCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'income' ? 'active' : ''}" data-filter="income">Income (${incomeCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'loan' ? 'active' : ''}" data-filter="loan">Debits/Loans (${totalDebitCount})</button>
                            <button type="button" class="bsi-filter-btn ${state.filter === 'duplicates' ? 'active' : ''}" data-filter="duplicates">Duplicates (${duplicateCount})</button>
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
                                <th>Date</th>
                                <th style="min-width: 180px;">Description</th>
                                <th>Reference</th>
                                <th style="text-align: right;">Debit (Out)</th>
                                <th style="text-align: right;">Credit (In)</th>
                                <th style="min-width: 160px;">Member</th>
                                <th>Classification</th>
                                <th>Enterprise</th>
                                <th>Confidence</th>
                                <th>Duplicate Status</th>
                                <th style="min-width: 200px;">Notes / Warnings</th>
                                <th>Status</th>
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
                            ` : filtered.map((txn, idx) => {
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

                                const enterpriseName = txn.enterpriseId
                                    ? (state.enterprises.find(e => String(e.id) === String(txn.enterpriseId))?.account_name || 'Selected')
                                    : (txn.classification === 'Remittance' ? 'Auto Share Distributed' : '—');

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
                                            <button type="button" class="btn btn-secondary bsi-edit-row-btn" data-idx="${realIdx}" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                                                Edit / Map
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1.25rem; flex-wrap: wrap; gap: 1rem;">
                    <div style="font-size: 0.82rem; color: var(--text-muted);">
                        Showing ${filtered.length} of ${totalCount} transactions &middot; ${readyToImportCount} selected for import
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
                            <select id="bsi-modal-member-select" style="width: 100%; min-height: 40px; padding: 0.5rem; border: 1px solid var(--border-medium); border-radius: var(--radius-sm); background: var(--bg-card); color: var(--text-primary);">
                                <option value="">— Select Member —</option>
                                ${state.members.filter(m => m && m.id !== '0000000000' && !m.is_deleted).map(m => `
                                    <option value="${escapeAttribute(m.id)}" ${txn.memberId === m.id ? 'selected' : ''}>
                                        ${escapeHtml(m.first_name)} ${escapeHtml(m.last_name)} ${m.registration_no ? `(Reg: ${m.registration_no})` : ''} ${m.mobile ? `(${m.mobile})` : ''}
                                    </option>
                                `).join('')}
                            </select>
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

        if (saveBtn) {
            saveBtn.onclick = () => {
                const newClass = classSelect?.value || txn.classification;
                const memberSel = document.getElementById('bsi-modal-member-select');
                const loanEntSel = document.getElementById('bsi-modal-loan-ent-select');
                const expSel = document.getElementById('bsi-modal-expense-select');
                const notesInput = document.getElementById('bsi-modal-notes-input');

                txn.classification = newClass;
                txn.notes = notesInput?.value || txn.notes;

                if (newClass === 'Remittance' || newClass === 'Loan') {
                    const mId = memberSel?.value || '';
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
                state.selectedBank = d.selectedBank || (state.banks[0]?.bank_name || '');
                state.fileName = d.fileName || 'bank_statement';
                state.fileSize = d.fileSize || 0;
                state.transactions = d.transactions || [];
                state.step = 'review';
                renderMain();
                showToast('Resumed in-progress statement import.', 'info');
            };
        }

        const discardDraftBtn = document.getElementById('bsi-discard-draft-btn');
        if (discardDraftBtn) {
            discardDraftBtn.onclick = async () => {
                await clearStatementDraft(coopId, userId);
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
        container.querySelectorAll('.bsi-filter-btn').forEach(btn => {
            btn.onclick = () => {
                state.filter = btn.dataset.filter;
                renderMain();
            };
        });

        const searchInput = document.getElementById('bsi-search-input');
        if (searchInput) {
            searchInput.oninput = (e) => {
                state.searchTerm = e.target.value;
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
                    state.step = 'upload';
                    state.transactions = [];
                    state.selectedFile = null;
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
                state.transactions = [];
                state.importSummary = null;
                renderMain();
            };
        }
    }

    function handleSelectedFile(file) {
        state.selectedFile = file;
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
        renderMain();

        try {
            // 1. Extract raw transactions from file
            const rawExtracted = await extractTransactionsFromFile(state.selectedFile);

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

            // 3. Duplicate detection against database and within batch
            const withDuplicates = await detectDuplicates(classified, {
                cooperativeId: coopId,
                bankName: state.selectedBank
            });

            state.transactions = withDuplicates;
            state.step = 'review';
            autoSave();
            renderMain();
            showToast(`Extracted ${state.transactions.length} transactions successfully.`, 'success');
        } catch (err) {
            console.error('[BankStatementImport] Extraction error:', err);
            state.step = 'upload';
            renderMain();
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
