import { escapeHtml, getInitials, getAvatarColor, formatDate, formatDateTime } from '../../utils/formatters.js';
import {
    getFilteredMembers, visibleLimit, increaseVisibleLimit,
    isSelectionMode, selectedIds, toggleSelection, selectAllFiltered, deselectAll,
    setSort, applyFilters, sortKey, sortDir
} from './membersState.js'

// Avatar colors now shared via utils/formatters.js:getAvatarColor
function mobileCellHtml(m) {
    const raw = String(m.mobile || '').trim()
    if (!raw) return ''
    return `<a href="tel:${escapeHtml(raw.replace(/\s+/g, ''))}" class="col-mobile-link" data-tel>${escapeHtml(raw)}</a>`
}

function getProfileHtml(m) {
    if (m.image_path) {
        return `<div class="avatar-container" data-has-image="true" data-src="${escapeHtml(m.image_path)}" data-name="${escapeHtml(m.name)}">
                  <img src="${m.image_path}" class="avatar-img" alt="${escapeHtml(m.name)}" loading="lazy" draggable="false">
                </div>`
    }
    const initials = getInitials(m.name)
    const color = getAvatarColor(m.name)
    return `<div class="avatar-container avatar-initials" style="background-color: ${color};" data-name="${escapeHtml(m.name)}">
              ${escapeHtml(initials)}
            </div>`
}

function hideAvatarPreview() {
    document.getElementById('avatar-preview-overlay')?.remove()
}

function showAvatarPreview(src, name) {
    hideAvatarPreview()
    const overlay = document.createElement('div')
    overlay.className = 'avatar-preview-overlay'
    overlay.id = 'avatar-preview-overlay'
    const initials = getInitials(name)
    const color = getAvatarColor(name)
    overlay.innerHTML = src
        ? `<div class="avatar-preview-image-wrap">
               <img src="${src}" alt="${escapeHtml(name)}" draggable="false">
               <div class="avatar-preview-meta">
                   <div class="avatar-preview-initials-sm" style="background:${color}">${escapeHtml(initials)}</div>
                   <div class="avatar-preview-name">${escapeHtml(name)}</div>
               </div>
           </div>`
        : `<div class="avatar-preview-initials-wrap">
               <div class="avatar-preview-initials-circle" style="background-color: ${color};">${escapeHtml(initials)}</div>
               <div class="avatar-preview-name">${escapeHtml(name)}</div>
           </div>`
    overlay.addEventListener('click', hideAvatarPreview)
    document.body.appendChild(overlay)
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') {
            hideAvatarPreview()
            document.removeEventListener('keydown', onKey)
        }
    })
}

// Single click/press on an avatar opens a sticky photo preview
// (closes on click outside or Escape). The flag tells the row click
// handler to skip opening the member modal for this press.
function attachAvatarPreviewListeners(element, src, name) {
    if (!name) return;
    if (element.dataset.previewAttached) return;
    element.dataset.previewAttached = 'true';
    element.style.cursor = 'pointer';
    element.title = 'View photo';

    element.addEventListener('click', (e) => {
        e.stopPropagation();
        element.dataset.justPreviewed = 'true';
        setTimeout(() => { element.dataset.justPreviewed = 'false'; }, 300);
        showAvatarPreview(src, name);
    });
}


