import { state, getDefaultTab } from '../../state/appState.js'
import { escapeHtml, escapeAttribute, hashPassword } from '../../utils/formatters.js'
import { networkIndicatorClass, networkIndicatorLabel, networkIndicatorIcon } from '../../services/networkService.js'
import { showToast } from '../../services/toastService.js'
import { validateLogin } from '../../services/authService.js'
import { attemptOfflineLogin, saveSessionLocally as saveSession } from '../../services/offlineAuthService.js'
import { queryOne } from '../../services/sqliteService.js'
import { syncCooperativeData, initializeSyncService } from '../../services/syncService.js'
import { isSubscriptionActive, INACTIVE_MSG } from '../Dashboard/dashboardService.js'
import { setupLoanRequestListeners } from '../../components/LoanWizard.js'
import { setupNotificationModalListeners } from '../../components/NotificationModal.js'

export function renderLoginHTML(renderAlertFn, renderGlobalModalFn) {
  const detectInputType = (val) => {
    const s = String(val || '');
    if (!s) return '';
    if (/^\d+$/.test(s)) return s.length >= 10 ? '📱 Mobile' : s.length === 6 ? '🔢 PIN' : '🔢 Registration No';
    if (/^[A-Z0-9]{2,}$/i.test(s) && s.length >= 3) return '🆔 Special ID';
    if (s.includes('@')) return '✉️ Email';
    return '👤 Username';
  };

  const titles = {
    1: 'Welcome Back',
    2: 'Select Cooperative',
    3: 'Enter Password',
    4: 'Link Google Account',
  }

  const buttonLabels = {
    1: 'Next',
    2: 'Next',
    3: 'Sign In',
    4: 'Verify & Link',
  }

  // First-time Google linking screen (stage 4). Same responsive
  // .shell/.card/.form layout as login; full-width touch-sized buttons.
  if (state.stage === 4) {
    const linkCoops = Array.isArray(state.googleLinkCoops) ? state.googleLinkCoops : [];
    return `
    <main class="shell">
      <section class="card" style="animation: fadeIn 0.5s ease-out; position: relative;">
        <div class="brand">COOPERATIVE LOG APP</div>
        <h1 style="font-weight: 800; font-size: 1.5rem; color: var(--text-primary); margin-top: 0; text-align: center;">${titles[4]}</h1>
        <p style="color: var(--text-muted); text-align: center; margin-bottom: 1rem; font-size: 0.9rem; line-height: 1.5;">
          Your Google email <strong style="color: var(--text-primary);">${escapeHtml(state.googleLinkEmail || '')}</strong>
          ${state.googleLinkVerified ? '✓ verified' : ''} is new here.<br/>Enter the details below to link it to your membership.
        </p>
        <div style="margin-bottom: 1rem;"></div>
        ${renderAlertFn()}
        <form class="form" style="text-align: left;">
          <label class="field">
            <span>Mobile Number (as registered with your cooperative)</span>
            <input name="google-link-mobile" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. 0803 123 4567" value="${escapeAttribute(state.googleLinkMobile || '')}" style="min-height: 3rem;" />
          </label>
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <label class="field" style="flex: 1 1 8rem;">
              <span>First Name</span>
              <input name="google-link-first" type="text" autocomplete="given-name" placeholder="First name" value="${escapeAttribute(state.googleLinkFirst || '')}" style="min-height: 3rem;" />
            </label>
            <label class="field" style="flex: 1 1 8rem;">
              <span>Last Name</span>
              <input name="google-link-last" type="text" autocomplete="family-name" placeholder="Last name" value="${escapeAttribute(state.googleLinkLast || '')}" style="min-height: 3rem;" />
            </label>
          </div>
          <div class="actions" style="flex-direction: column; align-items: stretch;">
            <button type="button" class="primary-button" data-action="google-link-search" style="width: 100%; min-height: 3rem;" ${state.isSubmitting ? 'disabled' : ''}>
              ${state.isSubmitting ? 'Please wait...' : 'Find My Cooperatives'}
            </button>
          </div>
          ${linkCoops.length > 0 ? `
          <div style="margin-top: 1.25rem;">
            <span style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.08em; display: block;">Select your cooperative</span>
            <div role="radiogroup" aria-label="Cooperatives" style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 40vh; overflow-y: auto;">
              ${linkCoops.map(coop => `
                <label style="display: flex; align-items: center; gap: 0.75rem; padding: 0.85rem 1rem; border: 1px solid var(--border-light); border-radius: 0.75rem; cursor: pointer; min-height: 3rem;">
                  <input type="radio" name="google-link-coop" value="${escapeAttribute(coop.id)}" ${state.googleLinkSelectedCoop === coop.id ? 'checked' : ''} style="width: 1.25rem; height: 1.25rem; accent-color: var(--accent-primary);" />
                  <span>
                    <span style="display: block; font-weight: 600; color: var(--text-primary);">${escapeHtml(coop.name || 'Cooperative')}</span>
                    <span style="display: block; font-size: 0.7rem; color: var(--text-muted);">ID: ${escapeHtml(coop.id)}</span>
                  </span>
                </label>
              `).join('')}
            </div>
            <div class="actions" style="flex-direction: column; align-items: stretch; margin-top: 1rem;">
              <button type="button" class="primary-button" data-action="google-link-verify" style="width: 100%; min-height: 3rem;" ${state.isSubmitting ? 'disabled' : ''}>
                ${state.isSubmitting ? 'Please wait...' : buttonLabels[4]}
              </button>
            </div>
          </div>
          ` : ''}
          <div class="actions" style="margin-top: 1rem;">
            <button type="button" class="secondary-button" data-action="google-link-cancel" style="width: 100%; min-height: 3rem;" ${state.isSubmitting ? 'disabled' : ''}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    </main>
    ${renderGlobalModalFn()}
    `
  }

  return `
    <main class="shell">
      <section class="card" style="animation: fadeIn 0.5s ease-out; position: relative;">
        <div style="position: absolute; top: 1rem; left: 1.25rem;">
          <div class="network-indicator ${networkIndicatorClass()}" role="status" aria-label="${networkIndicatorLabel()}">
            <span class="indicator-icon">${networkIndicatorIcon()}</span>
            <span>${networkIndicatorLabel()}</span>
          </div>
        </div>
        <div class="brand">COOPERATIVE LOG APP</div>
        <h1 style="font-weight: 800; font-size: 1.75rem; color: var(--text-primary); margin-top: 0; text-align: center;">${titles[state.stage]}</h1>
        <div style="margin-bottom: 2rem;"></div>
        ${renderAlertFn()}
        <form class="form" style="text-align: left;">
          <label class="field ${state.stage !== 1 ? 'field-hidden' : ''}">
            <span>Username, Mobile, or Special ID</span>
            <input
              name="username"
              type="text"
              placeholder="admin, mobile, or special id"
              value="${escapeAttribute(state.username)}"
              ${state.stage !== 1 ? 'disabled' : ''}
            />
            ${state.username ? `<div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.25rem;">Detected: ${detectInputType(state.username)}</div>` : ''}
          </label>

          <label class="field ${state.stage !== 2 ? 'field-hidden' : ''}" style="position: relative; margin-top: 1rem;">
            <span style="font-size: 0.7rem; font-weight: 700; color: var(--text-muted); margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; display: block;">Cooperative Context</span>
            <div style="position: relative;">
              <div style="display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;">
                <div style="position: relative; flex: 1;">
                  <input
                    type="text"
                    id="coop-search-input"
                    placeholder="Search cooperative..."
                    value="${escapeAttribute(state.coopSearchQuery)}"
                    autocomplete="off"
                    ${state.stage !== 2 ? 'disabled' : ''}
                  />
                </div>
                <button type="button" id="coop-reset-btn" title="Clear search" style="background: var(--bg-secondary); border: none; border-radius: 50%; width: 2.75rem; height: 2.75rem; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-muted); transition: all 0.2s ease;">
                  <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
              </div>

              <div id="coop-selection-status" style="font-size: 0.8rem; color: var(--accent-primary); margin-bottom: 1.25rem; font-weight: 600; text-align: left; padding-left: 0.5rem;">
                ${state.selectedCooperativeId ? `Currently viewing: <span style="color: var(--text-primary); font-weight: 700;">${escapeHtml(state.cooperatives.find(c => c.id === state.selectedCooperativeId)?.name || '')}</span>` : 'Currently viewing: Global Data'}
              </div>

              <div id="coop-suggestions" class="search-suggestions ${!state.coopSearchQuery ? 'hidden' : ''}" style="top: 3.25rem;">
                ${state.cooperatives
      .filter(c => c.name.toLowerCase().includes((state.coopSearchQuery || '').toLowerCase()))
      .map(coop => `
                    <div class="suggestion-item" data-id="${escapeAttribute(coop.id)}">
                      <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(coop.name || 'Cooperative')}</div>
                      <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.25rem;">ID: ${escapeHtml(coop.id)}</div>
                    </div>
                  `).join('')}
                ${state.cooperatives.filter(c => c.name.toLowerCase().includes((state.coopSearchQuery || '').toLowerCase())).length === 0 ? '<div style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.85rem;">No results found</div>' : ''}
              </div>
            </div>
            <input type="hidden" name="cooperative" value="${escapeAttribute(state.selectedCooperativeId)}" />
          </label>

          <label class="field ${state.stage !== 3 ? 'field-hidden' : ''}">
            <span>6-Digit PIN</span>
            <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: var(--bg-secondary); border-radius: 0.5rem; line-height: 1.5;">
              Logging in as <strong style="color: var(--text-primary);">${escapeHtml(state.username)}</strong>
              ${state.selectedCooperativeId ? `→ <strong style="color: var(--text-primary);">${escapeHtml(state.cooperatives.find(c => c.id === state.selectedCooperativeId)?.name || '')}</strong>` : ''}
            </div>
            <div class="pin-wrap" style="margin-bottom: 1rem;">
              ${[0,1,2,3,4,5].map(i => `
                <input
                  type="text"
                  name="pin-${i}"
                  maxlength="1"
                  pattern="[0-9]"
                  inputmode="numeric"
                  ${state.stage !== 3 ? 'disabled' : ''}
                  aria-label="PIN digit ${i+1}"
                />
              `).join('')}
            </div>
            <input type="hidden" name="password" value="${escapeAttribute(state.password)}" />
          </label>

          <div class="actions">
            <button
              type="button"
              class="secondary-button ${state.stage === 1 ? 'hidden' : ''}"
              data-action="back"
              ${state.isSubmitting ? 'disabled' : ''}
            >
              Back
            </button>
            <button type="submit" class="primary-button" ${state.isSubmitting ? 'disabled' : ''}>
              ${state.isSubmitting ? 'Please wait...' : buttonLabels[state.stage]}
            </button>
          </div>

          ${state.stage === 1 ? `
          <div style="margin-top: 1rem;">
            <button type="button" class="secondary-button" data-action="google-login" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 0.5rem; border-color: #d1d5db; color: #374151;" ${state.isSubmitting ? 'disabled' : ''}>
              <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Sign In with Google
            </button>
          </div>
          ` : ''}

          <div style="margin-top: 2.5rem; text-align: center; border-top: 1px solid var(--border-light); padding-top: 2rem;">
            <button type="button" class="ghost-button" data-action="show-registration" style="width: 100%; height: 3.25rem;">
                Register
            </button>
          </div>
        </form>
      </section>
    </main>
    ${renderGlobalModalFn()}
  `
}

export function setupLoginPostRender() {
  // Restore focus to the active input for seamless typing
  if (state.stage === 1) {
    const input = document.querySelector('input[name="username"]');
    if (input && !state.isSubmitting) input.focus();
  } else if (state.stage === 2) {
    const input = document.getElementById('coop-search-input');
    if (input) {
      input.focus();
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  } else if (state.stage === 4) {
    const input = document.querySelector('input[name="google-link-mobile"]');
    if (input && !state.isSubmitting) input.focus();
  } else if (state.stage === 3) {
    const firstPinInput = document.querySelector('input[name="pin-0"]');
    if (firstPinInput && !state.isSubmitting) firstPinInput.focus();
    
    // Setup PIN input auto-focus and combine into hidden password field
    const pinInputs = Array.from({length: 6}, (_, i) => document.querySelector(`input[name="pin-${i}"]`));
    const hiddenPasswordInput = document.querySelector('input[name="password"]');
    
    pinInputs.forEach((input, idx, arr) => {
      if (!input) return;
      input.addEventListener('input', (e) => {
        if (e.target.value.length === 1 && idx < arr.length - 1) {
          arr[idx + 1]?.focus();
        }
        // Update hidden password field
        if (hiddenPasswordInput) {
          hiddenPasswordInput.value = arr.map(i => i?.value || '').join('');
        }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && idx > 0) {
          arr[idx - 1]?.focus();
        }
      });
    });
  }

  // If a modal with complex listeners is open, re-attach them
  if (state.modal.isOpen && state.modal.type === 'force-password') {
    setupForcePwdListeners();
  }
  if (state.modal.isOpen && state.modal.type === 'withdrawal-request') {
    setupLoanRequestListeners();
  }
  if (state.modal.isOpen && state.modal.type === 'notifications') {
    setupNotificationModalListeners(
      document.getElementById('modal-body'),
      state.welcomeUser,
      () => {
        // On Read: Refresh the modal content
        window.dispatchEvent(new CustomEvent('show-notifications'))
        // Also refresh bell count (handled by bell listener)
      },
      (recordId) => {
        // On View: Close modal and go to record
        state.modal.isOpen = false
        window.__render()
        window.dispatchEvent(new CustomEvent('edit-remittance', { detail: { id: recordId } }))
      }
    )
  }
}

export function classifyLoginError(err) {
  const rawMsg = (err && (err.message || err.toString() || ''));
  const msg = rawMsg.toLowerCase()
  if (!msg) return { type: 'unknown', message: 'Unable to sign in. Please try again.' }
  // Unsubscribed/expired accounts are blocked completely — surface verbatim.
  if (msg.includes('subscription is inactive') || msg.includes('subscription') && msg.includes('contact your administrator')) {
    return { type: 'subscription', message: rawMsg || 'Your account subscription is inactive. Please contact your administrator for assistance.' }
  }
  // Progressive back-off lockouts must reach the user verbatim (with countdown).
  if (msg.includes('too many failed attempts') || msg.includes('try again in')) {
    return { type: 'lockout', message: rawMsg }
  }
  // Cooperative extracted - block login with clear message
  if (msg.includes('extracted') || msg.includes('contact your administrator')) {
    return { type: 'extracted', message: rawMsg || 'This cooperative\'s data has been extracted. Please contact your administrator for assistance.' }
  }
  // Keep network/timeout errors specific
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout') || msg.includes('abort') || msg.includes('internet') || msg.includes('connection')) {
    if (msg.includes('timeout')) return { type: 'timeout', message: 'The server is not responding. Please check your connection and try again.' }
    return { type: 'network', message: 'No internet connection. Please check your network and try again.' }
  }
  // Generic auth error for everything else (database, sync, subscription, unauthorized, etc.)
  return { type: 'auth', message: 'Invalid username or PIN. Please try again.' }
}

export async function handleNext() {
  if (state.isSubmitting) {
    return
  }

  if (state.stage === 1) {
    await handleUsernameStage()
    return
  }

  if (state.stage === 2) {
    await handleCooperativeStage()
    return
  }

  if (state.stage === 4) {
    if (!state.googleLinkCoops || state.googleLinkCoops.length === 0) {
      await handleGoogleLinkSearch()
    } else {
      await handleGoogleLinkVerify()
    }
    return
  }

  await handlePasswordStage()
}

export function handleBack() {
  if (state.stage === 3) {
    state.stage = 2
    state.password = ''
  } else if (state.stage === 2) {
    state.stage = 1
    state.selectedCooperativeId = ''
    state.cooperatives = []
    state.coopSearchQuery = ''
    state.isGoogleLoginFlow = false
  } else if (state.stage === 4) {
    _resetGoogleLinkState()
    state.stage = 1
    state.isGoogleLoginFlow = false
    import('../../firebase.js').then(m => {
      try {
        const { auth } = m.getFirebaseAuth()
        if (auth?.currentUser) m.signOut(auth).catch(() => {})
      } catch {}
    }).catch(() => {})
  }

  state.errorMessage = ''
  window.__render()
}

function _resetGoogleLinkState() {
  state.googleLinkEmail = ''
  state.googleLinkVerified = false
  state.googleLinkMobile = ''
  state.googleLinkFirst = ''
  state.googleLinkLast = ''
  state.googleLinkCoops = []
  state.googleLinkSelectedCoop = ''
}

async function _signOutGoogleQuietly() {
  try {
    const m = await import('../../firebase.js')
    const { auth } = m.getFirebaseAuth()
    if (auth?.currentUser) await m.signOut(auth)
  } catch {}
}

async function _abortGoogleLink(message) {
  await _signOutGoogleQuietly()
  _resetGoogleLinkState()
  state.isGoogleLoginFlow = false
  state.stage = 1
  state.isSubmitting = false
  state.errorMessage = message
  window.__render()
}

function _isCapacitorNative() {
  try {
    return typeof window !== 'undefined' && !!(window.Capacitor?.isNativePlatform?.() || (window.Capacitor?.getPlatform && window.Capacitor.getPlatform() !== 'web'))
  } catch { return false }
}

function _isMobileBrowser() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return true
    return /Android|iPhone|iPad|iPod|Mobile/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '')
  } catch { return false }
}

async function _signInWithGoogleCrossPlatform() {
  const m = await import('../../firebase.js')
  const { auth, googleProvider } = m.getFirebaseAuth()
  try {
    if (googleProvider?.setCustomParameters) googleProvider.setCustomParameters({ prompt: 'select_account' })
  } catch {}
  if (_isCapacitorNative()) {
    await m.signInWithRedirect(auth, googleProvider)
    return null
  }
  try {
    const result = await m.signInWithPopup(auth, googleProvider)
    return result?.user || null
  } catch (popupErr) {
    const code = String(popupErr?.code || '')
    // User deliberately dismissed the popup — respect it, no silent redirect.
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw popupErr
    const msg = String(popupErr?.message || '').toLowerCase()
    const popupUnusable = code.startsWith('auth/popup')
      || msg.includes('popup') || msg.includes('blocked') || msg.includes('redirect')
    // Blocked popup? Redirect works everywhere — use it instead of erroring.
    if (popupUnusable) {
      await m.signInWithRedirect(auth, googleProvider)
      return null
    }
    throw popupErr
  }
}

async function _completeGoogleSession(session, fallbackEmail) {
  if (session && session.forceChange) {
    state.isSubmitting = false
    showForcePasswordChangeModal(session.userDoc, session.collection)
    return
  }
  if (!session) throw new Error('Login validation failed.')
  state.welcomeUser = session
  await saveSession(session)
  _resetGoogleLinkState()
  state.isGoogleLoginFlow = false
  state.isSubmitting = false
  window.__render()
}

export async function handleGoogleUser(email, emailVerified) {
  const verifiedEmail = String(email || '').trim().toLowerCase()
  if (!verifiedEmail || !verifiedEmail.includes('@')) throw new Error('No email associated with this Google account.')
  if (emailVerified === false) {
    await _abortGoogleLink('This Google email is not verified. Please verify it with Google and try again.')
    return
  }
  const { discoverLoginCooperativesByEmail, validateGoogleLogin } = await import('../../services/authService.js')
  const cooperatives = await Promise.race([
    discoverLoginCooperativesByEmail(verifiedEmail),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
  ])
  if (cooperatives.length === 1) {
    const session = await validateGoogleLogin(verifiedEmail, cooperatives[0].id)
    await _completeGoogleSession(session, verifiedEmail)
  } else if (cooperatives.length > 1) {
    state.cooperatives = cooperatives
    state.username = verifiedEmail
    state.selectedCooperativeId = ''
    state.isGoogleLoginFlow = true
    state.stage = 2
    state.isSubmitting = false
    window.__render()
  } else {
    _resetGoogleLinkState()
    state.googleLinkEmail = verifiedEmail
    state.googleLinkVerified = true
    state.username = verifiedEmail
    state.isGoogleLoginFlow = true
    state.stage = 4
    state.isSubmitting = false
    state.errorMessage = ''
    window.__render()
  }
}

export async function handleGoogleLinkSearch() {
  const email = String(state.googleLinkEmail || '').trim().toLowerCase()
  const mobile = String(state.googleLinkMobile || '').trim()
  const first = String(state.googleLinkFirst || '').trim()
  const last = String(state.googleLinkLast || '').trim()
  if (!email) { await _abortGoogleLink('Google session expired. Please tap "Sign In with Google" again.'); return }
  if (!mobile || !first || !last) {
    state.errorMessage = 'Please enter your mobile number, first name and last name.'
    window.__render()
    return
  }
  if (!navigator.onLine) {
    state.errorMessage = 'Internet connection required to link your account. Please connect and try again.'
    window.__render()
    return
  }
  try {
    state.isSubmitting = true
    state.errorMessage = ''
    window.__render()
    const { discoverCooperativesByMobile } = await import('../../services/authService.js')
    const coops = await Promise.race([
      discoverCooperativesByMobile(mobile),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
    ])
    if (!coops || coops.length === 0) {
      await _abortGoogleLink('No cooperative record found for this mobile number. Please contact your administrator.')
      return
    }
    state.googleLinkCoops = coops
    state.googleLinkSelectedCoop = coops.length === 1 ? coops[0].id : ''
    state.isSubmitting = false
    state.errorMessage = coops.length === 1
      ? 'One cooperative found for this mobile. Tap "Verify & Link" to continue.'
      : `${coops.length} cooperatives found for this mobile. Select yours, then tap "Verify & Link".`
    window.__render()
  } catch (error) {
    state.isSubmitting = false
    state.errorMessage = /timeout/i.test(String(error?.message || ''))
      ? 'The server is not responding. Please check your connection and try again.'
      : (error?.message || 'Could not search cooperatives. Please try again.')
    window.__render()
  }
}

export async function handleGoogleLinkVerify() {
  const email = String(state.googleLinkEmail || '').trim().toLowerCase()
  const mobile = String(state.googleLinkMobile || '').trim()
  const first = String(state.googleLinkFirst || '').trim()
  const last = String(state.googleLinkLast || '').trim()
  const coopId = String(state.googleLinkSelectedCoop || '').trim()
  if (!email) { await _abortGoogleLink('Google session expired. Please tap "Sign In with Google" again.'); return }
  if (!coopId) {
    state.errorMessage = 'Please select your cooperative first.'
    window.__render()
    return
  }
  try {
    state.isSubmitting = true
    state.errorMessage = ''
    window.__render()
    const { fetchMemberCandidatesByMobileForCoop, verifyMemberLinkCandidate, linkGoogleEmailToMember, validateGoogleLogin } = await import('../../services/authService.js')
    const candidates = await Promise.race([
      fetchMemberCandidatesByMobileForCoop(mobile, coopId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000)),
    ])
    if (!candidates || candidates.length === 0) {
      await _abortGoogleLink('Details do not match any record in the selected cooperative. Login cancelled — please contact your administrator.')
      return
    }
    if (candidates.length > 1) {
      await _abortGoogleLink('Multiple records share this mobile number in the selected cooperative. Login cancelled — please contact your administrator to fix the duplicate.')
      return
    }
    const check = verifyMemberLinkCandidate(candidates[0], { mobile, firstName: first, lastName: last })
    if (!check.matched) {
      await _abortGoogleLink('Details do not match our records (mobile plus first or last name must match). Login cancelled — please contact your administrator.')
      return
    }
    await linkGoogleEmailToMember(candidates[0].id, coopId, email)
    const session = await validateGoogleLogin(email, coopId)
    await _completeGoogleSession(session, email)
    try { showToast('Google account linked successfully. Welcome!', 'success') } catch {}
  } catch (error) {
    await _abortGoogleLink(error?.message || 'Could not link your account. Login cancelled — please try again or contact your administrator.')
  }
}

export async function handleGoogleLogin() {
  if (state.isSubmitting) return;

  if (typeof window !== 'undefined' && window.cooplog) {
    state.errorMessage = 'Google sign-in is not available in the desktop app. Please sign in with Google once in your browser to link your account, then use your username and PIN here.';
    window.__render();
    return;
  }

  try {
    state.isSubmitting = true;
    state.errorMessage = '';
    window.__render();

    if (!navigator.onLine) throw new Error('No internet connection. Please connect and try again.');

    const user = await _signInWithGoogleCrossPlatform();
    // null => redirect flow started (native/mobile); boot completes login.
    if (!user) {
      state.isSubmitting = false;
      state.errorMessage = 'Completing Google sign-in…';
      window.__render();
      return;
    }
    await handleGoogleUser(user.email, user.emailVerified);
  } catch (error) {
    console.error('Google Auth Error:', error);
    await _signOutGoogleQuietly();
    const msg = String(error?.message || '');
    state.errorMessage = /timeout/i.test(msg)
      ? 'The server is not responding. Please check your connection and try again.'
      : (error?.code === 'auth/popup-closed-by-user' ? 'Google sign-in was cancelled.'
        : (error?.code === 'auth/popup-blocked' ? 'Popup was blocked by your browser. Please allow popups for this site and try again.'
          : (msg || 'Google Sign-In failed.')));
    state.isSubmitting = false;
    window.__render();
  }
}

export async function handleUsernameStage() {
  state.isGoogleLoginFlow = false;
  const username = state.username.trim()
  if (!username) {
    state.errorMessage = 'Please enter username.'
    window.__render()
    return
  }

  try {
    state.isSubmitting = true
    state.errorMessage = ''
    window.__render()

    let cooperatives = []
    let onlineFailed = false

    // Try online discovery first (with 10s timeout)
    try {
      const { discoverLoginCooperatives } = await import('../../services/authService.js')
      cooperatives = await Promise.race([
        discoverLoginCooperatives(username),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
      ]);
    } catch (onlineErr) {
      onlineFailed = true
      console.warn('[Login] Online discovery failed, trying offline...', onlineErr.message)
    }

    // If online returned nothing (offline or genuinely no match), try offline sessions
    if (cooperatives.length === 0) {
      try {
        const { discoverCooperativesOffline, hasLocalAuthData } = await import('../../services/offlineAuthService.js')
        const offlineCoops = await discoverCooperativesOffline(username)
        if (offlineCoops.length > 0) {
          cooperatives = offlineCoops
          console.log('[Login] Found', offlineCoops.length, 'cooperative(s) from offline sessions')
        }

        // Determine the right error message when both online and offline returned nothing
        if (cooperatives.length === 0) {
          const localDbHasData = await hasLocalAuthData()
          if (!onlineFailed) {
            state.errorMessage = 'No matching user found. Please check your input.'
          } else if (!localDbHasData) {
            state.errorMessage = 'A network error occurred. Please check your internet connection and try again.'
          } else {
            state.errorMessage = 'Match not found offline. Please connect to the internet to login for the first time.'
          }
          return
        }
      } catch (offErr) {
        console.warn('[Login] Offline discovery also failed:', offErr.message)
      }
    }

    if (cooperatives.length === 0) {
      state.errorMessage = 'A network error occurred. Please check your internet connection and try again.'
      return
    }

    state.cooperatives = cooperatives
    if (cooperatives.length === 1) {
      state.selectedCooperativeId = cooperatives[0].id;
      state.stage = 3;
    } else {
      // Remember last selected cooperative for this username
      const lastCoop = localStorage.getItem('cooplog-last-coop-' + username.toLowerCase());
      state.selectedCooperativeId = lastCoop && cooperatives.some(c => c.id === lastCoop) ? lastCoop : '';
      state.stage = 2;
    }
  } catch (error) {
    state.errorMessage = error.message || 'Unable to continue.'
  } finally {
    state.isSubmitting = false
    window.__render()
  }
}

export async function handleCooperativeStage() {
  if (!state.selectedCooperativeId) {
    state.errorMessage = 'Please select a cooperative.'
    window.__render()
    return
  }

  if (state.isGoogleLoginFlow) {
    state.isSubmitting = true;
    state.errorMessage = '';
    window.__render();
    try {
      const { validateGoogleLogin } = await import('../../services/authService.js');
      const session = await validateGoogleLogin(state.username, state.selectedCooperativeId);
      if (session) {
        state.welcomeUser = session;
        await saveSession(session);
        window.__render();
      } else {
        throw new Error('Login validation failed.');
      }
    } catch (error) {
      state.errorMessage = error.message || 'Google Sign-In failed.';
      state.isSubmitting = false;
      window.__render();
    }
    return;
  }

  state.stage = 3
  state.errorMessage = ''
  window.__render()
}

export async function handlePasswordStage() {
  const username = state.username.trim()
  const cooperativeId = state.selectedCooperativeId

  // Read PIN from 6 individual inputs
  let pin = '';
  for (let i = 0; i < 6; i++) {
    const input = document.querySelector(`input[name="pin-${i}"]`);
    if (input) pin += input.value;
  }
  const password = pin;

  // NOTE: do NOT require 6 digits here. Members on legacy short passwords
  // (e.g. cloud still holds "1234") must be able to submit so auth can
  // verify them and route them to the force-change modal. New PINs are
  // still enforced as 6 digits inside that modal.
  if (password.length < 1) {
    state.errorMessage = 'Please enter your PIN.'
    window.__render()
    return
  }

  if (!cooperativeId) {
    state.errorMessage = 'Please select a cooperative.'
    window.__render()
    return
  }

  if (state.isSubmitting) {
    console.log('[Login] Already submitting, ignoring duplicate call.');
    return
  }

  const loginStartTs = Date.now();
  console.log(`[Login] ---------- LOGIN STARTED ---------- [${loginStartTs}]`);
  console.log(`[Login] Username: "${username}", CooperativeId: "${cooperativeId}", Online: ${navigator.onLine}`);

  try {
    state.isSubmitting = true
    state.errorMessage = ''
    window.__render()

    // Progressive back-off pre-check (1-4 free, 5th→1m, 6th→5m, 7-8th→15m, 9th+→1h)
    try {
      const { checkRateLimit, formatDelay } = await import('../../services/authService.js')
      const gate = checkRateLimit(username.toLowerCase(), cooperativeId)
      if (!gate.allowed) {
        state.errorMessage = `Too many failed attempts. Try again in ${formatDelay(gate.retryAfterMs)}.`
        state.isSubmitting = false
        window.__render()
        return
      }
    } catch {}

    // Online authentication (with 10s timeout)
    let session = null
    let loginError = null
    let onlineRecordedFail = false
    try {
      if (navigator.onLine) {
        console.log(`[Login] [${Date.now()}] Sending authentication request...`);
        session = await Promise.race([
          validateLogin(username, password, cooperativeId),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ]);
        console.log(`[Login] [${Date.now()}] Authentication response received. Success: ${!!session}`);
        if (!session) onlineRecordedFail = true
      } else {
        // Actual login (not remember-me boot auto-login) requires internet.
        // If offline, show network error and skip both online AND offline fallback.
        // The "remember me" persistent session is handled at boot in main.js via loadSavedSession().
        loginError = { type: 'network', message: 'No internet connection. Actual login requires online connection. Please connect to the internet and try again.' }
        console.log(`[Login] [${Date.now()}] No internet connection — actual login requires online.`);
      }
    } catch (onlineErr) {
      loginError = classifyLoginError(onlineErr)
      if (loginError.type === 'lockout' || loginError.type === 'auth') onlineRecordedFail = true
      console.warn(`[Login] [${Date.now()}] Online authentication failed:`, onlineErr.message)
    }

    // Offline fallback (skipped when online already gave a final verdict:
    // lockout, extracted coop, or unsubscribed account must not fall back
    // to stale local data). Also skipped when network error prevents login.
    if (!session) {
      if (loginError?.type === 'network') {
        // Actual login requires internet — do not fall back to offline.
        // The error message is already set in the online block above.
        console.log(`[Login] [${Date.now()}] Skipping offline login due to network error.`);
      } else if (loginError?.type === 'lockout' || loginError?.type === 'subscription' || loginError?.type === 'extracted') {
        state.errorMessage = loginError.message
        state.isSubmitting = false
        window.__render()
        return
      } else {
        console.log(`[Login] [${Date.now()}] Attempting offline authentication...`);
        try {
          session = await attemptOfflineLogin(username, password, cooperativeId, onlineRecordedFail)
          if (session) loginError = null
          console.log(`[Login] [${Date.now()}] Offline authentication result: ${!!session}`);
          if (!session && !onlineRecordedFail) {
            try {
              const { recordFailedAttempt } = await import('../../services/authService.js')
              recordFailedAttempt(username.toLowerCase(), cooperativeId)
            } catch {}
          }
        } catch (offlineErr) {
          const classified = classifyLoginError(offlineErr)
          // A definitive offline verdict (blocked/lockout) overrides a softer
          // online error (e.g. timeout/network) so the polite message wins.
          if (!loginError || classified.type === 'subscription' || classified.type === 'extracted' || classified.type === 'lockout') {
            loginError = classified
          }
          console.warn(`[Login] [${Date.now()}] Offline authentication failed:`, offlineErr.message)
        }
      }
    }

    // No session — show specific error (with enforced delay when locked)
    if (!session) {
      try {
        const { checkRateLimit, formatDelay } = await import('../../services/authService.js')
        const gate = checkRateLimit(username.toLowerCase(), cooperativeId)
        if (!gate.allowed) {
          state.errorMessage = `Too many failed attempts. Try again in ${formatDelay(gate.retryAfterMs)}.`
          state.isSubmitting = false
          window.__render()
          return
        }
      } catch {}
      const errorMsg = loginError?.message || 'Invalid username or PIN. Please try again.'
      console.log(`[Login] [${Date.now()}] No session returned. Error: "${errorMsg}"`);
      state.errorMessage = errorMsg
      state.isSubmitting = false
      window.__render()
      console.log(`[Login] -------- LOGIN FAILED: ${errorMsg} -------- [${Date.now()}]`);
      return
    }

    console.log(`[Login] [${Date.now()}] Session details:`, {
      forceChange: session?.forceChange,
      collection: session?.collection,
      username: session?.username,
      role: session?.role,
      memberId: session?.memberId,
      isOffline: !!session?.isOfflineSession
    });

    // Defense-in-depth: a subscription revoked between auth and session
    // build (or a stale offline row) must still block here with the same
    // polite message — before the force-change modal and before any session
    // is persisted. Admin is exempt inside the helper.
    try {
      const { isSubscriptionBlocked, SUBSCRIPTION_BLOCKED_MSG } = await import('../../services/subscriptionService.js')
      const docForGate = session.userDoc || session
      if (isSubscriptionBlocked(docForGate, session.username)) {
        state.errorMessage = SUBSCRIPTION_BLOCKED_MSG
        state.isSubmitting = false
        window.__render()
        console.log(`[Login] -------- LOGIN BLOCKED (subscription) -------- [${Date.now()}]`);
        return
      }
    } catch (e) {
      if (e && /subscription is inactive/i.test(e.message || '')) {
        state.errorMessage = e.message
        state.isSubmitting = false
        window.__render()
        return
      }
      // helper-load failure: fail-open, auth layer already enforced
    }

    if (session && session.forceChange) {
      console.log(`[Login] [${Date.now()}] Force password change required.`);
      showForcePasswordChangeModal(session.userDoc, session.collection)
      return
    }

    const cooperativeName =
      state.cooperatives.find((coop) => coop.id === session.cooperativeId)?.name || session.cooperativeId

    // Reset session-specific state
    state.selectedMemberId = null
    state.members = []
    state.editingRemittance = null
    state.editingRemittanceId = null
    state.loanRequest = {
      step: 1,
      enterpriseId: '',
      amount: 0,
      duration: 1,
      guarantors: [],
      bankDetails: { bankName: '', accountName: '', accountNumber: '' }
    }

    // Build the welcomeUser immediately, subscription will be loaded in background
    // Seed from the live auth doc (already subscription-gated above) so the
    // dashboard guard is correct on first paint — not a hardcoded 1.
state.welcomeUser = {
      memberId: session.memberId,
      username: session.username,
      fullName: session.fullName,
      role: session.role,
      permissions: session.permissions || '',
      enterprises: session.enterprises || '',
      enterprise_rights: session.enterprise_rights || session.enterprises || '',
      cooperativeId: session.cooperativeId,
      cooperativeName: session.cooperative_name || '',
      coopShortName: session.cooperative_name?.split('-')[0] || session.cooperative_name || '',  // short name segment or full name fallback
      subscriptionStatus: session.userDoc?.subscriptionStatus ?? 1,
      subscriptionExpiry: session.userDoc?.expiry_date ?? session.userDoc?.subscriptionExpiry ?? null,
      userDoc: session.userDoc,
      collection: session.collection,
    }

    // Save to sessionStorage and persist userDoc for offline access
    saveSession(state.welcomeUser).catch(err => console.warn('[Login] Session save failed:', err))

    if (!isSubscriptionActive()) {
      state.activeTab = 'dashboard'
      window.location.hash = 'dashboard'
    }

    // Default to appropriate tab on successful login
    const defaultTab = getDefaultTab(state.welcomeUser)
    state.activeTab = defaultTab
    window.history.replaceState(null, '', `#${defaultTab}`)

    // Reset login stage
    state.stage = 1
    state.password = ''

    // Render the dashboard first (instant!), then async work in background
    state.isSubmitting = false
    window.__render()
    console.log(`[Login] [${Date.now()}] Dashboard rendered. Login completed in ${Date.now() - loginStartTs}ms`);

    // Background: Load subscription info (non-blocking) from the correct
    // table — members logins previously read the users table (always miss).
    (async () => {
      try {
        const table = session.collection === 'members' ? 'members' : 'users'
        const userRecord = await queryOne(
          `SELECT subscriptionStatus, expiry_date FROM ${table} WHERE id = ?`,
          [session.userDoc?.id || '']
        );
        if (userRecord) {
          state.welcomeUser.subscriptionStatus = userRecord.subscriptionStatus;
          state.welcomeUser.subscriptionExpiry = userRecord.expiry_date;
          // Update sidebar subscription banner in-place (no full re-render)
          const existingBanner = document.querySelector('.sidebar [class*="warning"]');
          if (existingBanner && (userRecord.subscriptionStatus === 0 || userRecord.subscriptionStatus === '0')) {
            // Leave the existing inactive banner as-is
          } else if (existingBanner) {
            // Remove banner if subscription is now active
            existingBanner.remove();
          } else if (!isSubscriptionActive() && String(state.welcomeUser.username || '').toLowerCase() !== 'admin') {
            // Add banner if missing
            const sidebar = document.querySelector('.sidebar');
            const header = sidebar?.querySelector('.sidebar-header');
            if (sidebar && header) {
              const banner = document.createElement('div');
              banner.style.cssText = 'margin: 0.75rem 1rem; padding: 0.75rem; background: var(--warning-bg, #fef3c7); color: var(--warning, #d97706); border: 1px solid var(--warning, #d97706); border-radius: 0.5rem; font-size: 0.7rem; font-weight: 600; text-align: center; line-height: 1.4;';
              banner.textContent = INACTIVE_MSG;
              header.insertAdjacentElement('afterend', banner);
            }
          }
        }
      } catch (e) {
        console.warn('[Login] Background subscription fetch failed (non-blocking):', e.message);
      }
    })();

    // Background sync (non-blocking)
    if (navigator.onLine) {
      syncCooperativeData(
        session.cooperativeId,
        session.role,
        session.memberId,
        session.permissions,
        session.username,
        ''
      ).then(() => {
        console.log(`[Login] [${Date.now()}] Background sync completed.`);
        // No renderDashboardContent() call - background sync updates data silently
      }).catch(err => {
        console.warn(`[Login] [${Date.now()}] Background sync failed:`, err.message)
      }).finally(() => {
        initializeSyncService().catch(err => console.warn('[Sync] initializeSyncService failed:', err.message))
      })
    } else {
      initializeSyncService().catch(err => console.warn('[Sync] initializeSyncService failed:', err.message))
    }

    console.log(`[Login] -------- LOGIN COMPLETED SUCCESSFULLY -------- [${Date.now()}]`);

  } catch (error) {
    console.error(`[Login] [${Date.now()}] UNEXPECTED ERROR:`, error);
    state.errorMessage = error.message || 'An unexpected error occurred during login. Please try again or contact your administrator if the problem persists.'
    state.isSubmitting = false
    window.__render()
  } finally {
    state.isSubmitting = false
  }
}

