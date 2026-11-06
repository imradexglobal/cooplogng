import { fetchAllMembers, fetchRemittances, fetchEnterprises } from '../services/dataService.js'
import { hasPermission } from '../services/permissionService.js'
import { formatCurrency, escapeHtml } from '../utils/formatters.js'

if (!window.__ledgerFilters) {
  window.__ledgerFilters = {
    memberId: 'All',
    memberName: 'All Members (Global)'
  }
}

if (window.__pendingLedgerMember) {
  window.__ledgerFilters.memberId = window.__pendingLedgerMember
  window.__ledgerFilters.memberName = 'Selected Member'
  window.__pendingLedgerMember = null
}

if (!window.__summaryFilters) {
  window.__summaryFilters = {
    month: 'All',
    year: new Date().getFullYear().toString()
  }
}

if (!window.__pendingLedgerMember) {
  window.__pendingLedgerMember = null
  window.addEventListener('change-tab', (e) => {
    const { tab, memberId, memberName } = e.detail || {}
    if (tab === 'ledger' && memberId) {
      window.__pendingLedgerMember = memberId
      if (memberName) window.__pendingLedgerMemberName = memberName
    }
  })
}

if (!window.__ledgerClickHandler) {
  window.__ledgerClickHandler = (e) => {
    if (!e.target.closest('.member-selector-wrap')) {
      const dd = document.getElementById('ledger-member-dropdown')
      if (dd) dd.classList.remove('open')
    }
  }
  document.addEventListener('click', window.__ledgerClickHandler)
}

function getMemberDisplay(memberId, memberName) {
  if (!memberId || memberId === 'All') return 'All Members (Global)'
  return memberName || 'Selected Member'
}