// Helper to update an existing row with member data without recreating the entire row element.
function updateRow(row, m) {
    // Update avatar cell
    const avatarCell = row.querySelector('.col-profile')
    if (avatarCell) {
        avatarCell.innerHTML = getProfileHtml(m)
        const avatar = avatarCell.querySelector('.avatar-container')
        if (avatar) attachAvatarPreviewListeners(avatar, avatar.dataset.src, avatar.dataset.name)
    }

    // Update selection checkbox if in selection mode
    if (isSelectionMode) {
        let chkTd = row.querySelector('.selection-col')
        if (!chkTd) {
            chkTd = document.createElement('td')
            chkTd.className = 'selection-col'
            chkTd.innerHTML = `<input type="checkbox" class="member-chk" data-id="${m.id}" ${selectedIds.has(m.id) ? 'checked' : ''}>`
            row.prepend(chkTd)
        } else {
            const chk = chkTd.querySelector('.member-chk')
            if (chk) chk.checked = selectedIds.has(m.id)
        }
    } else {
        const chkTd = row.querySelector('.selection-col')
        if (chkTd) chkTd.remove()
    }

    // Update name and identifier (textContent = raw text, no double-escaping)
    const nameEl = row.querySelector('.member-row-name')
    if (nameEl) nameEl.textContent = m.name || ''

    // Update Special ID cell
    const specialEl = row.querySelector('.col-special')
    if (specialEl) specialEl.textContent = m.special_id || '—'

    const padRegNo = (val) => String(val || '').padStart(3, '0')
    let identifierEl = row.querySelector('.member-row-identifier')
    if (identifierEl) {
        identifierEl.innerHTML = m.special_id 
            ? `<div class="member-row-special-id">ID: ${escapeHtml(m.special_id)}</div>` 
            : `<div class="member-row-mobile-reg-no">Reg No: ${padRegNo(m.registration_no || m.reg_no)}</div>`;
    }

    // Update mobile cell (tel: link; plain text fallback handled by render)
    const mobileEl = row.querySelector('.col-mobile')
    if (mobileEl) mobileEl.innerHTML = mobileCellHtml(m)

    // Update Last Login cell
    let lastLoginEl = row.querySelector('.col-last-login')
    if (lastLoginEl) {
        const at = formatDate(m.last_login) || '—'
        const count = m.login_count !== undefined && m.login_count !== null ? m.login_count : 0
        lastLoginEl.innerHTML = `
            <div class="modified-at-time">${at}</div>
            <div class="login-count-badge">(${String(count).padStart(2, '0')})</div>
        `
    }

    // Update combined modified cell
    const modifiedEl = row.querySelector('.col-modified')
    if (modifiedEl) {
        const by = escapeHtml(m.modified_by || m.created_by || '—')
        const at = formatDateTime(m.modified_at || m.created_at) || '—'
        modifiedEl.innerHTML = `
            <div class="modified-by-name">${by}</div>
            <div class="modified-at-time">${at}</div>
        `
    }
}


