/**
 * Experimental pages — route entry point.
 *
 * The host application (src/main.js) reaches this module through a dynamic
 * import guarded by import.meta.glob, which means:
 *
 *   • deleting the whole src/experimental/ folder leaves the app untouched
 *     (the glob simply returns no loader and the app falls back to the
 *     dashboard), and
 *   • no existing screen, component, hook or stylesheet is imported here.
 *
 * Routes: #experimental-ledger · #experimental-loans
 * Access: administrators only (both the nav entries and the routes).
 */

import './styles/xp.css'
import { hasPermission } from '../services/permissionService.js'
import { escapeHtml } from './lib/format.js'
import { setMobileTitle } from './lib/ui.js'
import { renderLedgerPage } from './ledger/ledgerPage.js'
import { renderLoansPage } from './loans/loansPage.js'

export const ROUTES = {
  'experimental-ledger': { label: 'Ledger', title: 'General Ledger', render: renderLedgerPage },
  'experimental-loans': { label: 'Loan Management', title: 'Loan Management', render: renderLoansPage },
}

const LEDGER_ICON = `
  <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
       viewBox="0 0 24 24" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round"
          d="M4 7h16M4 12h16M4 17h10M4 7a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"/>
  </svg>`

const LOAN_ICON = `
  <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
       viewBox="0 0 24 24" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round"
          d="M3 10h18M5 10V8a2 2 0 012-2h10a2 2 0 012 2v2M4 10v8a2 2 0 002 2h12a2 2 0 002-2v-8M9 14h6"/>
  </svg>`

function isAuthorised(user) {
  if (!user) return false
  return (
    !!user.isAdmin ||
    String(user.role || '').toLowerCase() === 'admin' ||
    hasPermission(user.permissions, 'admin') ||
    String(user.username || '').toLowerCase() === 'admin' ||
    String(user.username || '').toLowerCase() === String(user.coopShortName || '').toLowerCase()
  )
}

function currentRoute() {
  let hash = window.location.hash.substring(1)
  while (hash.startsWith('/')) hash = hash.substring(1)
  return hash.split('/')[0]
}

function bindCalendarPickers() {
  if (window.__xpCalendarPickerBound) return
  window.__xpCalendarPickerBound = true
  document.addEventListener('click', (event) => {
    const input = event.target?.closest?.('.xp input[type="date"], .xp-drawer input[type="date"]')
    if (!input || typeof input.showPicker !== 'function') return
    try {
      input.showPicker()
    } catch {
      // Native picker may already be open or unsupported by the current WebView.
    }
  }, true)
}

/**
 * Adds the two experimental entries to the sidebar and the mobile bottom bar.
 * The host app rebuilds its shell on every render, so this runs on each visit
 * and simply appends — no existing navigation markup is modified.
 */
function injectNav(user) {
  const entries = Object.entries(ROUTES)
  const active = currentRoute()

  const sidebar = document.querySelector('.sidebar-nav')
  if (sidebar && !sidebar.querySelector('[data-xp-nav]')) {
    const html = entries.map(([route, cfg]) => `
        <button class="nav-item${active === route ? ' active' : ''}" data-action="nav-tab"
                data-tab="${route}" data-xp-nav="1" title="Experimental ${escapeHtml(cfg.title)}">
          <span class="nav-icon">${route === 'experimental-ledger' ? LEDGER_ICON : LOAN_ICON}</span>
          <span>${escapeHtml(cfg.label)}</span>
          <span class="xp-nav-badge">New</span>
        </button>`).join('')
    const summaryLink = sidebar.querySelector('[data-tab="ledger/summary"]')
    if (summaryLink) summaryLink.insertAdjacentHTML('beforebegin', html)
    else sidebar.insertAdjacentHTML('beforeend', html)
  }

  const bottom = document.querySelector('.mobile-bottom-nav')
  if (bottom && !bottom.querySelector('[data-xp-nav]')) {
    const html = entries.map(([route, cfg]) => `
        <button class="bottom-nav-item${active === route ? ' active' : ''}" data-action="nav-tab"
                data-tab="${route}" data-xp-nav="1" title="Experimental ${escapeHtml(cfg.title)}">
          ${route === 'experimental-ledger' ? LEDGER_ICON : LOAN_ICON}
          <span class="nav-label">${route === 'experimental-ledger' ? 'Ledger' : 'Loans'}</span>
        </button>`).join('')
    const summaryLink = bottom.querySelector('[data-tab="ledger/summary"]')
    if (summaryLink) summaryLink.insertAdjacentHTML('beforebegin', html)
    else bottom.insertAdjacentHTML('beforeend', html)
  }
}

/** Add experimental navigation after the host application's shell is rendered. */
export function addExperimentalNavigation(user) {
  if (isAuthorised(user)) injectNav(user)
}

function renderDenied(container, user, reason) {
  setMobileTitle('Access restricted', 'Experimental pages')
  container.innerHTML = `
    <div class="xp xp-denied-wrap">
      <div class="xp-denied">
        <div class="xp-eyebrow">Experimental</div>
        <h2>Administrator access required</h2>
        <p>${escapeHtml(reason)}</p>
        <button type="button" class="xp-btn xp-btn-primary" data-xp-back>Back to dashboard</button>
      </div>
    </div>`
  container.querySelector('[data-xp-back]')?.addEventListener('click', () => {
    window.location.hash = 'dashboard'
  })
}

/**
 * Called by src/main.js for the experimental routes.
 * @param {string} tab      'experimental-ledger' | 'experimental-loans'
 * @param {HTMLElement} container main content container
 * @param {object} user     displayUser (deep copy built by the host)
 */
export async function renderExperimentalPage(tab, container, user) {
  const cfg = ROUTES[tab]
  if (!cfg) {
    window.location.hash = 'dashboard'
    return
  }

  if (!isAuthorised(user)) {
    renderDenied(
      container,
      user,
      'These preview pages are limited to administrators while they are being evaluated.'
    )
    return
  }

  bindCalendarPickers()
  injectNav(user)
  await cfg.render(container, user)
}
