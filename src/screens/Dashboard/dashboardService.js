import { state } from '../../state/appState.js'
import { escapeHtml, escapeAttribute, getInitials, formatCurrency, getTimestampMs } from '../../utils/formatters.js'
import { hasPermission } from '../../services/permissionService.js'
import { networkIndicatorClass, networkIndicatorLabel, networkIndicatorIcon } from '../../services/networkService.js'
import { getAllForCoop, loadDoc, isSynced } from '../../services/sqliteService.js'
import { saveSessionLocally as saveSession } from '../../services/offlineAuthService.js'
import { updateNavSelection } from '../../services/routingService.js'
import { canPerformRefresh } from '../../services/formDirtyTracker.js'
import { setupLoanRequestListeners } from '../../components/LoanWizard.js'
import { renderAccountBalance } from '../AccountBalance.js'
import { renderMemberLedger } from '../MemberLedger.js'
import { renderUnifiedPayment } from '../Remittance/index.js'
import { renderMembers } from '../members/index.js'
import { renderSettings } from '../Settings.js'
import { renderReports } from '../Reports.js'
import { renderReconciliation } from '../Reconciliation.js'

let _dashboardRefreshInterval = null
const DASHBOARD_REFRESH_INTERVAL = 60000

function renderDashboard() {
  window.__appEl.innerHTML = `
    <div class="dashboard-layout">
      <!-- Mobile Nav Toggle -->
      <button class="mobile-nav-toggle" data-action="toggle-mobile-nav">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="24" height="24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
        </svg>
      </button>

      <aside class="sidebar">
        <div class="sidebar-header">
          <div style="display: flex; gap: 1rem; align-items: center; width: 100%;">
            <div id="coop-logo-container" style="width: 48px; height: 48px; border-radius: 50%; background: var(--accent-primary); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.25rem; overflow: hidden; flex-shrink: 0;">
              <!-- Will be filled dynamically -->
            </div>
            <div style="flex: 1;">
              <div style="font-weight: 700; color: var(--text-primary); font-size: 1rem; margin-bottom: 0.25rem;">${escapeHtml(state.welcomeUser.cooperativeName)}</div>
              <div class="network-indicator ${networkIndicatorClass()}" style="padding: 0.15rem 0.5rem; font-size: 0.65rem;" role="status" aria-label="${networkIndicatorLabel()}">
                <span class="indicator-icon" style="width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center;">${networkIndicatorIcon()}</span>
                <span>${networkIndicatorLabel()}</span>
              </div>
            </div>
            <div id="notification-bell-placeholder"></div>
          </div>
        </div>

        ${!isSubscriptionActive() && String(state.welcomeUser.username || '').toLowerCase() !== 'admin' ? `
          <div style="margin: 0.75rem 1rem; padding: 0.75rem; background: var(--warning-bg, #fef3c7); color: var(--warning, #d97706); border: 1px solid var(--warning, #d97706); border-radius: 0.5rem; font-size: 0.7rem; font-weight: 600; text-align: center; line-height: 1.4;">
            ${INACTIVE_MSG}
          </div>
        ` : ''}
        
        <nav class="sidebar-nav">
          ${(state.welcomeUser.role === 'member' || hasPermission(state.welcomeUser.permissions, 'dashboard_view')) ? `
            <button class="nav-item ${state.activeTab === 'dashboard' ? 'active' : ''}" data-action="nav-tab" data-tab="dashboard">
              Dashboard
            </button>
          ` : ''}
          ${!isSubscriptionActive() && String(state.welcomeUser.username || '').toLowerCase() !== 'admin' ? '' : `
          ${(state.welcomeUser.role !== 'member' && hasPermission(state.welcomeUser.permissions, 'read_member')) ? `
            <button class="nav-item ${state.activeTab === 'members' ? 'active' : ''}" data-action="nav-tab" data-tab="members">
              Members
            </button>
          ` : ''}
          ${(state.welcomeUser.role === 'member' || hasPermission(state.welcomeUser.permissions, 'read_remittance')) ? `
            <button class="nav-item ${state.activeTab === 'payments' ? 'active' : ''}" data-action="nav-tab" data-tab="payments">
              Remittance
            </button>
          ` : ''}
          ${(state.welcomeUser.role === 'member' || hasPermission(state.welcomeUser.permissions, 'read_ledger')) ? `
            <button class="nav-item ${state.activeTab === 'monthly-summary' ? 'active' : ''}" data-action="nav-tab" data-tab="monthly-summary">
              Account Summary
            </button>
          ` : ''}
          <button class="nav-item ${state.activeTab === 'withdrawal-request' ? 'active' : ''}" data-action="withdrawal-request">
            Withdrawal Request
          </button>
          ${(state.welcomeUser.role !== 'member' && hasPermission(state.welcomeUser.permissions, 'read_member')) ? `
            <button class="nav-item ${state.activeTab === 'reports' ? 'active' : ''}" data-action="nav-tab" data-tab="reports">
              Reports
            </button>
          ` : ''}
          ${hasPermission(state.welcomeUser.permissions, 'read_reconcile') ? `
            <button class="nav-item ${state.activeTab === 'reconciliation' ? 'active' : ''}" data-action="nav-tab" data-tab="reconciliation">
              Reconciliation
            </button>
          ` : ''}
          `}
          ${(state.welcomeUser.role === 'member' || hasPermission(state.welcomeUser.permissions, 'settings_manage')) ? `
            <button class="nav-item ${state.activeTab === 'settings' ? 'active' : ''}" data-action="nav-tab" data-tab="settings">
              Settings
            </button>
          ` : ''}
        </nav>

        <div class="sidebar-footer">
          <div style="display: flex; gap: 0.75rem; align-items: center;">
            <div id="user-avatar-container" style="width: 40px; height: 40px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-primary); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; overflow: hidden; flex-shrink: 0;">
              <!-- Will be filled dynamically -->
            </div>
            <div style="flex: 1;">
              <div style="font-weight: 600; color: var(--text-primary); font-size: 0.9rem;">
                ${escapeHtml(state.welcomeUser.role === 'member' ? state.welcomeUser.fullName : state.welcomeUser.username)}
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem;">
            <button class="secondary-button" style="flex: 1; padding: 0.5rem; font-size: 0.8rem; border-radius: var(--radius-md);" data-action="logout">
              Log Out
            </button>
          </div>
        </div>
      </aside>
      <div class="sidebar-overlay" data-action="close-sidebar"></div>

      <!-- Main Content Area -->
      <main class="main-content" id="dashboard-main-content">
        <!-- Content gets injected here -->
      </main>

      ${renderGlobalModal()}
    </div>
  `

  saveSession(state.welcomeUser)
  renderDashboardContent()
  updateNavSelection()
  
  // Start periodic dashboard data refresh (only when idle)
  startDashboardAutoRefresh()

  // Populate cooperative logo and user avatar
  populateAvatars()

  // Setup listeners for Global Modal if active
  if (state.modal.isOpen) {
    if (state.modal.type === 'withdrawal-request') {
      setupLoanRequestListeners()
    }
  }
}

