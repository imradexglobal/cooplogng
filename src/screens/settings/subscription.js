import { showToast } from '../../services/toastService.js';
import { escapeHtml, formatDate } from '../../utils/formatters.js';
import {
  getSubscriptionStatistics,
  getAllAccounts,
  activateSubscription,
  deactivateSubscription,
  bulkSetSubscription,
} from '../../services/subscriptionService.js';

export function renderSubscriptionSection(area) {
  area.innerHTML = `
    <style>
      .sub-page { display: flex; flex-direction: column; min-height: 0; gap: 0.5rem; }
      .sub-sticky {
        position: sticky; top: 0; z-index: 20;
        background: var(--bg-card);
        padding-bottom: 0.5rem;
      }
      .sub-title { margin: 0; font-size: 1.15rem; font-weight: 800; color: var(--text-primary); line-height: 1.2; }
      .sub-desc { margin: 0.15rem 0 0 0; font-size: 0.78rem; color: var(--text-muted); }
      .sub-stats-grid {
        display: grid; grid-template-columns: repeat(4, 1fr);
        gap: 0.5rem; margin-top: 0.6rem;
      }
      .sub-stats-grid .stat-card {
        background: var(--bg-card);
        border: 1px solid var(--border-light);
        border-radius: var(--radius-lg);
        padding: 0.55rem 0.75rem;
        box-shadow: var(--shadow-sm);
        min-width: 0; cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
      }
      .sub-stats-grid .stat-card:hover { transform: translateY(-1px); border-color: var(--border-medium); }
      .sub-stats-grid .stat-card.active { border-color: var(--accent-primary); box-shadow: 0 0 0 2px var(--accent-soft); }
      .sub-stats-grid .stat-label {
        font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.07em; color: var(--text-muted);
      }
      .sub-stats-grid .stat-value {
        font-size: 1.2rem; font-weight: 800; color: var(--text-primary);
        font-variant-numeric: tabular-nums; line-height: 1.2;
      }
      .sub-stats-grid .stat-sub {
        font-size: 0.68rem; color: var(--text-muted); font-weight: 600;
        margin-top: 0.1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sub-filters-row {
        display: flex; align-items: center; gap: 0.5rem;
        margin-top: 0.6rem; background: var(--bg-card);
        padding: 0.5rem; border-radius: var(--radius-lg);
        border: 1px solid var(--border-light); flex-wrap: wrap;
      }
      .sub-search-wrap { position: relative; flex: 1; min-width: 160px; max-width: 300px; }
      .sub-search-wrap input {
        width: 100%; padding: 0.45rem 0.6rem 0.45rem 1.9rem; border-radius: var(--radius-md);
        border: 1px solid var(--border-medium); font-size: 0.8rem; outline: none;
        background: var(--bg-input); color: var(--text-primary); box-sizing: border-box;
      }
      .sub-search-wrap .search-icon {
        position: absolute; left: 0.6rem; top: 50%; transform: translateY(-50%);
        color: var(--text-muted); pointer-events: none;
      }
      .sub-select {
        padding: 0.45rem 0.5rem; border-radius: var(--radius-md);
        border: 1px solid var(--border-medium); font-size: 0.78rem;
        background: var(--bg-input); color: var(--text-primary); outline: none; cursor: pointer;
      }
      .sub-actions { display: flex; gap: 0.4rem; margin-left: auto; }
      .sub-btn {
        display: inline-flex; align-items: center; gap: 0.3rem;
        padding: 0.45rem 0.7rem; border-radius: var(--radius-md);
        border: 1px solid var(--border-medium); background: var(--bg-card);
        font-size: 0.76rem; font-weight: 600; color: var(--text-primary);
        cursor: pointer; transition: background 0.15s ease; white-space: nowrap;
      }
      .sub-btn:hover { background: var(--bg-secondary); }
      .sub-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .sub-btn.danger { color: var(--danger); border-color: rgba(220,38,38,0.35); }
      .sub-btn.primary { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
      .sub-count {
        font-size: 0.72rem; color: var(--text-muted); font-weight: 600;
        padding: 0.35rem 0.25rem 0; font-variant-numeric: tabular-nums;
      }
      .sub-table-wrap {
        overflow-y: auto; border-radius: var(--radius-lg);
        background: var(--bg-card); border: 1px solid var(--border-light);
        box-shadow: var(--shadow-sm); scrollbar-width: thin;
        max-height: calc(100vh - 430px); min-height: 280px; position: relative;
      }
      .sub-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
      .sub-table thead th {
        position: sticky; top: 0; z-index: 10;
        background: var(--bg-card) !important;
        color: var(--text-muted) !important;
        font-weight: 700; text-transform: uppercase; font-size: 0.66rem; letter-spacing: 0.07em;
        padding: 0.6rem 0.75rem; text-align: left; white-space: nowrap;
        border-bottom: 2px solid var(--border-light);
        box-shadow: 0 1px 0 var(--border-light);
      }
      .sub-table tbody td {
        padding: 0.55rem 0.75rem; border-bottom: 1px solid var(--border-light);
        vertical-align: middle; color: var(--text-primary);
      }
      .sub-table tbody tr:nth-child(even) { background-color: var(--bg-secondary); }
      .sub-table tbody tr:hover { background-color: var(--accent-soft) !important; }
      .sub-table tbody tr.selected { background: var(--accent-soft) !important; }
      .sub-badge {
        display: inline-flex; align-items: center; gap: 0.3rem;
        font-size: 0.68rem; font-weight: 700; padding: 0.22rem 0.6rem;
        border-radius: 999px; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;
      }
      .sub-badge::before {
        content: ''; display: inline-block; width: 5px; height: 5px;
        border-radius: 50%; background: currentColor; flex-shrink: 0;
      }
      .sub-badge.active { background: var(--success-bg); color: var(--success); border: 1px solid rgba(22,163,74,0.2); }
      .sub-badge.expired { background: var(--warning-bg); color: var(--warning); border: 1px solid rgba(217,119,6,0.2); }
      .sub-badge.inactive { background: var(--danger-bg); color: var(--danger); border: 1px solid rgba(220,38,38,0.2); }
      .sub-badge.admin { background: var(--accent-soft); color: var(--accent-primary); border: 1px solid var(--accent-primary); }
      .sub-row-btn {
        padding: 0.28rem 0.6rem; font-size: 0.72rem; font-weight: 600;
        border-radius: var(--radius-md); border: 1px solid var(--border-medium);
        background: var(--bg-card); color: var(--text-primary); cursor: pointer; white-space: nowrap;
      }
      .sub-row-btn:hover { background: var(--bg-secondary); }
      .sub-row-btn.go { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
      .sub-row-btn.stop { color: var(--danger); border-color: rgba(220,38,38,0.35); }
      .sub-type-tag { font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; }
      .sub-name { font-weight: 600; font-size: 0.85rem; line-height: 1.25; }
      .sub-sub { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.1rem; }
      @media (max-width: 999px) {
        .sub-stats-grid { grid-template-columns: repeat(2, 1fr); gap: 0.4rem; }
        .sub-stats-grid .stat-value { font-size: 1.05rem; }
        .sub-table-wrap { max-height: calc(100vh - 380px); }
        .sub-table thead th:nth-child(4), .sub-table tbody td:nth-child(4) { display: none; }
      }
    </style>
    <div class="sub-page">
      <div class="sub-sticky">
        <h3 class="sub-title">Subscription Management</h3>
        <p class="sub-desc">Manage member and user subscriptions for this cooperative.</p>
        <div id="subscription-stats"><p style="color: var(--text-muted); font-style: italic; font-size: 0.8rem;">Loading statistics...</p></div>
        <div class="sub-filters-row">
          <div class="sub-search-wrap">
            <svg class="search-icon" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            <input type="text" id="sub-search-input" placeholder="Search name, reg. no, username...">
          </div>
          <select id="sub-type-filter" class="sub-select">
            <option value="all">All types</option>
            <option value="members">Members</option>
            <option value="users">Users</option>
          </select>
          <select id="sub-status-filter" class="sub-select">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="inactive">Inactive</option>
          </select>
          <div class="sub-actions">
            <button class="sub-btn primary" id="sub-bulk-activate">Activate</button>
            <button class="sub-btn danger" id="sub-bulk-deactivate">Deactivate</button>
          </div>
        </div>
        <div id="sub-count" class="sub-count" aria-live="polite"></div>
      </div>
      <div class="sub-table-wrap" id="sub-table-wrap">
        <div id="subscription-table-container">
          <p style="color: var(--text-muted); font-style: italic; font-size: 0.8rem; padding: 1rem;">Loading accounts...</p>
        </div>
      </div>
    </div>
  `;
}