export function renderMembersTable(container) {
    const tableContainer = container.querySelector('#members-table-container')
    if (!tableContainer) return

    // Preserve scroll position during updates
    const previousScrollTop = container.scrollTop

    // Update checkbox header state
    const headerRow = tableContainer.querySelector('thead tr')
    if (headerRow) {
        const existingCheckbox = headerRow.querySelector('.selection-col')
        if (isSelectionMode) {
            if (!existingCheckbox) {
                const th = document.createElement('th')
                th.className = 'selection-col'
                th.style.width = '40px'
                th.innerHTML = `<input type="checkbox" id="select-all-members-chk">`
                headerRow.prepend(th)

                headerRow.querySelector('#select-all-members-chk').onclick = (e) => {
                    e.stopPropagation()
                    if (e.target.checked) selectAllFiltered()
                    else deselectAll()
                    renderMembersTable(container)
                    window.dispatchEvent(new CustomEvent('members-selection-changed'))
                }
            } else {
                const currentFiltered = getFilteredMembers()
                const allSelected = currentFiltered.length > 0 && currentFiltered.every(m => selectedIds.has(m.id))
                headerRow.querySelector('#select-all-members-chk').checked = allSelected
            }
        } else if (existingCheckbox) {
            existingCheckbox.remove()
        }

        // Clickable column headers: sort A-Z / Z-A (attached once per thead).
        const thead = tableContainer.querySelector('thead')
        if (thead && !thead.dataset.sortAttached) {
            thead.dataset.sortAttached = 'true'
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('th[data-sort]')
                if (!th) return
                setSort(th.dataset.sort)
                applyFilters()
                renderMembersTable(container)
            })
        }

        // Arrow indicator on the active sort column.
        tableContainer.querySelectorAll('th[data-sort]').forEach(th => {
            const arrow = th.querySelector('.sort-arrow')
            if (!arrow) return
            arrow.textContent = th.dataset.sort === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
        })
    }

    const currentFiltered = getFilteredMembers()
    const visibleMembers = currentFiltered.slice(0, visibleLimit)
    const hasMore = visibleLimit < currentFiltered.length
    // Restore scroll after rendering
    container.scrollTop = previousScrollTop

    const padRegNo = (val) => String(val || '').padStart(3, '0')

    const tbody = tableContainer.querySelector('#members-table-body')
    if (!tbody) return

    // DOM Reconciliation
    const existingRows = Array.from(tbody.querySelectorAll('.member-row'))
    const rowMap = new Map()
    existingRows.forEach(row => rowMap.set(row.dataset.id, row))

    let currentRowElement = tbody.firstElementChild

    visibleMembers.forEach(m => {
        const isSelected = selectedIds.has(m.id)
        const specialIdHtml = m.special_id
            ? `<div class="member-row-special-id">ID: ${escapeHtml(m.special_id)}</div>`
            : `<div class="member-row-mobile-reg-no">Reg No: ${padRegNo(m.registration_no || m.reg_no)}</div>`
        const row = rowMap.get(m.id);

        if (!row) {
            // Create new row element
            const newRow = document.createElement('tr')
            newRow.className = `member-row ${isSelected ? 'selected' : ''}`
            newRow.dataset.id = m.id
            const loginAt = formatDate(m.last_login) || '—'
            const loginCount = m.login_count !== undefined && m.login_count !== null ? m.login_count : 0
            newRow.innerHTML = `
                <td class="col-profile"></td>
                <td class="col-reg-no">${padRegNo(m.registration_no || m.reg_no)}</td>
                <td class="col-special desktop-only">${escapeHtml(m.special_id || '—')}</td>
                <td class="col-name">
                    <div class="member-row-name">${escapeHtml(m.name)}</div>
                    <div class="member-row-identifier">${specialIdHtml}</div>
                </td>
                <td class="col-mobile">${mobileCellHtml(m)}</td>
                <td class="col-status"><div class="status-badge status-${escapeHtml(m.status)}">${escapeHtml(m.status)}</div></td>
                <td class="col-last-login">
                    <div class="modified-at-time">${loginAt}</div>
                    <div class="login-count-badge">(${String(loginCount).padStart(2, '0')})</div>
                </td>
                <td class="col-modified">
                    <div class="modified-by-name">${escapeHtml(m.modified_by || m.created_by || '—')}</div>
                    <div class="modified-at-time">${formatDateTime(m.modified_at || m.created_at) || '—'}</div>
                </td>
            `
            updateRow(newRow, m)

            // Insert in correct position
            if (currentRowElement) {
                tbody.insertBefore(newRow, currentRowElement)
            } else {
                tbody.appendChild(newRow)
            }
        } else {
            // Update existing row using helper to keep DOM stable
            updateRow(row, m)

            // Ensure order is correct
            if (currentRowElement !== row) {
                tbody.insertBefore(row, currentRowElement)
            } else {
                currentRowElement = currentRowElement.nextElementSibling
            }

            rowMap.delete(m.id) // Remove from map so we know it's processed
        }
    })

    // Remove rows that are no longer visible
    rowMap.forEach(row => row.remove())

    // Result count (additive; filters own the filter state)
    const countEl = container.querySelector('#members-count')
    if (countEl) {
        const total = getFilteredMembers().length
        const shown = Math.min(visibleMembers.length, total)
        countEl.textContent = total === 0
            ? 'No members match the current filters'
            : `Showing ${shown} of ${total} member${total === 1 ? '' : 's'}`
    }

    // Empty state with clear-filters CTA (event handled by membersFilters)
    let emptyRow = tbody.querySelector('.members-empty-row')
    if (currentFiltered.length === 0) {
        if (!emptyRow) {
            emptyRow = document.createElement('tr')
            emptyRow.className = 'members-empty-row'
            tbody.appendChild(emptyRow)
        }
        emptyRow.innerHTML = `
            <td colspan="8" style="text-align:center; padding: 2.5rem 1rem;">
                <div style="font-size:2rem; margin-bottom:0.5rem;">🔍</div>
                <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.25rem;">No members found</div>
                <div style="font-size:0.82rem; color:var(--text-muted); margin-bottom:1rem;">Try a different search term or clear the filters.</div>
                <button type="button" id="clear-filters-empty" class="action-btn" style="margin:0 auto;">Clear filters</button>
            </td>`
        emptyRow.querySelector('#clear-filters-empty')?.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('members-clear-filters'))
        }, { once: true })
    } else if (emptyRow) {
        emptyRow.remove()
    }

    // Back-to-top button (created once, toggled on scroll)
    if (tableContainer && !tableContainer.querySelector('#members-back-to-top')) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.id = 'members-back-to-top'
        btn.title = 'Back to top'
        btn.setAttribute('aria-label', 'Back to top')
        btn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 15l7-7 7 7"></path></svg>`
        btn.addEventListener('click', () => tableContainer.scrollTo({ top: 0, behavior: 'smooth' }))
        tableContainer.appendChild(btn)
    }

    attachRowListeners(container)

    const indicator = container.querySelector('#infinite-scroll-indicator')
    if (indicator) {
        indicator.style.display = hasMore ? 'block' : 'none'
        indicator.innerHTML = hasMore ? '<div class="spinner"></div> Loading more...' : 'All members loaded.'
        if (!hasMore) indicator.style.display = currentFiltered.length > 50 ? 'block' : 'none'
    }

    if (tableContainer && !tableContainer.dataset.scrollListener) {
        tableContainer.addEventListener('scroll', handleScroll)
        tableContainer.dataset.scrollListener = 'true'
    }
}