function startDashboardAutoRefresh() {
  if (_dashboardRefreshInterval) clearInterval(_dashboardRefreshInterval)
  _dashboardRefreshInterval = setInterval(() => {
    if (document.hidden) return
    if (state.activeTab === 'dashboard' && canPerformRefresh()) {
      renderDashboardContent()
    }
  }, DASHBOARD_REFRESH_INTERVAL)
}

function renderGlobalModal() {
  return `
      <!-- Global Modal Overlay -->
      <div id="modal-overlay" class="modal-overlay ${state.modal.isOpen ? 'open' : ''}">
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="modal-title" style="margin: 0;">${state.modal.title || 'Details'}</h3>
                <button class="modal-close" data-action="close-modal">
                    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
            </div>
            <div id="modal-body" class="modal-body">
                ${state.modal.content || ''}
            </div>
        </div>
      </div>
  `
}

async function populateAvatars() {
  try {
    console.log('[Avatars] Starting populateAvatars...');
    console.log('[Avatars] Welcome user:', state.welcomeUser);
    
    // Populate cooperative logo
    const coopContainer = document.getElementById('coop-logo-container');
    if (coopContainer && state.welcomeUser?.cooperativeId) {
      console.log('[Avatars] Fetching cooperative data for ID:', state.welcomeUser.cooperativeId);
      const coops = await getAllForCoop(state.welcomeUser.cooperativeId, 'cooperatives');
      console.log('[Avatars] Coops found:', coops);
      console.log('[Avatars] Coops full data (JSON):', JSON.stringify(coops, null, 2));
      const coop = coops[0];
      console.log('[Avatars] Coop logo_path:', coop?.logo_path);
      console.log('[Avatars] Coop logo_path type:', typeof coop?.logo_path);
      
      if (coop?.logo_path) {
        console.log('[Avatars] Displaying cooperative logo');
        coopContainer.innerHTML = `<img src="${coop.logo_path}" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="console.error('[Avatars] Coop logo failed to load', this.src)" />`;
      } else {
        console.log('[Avatars] Using cooperative initials:', getInitials(state.welcomeUser.cooperativeName));
        coopContainer.textContent = getInitials(state.welcomeUser.cooperativeName);
      }
    }

    // Populate user avatar
    const userContainer = document.getElementById('user-avatar-container');
    if (userContainer && state.welcomeUser) {
      const displayName = state.welcomeUser.role === 'member' 
        ? state.welcomeUser.fullName 
        : state.welcomeUser.username;
      
      let imagePath = null;
      if (state.welcomeUser.role === 'member' && state.welcomeUser.memberId) {
        console.log('[Avatars] Fetching member data for ID:', state.welcomeUser.memberId);
        const member = await loadDoc('members', state.welcomeUser.memberId, state.welcomeUser.cooperativeId);
        console.log('[Avatars] Member data:', member);
        console.log('[Avatars] Member image_path:', member?.image_path);
        imagePath = member?.image_path;
      }

      if (imagePath) {
        console.log('[Avatars] Displaying user avatar');
        userContainer.innerHTML = `<img src="${imagePath}" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="console.error('[Avatars] User avatar failed to load', this.src)" />`;
      } else {
        console.log('[Avatars] Using user initials:', getInitials(displayName));
        userContainer.textContent = getInitials(displayName);
      }
      // Member self-service: clickable only when no photo exists; read-only otherwise.
      try {
        const { enableMemberAvatarUpload } = await import('../../components/memberAvatarUpload.js')
        for (const el of document.querySelectorAll('#user-avatar-container')) {
          await enableMemberAvatarUpload(el, state.welcomeUser)
        }
      } catch {}
    }
  } catch (err) {
    console.error('[Avatars] Failed to populate avatars:', err);
  }
}

