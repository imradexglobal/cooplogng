import { state } from '../state/appState.js'

function handleRouting() {
  const rawHash = window.location.hash.substring(1)
  if (rawHash === 'ledger/summary' || rawHash === 'ledger/') {
    window.location.hash = 'monthly-summary'
    return
  }
  const hash = rawHash
  if (!hash) {
    if (state.welcomeUser) {
      window.location.hash = state.activeTab
    }
    return
  }

  const [tab, ...parts] = hash.split('/')
  state.activeTab = tab
  state.routeParts = parts

  document.body.className = `tab-${tab}`
}

function updateNavSelection() {
  const currentHash = window.location.hash.substring(1)
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const btnTab = btn.dataset.tab
    if (currentHash === btnTab || (currentHash.startsWith(btnTab + '/') && btnTab !== '')) {
      btn.classList.add('active')
    } else {
      btn.classList.remove('active')
    }
  })
}

export { handleRouting, updateNavSelection }