let scrollTimeout = null

function handleScroll(e) {
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(() => {
        const el = e.target;
        const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

        if (scrollBottom < 150) {
            const currentFiltered = getFilteredMembers();
            if (visibleLimit < currentFiltered.length) {
                const start = visibleLimit;
                increaseVisibleLimit(50);
                const nextBatch = currentFiltered.slice(start, visibleLimit);

                const tbody = el.querySelector('#members-table-body');
                if (tbody && nextBatch.length > 0) {
                    const padRegNo = (val) => String(val || '').padStart(3, '0');
                    const fragment = document.createDocumentFragment();
                    nextBatch.forEach(m => {
                        const isSelected = selectedIds.has(m.id);
                        const specialIdHtml = m.special_id
                            ? `<div class="member-row-special-id">ID: ${escapeHtml(m.special_id)}</div>`
                            : `<div class="member-row-mobile-reg-no">Reg No: ${padRegNo(m.registration_no || m.reg_no)}</div>`;
                        const tr = document.createElement('tr');
                        tr.className = `member-row ${isSelected ? 'selected' : ''}`;
                        tr.dataset.id = m.id;
                        const loginAt = formatDate(m.last_login) || '—'
                        const loginCount = m.login_count !== undefined && m.login_count !== null ? m.login_count : 0
                        tr.innerHTML = `
                            <td class="col-profile">${getProfileHtml(m)}</td>
                            <td class="col-reg-no">${padRegNo(m.registration_no || m.reg_no)}</td>
                            <td class="col-special desktop-only">${escapeHtml(m.special_id || '—')}</td>
                            <td class="col-name">
                                <div class="member-row-name">${escapeHtml(m.name)}</div>
                                <div class="member-row-identifier">${specialIdHtml}</div>
                            </td>
                            <td class="col-mobile">${mobileCellHtml(m)}</td>
                            <td class="col-status"><div class="status-badge status-${escapeHtml(m.status)}">${escapeHtml(m.status)}</div></td>
                            <td class="col-last-login">
                                <div class="modified-at-time">${loginAt}</div>
                                <div class="login-count-badge">(${String(loginCount).padStart(2, '0')})</div>
                            </td>
                            <td class="col-modified">
                                <div class="modified-by-name">${escapeHtml(m.modified_by || m.created_by || '—')}</div>
                                <div class="modified-at-time">${formatDateTime(m.modified_at || m.created_at) || '—'}</div>
                            </td>
                        `;
                        updateRow(tr, m);
                        fragment.appendChild(tr);
                    });
                    tbody.appendChild(fragment);
                }

                const indicator = document.getElementById('infinite-scroll-indicator');
                if (indicator) {
                    const hasMore = visibleLimit < getFilteredMembers().length;
                    indicator.style.display = hasMore ? 'block' : 'none';
                }

                // Keep the "Showing X of Y" count in sync after appending
                const countEl = document.getElementById('members-count');
                if (countEl) {
                    const total = getFilteredMembers().length;
                    const shown = Math.min(visibleLimit, total);
                    countEl.textContent = `Showing ${shown} of ${total} member${total === 1 ? '' : 's'}`;
                }
            }
        }

        // Back-to-top visibility (independent of infinite-scroll threshold)
        const backBtn = el.querySelector?.('#members-back-to-top');
        if (backBtn) backBtn.classList.toggle('show', el.scrollTop > 400);

        scrollTimeout = null;
    }, 150);
}