function isSubscriptionActive() {
  const u = state.welcomeUser
  if (!u) return false
  if (String(u.username || '').toLowerCase() === 'admin') return true
  const status = u.subscriptionStatus
  if (status === undefined || status === null || status === '') return true
  const n = Number(status)
  if (n !== 1) return false
  if (u.subscriptionExpiry) {
    const expiryMs = getTimestampMs(u.subscriptionExpiry)
    if (expiryMs > 0 && expiryMs < Date.now()) return false
  }
  return true
}

const INACTIVE_MSG = 'Your account subscription is inactive. Please contact the administrator.'

let _dashRenderBusy = false;
let _dashRenderQueued = false;
async function renderDashboardContent() {
  if (_dashRenderBusy) { _dashRenderQueued = true; return; }
  _dashRenderBusy = true;
  try {
    await _renderDashboardContentInner();
  } finally {
    _dashRenderBusy = false;
    if (_dashRenderQueued) { _dashRenderQueued = false; renderDashboardContent(); }
  }
}

async function _renderDashboardContentInner() {
  const container = document.getElementById('dashboard-main-content')
  if (!container) return

  const isAdmin = hasPermission(state.welcomeUser.permissions, 'admin') || String(state.welcomeUser.username || '').toLowerCase() === 'admin'
  const subActive = isSubscriptionActive()

  if (!subActive && !isAdmin) {
    if (state.activeTab !== 'dashboard' && state.activeTab !== 'settings') {
      container.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4rem 2rem; text-align: center;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">🔒</div>
          <h3 style="margin: 0 0 0.5rem 0;">Access Restricted</h3>
          <p style="color: var(--text-muted); max-width: 400px; margin: 0;">${INACTIVE_MSG}</p>
        </div>
      `
      return
    }
  }

  // Preserve actual role — don't override to 'admin' for staff users (breaks RBAC in screens)
  // isAdmin flag is passed separately so screens can check it properly
  // Create a deep copy to prevent accidental modifications to shared state
  const displayUser = JSON.parse(JSON.stringify({
    ...state.welcomeUser,
    memberId: state.welcomeUser.memberId,
    memberName: state.welcomeUser.role === 'member' ? state.welcomeUser.fullName : null,
    isAdmin,
    subscriptionStatus: state.welcomeUser.subscriptionStatus,
    subscriptionExpiry: state.welcomeUser.subscriptionExpiry,
  }))

  // Pass sub-route info (deep copy to prevent shared references)
  displayUser.routeParts = JSON.parse(JSON.stringify(state.routeParts || []))

  const isMemberRole = state.welcomeUser.role === 'member'

  // Members cannot access the Members tab — redirect to payments
  if (isMemberRole && state.activeTab === 'members') {
    state.activeTab = 'payments'
    window.location.hash = 'payments'
    return
  }

  // Redirect legacy tabs to unified payments
  if (state.activeTab === 'history' || state.activeTab === 'log') {
    state.activeTab = 'payments'
    window.location.hash = 'payments'
    return
  }

  if (state.activeTab === 'members') {
    await renderMembers(container, displayUser)
  } else if (state.activeTab === 'dashboard') {
    await renderAccountBalance(container, displayUser)
  } else if (state.activeTab === 'payments') {
    await renderUnifiedPayment(container, displayUser, state.editingRemittance)
  } else if (state.activeTab === 'monthly-summary') {
    await renderMemberLedger(container, displayUser)
  } else if (state.activeTab === 'reports') {
    const displayUserReports = JSON.parse(JSON.stringify(displayUser));
    displayUserReports.reports = state.reports;
    displayUserReports.onReportsStateChange = (newReportsState) => {
      state.reports = { ...state.reports, ...newReportsState };
      // We don't necessarily need to full re-render here if the screen handles its own updates
      // but it's good for persistence
    };
    await renderReports(container, displayUserReports)
  } else if (state.activeTab === 'reconciliation') {
    await renderReconciliation(state, container)
  } else if (state.activeTab === 'settings') {
    await renderSettings(container, displayUser)
  }
}

function renderAlert() {
  if (!state.errorMessage) {
    return ''
  }

  return `<div class="alert">${escapeHtml(state.errorMessage)}</div>`
}

export { renderDashboard, startDashboardAutoRefresh, renderGlobalModal, populateAvatars, isSubscriptionActive, INACTIVE_MSG, renderDashboardContent, renderAlert }
