/**
 * Experimental pages — tiny UI primitives (toast + side drawer).
 *
 * Deliberately independent of the app's toast/modal services so the
 * experimental pages share no UI code with the existing pages.
 */

import { escapeHtml } from './format.js'

let toastStack = null

export function toast(message, type = 'info', title = '') {
  if (!toastStack || !document.body.contains(toastStack)) {
    toastStack = document.createElement('div')
    toastStack.className = 'xp-toast-stack'
    toastStack.setAttribute('aria-live', 'polite')
    document.body.appendChild(toastStack)
  }
  const el = document.createElement('div')
  el.className = `xp-toast is-${type}`
  el.innerHTML = `
    ${title ? `<div class="xp-toast-title">${escapeHtml(title)}</div>` : ''}
    <div class="xp-toast-msg">${escapeHtml(message)}</div>`
  toastStack.appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease'
    el.style.opacity = '0'
    el.style.transform = 'translateY(6px)'
    setTimeout(() => el.remove(), 260)
  }, type === 'error' ? 6000 : 3800)
}

/**
 * Opens a right-hand detail drawer.
 *
 * @param {{title:string, sub?:string, body:string, footer?:string,
 *          onMount?:(root:HTMLElement)=>void}} opts
 * @returns {{close:()=>void, root:HTMLElement}}
 */
export function openDrawer(opts) {
  closeDrawer()

  const overlay = document.createElement('div')
  overlay.className = 'xp-drawer-overlay'

  const panel = document.createElement('aside')
  panel.className = 'xp-drawer'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', opts.title || 'Details')
  panel.innerHTML = `
    <header class="xp-drawer-head">
      <div>
        <h2>${escapeHtml(opts.title || 'Details')}</h2>
        ${opts.sub ? `<div class="xp-drawer-sub">${opts.sub}</div>` : ''}
      </div>
      <button type="button" class="xp-drawer-close" data-xp-close aria-label="Close">&times;</button>
    </header>
    <div class="xp-drawer-body">${opts.body || ''}</div>
    ${opts.footer ? `<footer class="xp-drawer-foot">${opts.footer}</footer>` : ''}`

  document.body.appendChild(overlay)
  document.body.appendChild(panel)

  const close = () => {
    panel.classList.remove('is-open')
    overlay.classList.remove('is-open')
    document.removeEventListener('keydown', onKey)
    setTimeout(() => {
      panel.remove()
      overlay.remove()
    }, 220)
  }

  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }

  overlay.addEventListener('click', close)
  panel.querySelector('[data-xp-close]')?.addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  requestAnimationFrame(() => {
    overlay.classList.add('is-open')
    panel.classList.add('is-open')
  })

  if (typeof opts.onMount === 'function') opts.onMount(panel)

  return { close, root: panel }
}

export function closeDrawer() {
  document.querySelectorAll('.xp-drawer').forEach((el) => el.remove())
  document.querySelectorAll('.xp-drawer-overlay').forEach((el) => el.remove())
}

/** Standard loading placeholder used while the dataset is read. */
export function loadingHTML(label = 'Loading ledger data…') {
  return `
    <div class="xp-loading">
      <div class="xp-spinner" role="status" aria-label="Loading"></div>
      <div>${escapeHtml(label)}</div>
    </div>`
}

/** Keeps the app's mobile header title in sync while an experimental page is open. */
export function setMobileTitle(title, subtitle = '') {
  const el = document.getElementById('mobile-page-title')
  if (!el) return
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;text-align:left;line-height:1.2;">
      <span style="font-size:1.05rem;font-weight:700;color:var(--text-primary);">${escapeHtml(title)}</span>
      <span style="font-size:0.7rem;color:var(--text-muted);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;">${escapeHtml(subtitle)}</span>
    </div>`
}

export function errorHTML(err) {
  const msg = err && err.message ? err.message : String(err || 'Unknown error')
  return `<div class="xp-error"><strong>Could not load data.</strong> ${escapeHtml(msg)}</div>`
}