export async function showForcePasswordChangeModal(userDoc, collectionName) {
  state.modal.title = "Set Your 6-Digit PIN";
  state.modal.type = "force-password";
  state.modal.data = { userDoc, collectionName };
  state.modal.isOpen = true;
  state.modal.content = `
        <div class="force-pin">
            <p class="force-pin-desc">
                Your account is currently using a default or temporary password. For your
                security, please set a new 6-digit numeric PIN to continue. Letters are not allowed.
            </p>

            <form id="force-pwd-form" class="force-pin-form">
                <div class="field force-pin-field">
                    <span class="force-pin-label">New 6-Digit PIN (numbers only)</span>
                    <div class="pin-wrap force-pin-boxes">
                      ${[0,1,2,3,4,5].map(i => `
                        <input
                          type="text"
                          name="new-pin-${i}"
                          maxlength="1"
                          pattern="[0-9]"
                          inputmode="numeric"
                          autocomplete="one-time-code"
                          aria-label="New PIN digit ${i+1}"
                        />
                      `).join('')}
                    </div>
                </div>
                <div class="field force-pin-field">
                    <span class="force-pin-label">Confirm 6-Digit PIN</span>
                    <div class="pin-wrap force-pin-boxes">
                      ${[0,1,2,3,4,5].map(i => `
                        <input
                          type="text"
                          name="confirm-pin-${i}"
                          maxlength="1"
                          pattern="[0-9]"
                          inputmode="numeric"
                          autocomplete="one-time-code"
                          aria-label="Confirm PIN digit ${i+1}"
                        />
                      `).join('')}
                    </div>
                </div>

                <div id="pwd-requirements" class="force-pin-reqs">
                    <div class="force-pin-reqs-title">Requirements</div>
                    <ul class="force-pin-reqs-list">
                        <li id="req-length" class="req-pending">○ Exactly 6 digits</li>
                        <li id="req-match" class="req-pending">○ PINs match</li>
                    </ul>
                </div>

                <button type="submit" id="submit-new-pwd" class="primary-button force-pin-submit" disabled>Set PIN &amp; Login</button>
            </form>
        </div>
    `;

  window.__render();
}