export async function renderMemberLedger(container, user) {
  const currentYear = new Date().getFullYear().toString()
  const isAdmin = user.isAdmin || hasPermission(user.permissions, 'admin') || user.username?.toLowerCase() === 'admin'
  const isMember = user.role === 'member'

  // Consume a member selected from Members preview ("View Ledger").
  // The old top-of-module copy only ran once at import, so the pending id
  // was never applied on subsequent navigations -> ledger opened unfiltered.
  if (window.__pendingLedgerMember) {
    const pendingId = String(window.__pendingLedgerMember)
    window.__ledgerFilters.memberId = pendingId
    window.__ledgerFilters.memberName = window.__pendingLedgerMemberName || 'Selected Member'
    window.__pendingLedgerMember = null
    window.__pendingLedgerMemberName = null
    // Resolve the display name (best-effort; lookup is coop-scoped + offline).
    try {
      const found = await fetchAllMembers(user.cooperativeId, user.username, true)
      const hit = (found || []).find(m => String(m.id) === pendingId)
      if (hit) {
        const full = `${hit.first_name || ''} ${hit.last_name || ''}`.trim()
        if (full) window.__ledgerFilters.memberName = full
      }
    } catch {}
  }

  if (isMember && user.memberId && user.memberId !== '0000000000' && window.__ledgerFilters.memberId === 'All') {
    window.__ledgerFilters.memberId = user.memberId
    window.__ledgerFilters.memberName = user.memberName || 'My Ledger'
  }

  const filters = window.__ledgerFilters

  const monthsList = ['All', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  const isGlobalView = () => filters.memberId === 'All'

  container.innerHTML = `
    <style>
      .lmv { display: none; }
      .lmc { background: var(--bg-card); border-radius: var(--radius-md); padding: 0.6rem 0.7rem; margin-bottom: 0.5rem; border: 1px solid var(--border-light); }
      .lch { font-size: 0.95rem; font-weight: 700; color: var(--text-primary); margin-bottom: 0.5rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--border-light); }
      .lch-row { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; min-width: 0; }
      .ltype { font-size: 0.6rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.15rem 0.5rem; border-radius: 999px; white-space: nowrap; }
      .ltype.t-credit { background: var(--success-bg); color: var(--success); }
      .ltype.t-debit { background: var(--danger-bg); color: var(--danger); }
      .ltype.t-neutral { background: var(--bg-secondary); color: var(--text-secondary); }
      .ldate { font-size: 0.72rem; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
      .ldesc { font-size: 0.82rem; line-height: 1.35; color: var(--text-primary); margin-bottom: 0.35rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .lmeta { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.66rem; font-weight: 600; color: var(--text-muted); margin-bottom: 0.5rem; }
      .lmeta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lname { display: block; font-size: 0.88rem; font-weight: 700; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lsub { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 0.45rem; }
      .lcg { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
      .lcg-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.35rem; }
      .ls { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
      .ls .sl { font-size: 0.6rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
      .ls .sv { font-size: 0.85rem; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

      /* Paging affordances */
      .lcount { text-align: center; font-size: 0.7rem; color: var(--text-muted); padding: 0.6rem 0 0.25rem; }
      .lsentinel { height: 1px; }
      .lmore { display: block; width: 100%; min-height: 44px; margin-top: 0.6rem; padding: 0.6rem 1rem; border: 1px solid var(--border-medium); border-radius: var(--radius-md); background: var(--bg-card); color: var(--accent-primary); font-size: 0.82rem; font-weight: 700; cursor: pointer; }
      .lmore:active { background: var(--bg-secondary); }

      /* Outer layout — contains its own scroll so sticky header truly freezes */
      .ledger-outer {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;  /* critical: allows flex child to shrink below content size */
        overflow: hidden;
      }

      /* Sticky frozen header — no position:sticky needed, just sits at top of flex col */
      .ledger-sticky-header {
        flex-shrink: 0;
        background: var(--bg-main);
        padding: 1.5rem 3rem 0.75rem;
        border-bottom: 1px solid var(--border-light);
        z-index: 50;
      }

      /* Scrollable content — inner scroll container */
      .ledger-scroll-body {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        padding: 1rem 3rem 2rem;
      }

      .scards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin-bottom: 1rem; }
      .scard { background: var(--bg-card); padding: 0.75rem 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-light); box-shadow: var(--shadow-sm); min-width: 0; }
      .scard .lbl { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700; margin-bottom: 0.25rem; letter-spacing: 0.04em; }
      .scard .val { font-size: clamp(0.95rem, 2.4vw, 1.1rem); font-weight: 800; color: var(--text-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

      .lhdr { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
      .lhdr h2 { margin: 0; font-size: 1.2rem; font-weight: 800; white-space: nowrap; }
      .lhdr .sub { font-size: 0.85rem; color: var(--text-muted); margin: 0; }
      .lhdr .hdr-right { margin-left: auto; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }

      .lfil { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
      .lfil .fg { display: flex; align-items: center; gap: 0.25rem; }
      .lfil .fg label { font-size: 0.6rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; white-space: nowrap; min-width: 2rem; }

      /* Quick range presets (tap once to fill From/To) */
      .lfil-presets { display: flex; align-items: center; gap: 0.4rem; overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding-bottom: 0.5rem; margin-bottom: 0.25rem; }
      .lfil-presets::-webkit-scrollbar { display: none; }
      .lpreset { flex: 0 0 auto; min-height: 34px; padding: 0.35rem 0.8rem; border: 1px solid var(--border-medium); border-radius: 999px; background: var(--bg-card); color: var(--text-secondary); font-size: 0.75rem; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
      .lpreset:hover { background: var(--bg-hover, var(--bg-secondary)); }
      .lpreset.active { background: var(--accent-primary); border-color: var(--accent-primary); color: #ffffff; }
      .lpreset:focus-visible, .ltab:focus-visible, .lmore:focus-visible, .ghost-button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

      /* Dates always-inline container */
      .lfil-dates { display: flex; flex-direction: row; gap: 0.4rem; align-items: flex-end; flex-wrap: nowrap; }
      .lfil-dates .fg { flex-direction: column; align-items: stretch; gap: 0.15rem; }
      .lfil-dates .fg label { min-width: unset; }

      .dwrap { position: relative; display: inline-block; min-width: 120px; }
      .dwrap input[type="date"] { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
      .dwrap .ddisp { width: 100%; box-sizing: border-box; cursor: pointer; padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font: inherit; font-size: 0.75rem; font-weight: 600; white-space: nowrap; text-align: center; line-height: 1.5; }
      .dwrap .ddisp:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

      .mwrap { position: relative; min-width: 180px; max-width: 280px; }
      .mwrap input { width: 100%; box-sizing: border-box; padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.75rem; line-height: 1.5; }
      .mdrop { display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: var(--radius-sm); box-shadow: var(--shadow-lg); z-index: 100; max-height: 200px; overflow-y: auto; margin-top: 2px; }
      .mdrop.open { display: block; }
      .mdrop .di { padding: 0.3rem 0.5rem; cursor: pointer; font-size: 0.75rem; color: var(--text-primary); border-bottom: 1px solid var(--border-light); transition: background 0.1s; }
      .mdrop .di:hover, .mdrop .di.hl { background: var(--bg-hover, var(--bg-secondary)); }
      .mdrop .di.all { font-weight: 700; color: var(--accent-primary); border-bottom: 2px solid var(--border-medium); }

      .sfils { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; }
      .sfils label { font-size: 0.6rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; display: flex; align-items: center; gap: 0.25rem; }
      .sfils select { padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.75rem; }
      .lzero-btn { min-height: 32px; }

      .lmodal-overlay { display: none; position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; }
      .lmodal-overlay.open { display: flex; }
      .lmodal { background: var(--bg-card); border-radius: var(--radius-lg); max-width: 600px; width: 92%; max-height: 85vh; overflow-y: auto; box-shadow: var(--shadow-xl); }
      .lmodal-hdr { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-light); position: sticky; top: 0; background: var(--bg-card); z-index: 1; }
      .lmodal-hdr h3 { margin: 0; font-size: 1rem; }
      .lmodal-body { padding: 0.75rem 1rem 1rem; }
      .lmodal-body .section { margin-bottom: 0.75rem; }
      .lmodal-body .section:last-child { margin-bottom: 0; }
      .lmodal-body .s-title { font-size: 0.65rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.35rem; }
      .lmodal-body .s-row { display: flex; justify-content: space-between; padding: 0.25rem 0; font-size: 0.85rem; }
      .lmodal-body .s-row + .s-row { border-top: 1px solid var(--border-light); }
      .lmodal-body .charges-list { max-height: 200px; overflow-y: auto; }
      .lmodal-actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-light); flex-wrap: wrap; }

      .tc { overflow-x: auto; border: 1px solid var(--border-light); border-radius: var(--radius-md); background: var(--bg-card); }
      .tc table { width: 100%; font-size: 0.78rem; }
      .tc table th { padding: 0.4rem 0.5rem; font-size: 0.68rem; white-space: nowrap; background: var(--bg-secondary); }
      .tc table td { padding: 0.35rem 0.5rem; }
      .tc table tr { cursor: pointer; transition: background 0.1s; }
      .tc table tbody tr:hover { background: var(--bg-hover, var(--bg-secondary)); }

      /* Tab styles */
      .ltabs { display: flex; gap: 0.35rem; margin-bottom: 0; background: var(--bg-input, #f1f5f9); padding: 0.3rem; border-radius: var(--radius-md); }
      .ltab { flex: 1; padding: 0.45rem 0.75rem; border: none; background: transparent; color: var(--text-muted); font-weight: 600; font-size: 0.85rem; cursor: pointer; border-radius: var(--radius-sm); white-space: nowrap; transition: all 0.2s ease; text-align: center; }
      .ltab:hover { color: var(--text-primary); background: var(--bg-hover, rgba(0,0,0,0.05)); }
      .ltab.active { background: var(--bg-card, #ffffff); color: var(--accent-primary); box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.1)); }

      @media (max-width: 999px) {
        .ldv { display: none; }
        .lmv { display: block; }
        .ledger-sticky-header {
          padding: 0.6rem 0.75rem 0.5rem;
        }
        .ledger-scroll-body {
          padding: 0.75rem 0.75rem 1.5rem;
        }
        /* Dates on same row */
        .lfil-dates { width: 100%; gap: 0.35rem; }
        .lfil-dates .fg { flex: 1; }
        .lfil-dates .fg label { font-size: 0.55rem; }
        .dwrap { min-width: auto; width: 100%; }
        /* 16px input text prevents iOS focus-zoom (labels stay small) */
        .dwrap .ddisp { min-height: 42px; padding: 0.45rem 0.5rem; font-size: 16px; }
        /* Stats: always 2 columns on mobile — never 3+1 */
        .scards { grid-template-columns: 1fr 1fr !important; }
        .scard { padding: 0.6rem 0.7rem; }
        .scard .val { font-size: clamp(0.95rem, 4.4vw, 1.1rem); }
        /* Hide member selector in header (it's in top bar on mobile) */
        .lhdr-member-desktop { display: none !important; }
        /* Hide page title in sticky header on mobile (shown in top bar),
           but keep the subtitle — member name + running total — visible */
        .lhdr > div:first-child { flex: none; width: 100%; min-width: 0; }
        .lhdr > div:first-child h2 { display: none; }
        .lhdr > div:first-child .sub { font-size: 0.72rem; line-height: 1.35; }
        .lhdr { flex-direction: column; align-items: flex-start; margin-bottom: 0.5rem; }
        .lhdr .hdr-right { margin-left: 0; width: 100%; }
        .lfil { margin-bottom: 0; width: 100%; }
        /* Presets: finger-sized, scroll off the right edge */
        .lfil-presets { margin-right: -0.75rem; padding-right: 0.75rem; padding-bottom: 0.4rem; }
        .lpreset { min-height: 40px; font-size: 0.8rem; padding: 0.4rem 0.9rem; }
        /* Filter selects + toggles: >=40px hit area, 16px text */
        .sfils select, #loan-status-filter { min-height: 40px; font-size: 16px !important; padding: 0.4rem 0.6rem; }
        .sfils label { font-size: 0.62rem; }
        .lzero-btn { min-height: 40px; font-size: 0.78rem !important; padding: 0 0.85rem !important; }
        /* Card amounts shrink so 7-figure sums stay inside the card */
        .lmc-tx .sv, .lmc-loan .sv { font-size: 0.78rem; }
        .lmc-tx .lmeta { font-size: 0.64rem; }
        /* Tab names shortened + bigger hit area */
        .ltab .tab-label-full { display: none; }
        .ltab .tab-label-short { display: inline; }
        .ltab { font-size: 0.8rem; padding: 0.6rem 0.4rem; min-height: 42px; }
        /* Loan detail becomes a bottom sheet */
        .lmodal-overlay { align-items: flex-end; }
        .lmodal { width: 100%; max-width: none; max-height: 88vh; max-height: 88dvh; border-radius: var(--radius-lg) var(--radius-lg) 0 0; padding-bottom: env(safe-area-inset-bottom); }
        .lmodal::before { content: ''; display: block; width: 40px; height: 4px; border-radius: 2px; background: var(--border-medium); margin: 0.5rem auto 0; }
        .lmodal-hdr { padding-top: 0.5rem; }
        .lmodal-body .s-row { flex-wrap: wrap; gap: 0.15rem 0.5rem; font-size: 0.9rem; padding: 0.4rem 0; }
        .lmodal-body .s-row > span:last-child { margin-left: auto; text-align: right; }
        .lmodal-actions { flex-direction: column; }
        .lmodal-actions .primary-button, .lmodal-actions .secondary-button { width: 100%; min-height: 44px; }
      }
      @media (min-width: 1000px) {
        .ltab .tab-label-full { display: inline; }
        .ltab .tab-label-short { display: none; }
      }
    </style>

    <div class="ledger-outer">

    <!-- Frozen sticky header -->
    <div class="ledger-sticky-header">
      <div class="lhdr" style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 0.6rem;">
        <div style="flex: 1; min-width: 200px;">
          <h2 style="margin: 0; font-size: 1.3rem; font-weight: 800;">Monthly &amp; Yearly Summary <span id="ledger-member-ids" style="font-weight: 800; color: var(--accent-primary);"></span></h2>
          <p class="sub" id="ledger-subtitle" style="margin: 0.25rem 0 0 0; color: var(--text-muted);"></p>
        </div>

        <div class="lfil" style="margin-bottom: 0; justify-content: flex-end; flex-wrap: wrap;">
          <!-- Member selector: desktop only, hidden on mobile (search is in top bar) -->
          <div class="fg lhdr-member-desktop" style="min-width: 180px; max-width: 240px;">
            <label>Member</label>
            <div class="mwrap" style="width: 100%;">
              <input type="text" id="ledger-member-search" placeholder="All Members (Global)" value="${getMemberDisplay(filters.memberId, filters.memberName) === 'All Members (Global)' ? '' : getMemberDisplay(filters.memberId, filters.memberName)}" autocomplete="off">
              <div class="mdrop" id="ledger-member-dropdown"></div>
            </div>
          </div>
        </div>
      </div>

    </div><!-- /.ledger-sticky-header -->

    <!-- Scrollable body -->
    <div class="ledger-scroll-body">
      <div id="ledger-content"></div>
    </div>

    </div><!-- /.ledger-outer -->

  `

  const contentContainer = document.getElementById('ledger-content')

  // --- Viewport tree + paging state ------------------------------------
  // Only one DOM tree is built (desktop table *or* mobile cards), so the
  // page re-renders whenever the 999px breakpoint is crossed (rotation,
  // split view, window resize).
  const PAGE_SIZE = 50
  let visibleLimit = PAGE_SIZE
  let pageKey = ''
  let totalRows = 0
  let loadingMore = false

  const isMobileViewport = () => window.matchMedia('(max-width: 999px)').matches

  if (window.__ledgerMq && window.__ledgerMqHandler) {
    window.__ledgerMq.removeEventListener('change', window.__ledgerMqHandler)
  }
  window.__ledgerMq = window.matchMedia('(max-width: 999px)')
  window.__ledgerMqHandler = () => {
    // Ignore stale handlers left over from a previous ledger mount.
    if (document.getElementById('ledger-content') !== contentContainer) return
    renderActiveTab()
  }
  window.__ledgerMq.addEventListener('change', window.__ledgerMqHandler)

  function paginate(list) {
    totalRows = list.length
    return list.slice(0, visibleLimit)
  }

  function loadMoreRows() {
    if (loadingMore || visibleLimit >= totalRows) return
    loadingMore = true
    visibleLimit += PAGE_SIZE
    Promise.resolve(renderActiveTab())
      .finally(() => { loadingMore = false })
      .catch(() => {})
  }

  function pagingFooter(shown, total) {
    if (total === 0) return ''
    const remaining = total - shown
    return `
      <div class="lcount">Showing ${shown} of ${total} ${total === 1 ? 'entry' : 'entries'}</div>
      ${remaining > 0 ? `
        <button type="button" class="lmore" id="ledger-load-more">Show more (${remaining} remaining)</button>
        <div class="lsentinel" id="ledger-sentinel"></div>` : ''}`
  }

  function bindPaging() {
    const btn = document.getElementById('ledger-load-more')
    if (btn) btn.addEventListener('click', loadMoreRows)

    // Drop the previous render's observer so they don't pile up.
    if (window.__ledgerPagingIO) {
      try { window.__ledgerPagingIO.disconnect() } catch {}
      window.__ledgerPagingIO = null
    }

    const sentinel = document.getElementById('ledger-sentinel')
    const scrollBody = container.querySelector('.ledger-scroll-body')
    if (!sentinel || !scrollBody || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some(en => en.isIntersecting)) {
        io.disconnect()
        loadMoreRows()
      }
    }, { root: scrollBody, rootMargin: '150px' })
    io.observe(sentinel)
    window.__ledgerPagingIO = io
  }

  // This legacy route is summary-only; old transaction/loan subroutes land here.
  window._activeLedgerTab = 'tab-summary'

  let allMembersCache = null
  let memberSearchTimeout = null

  async function getMembersForSearch() {
    if (allMembersCache) return allMembersCache
    allMembersCache = await fetchAllMembers(user.cooperativeId, user.username, isAdmin)
    return allMembersCache
  }

  function formatLedgerMemberIds(m) {
    if (!m) return ''
    const special = String(m.special_id || '').trim()
    const reg = String(m.member_registration_no || m.registration_no || '').trim()
    if (special && reg) return `${special} / ${reg}`
    if (special) return special
    if (reg) return reg
    return ''
  }

  async function updateLedgerTitleIds() {
    const el = document.getElementById('ledger-member-ids')
    if (!el) return
    if (!filters.memberId || filters.memberId === 'All') { el.textContent = ''; return }
    try {
      const members = await getMembersForSearch()
      const hit = (members || []).find(mm => String(mm.id) === String(filters.memberId))
      const label = formatLedgerMemberIds(hit)
      el.textContent = label ? ` (${label})` : ''
    } catch { el.textContent = '' }
  }

  const memberSearchInput = document.getElementById('ledger-member-search')
  const memberDropdown = document.getElementById('ledger-member-dropdown')

  function buildMemberDropdownHtml(members, query) {
    const q = (query || '').toLowerCase().trim()
    let filtered = members
    if (q) {
      filtered = members.filter(m => {
        const name = `${m.first_name || ''} ${m.last_name || ''} ${m.middle_name || ''}`.toLowerCase()
        const regNo = String(m.member_registration_no || m.registration_no || '').toLowerCase()
        const mobile = String(m.mobile || '').toLowerCase()
        const specialId = String(m.special_id || '').toLowerCase()
        return name.includes(q) || regNo.includes(q) || mobile.includes(q) || specialId.includes(q)
      })
    }

    const allSelected = filters.memberId === 'All' ? 'hl' : ''
    let html = `<div class="di all ${allSelected}" data-member-id="All">All Members (Global)</div>`

    if (filtered.length === 0 && q) {
      html += `<div class="di" style="color: var(--text-muted); cursor: default;">No members found</div>`
    } else {
      html += filtered.map(m => {
        const name = `${m.first_name || ''} ${m.last_name || ''}`.trim() || 'Unknown'
        const regNo = m.member_registration_no || m.registration_no || ''
        const specialId = m.special_id || ''
        const mobile = m.mobile || ''
        const selected = filters.memberId === m.id ? 'hl' : ''
        const extraParts = []
        if (specialId) extraParts.push(`ID: ${escapeHtml(specialId)}`)
        if (regNo) extraParts.push(`Reg: ${escapeHtml(regNo)}`)
        if (mobile) extraParts.push(`Mobile: ${escapeHtml(mobile)}`)
        return `<div class="di ${selected}" data-member-id="${m.id}" data-member-name="${escapeHtml(name)}">${escapeHtml(name)} ${extraParts.length ? `<span style="color: var(--text-muted); font-size: 0.65rem;">(${extraParts.join(' • ')})</span>` : ''}</div>`
      }).join('')
    }
    return html
  }

  function renderMemberDropdown(members, query) {
    memberDropdown.innerHTML = buildMemberDropdownHtml(members, query)
    memberDropdown.classList.add('open')
  }

  function closeMemberDropdown() {
    memberDropdown.classList.remove('open')
  }

  function selectMember(memberId, memberName) {
    if (memberId === 'All') {
      filters.memberId = 'All'
      filters.memberName = 'All Members (Global)'
      if (memberSearchInput) { memberSearchInput.value = ''; memberSearchInput.placeholder = 'All Members (Global)' }
      // Sync mobile input
      const mobileInput = document.getElementById('ledger-member-search-mobile')
      if (mobileInput) { mobileInput.value = '' }
    } else {
      filters.memberId = memberId
      filters.memberName = memberName
      if (memberSearchInput) { memberSearchInput.value = memberName; memberSearchInput.placeholder = 'Search member...' }
      const mobileInput = document.getElementById('ledger-member-search-mobile')
      if (mobileInput) { mobileInput.value = memberName }
    }
    closeMemberDropdown()
    // Also close mobile dropdown
    const mobileDropdown = document.getElementById('ledger-member-dropdown-mobile')
    if (mobileDropdown) mobileDropdown.style.display = 'none'
    renderActiveTab()
  }

  if (memberSearchInput) {
    memberSearchInput.addEventListener('focus', async () => {
      const members = await getMembersForSearch()
      renderMemberDropdown(members, memberSearchInput.value)
    })

    memberSearchInput.addEventListener('input', async () => {
      if (memberSearchTimeout) clearTimeout(memberSearchTimeout)
      memberSearchTimeout = setTimeout(async () => {
        const members = await getMembersForSearch()
        renderMemberDropdown(members, memberSearchInput.value)
      }, 150)
    })
  }

  memberDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.di')
    if (!item) return
    selectMember(item.dataset.memberId, item.dataset.memberName || '')
  })

  // --- Mobile top bar member search ---
  // Listen for the event fired by main.js when mobile input changes
  const _mobileLedgerSearchHandler = async (e) => {
    const query = e.detail?.query || ''
    const mobileDropdown = document.getElementById('ledger-member-dropdown-mobile')
    if (!mobileDropdown) return

    const members = await getMembersForSearch()
    const html = buildMemberDropdownHtml(members, query)
    // Style items to look good in the floating dropdown
    mobileDropdown.innerHTML = `<style>
      #ledger-member-dropdown-mobile .di { display: flex; align-items: center; min-height: 42px; padding: 0.45rem 0.65rem; cursor: pointer; font-size: 0.85rem; color: var(--text-primary); border-bottom: 1px solid var(--border-light); }
      #ledger-member-dropdown-mobile .di:hover, #ledger-member-dropdown-mobile .di.hl { background: var(--bg-secondary); }
      #ledger-member-dropdown-mobile .di.all { font-weight: 700; color: var(--accent-primary); }
    </style>${html}`
    mobileDropdown.style.display = 'block'

    mobileDropdown.querySelectorAll('.di').forEach(item => {
      item.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const mId = item.dataset.memberId
        const mName = item.dataset.memberName || ''
        selectMember(mId, mName)
        mobileDropdown.style.display = 'none'
      })
    })
  }

  // Remove any stale listener from previous render before adding
  if (window._currentMobileLedgerSearchHandler) {
    window.removeEventListener('mobile-ledger-member-search', window._currentMobileLedgerSearchHandler)
  }
  window._currentMobileLedgerSearchHandler = _mobileLedgerSearchHandler
  window.addEventListener('mobile-ledger-member-search', window._currentMobileLedgerSearchHandler)


  const _ledgerCacheKey = () => String(user.cooperativeId || '')

  async function _getCachedRemittances() {
    const cache = window.__ledgerDataCache
    const key = _ledgerCacheKey()
    if (cache && cache.key === key && cache.remittances) {
      return cache.remittances
    }
    const data = await fetchRemittances(user.cooperativeId, user)
    window.__ledgerDataCache = { remittances: data, key, cooperativeId: user.cooperativeId }
    return data
  }

  // Invalidate ledger cache on remittance sync events
  if (!window.__ledgerCacheListener) {
    window.__ledgerCacheListener = true
    import('../services/syncEventBus.js').then(({ syncBus, SyncEvents }) => {
      syncBus.on(SyncEvents.REMITTANCE_UPDATED, () => { window.__ledgerDataCache = null })
      syncBus.on(SyncEvents.REMITTANCE_ADDED, () => { window.__ledgerDataCache = null })
      syncBus.on(SyncEvents.REMITTANCE_DELETED, () => { window.__ledgerDataCache = null })
    }).catch(() => {})
  }

  async function renderActiveTab() {
    updateLedgerTitleIds()

    // A change in any filter means a new result set -> reset paging.
    // "Show more" keeps the same key, so it keeps its scroll position and
    // skips the full-screen spinner.
    const key = [
      window._activeLedgerTab,
      filters.dateFrom || '',
      filters.dateTo || '',
      filters.memberId || '',
      window._activeLedgerTab === 'tab-summary'
        ? `${window.__summaryFilters.month}|${window.__summaryFilters.year}|${window.__ledgerShowZeroes ? 1 : 0}`
        : '',
    ].join('|')
    const isSameContext = key === pageKey
    if (!isSameContext) {
      pageKey = key
      visibleLimit = PAGE_SIZE
    }

    const subtitleEl = document.getElementById('ledger-subtitle')
    if (subtitleEl && !isSameContext) {
      const viewLabel = isGlobalView() ? 'Cooperative-wide' : `Member: <strong style="color: var(--accent-primary);">${escapeHtml(filters.memberName)}</strong>`
      subtitleEl.innerHTML = `${viewLabel} | Loading...`
    }

    if (!isSameContext || !contentContainer.innerHTML.trim()) {
      contentContainer.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:3rem 1rem;"><div style="width:40px;height:40px;border:4px solid var(--border-medium);border-top-color:var(--accent-primary);border-radius:50%;animation:spin 1s linear infinite;"></div><div style="margin-top:1rem;color:var(--text-primary);font-weight:600;">Loading workspace...</div><div style="color:var(--text-muted);font-size:0.8rem;margin-top:0.25rem;">Please wait while we prepare your workspace</div><style>@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style></div>'
    }

    try {
      await renderSummaryTab()
    } catch (err) {
      contentContainer.innerHTML = `<div class="alert">Error: ${escapeHtml(err.message)}</div>`
    }
  }

  function updateSubtitle(networth) {
    const subtitleEl = document.getElementById('ledger-subtitle')
    if (!subtitleEl) return
    const viewLabel = isGlobalView()
      ? `Showing <strong>${isAdmin ? 'Global' : 'Accessible'}</strong> summary`
      : `Summary for <strong style="color: var(--accent-primary);">${escapeHtml(filters.memberName)}</strong>`
    const totalClass = Number(networth) < 0 ? 'text-red' : 'text-green'
    subtitleEl.innerHTML = `${viewLabel} | Total: <strong class="${totalClass}">${formatCurrency(networth)}</strong>`
  }

  async function renderSummaryTab() {
    const { month, year } = window.__summaryFilters
    const yearNum = parseInt(year)

    const monthStart = month === 'All'
      ? new Date(yearNum, 0, 1)
      : new Date(yearNum, parseInt(month), 1)
    const monthEnd = month === 'All'
      ? new Date(yearNum, 11, 31, 23, 59, 59)
      : new Date(yearNum, parseInt(month) + 1, 0, 23, 59, 59)

    const allRemittances = await _getCachedRemittances()
    const approved = allRemittances.filter(r => r.status === 'Approved')

    let filteredRemittances = approved
    if (!isGlobalView()) {
      filteredRemittances = filteredRemittances.filter(r => String(r.member_id) === String(filters.memberId))
    }

    let openingBalance = 0
    let totalCredit = 0
    let totalDebit = 0

    const enterpriseOpening = {}
    const enterprisePeriod = {}

    const allEnts = await fetchEnterprises(user.cooperativeId)
    const enterpriseIds = new Set()

    for (const r of filteredRemittances) {
      const d = new Date(r.remittance_date)
      const amt = r.amount || 0
      const details = r.details || []

      if (d < monthStart) {
        openingBalance += amt
        for (const detail of details) {
          const eid = detail.enterprise_id
          if (eid) {
            enterpriseIds.add(eid)
            if (!enterpriseOpening[eid]) enterpriseOpening[eid] = 0
            enterpriseOpening[eid] += parseFloat(detail.amount || 0)
          }
        }
      } else if (d >= monthStart && d <= monthEnd) {
        if (amt > 0) totalCredit += amt
        else totalDebit += Math.abs(amt)

        for (const detail of details) {
          const eid = detail.enterprise_id
          if (eid) {
            enterpriseIds.add(eid)
            if (!enterprisePeriod[eid]) enterprisePeriod[eid] = { cr: 0, dr: 0 }
            const detAmt = parseFloat(detail.amount || 0)
            if (detAmt > 0) enterprisePeriod[eid].cr += detAmt
            else enterprisePeriod[eid].dr += Math.abs(detAmt)
          }
        }
      }
    }

    const closingBalance = openingBalance + totalCredit - totalDebit

    updateSubtitle(closingBalance)

    Object.keys(allEnts).forEach(id => {
      enterpriseIds.add(id)
    })

    let entries = Array.from(enterpriseIds).map(id => {
      const opening = enterpriseOpening[id] || 0
      const cr = enterprisePeriod[id]?.cr || 0
      const dr = enterprisePeriod[id]?.dr || 0
      const closing = opening + cr - dr
      return { id, name: allEnts[id] || 'Unknown', bbf: opening, cr, dr, closing }
    })

    entries.sort((a, b) => a.name.localeCompare(b.name))

    const localShowZeroes = window.__ledgerShowZeroes || false;
    if (!localShowZeroes) {
      entries = entries.filter(e => Math.abs(e.bbf) >= 0.01 || Math.abs(e.closing) >= 0.01 || Math.abs(e.dr) >= 0.01 || Math.abs(e.cr) >= 0.01)
    }

    let allowedEntIds = []
    let allowedEntNames = []
    let hasAllAccess = false

    if (!isAdmin && !isMember) {
      const rightsString = user.enterprise_rights || user.enterprises || ''
      const rights = rightsString.split(',').map(p => p.trim()).filter(p => p.length > 0)
      if (rights.some(r => r.toLowerCase() === 'all')) {
        hasAllAccess = true
      } else {
        rights.forEach(r => {
          const matchId = Object.keys(allEnts).find(id => id.toLowerCase() === r.toLowerCase())
          if (matchId) allowedEntIds.push(matchId)
          else allowedEntNames.push(r.toLowerCase())
        })
      }
    }

    entries = entries.map(e => {
      const hasAccess = isAdmin || isMember || hasAllAccess ||
        allowedEntIds.includes(String(e.id)) ||
        allowedEntNames.includes((e.name || '').toLowerCase())
      if (!hasAccess) {
        return { ...e, bbf: 0, dr: 0, cr: 0, closing: 0, isRestricted: true }
      }
      return e
    })

    const monthlyDebitTotal = entries.reduce((sum, entry) => sum + (entry.isRestricted ? 0 : Number(entry.dr) || 0), 0)
    const monthlyCreditTotal = entries.reduce((sum, entry) => sum + (entry.isRestricted ? 0 : Number(entry.cr) || 0), 0)

    // Month payment indicator: per-month +ve (deposit) totals for the selected
    // year within the current member scope. Green = paid (>0), red = none (=0),
    // unstyled = 'All' or a future month.
    const nowDate = new Date()
    const nowYear = nowDate.getFullYear()
    const nowMonth = nowDate.getMonth()
    const monthlyCredit = new Array(12).fill(0)
    if (!isNaN(yearNum)) {
      for (const r of filteredRemittances) {
        const amt = Number(r.amount) || 0
        if (amt <= 0) continue
        const d = new Date(r.remittance_date)
        if (isNaN(d)) continue
        if (d.getFullYear() === yearNum) monthlyCredit[d.getMonth()] += amt
      }
    }
    const monthStyleFor = (idx) => {
      if (isNaN(yearNum)) return ''
      if (yearNum > nowYear || (yearNum === nowYear && idx > nowMonth)) return ''
      return monthlyCredit[idx] > 0
        ? 'background:#15803d;color:#ffffff;font-weight:700;'
        : 'background:#b91c1c;color:#ffffff;'
    }
    const selectedMonthStyle = (() => {
      if (month === 'All') return ''
      const idx = parseInt(month)
      if (isNaN(idx) || idx < 0 || idx > 11) return ''
      if (isNaN(yearNum)) return ''
      if (yearNum > nowYear || (yearNum === nowYear && idx > nowMonth)) return ''
      return monthlyCredit[idx] > 0
        ? 'background:#15803d;color:#ffffff;font-weight:700;'
        : 'background:#b91c1c;color:#ffffff;'
    })()
    const monthOptions = monthsList.map((m, i) => {
      let val = m === 'All' ? 'All' : String(i - 1)
      let sel = val === month ? 'selected' : ''
      let style = m === 'All' ? '' : ` style="${monthStyleFor(i - 1)}"`
      return `<option value="${val}"${style} ${sel}>${m}</option>`
    }).join('')

    // Always include the currently selected year, even if it falls outside
    // the default last-3-years window (e.g. restored filter from an older year).
    const yearSet = new Set([0, -1, -2].map(d => Number(currentYear) + d))
    if (year && !isNaN(parseInt(year))) yearSet.add(parseInt(year))
    const yearOptions = [...yearSet].sort((a, b) => b - a).map(y => {
      const sel = String(y) === year ? 'selected' : ''
      return `<option value="${y}" ${sel}>${y}</option>`
    }).join('')

    const summaryFilterBar = `
      <div class="sfils" style="justify-content: space-between; align-items: center; width: 100%;">
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
          <label>Month <select id="summary-month-select" title="Green = deposit made that month, red = none" style="margin-left: 0.25rem;${selectedMonthStyle}">${monthOptions}</select></label>
          <label>Year <select id="summary-year-select" style="margin-left: 0.25rem;">${yearOptions}</select></label>
          <span style="font-size: 0.68rem; color: var(--text-muted);"><span style="display:inline-block;width:0.6rem;height:0.6rem;border-radius:2px;background:#15803d;vertical-align:middle;"></span> paid <span style="display:inline-block;width:0.6rem;height:0.6rem;border-radius:2px;background:#b91c1c;vertical-align:middle;margin-left:0.35rem;"></span> none</span>
        </div>
        <button id="summary-toggle-zeroes-btn" class="ghost-button lzero-btn" style="font-size: 0.7rem; padding: 0 0.6rem; border-radius: var(--radius-sm);">${localShowZeroes ? 'Hide Zeroes' : 'Unhide Zeroes'}</button>
      </div>`
    const bindSummaryControls = () => {
      document.getElementById('summary-toggle-zeroes-btn')?.addEventListener('click', () => {
        window.__ledgerShowZeroes = !window.__ledgerShowZeroes
        renderActiveTab()
      })
      document.getElementById('summary-month-select')?.addEventListener('change', (e) => {
        window.__summaryFilters.month = e.target.value
        renderActiveTab()
      })
      document.getElementById('summary-year-select')?.addEventListener('change', (e) => {
        window.__summaryFilters.year = e.target.value
        renderActiveTab()
      })
    }

    if (entries.length === 0) {
      contentContainer.innerHTML = `
      ${summaryFilterBar}
      <div class="card" style="width: 100%; padding: 1rem; color: var(--text-muted); text-align: center; border: 1px solid var(--border-light); background: var(--bg-card); font-size: 0.85rem;">No ledger entries found for this period.</div>`
      bindSummaryControls()
      return
    }

    const page = paginate(entries)
    const mobile = isMobileViewport()

    const desktopRow = (entry) => `
        <tr>
          <td>${entry.isRestricted ? '🔒 ' : ''}${escapeHtml(entry.name)}</td>
          <td class="text-right ${entry.bbf < 0 ? 'text-red' : ''}">${entry.isRestricted ? '***' : formatCurrency(entry.bbf)}</td>
          <td class="text-red text-right">${entry.isRestricted ? '***' : formatCurrency(entry.dr)}</td>
          <td class="text-green text-right">${entry.isRestricted ? '***' : formatCurrency(entry.cr)}</td>
          <td class="text-right ${entry.closing < 0 ? 'text-red' : ''}">${entry.isRestricted ? '***' : formatCurrency(entry.closing)}</td>
        </tr>`

    const mobileCard = (entry) => `
        <div class="lmc"><div class="lch"><span class="lname">${entry.isRestricted ? '🔒 ' : ''}${escapeHtml(entry.name)}</span></div>
        <div class="lcg">
          <div class="ls"><span class="sl">Opening</span><span class="sv ${entry.bbf < 0 ? 'text-red' : ''}">${entry.isRestricted ? '***' : formatCurrency(entry.bbf)}</span></div>
          <div class="ls"><span class="sl">Closing</span><span class="sv ${entry.closing < 0 ? 'text-red' : ''}">${entry.isRestricted ? '***' : formatCurrency(entry.closing)}</span></div>
          <div class="ls"><span class="sl text-red">Debit</span><span class="sv text-red">${entry.isRestricted ? '***' : formatCurrency(entry.dr)}</span></div>
          <div class="ls"><span class="sl text-green">Credit</span><span class="sv text-green">${entry.isRestricted ? '***' : formatCurrency(entry.cr)}</span></div>
        </div></div>`

    const listHtml = page.map(mobile ? mobileCard : desktopRow).join('')

    const bodyHtml = mobile
      ? `<div class="scards" style="grid-template-columns: repeat(2, minmax(0, 1fr));"><div class="scard"><div class="lbl">Monthly Debit (DR)</div><div class="val text-red">${formatCurrency(monthlyDebitTotal)}</div></div><div class="scard"><div class="lbl">Monthly Credit (CR)</div><div class="val text-green">${formatCurrency(monthlyCreditTotal)}</div></div></div><div class="lmv">${listHtml}</div>`
      : `<div class="ldv"><div class="tc"><table class="styled-table"><thead><tr><th>Enterprise</th><th class="text-right">Opening (BBF)</th><th class="text-right">Debit (DR)</th><th class="text-right">Credit (CR)</th><th class="text-right">Closing</th></tr><tr style="background: var(--bg-card); font-weight: 800;"><th>Monthly Total</th><th class="text-right">—</th><th class="text-right text-red">${formatCurrency(monthlyDebitTotal)}</th><th class="text-right text-green">${formatCurrency(monthlyCreditTotal)}</th><th class="text-right">—</th></tr></thead><tbody>${listHtml}</tbody></table></div></div>`

    contentContainer.innerHTML = `
      ${summaryFilterBar}
      ${bodyHtml}
      ${pagingFooter(page.length, entries.length)}
    `
    bindSummaryControls()
    bindPaging()
  }

  renderActiveTab()
}