export function setupSubscriptionListeners(user, cooperativeId) {
  const isAdmin = user.isAdmin || user.username === 'admin';
  if (!isAdmin) {
    document.getElementById('subscription-stats').innerHTML =
      '<p style="color: var(--danger); font-size: 0.82rem;">Access restricted to administrators only.</p>';
    document.getElementById('subscription-table-container').innerHTML = '';
    return;
  }

  let activeType = 'all';
  let activeStatus = 'all';
  let searchTerm = '';
  let accounts = [];
  let selected = new Set();
  let searchDebounce = null;

  const statsEl = () => document.getElementById('subscription-stats');
  const container = () => document.getElementById('subscription-table-container');
  const countEl = () => document.getElementById('sub-count');
  const wrapEl = () => document.getElementById('sub-table-wrap');

  const loadStats = async () => {
    try {
      const s = await getSubscriptionStatistics(cooperativeId);
      const t = s.total;
      const card = (key, label, value, color, sub) => `
        <div class="stat-card${activeStatus === key ? ' active' : ''}" data-stat="${key}" role="button" tabindex="0" title="Filter: ${label}">
          <div class="stat-label">${label}</div>
          <div class="stat-value" style="color: ${color};">${value}</div>
          <div class="stat-sub">${sub}</div>
        </div>`;
      statsEl().innerHTML = `
        <div class="sub-stats-grid">
          ${card('all', 'Total', t.total, 'var(--text-primary)', `M ${s.members.total} • U ${s.users.total}`)}
          ${card('active', 'Active', t.active, 'var(--success)', `M ${s.members.active} • U ${s.users.active}`)}
          ${card('expired', 'Expired', t.expired, 'var(--warning)', `M ${s.members.expired} • U ${s.users.expired}`)}
          ${card('inactive', 'Inactive', t.inactive, 'var(--danger)', `M ${s.members.inactive} • U ${s.users.inactive}`)}
        </div>`;
      statsEl().querySelectorAll('.stat-card[data-stat]').forEach((el) => {
        const fire = () => {
          activeStatus = el.dataset.stat;
          const sel = document.getElementById('sub-status-filter');
          if (sel) sel.value = activeStatus;
          loadStats();
          loadTable();
        };
        el.onclick = fire;
        el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } };
      });
    } catch (e) {
      statsEl().innerHTML = `<p style="color: var(--danger); font-size: 0.8rem;">Failed to load statistics: ${escapeHtml(e.message)}</p>`;
    }
  };

  const statusBadge = (a) => {
    if (a.isAdmin) return '<span class="sub-badge admin">Admin</span>';
    return `<span class="sub-badge ${a.state}">${a.state}</span>`;
  };

  const paintCount = (shown, total) => {
    if (countEl()) {
      countEl().textContent = total === 0
        ? 'No accounts match the current filters'
        : `Showing ${shown} of ${total} account${total === 1 ? '' : 's'}${selected.size ? ` • ${selected.size} selected` : ''}`;
    }
  };

  const loadTable = async () => {
    const el = container();
    if (!el) return;
    el.innerHTML = '<p style="color: var(--text-muted); font-style: italic; font-size: 0.8rem; padding: 1rem;">Loading accounts...</p>';
    try {
      accounts = await getAllAccounts(cooperativeId, { type: activeType, status: activeStatus, search: searchTerm });
      selected = new Set([...selected].filter((k) => accounts.some((a) => `${a.collection}:${a.id}` === k)));
      paintCount(accounts.length, accounts.length);
      if (accounts.length === 0) {
        el.innerHTML = '<p style="color: var(--text-muted); font-style: italic; font-size: 0.8rem; padding: 1.25rem; text-align: center;">No accounts match this filter.</p>';
        return;
      }
      el.innerHTML = `
        <table class="sub-table">
          <thead>
            <tr>
              <th style="width: 32px;"><input type="checkbox" id="sub-select-all" style="width: 14px; height: 14px; accent-color: var(--accent-primary);"></th>
              <th>Type</th>
              <th>Name / Username</th>
              <th>Info</th>
              <th>Status</th>
              <th>Expiry</th>
              <th style="width: 150px; text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map((a) => {
              const key = `${a.collection}:${a.id}`;
              const checked = selected.has(key) ? 'checked' : '';
              const disabled = a.isAdmin ? 'disabled' : '';
              const sel = selected.has(key) ? ' class="selected"' : '';
              return `
                <tr${sel} data-key="${escapeHtml(key)}">
                  <td><input type="checkbox" class="sub-select-cb" data-key="${escapeHtml(key)}" ${checked} ${disabled} style="width: 14px; height: 14px; accent-color: var(--accent-primary);"></td>
                  <td><span class="sub-type-tag">${a.collection === 'members' ? 'Member' : 'User'}</span></td>
                  <td><div class="sub-name">${escapeHtml(a.displayName || '—')}</div>${a.detail ? `<div class="sub-sub">${escapeHtml(a.detail)}</div>` : ''}</td>
                  <td style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(a.secondary || '—')}</td>
                  <td>${statusBadge(a)}</td>
                  <td style="font-size: 0.78rem; color: var(--text-muted); white-space: nowrap;">${a.isAdmin || !a.expiry_date ? '—' : escapeHtml(formatDate(a.expiry_date))}</td>
                  <td style="text-align: right; white-space: nowrap;">
                    ${a.isAdmin ? '<span style="color: var(--text-muted); font-size: 0.72rem;">—</span>' : `
                      <button class="sub-row-btn go sub-activate-btn" data-collection="${a.collection}" data-id="${escapeHtml(a.id)}" data-name="${escapeHtml(a.displayName)}">Activate</button>
                      <button class="sub-row-btn stop sub-deactivate-btn" data-collection="${a.collection}" data-id="${escapeHtml(a.id)}" data-name="${escapeHtml(a.displayName)}" style="margin-left: 0.3rem;">Deactivate</button>
                    `}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
      bindTableEvents();
      if (wrapEl()) wrapEl().scrollTop = 0;
    } catch (e) {
      el.innerHTML = `<p style="color: var(--danger); font-size: 0.8rem; padding: 1rem;">Failed to load accounts: ${escapeHtml(e.message)}</p>`;
    }
  };

  const refresh = async () => {
    await Promise.all([loadStats(), loadTable()]);
  };

  const generateExpectedKey = () => {
    const today = new Date();
    const yy = String(today.getFullYear()).slice(-2);
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    return `${yy}${dd}${mm}`;
  };

  const promptActivationKey = (title, subtitle) =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'settings-modal-overlay';
      overlay.innerHTML = `
        <div class="settings-modal-content" style="max-width: 400px;">
          <div class="modal-header">
            <h3 style="margin:0; font-size: 1rem;">${escapeHtml(title)}</h3>
            <button class="close-modal-x" style="background:transparent; border:none; color:var(--text-muted); font-size:1.4rem; cursor:pointer;">&times;</button>
          </div>
          <div class="modal-body" style="padding: 1.25rem;">
            <p style="margin: 0 0 0.75rem 0; font-size: 0.85rem;">${subtitle}</p>
            <input type="text" id="activation-key-input" placeholder="Enter activation key"
              style="width: 100%; padding: 0.5rem; border-radius: 6px; border: 1px solid var(--border-medium); font-size: 0.95rem; text-align: center; letter-spacing: 0.2em; background: var(--bg-input); color: var(--text-primary); margin-bottom: 0.75rem; box-sizing: border-box;">
            <div id="activation-key-error" style="color: var(--danger); font-size: 0.78rem; margin-bottom: 0.5rem; display: none;"></div>
            <div style="display: flex; gap: 0.5rem;">
              <button class="sub-btn close-modal-x" style="flex: 1; justify-content: center;">Cancel</button>
              <button class="sub-btn primary" id="confirm-activate-btn" style="flex: 1; justify-content: center;">Activate</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelectorAll('.close-modal-x').forEach((el) => { el.onclick = () => close(null); });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('#confirm-activate-btn').onclick = () => {
        const key = overlay.querySelector('#activation-key-input').value.trim();
        if (key !== generateExpectedKey()) {
          const err = overlay.querySelector('#activation-key-error');
          err.textContent = 'Invalid activation key. Please try again.';
          err.style.display = 'block';
          return;
        }
        close(true);
      };
    });

  const confirmDeactivation = (name) =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'settings-modal-overlay';
      overlay.innerHTML = `
        <div class="settings-modal-content" style="max-width: 380px;">
          <div class="modal-header">
            <h3 style="margin:0; font-size: 1rem; color: var(--danger);">Deactivate</h3>
            <button class="close-modal-x" style="background:transparent; border:none; color:var(--text-muted); font-size:1.4rem; cursor:pointer;">&times;</button>
          </div>
          <div class="modal-body" style="padding: 1.25rem;">
            <p style="margin: 0 0 0.5rem 0; font-size: 0.85rem;">Deactivate <strong>${escapeHtml(name)}</strong>?</p>
            <p style="font-size: 0.76rem; color: var(--text-muted); margin: 0 0 1rem 0;">Access will be restricted after deactivation.</p>
            <div style="display: flex; gap: 0.5rem;">
              <button class="sub-btn close-modal-x" style="flex: 1; justify-content: center;">Cancel</button>
              <button class="sub-btn danger" id="confirm-deactivate-btn" style="flex: 1; justify-content: center; background: var(--danger); border-color: var(--danger); color: #fff;">Deactivate</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelectorAll('.close-modal-x').forEach((el) => { el.onclick = () => close(false); });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      overlay.querySelector('#confirm-deactivate-btn').onclick = () => close(true);
    });

  const doActivate = async (collection, id, name) => {
    const ok = await promptActivationKey('Activate', `Activate subscription for <strong>${escapeHtml(name)}</strong>?`);
    if (!ok) return;
    try {
      const res = await activateSubscription(collection, id, user.username, cooperativeId);
      showToast(`Activated ${name} until ${formatDate(res.expiry)}`, 'success');
      await refresh();
    } catch (e) {
      showToast('Activation failed: ' + e.message, 'error');
    }
  };

  const doDeactivate = async (collection, id, name) => {
    const ok = await confirmDeactivation(name);
    if (!ok) return;
    try {
      await deactivateSubscription(collection, id, user.username, cooperativeId);
      showToast(`Deactivated ${name}`, 'info');
      await refresh();
    } catch (e) {
      showToast('Deactivation failed: ' + e.message, 'error');
    }
  };

  const bindTableEvents = () => {
    container().querySelectorAll('.sub-activate-btn').forEach((btn) => {
      btn.onclick = () => doActivate(btn.dataset.collection, btn.dataset.id, btn.dataset.name);
    });
    container().querySelectorAll('.sub-deactivate-btn').forEach((btn) => {
      btn.onclick = () => doDeactivate(btn.dataset.collection, btn.dataset.id, btn.dataset.name);
    });
    container().querySelectorAll('.sub-select-cb').forEach((cb) => {
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.dataset.key);
        else selected.delete(cb.dataset.key);
        cb.closest('tr')?.classList.toggle('selected', cb.checked);
        paintCount(accounts.length, accounts.length);
      };
    });
    const selectAll = document.getElementById('sub-select-all');
    if (selectAll) {
      selectAll.onchange = () => {
        container().querySelectorAll('.sub-select-cb:not(:disabled)').forEach((cb) => {
          cb.checked = selectAll.checked;
          cb.closest('tr')?.classList.toggle('selected', selectAll.checked);
          if (selectAll.checked) selected.add(cb.dataset.key);
          else selected.delete(cb.dataset.key);
        });
        paintCount(accounts.length, accounts.length);
      };
    }
  };

  const selectedAccounts = () =>
    [...selected]
      .map((key) => {
        const sep = key.indexOf(':');
        return { collection: key.slice(0, sep), id: key.slice(sep + 1) };
      })
      .filter((a) => ['members', 'users'].includes(a.collection));

  document.getElementById('sub-type-filter').onchange = (e) => { activeType = e.target.value; loadTable(); };
  document.getElementById('sub-status-filter').onchange = (e) => { activeStatus = e.target.value; loadStats(); loadTable(); };
  document.getElementById('sub-search-input').oninput = (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { searchTerm = e.target.value; loadTable(); }, 250);
  };

  document.getElementById('sub-bulk-activate').onclick = async () => {
    const list = selectedAccounts();
    if (list.length === 0) return showToast('Select at least one account.', 'warning');
    const ok = await promptActivationKey('Bulk activate', `Activate <strong>${list.length}</strong> selected account(s)?`);
    if (!ok) return;
    const res = await bulkSetSubscription(list, true, user.username, cooperativeId);
    showToast(res.failed.length ? `Activated ${res.done}, ${res.failed.length} failed.` : `Activated ${res.done} account(s).`, res.failed.length ? 'warning' : 'success');
    selected.clear();
    await refresh();
  };

  document.getElementById('sub-bulk-deactivate').onclick = async () => {
    const list = selectedAccounts();
    if (list.length === 0) return showToast('Select at least one account.', 'warning');
    const ok = await confirmDeactivation(`${list.length} selected account(s)`);
    if (!ok) return;
    const res = await bulkSetSubscription(list, false, user.username, cooperativeId);
    showToast(res.failed.length ? `Deactivated ${res.done}, ${res.failed.length} failed.` : `Deactivated ${res.done} account(s).`, res.failed.length ? 'warning' : 'success');
    selected.clear();
    await refresh();
  };

  refresh();
}
