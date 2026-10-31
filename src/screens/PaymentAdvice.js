import { fetchEnterprises, buildAccountBalance, fetchMemberDoc, fetchMemberPaymentAdvise, updateMemberPaymentAdvice } from '../services/dataService.js';
import { showToast } from '../services/toastService.js';
import { formatCurrency, escapeHtml, escapeAttribute, generateId } from '../utils/formatters.js';

function roundUpTo100(val) {
  return Math.ceil(Number(val) / 100) * 100
}

export async function renderPaymentAdvice(container, user) {
  const cooperativeId = user.cooperativeId;
  const isMember = user.role === 'member' || !!user.memberId;

  if (!isMember) {
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4rem 2rem;text-align:center;">
        <div style="font-size:3rem;margin-bottom:1rem;">🔒</div>
        <h3 style="margin:0 0 0.5rem 0;">Access Restricted</h3>
        <p style="color:var(--text-muted);max-width:400px;margin:0;">Payment Advice is only available to members.</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <style>
      .advice-hero {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: 1.5rem; padding: 1.5rem; color: #fff;
        position: relative; overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .advice-hero::after {
        content: ''; position: absolute; right: -60px; top: -60px;
        width: 200px; height: 200px; border-radius: 50%;
        background: rgba(255,255,255,0.12);
      }
      .advice-hero::before {
        content: ''; position: absolute; right: 30px; bottom: -80px;
        width: 140px; height: 140px; border-radius: 50%;
        background: rgba(255,255,255,0.08);
      }
      .advice-chip {
        display: inline-flex; align-items: center; gap: 0.35rem;
        background: rgba(255,255,255,0.18); color: #fff;
        font-size: 0.75rem; font-weight: 700;
        padding: 0.3rem 0.7rem; border-radius: 999px;
        backdrop-filter: blur(4px);
      }
      .advice-toolbar {
        background: var(--bg-card); border: 1px solid var(--border-light);
        border-radius: 1.25rem; padding: 1rem;
        display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center;
      }
      .advice-search {
        flex: 1; min-width: 180px; position: relative;
      }
      .advice-search input {
        width: 100%; box-sizing: border-box;
        padding: 0.65rem 0.9rem 0.65rem 2.4rem;
        border-radius: 0.9rem; border: 1px solid var(--border-medium);
        background: var(--bg-input); color: var(--text-primary);
        font-size: 0.9rem; outline: none;
      }
      .advice-search svg { position: absolute; left: 0.8rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
      .filter-chip {
        border: 1px solid var(--border-medium); background: transparent;
        color: var(--text-muted); font-size: 0.8rem; font-weight: 700;
        padding: 0.55rem 1rem; border-radius: 999px; cursor: pointer;
        transition: all 0.15s ease; white-space: nowrap;
      }
      .filter-chip.active {
        background: var(--accent-primary); border-color: var(--accent-primary); color: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      }
      .zero-toggle {
        display: inline-flex; align-items: center; gap: 0.6rem; cursor: pointer;
        font-size: 0.8rem; font-weight: 700; color: var(--text-muted);
        padding: 0.4rem 0.2rem; user-select: none;
      }
      .zero-toggle .switch {
        width: 42px; height: 24px; border-radius: 999px; position: relative;
        background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
        transition: all 0.2s ease; flex-shrink: 0;
      }
      .zero-toggle.off .switch { background: var(--border-light); }
      .zero-toggle .knob {
        position: absolute; top: 2px; left: 22px; width: 20px; height: 20px;
        background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        transition: all 0.2s ease;
      }
      .zero-toggle.off .knob { left: 2px; }
      .advice-row {
        display: flex; gap: 1rem; align-items: center;
        background: var(--bg-card); border: 1px solid var(--border-light);
        border-radius: 1.1rem; padding: 1rem 1.1rem;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .advice-row:hover { border-color: var(--border-medium); box-shadow: var(--shadow-sm); }
      .advice-row.hidden-row { display: none; }
      .advice-avatar {
        width: 44px; height: 44px; border-radius: 14px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 1.1rem; color: #fff;
      }
      .advice-stepper { display: flex; align-items: center; gap: 0.4rem; }
      .step-btn {
        width: 32px; height: 32px; border-radius: 10px; border: 1px solid var(--border-medium);
        background: var(--bg-secondary); color: var(--text-primary);
        font-size: 1.1rem; font-weight: 800; cursor: pointer; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      }
      .step-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .advice-input {
        width: 130px; text-align: right; padding: 0.55rem 0.7rem;
        border: 1px solid var(--border-medium); border-radius: 10px;
        background: var(--bg-input); color: var(--text-primary);
        font-size: 0.95rem; font-weight: 700; outline: none;
      }
      .advice-input:focus { border-color: var(--accent-primary); box-shadow: 0 0 0 3px var(--accent-soft); }
      .advice-input:disabled { background: var(--bg-secondary); opacity: 0.8; }
      .badge {
        font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 0.2rem 0.55rem; border-radius: 999px;
      }
      .badge-savings { background: rgba(16,185,129,0.14); color: #059669; }
      .badge-loan { background: rgba(245,158,11,0.16); color: #b45309; }
      .badge-other { background: var(--bg-secondary); color: var(--text-muted); }
      /* ── Smart sticky header: title + stats + toolbar stay fixed while
         the enterprise list scrolls beneath (scroll container is
         .main-content, so top:0 pins just under the mobile top bar). ── */
      .advice-sticky {
        position: sticky; top: 0; z-index: 60;
        margin: 0 -1rem; padding: 0.75rem 1rem 0.85rem;
        background: var(--bg-card);
        background: color-mix(in srgb, var(--bg-card) 93%, transparent);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        border-bottom: 1px solid var(--border-light);
        box-shadow: var(--shadow-sm);
      }
      .advice-title-row { display: flex; align-items: baseline; gap: 0.6rem; min-width: 0; }
      .advice-title-row h2 { font-size: 1.25rem; font-weight: 800; margin: 0; color: var(--text-primary); white-space: nowrap; }
      .advice-title-row p { font-size: 0.78rem; color: var(--text-muted); margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .advice-hero { margin-top: 0.7rem; padding: 1.1rem 1.25rem; }
      .advice-hero-inner { display: flex; flex-direction: column; gap: 0.9rem; }
      .advice-hero-actions { display: flex; gap: 0.6rem; flex-wrap: wrap; }
      .advice-toolbar { margin-top: 0.7rem; padding: 0.8rem; }
      #advice-count { margin-top: 0.6rem; }
      @media (min-width: 700px) {
        .advice-hero-inner { flex-direction: row; align-items: center; justify-content: space-between; }
        .advice-hero-actions { justify-content: flex-end; }
      }
      @media (max-width: 640px) {
        .advice-row { flex-direction: column; align-items: stretch; }
        .advice-stepper { justify-content: space-between; }
        .advice-input { flex: 1; width: auto; }
        .advice-sticky { padding: 0.6rem 0.8rem 0.7rem; }
        .advice-title-row p { display: none; }
        .advice-title-row h2 { font-size: 1.1rem; }
        .advice-search { flex-basis: 100%; }
        #add-enterprise-btn { flex: 1; margin-left: 0 !important; }
        .advice-hero-actions .primary-button,
        .advice-hero-actions button { flex: 1; white-space: nowrap; }
        #advice-list { padding-bottom: 5.5rem; }
      }
      .advice-modal-overlay {
        position: fixed; top: 0; right: 0; bottom: 0; left: 0;
        background: rgba(0,0,0,0.6); backdrop-filter: blur(3px);
        display: flex; align-items: center; justify-content: center; z-index: 10000; padding: 1rem;
        opacity: 1; pointer-events: auto;
      }
      .advice-modal-card {
        background: var(--bg-card); border: 1px solid var(--border-light);
        border-radius: 1.25rem; width: 100%; max-width: 520px; max-height: 90vh;
        display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-xl);
        opacity: 1; pointer-events: auto; transform: none;
      }
    </style>
    <div class="page-container" style="padding:0 1rem 2rem;">
      <div style="max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:1rem;">
        <div class="advice-sticky">
          <div class="advice-title-row">
            <h2>Payment Advice</h2>
            <p>Set what you commit to pay monthly. Loans are automatic.</p>
          </div>
          <div class="advice-hero">
            <div class="advice-hero-inner" style="position:relative;z-index:1;">
              <div style="flex:1;min-width:0;">
                <div style="font-size:0.72rem;font-weight:700;opacity:0.9;text-transform:uppercase;letter-spacing:0.06em;">Total Expected To Pay · Monthly</div>
                <div id="advice-total-amount" style="font-size:clamp(1.7rem,5vw,2.2rem);font-weight:800;line-height:1.15;margin-top:0.2rem;">${formatCurrency(0)}</div>
                <div id="advice-total-breakdown" style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.6rem;">
                  <span class="advice-chip">Loading...</span>
                </div>
              </div>
              <div class="advice-hero-actions">
                <button id="save-advice-btn" class="primary-button" style="padding:0.7rem 1.6rem;background:#fff;color:#5b21b6;border:none;font-weight:800;">Save Changes</button>
                <button id="reset-advice-btn" style="padding:0.7rem 1.4rem;border-radius:var(--radius-md);border:1px solid rgba(255,255,255,0.5);background:transparent;color:#fff;font-weight:700;cursor:pointer;">Reset</button>
              </div>
            </div>
          </div>

          <div class="advice-toolbar">
            <div class="advice-search">
              <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              <input id="advice-search" type="text" placeholder="Search enterprises..." autocomplete="off">
            </div>
            <button type="button" class="filter-chip active" data-filter="all">All</button>
            <button type="button" class="filter-chip" data-filter="savings">Savings</button>
            <button type="button" class="filter-chip" data-filter="loan">Loans · auto</button>
            <div id="hide-zero-toggle" class="zero-toggle" title="Hide enterprises with ₦0 advice" role="switch" aria-checked="true" tabindex="0">
              <div class="switch"><div class="knob"></div></div>
              <span>Hide ₦0</span>
            </div>
            <button type="button" id="add-enterprise-btn" class="primary-button" style="padding:0.65rem 1.2rem;margin-left:auto;">+ Add enterprise</button>
          </div>

          <div id="advice-count" style="font-size:0.8rem;color:var(--text-muted);font-weight:600;"></div>
        </div>
        <div id="advice-list" style="display:flex;flex-direction:column;gap:0.75rem;">
          <p style="color:var(--text-muted);font-style:italic;">Loading advice details...</p>
        </div>
        <p style="font-size:0.78rem;color:var(--text-muted);line-height:1.5;margin:0;">💡 Loan advice is set automatically when a loan is created and cannot be edited or reset here. Use <strong>Hide ₦0</strong> to focus on active commitments, and <strong>+ Add enterprise</strong> to bring back any savings account not yet in your plan.</p>
        <div id="advice-modal-mount"></div>
      </div>
    </div>`;

  const listEl = container.querySelector('#advice-list');
  const totalEl = container.querySelector('#advice-total-amount');
  const breakdownEl = container.querySelector('#advice-total-breakdown');
  const countEl = container.querySelector('#advice-count');
  const saveBtn = container.querySelector('#save-advice-btn');
  const resetBtn = container.querySelector('#reset-advice-btn');
  const searchInput = container.querySelector('#advice-search');
  const hideToggle = container.querySelector('#hide-zero-toggle');
  const addBtn = container.querySelector('#add-enterprise-btn');
  const modalMount = container.querySelector('#advice-modal-mount');
  if (!listEl || !saveBtn) return;

  let rows = [];
  let activeFilter = 'all';
  let searchTerm = '';
  let hideZero = true;

  const AVATAR_COLORS = [
    'linear-gradient(135deg,#6366f1,#8b5cf6)', 'linear-gradient(135deg,#10b981,#34d399)',
    'linear-gradient(135deg,#f59e0b,#fbbf24)', 'linear-gradient(135deg,#3b82f6,#60a5fa)',
    'linear-gradient(135deg,#ec4899,#f472b6)', 'linear-gradient(135deg,#14b8a6,#2dd4bf)'
  ];
  const avatarFor = (name, i) => AVATAR_COLORS[i % AVATAR_COLORS.length];

  const getAmount = (id) => {
    const row = rows.find(r => String(r.id) === String(id));
    return row ? (parseFloat(row.amount) || 0) : 0;
  };

  const calcTotal = () => {
    let total = 0, savings = 0, loans = 0, count = 0;
    rows.forEach(r => {
      const amt = roundUpTo100(parseFloat(r.amount) || 0);
      total += amt;
      if (amt > 0) count++;
      if (r.type === 'loan') loans += amt; else savings += amt;
    });
    if (totalEl) totalEl.textContent = formatCurrency(total);
    if (breakdownEl) breakdownEl.innerHTML = `
      <span class="advice-chip">💰 Savings ${formatCurrency(savings)}</span>
      <span class="advice-chip">🏦 Loans (auto) ${formatCurrency(loans)}</span>
      <span class="advice-chip">📋 ${count} active</span>`;
  };

  const applyFilters = () => {
    let visible = 0;
    listEl.querySelectorAll('.advice-row').forEach(el => {
      const id = el.dataset.entid;
      const row = rows.find(r => String(r.id) === String(id));
      if (!row) return;
      const amt = parseFloat(row.amount) || 0;
      const matchesSearch = !searchTerm || (row.name || '').toLowerCase().includes(searchTerm);
      const matchesFilter = activeFilter === 'all' || row.type === activeFilter;
      const show = matchesSearch && matchesFilter && (!hideZero || amt !== 0);
      el.classList.toggle('hidden-row', !show);
      if (show) visible++;
    });
    const totalActive = rows.filter(r => (parseFloat(r.amount) || 0) > 0).length;
    if (countEl) countEl.textContent = `Showing ${visible} of ${rows.length} enterprises · ${totalActive} with advice`;
    const emptyEl = container.querySelector('#advice-empty');
    if (emptyEl) emptyEl.style.display = visible === 0 ? '' : 'none';
  };

  const paintRows = (balances) => {
    listEl.innerHTML = rows.map((r, i) => {
      const editable = r.type === 'savings';
      const badge = r.type === 'loan'
        ? '<span class="badge badge-loan">Auto · Loan</span>'
        : editable ? '<span class="badge badge-savings">Savings</span>' : `<span class="badge badge-other">${escapeHtml(r.typeLabel)}</span>`;
      const initials = escapeHtml((r.name || '?').trim().charAt(0).toUpperCase() || '?');
      return `
      <div class="advice-row" data-entid="${escapeAttribute(String(r.id))}" data-type="${escapeAttribute(r.type)}">
        <div style="display:flex;gap:0.9rem;align-items:center;flex:1;min-width:0;">
          <div class="advice-avatar" style="background:${avatarFor(r.name, i)};">${initials}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</div>
            <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.3rem;flex-wrap:wrap;">
              ${badge}
              <span style="font-size:0.78rem;color:var(--text-muted);">Balance: <strong style="color:${(r.balance || 0) < 0 ? 'var(--danger)' : 'var(--text-primary)'};">${formatCurrency(r.balance || 0)}</strong></span>
            </div>
          </div>
        </div>
        <div class="advice-stepper">
          ${editable ? `<button class="step-btn" data-step="-1" data-id="${escapeAttribute(String(r.id))}">−</button>` : `<span title="Loan advice is automatic" style="font-size:1.1rem;">🔒</span>`}
          <input type="number" step="100" min="0" class="advice-input" data-id="${escapeAttribute(String(r.id))}" value="${r.amount || 0}"
            ${!editable ? 'disabled title="Loan advice is set automatically on loan creation and cannot be edited here."' : 'aria-label="Monthly advice amount"'}>
          ${editable ? `<button class="step-btn" data-step="1" data-id="${escapeAttribute(String(r.id))}">+</button>` : ''}
        </div>
      </div>`;
    }).join('') + `
      <div id="advice-empty" style="display:none;background:var(--bg-card);border:1px dashed var(--border-medium);border-radius:1.1rem;padding:2rem;text-align:center;">
        <div style="font-size:2rem;">🫧</div>
        <div style="font-weight:800;color:var(--text-primary);margin-top:0.5rem;">Nothing to show</div>
        <div style="font-size:0.85rem;color:var(--text-muted);margin-top:0.25rem;">Try clearing search, changing filters, toggling Hide ₦0, or add an enterprise.</div>
      </div>`;

    listEl.querySelectorAll('.advice-input').forEach(input => {
      input.addEventListener('input', () => {
        const id = input.dataset.id;
        const row = rows.find(r => String(r.id) === String(id));
        if (row) row.amount = parseFloat(input.value) || 0;
        calcTotal();
        applyFilters();
      });
      input.addEventListener('change', () => {
        if (input.value === '' || Number(input.value) < 0) input.value = 0;
        const row = rows.find(r => String(r.id) === String(input.dataset.id));
        if (row) { row.amount = parseFloat(input.value) || 0; input.value = row.amount; }
        calcTotal(); applyFilters();
      });
    });
    listEl.querySelectorAll('.step-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const row = rows.find(r => String(r.id) === String(id));
        if (!row) return;
        const step = Number(btn.dataset.step) || 0;
        row.amount = Math.max(0, (parseFloat(row.amount) || 0) + step * 1000);
        const input = listEl.querySelector(`.advice-input[data-id="${CSS.escape(String(id))}"]`);
        if (input) input.value = row.amount;
        calcTotal(); applyFilters();
      });
    });
  };

  function openAddModal() {
    // Always open the modal: list every savings account, zero-amount
    // ("not yet added") ones first, so the button never dead-ends.
    try {
    if (!rows || rows.length === 0) {
      showToast('Enterprises are still loading. Please wait a moment and try again.', 'info');
      return;
    }
    const savings = rows
      .filter(r => r.type === 'savings')
      .sort((a, b) => ((parseFloat(a.amount) || 0) === 0 ? 0 : 1) - ((parseFloat(b.amount) || 0) === 0 ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
    if (savings.length === 0) {
      showToast('No savings enterprises found. Please contact your administrator.', 'info');
      return;
    }
    modalMount.innerHTML = `
      <div class="advice-modal-overlay" id="add-modal-overlay">
        <div class="advice-modal-card" role="dialog" aria-label="Add enterprise">
          <div style="padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-light);display:flex;gap:1rem;align-items:flex-start;justify-content:space-between;">
            <div>
              <div style="font-weight:800;font-size:1.15rem;color:var(--text-primary);">Add enterprise</div>
              <div style="font-size:0.82rem;color:var(--text-muted);margin-top:0.2rem;">Pick a savings account and set a monthly amount. Accounts at ₦0 are not yet in your plan.</div>
            </div>
            <button type="button" id="add-modal-close" style="border:1px solid var(--border-medium);background:transparent;color:var(--text-muted);border-radius:0.5rem;padding:0.4rem 0.8rem;cursor:pointer;">✕</button>
          </div>
          <div style="padding:1.25rem 1.5rem;overflow-y:auto;display:flex;flex-direction:column;gap:1rem;">
            <input id="add-modal-search" type="text" placeholder="Search..." autocomplete="off" style="padding:0.65rem 0.9rem;border-radius:0.8rem;border:1px solid var(--border-medium);background:var(--bg-input);color:var(--text-primary);outline:none;">
            <div id="add-modal-list" style="display:flex;flex-direction:column;gap:0.5rem;max-height:300px;overflow-y:auto;"></div>
            <div style="display:flex;gap:0.75rem;align-items:flex-end;flex-wrap:wrap;">
              <div style="flex:1;min-width:160px;">
                <label style="font-size:0.75rem;font-weight:700;color:var(--text-muted);">MONTHLY AMOUNT</label>
                <input id="add-modal-amount" type="number" step="100" min="0" value="5000" style="width:100%;box-sizing:border-box;margin-top:0.3rem;padding:0.65rem 0.8rem;border-radius:0.8rem;border:1px solid var(--border-medium);background:var(--bg-input);color:var(--text-primary);font-weight:700;">
              </div>
              <button type="button" id="add-modal-confirm" class="primary-button" style="padding:0.7rem 1.4rem;">Add to advice</button>
            </div>
          </div>
        </div>
      </div>`;
    let selectedId = String((savings.find(r => (parseFloat(r.amount) || 0) === 0) || savings[0]).id);
    const overlay = modalMount.querySelector('#add-modal-overlay');
    const q = modalMount.querySelector('#add-modal-search');
    const listBox = modalMount.querySelector('#add-modal-list');
    const amtInput = modalMount.querySelector('#add-modal-amount');

    const closeModal = () => {
      document.removeEventListener('keydown', onKey);
      modalMount.innerHTML = '';
    };
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);

    const paintModal = (term = '') => {
      const t = (term || '').toLowerCase();
      const filtered = savings.filter(c => !t || String(c.name || '').toLowerCase().includes(t));
      listBox.innerHTML = filtered.length ? filtered.map(c => {
        const amt = parseFloat(c.amount) || 0;
        const selected = String(selectedId) === String(c.id);
        return `
        <button type="button" data-pick="${escapeAttribute(String(c.id))}" style="text-align:left;display:flex;gap:0.75rem;align-items:center;padding:0.7rem 0.8rem;border-radius:0.8rem;border:1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-light)'};background:${selected ? 'var(--accent-soft)' : 'transparent'};cursor:pointer;color:var(--text-primary);">
          <span style="font-weight:800;">${escapeHtml(c.name)}</span>
          ${amt === 0
            ? '<span style="font-size:0.68rem;font-weight:800;color:#059669;background:rgba(16,185,129,0.14);padding:0.15rem 0.5rem;border-radius:999px;">NOT ADDED</span>'
            : `<span style="font-size:0.72rem;font-weight:700;color:var(--text-muted);">${formatCurrency(amt)}/mo</span>`}
          <span style="margin-left:auto;font-size:0.75rem;color:var(--text-muted);">Bal ${formatCurrency(c.balance || 0)}</span>
        </button>`;
      }).join('') : '<p style="color:var(--text-muted);font-size:0.85rem;">No match.</p>';
    };
    paintModal();
    const selectedRow = () => savings.find(r => String(r.id) === String(selectedId));
    const syncAmountWithSelection = () => {
      const r = selectedRow();
      if (r && (parseFloat(r.amount) || 0) > 0) amtInput.value = r.amount;
    };
    syncAmountWithSelection();
    q.addEventListener('input', () => paintModal(q.value || ''));
    // Single delegated listener — survives list repaints.
    listBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      selectedId = b.dataset.pick;
      paintModal(q.value || '');
      syncAmountWithSelection();
    });
    modalMount.querySelector('#add-modal-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    modalMount.querySelector('#add-modal-confirm').addEventListener('click', () => {
      const row = rows.find(r => String(r.id) === String(selectedId));
      if (!row) { showToast('Please select an enterprise first.', 'error'); return; }
      const amt = Math.max(0, parseFloat(amtInput.value) || 0);
      if (amt <= 0) { showToast('Enter an amount greater than zero.', 'error'); return; }
      row.amount = amt;
      const input = listEl.querySelector(`.advice-input[data-id="${CSS.escape(String(row.id))}"]`);
      if (input) input.value = amt;
      closeModal();
      // Make sure the updated row is actually visible: clear any
      // search/loan-filter that could keep it hidden.
      activeFilter = 'all';
      searchTerm = '';
      if (searchInput) searchInput.value = '';
      container.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
      calcTotal(); applyFilters();
      showToast(`${row.name} added to your advice. Remember to Save.`, 'success');
      setTimeout(() => {
        listEl.querySelector(`.advice-row[data-entid="${CSS.escape(String(row.id))}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
    });
    } catch (err) {
      console.error('[PaymentAdvice] Add enterprise failed:', err);
      showToast('Could not open Add enterprise: ' + (err?.message || err), 'error');
    }
  }

  // ── Toolbar listeners are attached BEFORE data loads so the buttons
  // are never dead (previously they were wired only after a successful
  // fetch — any load hiccup left "nothing happens on click").
  container.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      applyFilters();
    });
  });
  if (searchInput) searchInput.addEventListener('input', () => {
    searchTerm = (searchInput.value || '').toLowerCase().trim();
    applyFilters();
  });
  const toggleHideZero = () => {
    hideZero = !hideZero;
    if (hideToggle) {
      hideToggle.classList.toggle('off', !hideZero);
      hideToggle.setAttribute('aria-checked', String(hideZero));
    }
    applyFilters();
  };
  if (hideToggle) {
    hideToggle.addEventListener('click', toggleHideZero);
    hideToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHideZero(); }
    });
  }
  if (addBtn) addBtn.addEventListener('click', () => openAddModal());

  try {
    const [ents, balData, member] = await Promise.all([
      fetchEnterprises(cooperativeId, true),
      buildAccountBalance(cooperativeId, user),
      fetchMemberDoc(user.memberId)
    ]);
    // Prefer the member doc's advice, fall back to the payment_advise table
    // (fetchMemberDoc via global lookup may not carry the attached array).
    let adviceDocs = (member && member.payment_advise) || [];
    try {
      if (!adviceDocs || adviceDocs.length === 0) {
        adviceDocs = await fetchMemberPaymentAdvise(user.memberId) || [];
      }
    } catch { /* keep doc advice */ }

    const activeEnts = (ents || []).filter(e => !e.is_deleted);
    const adviceMap = {};
    adviceDocs.forEach(a => { adviceMap[String(a.enterprise_id)] = parseFloat(a.amount) || 0; });
    const balanceMap = {};
    (balData.accountBalance || []).forEach(b => { balanceMap[String(b.id)] = b.sum_of_amount; });

    rows = activeEnts.map(e => {
      const type = (e.account_type || '').toLowerCase();
      return {
        id: String(e.id),
        name: e.account_name || String(e.id),
        type: type || 'other',
        typeLabel: e.account_type || 'Other',
        balance: balanceMap[String(e.id)] || 0,
        amount: adviceMap[String(e.id)] || 0
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    paintRows();
    if (hideToggle) hideToggle.classList.remove('off');
    calcTotal();
    applyFilters();

    saveBtn.addEventListener('click', async () => {
      const adviceList = rows
        .filter(r => (parseFloat(r.amount) || 0) !== 0)
        .map(r => ({
          id: generateId(cooperativeId),
          enterprise_id: r.id,
          amount: parseFloat(r.amount) || 0,
          created_at: new Date().toISOString()
        }));
      try {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Saving...';
        await updateMemberPaymentAdvice(user.memberId, adviceList, user.username, cooperativeId);
        showToast('Payment advice updated successfully!', 'success');
      } catch (err) {
        showToast('Error: ' + err.message, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerText = 'Save Changes';
      }
    });

    resetBtn?.addEventListener('click', async () => {
      const loanAdvices = rows
        .filter(r => r.type === 'loan' && (parseFloat(r.amount) || 0) !== 0)
        .map(r => ({
          id: generateId(cooperativeId),
          enterprise_id: r.id,
          amount: parseFloat(r.amount) || 0,
          created_at: new Date().toISOString()
        }));
      const hasSavings = rows.some(r => r.type !== 'loan' && (parseFloat(r.amount) || 0) !== 0);
      if (!hasSavings) {
        showToast('No savings advice to reset. Loan advice is preserved.', 'info');
        return;
      }
      if (!window.confirm('Reset your savings advice to zero? Loan advice set automatically on loan creation will be preserved.')) return;
      try {
        resetBtn.disabled = true;
        resetBtn.innerText = 'Resetting...';
        await updateMemberPaymentAdvice(user.memberId, loanAdvices, user.username, cooperativeId);
        rows.forEach(r => { if (r.type !== 'loan') r.amount = 0; });
        listEl.querySelectorAll('.advice-input').forEach(input => {
          const row = rows.find(r => String(r.id) === String(input.dataset.id));
          if (row && row.type !== 'loan') input.value = 0;
        });
        calcTotal(); applyFilters();
        showToast('Savings advice reset. Loan advice preserved.', 'success');
      } catch (err) {
        showToast('Error: ' + err.message, 'error');
      } finally {
        resetBtn.disabled = false;
        resetBtn.innerText = 'Reset';
      }
    });
  } catch (err) {
    listEl.innerHTML = `<p style="color:var(--danger);">Error loading advice: ${escapeHtml(err.message)}</p>`;
    if (breakdownEl) breakdownEl.innerHTML = '<span class="advice-chip">Failed to load</span>';
    saveBtn.style.display = 'none';
    resetBtn.style.display = 'none';
  }
}