export function setupForcePwdListeners() {
  const body = document.getElementById('modal-body');
  if (!body) return;

  const userDoc = state.modal.data?.userDoc;
  const collectionName = state.modal.data?.collectionName;
  if (!userDoc) return;

  const newPinInputs = Array.from({length: 6}, (_, i) => body.querySelector(`input[name="new-pin-${i}"]`));
  const confirmPinInputs = Array.from({length: 6}, (_, i) => body.querySelector(`input[name="confirm-pin-${i}"]`));
  const submitBtn = body.querySelector('#submit-new-pwd');
  const form = body.querySelector('#force-pwd-form');

  const getPinValue = (inputs) => inputs.map(i => i?.value || '').join('');

  const setReq = (id, ok) => {
    const el = body.querySelector(id);
    if (!el) return;
    const label = id === '#req-length' ? 'Exactly 6 digits' : 'PINs match';
    el.textContent = `${ok ? '●' : '○'} ${label}`;
    el.classList.toggle('req-ok', !!ok);
    el.classList.toggle('req-pending', !ok);
  };

  const validate = () => {
    const newPin = getPinValue(newPinInputs);
    const confirmPin = getPinValue(confirmPinInputs);

    const lengthOk = newPin.length === 6 && /^\d{6}$/.test(newPin);
    const matchOk = lengthOk && newPin === confirmPin;
    setReq('#req-length', lengthOk);
    setReq('#req-match', matchOk);

    if (submitBtn) submitBtn.disabled = !(lengthOk && matchOk);
  };

  const wireGroup = (inputs, nextGroup) => {
    inputs.forEach((input, idx) => {
      if (!input) return;
      input.addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 1);
        input.classList.toggle('filled', !!e.target.value);
        if (e.target.value && idx < inputs.length - 1) inputs[idx + 1]?.focus();
        else if (e.target.value && idx === inputs.length - 1 && nextGroup) nextGroup[0]?.focus();
        validate();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !e.target.value && idx > 0) {
          inputs[idx - 1]?.focus();
        }
      });
      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!text) return;
        text.split('').forEach((ch, k) => {
          if (inputs[idx + k]) { inputs[idx + k].value = ch; inputs[idx + k].classList.add('filled'); }
        });
        inputs[Math.min(idx + text.length, inputs.length - 1)]?.focus();
        validate();
      });
    });
  };
  wireGroup(newPinInputs, confirmPinInputs);
  wireGroup(confirmPinInputs, null);
  validate();
  newPinInputs[0]?.focus();

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      submitBtn.disabled = true;
      submitBtn.innerText = "Setting PIN...";

      const newPin = getPinValue(newPinInputs);
      const confirmPin = getPinValue(confirmPinInputs);
      if (newPin !== confirmPin) {
        showToast('PINs do not match.', 'warning');
        submitBtn.disabled = false;
        submitBtn.innerText = "Set PIN & Login";
        return;
      }
      if (!/^\d{6}$/.test(newPin)) {
        showToast('PIN must be exactly 6 digits (numbers only).', 'warning');
        submitBtn.disabled = false;
        submitBtn.innerText = "Set PIN & Login";
        return;
      }

      // Forced PIN change is online-only: cloud must succeed before local login.
      if (!navigator.onLine) {
        showToast('Internet connection required to set PIN. Please connect and try again.', 'error');
        submitBtn.disabled = false;
        submitBtn.innerText = "Set PIN & Login";
        return;
      }

      const hashed = await hashPassword(newPin);
      console.log('[PasswordChange] Generated new PIN hash:', {
        length: hashed.length,
        isHash: /^[a-f0-9]{64}$/i.test(hashed)
      });

      const nowIso = new Date().toISOString();
      // This forced change IS a successful login, so members get +1 login_count
      // (validateLogin returns forceChange early without counting — see authService.js).
      const isMemberLogin = collectionName === 'members';
      const newLoginCount = isMemberLogin ? (parseInt(userDoc.login_count || 0, 10) + 1) : undefined;
      const minimalPayload = {
        cooperative_id: String(userDoc.cooperative_id),
        password_hash: hashed,
        force_password_change: false,
        modified_at: nowIso,
        modified_by: 'system-security',
        sync_at: nowIso,
        ...(isMemberLogin ? { last_login: nowIso, login_count: newLoginCount } : {})
      };

      // 1. Push directly to Firestore first — must succeed before login.
      try {
        const { getDb, doc: fsDoc, updateDoc } = await import('../../firebase.js');
        const db = getDb();
        await updateDoc(fsDoc(db, collectionName, userDoc.id), minimalPayload);
        console.log('[PasswordChange] Firestore write successful');
      } catch (fsErr) {
        console.error('[PasswordChange] Firestore write failed, aborting login:', fsErr.message);
        showToast('Failed to update PIN online: ' + (fsErr.message || 'network error'), 'error');
        submitBtn.disabled = false;
        submitBtn.innerText = "Set PIN & Login";
        return;
      }

      // 2. Mirror locally. updateMember/updateUser hash internally,
      // so pass the PLAINTEXT PIN (not `hashed`) to avoid double-hashing.
      try {
        const localPayload = { ...userDoc, password_hash: newPin, force_password_change: false, modified_at: nowIso, modified_by: 'system-security', ...(isMemberLogin ? { last_login: nowIso, login_count: newLoginCount } : {}) };
        const { updateMember, updateUser } = await import('../../services/dataService.js');
        if (collectionName === 'members') {
          await updateMember(userDoc.id, localPayload, 'system-security');
        } else {
          await updateUser(userDoc.id, localPayload, 'system-security');
        }
        // Keep the in-memory doc in sync so the session below carries the count.
        if (isMemberLogin) {
          userDoc.login_count = newLoginCount;
          userDoc.last_login = nowIso;
        }
        userDoc.password_hash = hashed;
        userDoc.force_password_change = false;
      } catch (localErr) {
        console.warn('[PasswordChange] Local mirror failed (cloud already updated):', localErr.message);
      }

      showToast("PIN updated successfully! Welcome to your dashboard.", "success");

      // 3. Reset ALL modal and login state completely
      state.modal.isOpen = false;
      state.modal.type = null;
      state.modal.title = '';
      state.modal.content = '';
      state.modal.data = null;
      state.stage = 1;
      state.password = '';
      state.errorMessage = '';

      // 4. Build and save the authenticated session
      const role = collectionName === 'members' ? 'member' : (userDoc.role || 'user');
      const fullName = collectionName === 'members'
        ? `${userDoc.last_name || ''} ${userDoc.first_name || ''} ${userDoc.middle_name || ''}`.trim()
        : (userDoc.full_name || userDoc.username);

      const cooperativeName = state.cooperatives.find((coop) => coop.id === userDoc.cooperative_id)?.name || userDoc.cooperative_id;

      const welcomeUser = {
        memberId: collectionName === 'members' ? userDoc.id : null,
        username: userDoc.username || userDoc.mobile,
        fullName: fullName || userDoc.full_name || userDoc.username || userDoc.mobile || '',
        role,
        permissions: userDoc.permissions || '',
        enterprises: userDoc.enterprise_rights || userDoc.enterprises || '',
        enterprise_rights: userDoc.enterprise_rights || userDoc.enterprises || '',
        cooperativeId: userDoc.cooperative_id,
        cooperativeName,
        collection: collectionName,
        userDoc: { ...userDoc },
        ...(isMemberLogin ? { login_count: newLoginCount, last_login: nowIso } : {}),
      };
      // Ensure no forceChange flag leaks into the session
      delete welcomeUser.forceChange;
      state.welcomeUser = welcomeUser;

      // Save session synchronously to sessionStorage first
      await saveSession(state.welcomeUser, newPin);

      // 5. Navigate to the default landing tab (dashboard for members)
      state.activeTab = 'dashboard';
      window.history.replaceState(null, '', '#dashboard');

      // 6. Trigger background sync to push any remaining queue items
      setTimeout(async () => {
        try {
          await initializeSyncService();
          if (navigator.onLine) {
            await syncCooperativeData(
              state.welcomeUser.cooperativeId,
              state.welcomeUser.role,
              state.welcomeUser.memberId,
              state.welcomeUser.permissions,
              state.welcomeUser.username
            );
          }
        } catch (syncErr) {
          console.warn('[PasswordChange] Post-change sync error:', syncErr.message);
        }
      }, 300);

      window.__render();
    } catch (err) {
      showToast("Failed to update PIN: " + err.message, "error");
      submitBtn.disabled = false;
      submitBtn.innerText = "Set PIN & Login";
    }
  });
}