function attachRowListeners(container) {
    const tbody = container.querySelector('#members-table-body')
    if (!tbody) return

    // We only attach once, we can check if it's already attached
    if (tbody.dataset.listenersAttached) return
    tbody.dataset.listenersAttached = 'true'

    tbody.addEventListener('click', async (e) => {
        const row = e.target.closest('.member-row')
        if (!row) return

        // Prevent opening modal if they clicked the checkbox, a tel: link,
        // or if they just previewed the image
        if (e.target.closest('.member-chk')) return
        if (e.target.closest('a[data-tel]')) return
        if (e.target.closest('.avatar-container[data-just-previewed="true"]')) return

        const id = row.dataset.id

        if (isSelectionMode) {
            toggleSelection(id)
            renderMembersTable(container)
            window.dispatchEvent(new CustomEvent('members-selection-changed'))
            return
        }

        const { getAllMembers } = await import('./membersState.js')
        const m = getAllMembers().find(m => m.id === id)
        if (m) {
            const { renderMemberModal } = await import('./memberModal.js')
            const { loadSavedSession } = await import('../../services/offlineAuthService.js')
            renderMemberModal(m, loadSavedSession())
        }
    })
}

export function getTableStyles() {
    return `
      <style>
        @media (max-width: 999px) {
          .desktop-only { display: none !important; }
        }

        /* IDs live in their own columns on desktop; the stacked line under
           the name is mobile-only (the Special ID column hides there). */
        @media (min-width: 1000px) {
          .member-row-identifier { display: none !important; }
        }

        .styled-table {
            width: 100%;
            border-collapse: collapse;
            font-family: 'Inter', system-ui, sans-serif;
        }

        /* ── Column header ── */
        .styled-table th {
            background: var(--bg-main) !important;
            color: var(--text-muted) !important;
            font-weight: 700;
            text-transform: uppercase;
            font-size: 0.7rem;
            letter-spacing: 0.08em;
            padding: 0.85rem 1rem;
            text-align: left;
            border-bottom: 2px solid var(--border-light);
            white-space: nowrap;
        }

        /* ── Column widths (th) ── */
        .styled-table th:nth-child(2) { width: 64px; text-align: center; }

        /* ── Cells ── */
        .styled-table td {
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--border-light);
            vertical-align: middle;
        }

        /* ── Avatars ── */
        .col-profile {
            width: 48px;
            padding: 0.5rem 0.5rem !important;
        }
        .avatar-container {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            overflow: hidden;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            border: 1px solid var(--border-light);
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
            margin: 0 auto;
            cursor: pointer;
            /* hover scale lives on the container, not the img, so both types animate */
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .avatar-container:hover {
            transform: scale(1.12);
            box-shadow: 0 6px 14px rgba(0,0,0,0.18);
        }
        .avatar-img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            /* inner-image scale on hover for photo avatars */
            transition: transform 0.2s ease;
        }
        .avatar-container[data-has-image="true"]:hover .avatar-img {
            transform: scale(1.15);
        }
        .avatar-initials {
            color: #ffffff;
            font-weight: 700;
            font-size: 0.85rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            user-select: none;
            -webkit-user-select: none;
        }

        /* ── Image Preview Overlay ── */
        .avatar-preview-overlay {
            position: fixed;
            inset: 0;
            z-index: 9999;
            background: rgba(0,0,0,0.84);
            display: flex;
            align-items: center;
            justify-content: center;
            animation: mdFadeIn 0.18s ease-out;
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
        }
        /* ── Photo preview ── */
        /* Avatar in table is 36px → 4× = 144px natural render target;
           we allow up to viewport bounds so large images stay sharp. */
        .avatar-preview-image-wrap {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1.25rem;
            animation: mdScaleIn 0.22s cubic-bezier(0.34,1.3,0.64,1);
        }
        .avatar-preview-image-wrap img {
            width: min(88vw, 144px * 4);
            max-width: min(88vw, 576px);
            max-height: 80vh;
            object-fit: contain;
            border-radius: 14px;
            box-shadow: 0 24px 80px rgba(0,0,0,0.65);
        }
        /* Row below image: small initials chip + name */
        .avatar-preview-meta {
            display: flex;
            align-items: center;
            gap: 0.65rem;
        }
        .avatar-preview-initials-sm {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8rem;
            font-weight: 800;
            color: #fff;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            flex-shrink: 0;
            border: 2px solid rgba(255,255,255,0.25);
        }
        /* ── Initials-only preview ── */
        .avatar-preview-initials-wrap {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 1rem;
            animation: mdScaleIn 0.22s cubic-bezier(0.34,1.3,0.64,1);
        }
        .avatar-preview-initials-circle {
            /* 4× the 36px table avatar = 144px */
            width: 144px;
            height: 144px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 3.2rem;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            user-select: none;
            box-shadow: 0 16px 60px rgba(0,0,0,0.45);
            border: 3px solid rgba(255,255,255,0.18);
        }
        /* ── Shared name label ── */
        .avatar-preview-name {
            color: rgba(255,255,255,0.92);
            font-size: 1.05rem;
            font-weight: 600;
            letter-spacing: 0.02em;
            text-shadow: 0 1px 6px rgba(0,0,0,0.6);
        }
        @keyframes mdFadeIn  { from { opacity: 0;                    } to { opacity: 1;              } }
        @keyframes mdScaleIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }


        /* ── Reg No cell ── */
        .col-reg-no {
            font-weight: 700;
            color: var(--text-muted);
            font-size: 0.85rem;
            text-align: center;
            font-variant-numeric: tabular-nums;
            letter-spacing: 0.03em;
        }

        /* ── Special ID cell ── */
        .col-special {
            font-weight: 600;
            color: var(--accent-primary);
            font-size: 0.85rem;
            font-variant-numeric: tabular-nums;
            letter-spacing: 0.01em;
            white-space: nowrap;
        }

        /* ── Sortable headers ── */
        .styled-table th[data-sort] {
            cursor: pointer;
            user-select: none;
            -webkit-user-select: none;
        }
        .styled-table th[data-sort]:hover {
            color: var(--text-primary) !important;
        }
        .sort-arrow {
            font-size: 0.65rem;
            margin-left: 0.25rem;
            color: var(--accent-primary);
        }

        /* ── Name cell ── */
        .col-name { min-width: 160px; }
        .member-row-name {
            font-weight: 600;
            color: var(--text-primary);
            font-size: 0.95rem;
            line-height: 1.3;
        }
        .member-row-special-id {
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--accent-primary);
            margin-top: 0.2rem;
            font-variant-numeric: tabular-nums;
            letter-spacing: 0.01em;
        }

        /* ── Mobile cell ── */
        .col-mobile {
            color: var(--text-muted);
            font-size: 0.875rem;
            font-variant-numeric: tabular-nums;
        }
        .col-mobile-link {
            color: inherit;
            text-decoration: none;
            border-bottom: 1px dotted var(--border-medium);
        }
        .col-mobile-link:hover {
            color: var(--accent-primary);
            border-bottom-color: var(--accent-primary);
        }
        .members-empty-row td { background: transparent !important; }
        .members-empty-row .action-btn { display: inline-flex; }

        /* ── Status cell ── */
        .col-status { white-space: nowrap; }

        /* ── Status badges ── */
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            font-size: 0.72rem;
            font-weight: 700;
            padding: 0.3rem 0.8rem;
            border-radius: 999px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }
        .status-badge::before {
            content: '';
            display: inline-block;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: currentColor;
            flex-shrink: 0;
        }
        .status-Active {
            background: var(--success-bg);
            color: var(--success);
            border: 1px solid rgba(22,163,74,0.2);
        }
        .status-Inactive {
            background: var(--warning-bg);
            color: var(--warning);
            border: 1px solid rgba(217,119,6,0.2);
        }
        .status-Suspended {
            background: var(--danger-bg);
            color: var(--danger);
            border: 1px solid rgba(220,38,38,0.2);
        }

        /* ── Zebra striping ── */
        .styled-table tbody tr:nth-child(even) {
            background-color: var(--bg-secondary);
        }

        /* ── Hover ── */
        .styled-table tbody tr {
            transition: background 0.15s ease, border-left-color 0.15s ease;
            border-left: 3px solid transparent;
        }
        .styled-table tbody tr:hover {
            background-color: var(--accent-soft) !important;
            border-left-color: var(--accent-primary);
            cursor: pointer;
        }

        /* ── Selected row ── */
        .styled-table tbody tr.selected {
            background: var(--accent-soft) !important;
            border-left: 3px solid var(--accent-primary);
        }

        /* ── Infinite scroll ── */
        #infinite-scroll-indicator {
            text-align: center;
            padding: 1rem;
            color: var(--text-muted);
            font-size: 0.85rem;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 0.5rem;
        }

        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid var(--border-medium);
            border-top-color: var(--accent-primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Last Login column ── */
        .col-last-login {
            min-width: 130px;
            vertical-align: middle;
            text-align: center;
        }
        .col-last-login .modified-at-time {
            font-size: 0.78rem;
            color: var(--text-primary);
            font-variant-numeric: tabular-nums;
            font-weight: 500;
        }
        .login-count-badge {
            font-size: 0.7rem;
            color: var(--accent-primary);
            font-weight: 700;
            margin-top: 0.2rem;
            font-variant-numeric: tabular-nums;
        }

        /* ── Combined Modified column ── */
        .col-modified {
            min-width: 140px;
            vertical-align: middle;
        }
        .modified-by-name {
            font-size: 0.82rem;
            font-weight: 600;
            color: var(--text-primary);
            line-height: 1.4;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 160px;
        }
        .modified-at-time {
            font-size: 0.72rem;
            color: var(--text-muted);
            font-variant-numeric: tabular-nums;
            margin-top: 0.18rem;
            white-space: nowrap;
        }

        /* ── Mobile cell tweaks ── */
        @media (max-width: 999px) {
            .styled-table th, .styled-table td { padding: 0.9rem 0.75rem; font-size: 0.88rem; }
        }
      </style>
    `
}
