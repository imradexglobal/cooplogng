import { escapeHtml, escapeAttribute, getInitials, getAvatarColor, formatDate } from '../../utils/formatters.js'
import { hasPermission } from '../../services/permissionService.js'
import { showToast } from '../../services/toastService.js'
import { listMembershipRequests, approveMembershipRequest, declineMembershipRequest, approveAndActivateMembershipRequest, countPendingMembershipRequests } from '../../services/data/membershipRequests.js'
import { secondaryView, setSecondaryView } from './membersState.js'
import { renderMembersStats } from './membersStats.js'

let jrSortKey = 'created_at'
let jrSortDir = 'desc'

function setJrSort(key) {
    if (jrSortKey === key) {
        jrSortDir = jrSortDir === 'asc' ? 'desc' : 'asc'
    } else {
        jrSortKey = key
        jrSortDir = 'asc'
    }
}

function sortRows(rows) {
    const dir = jrSortDir === 'desc' ? -1 : 1
    const key = jrSortKey
    const copy = [...rows]
    copy.sort((a, b) => {
        let va = ''
        let vb = ''
        switch (key) {
            case 'created_at':
                va = a.created_at || ''
                vb = b.created_at || ''
                break
            case 'name':
                va = `${a.last_name || ''} ${a.first_name || ''} ${a.middle_name || ''}`.trim().toLowerCase()
                vb = `${b.last_name || ''} ${b.first_name || ''} ${b.middle_name || ''}`.trim().toLowerCase()
                break
            case 'mobile':
                va = String(a.mobile || '').trim()
                vb = String(b.mobile || '').trim()
                break
            case 'status':
                va = String(a.status || 'Pending').toLowerCase()
                vb = String(b.status || 'Pending').toLowerCase()
                break
            default:
                return 0
        }
        // Natural string cmp with empties last
        const ae = !va
        const be = !vb
        if (ae && be) return 0
        if (ae) return 1
        if (be) return -1
        if (key === 'created_at') {
            const ta = Date.parse(va) || 0
            const tb = Date.parse(vb) || 0
            if (ta === 0 || tb === 0) return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir
            return (ta - tb) * dir
        }
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir
    })
    return copy
}

function statusPill(status) {
    const s = String(status || 'Pending')
    const color = s === 'Approved' ? 'var(--success)' : s === 'Declined' ? 'var(--danger)' : '#d97706'
    const bg = s === 'Approved' ? 'var(--success-bg)' : s === 'Declined' ? 'var(--danger-bg)' : '#fef3c7'
    return `<span style="display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 700; color: ${color}; background: ${bg};">${escapeHtml(s)}</span>`
}

function photoCell(row) {
    const name = `${row.last_name || ''} ${row.first_name || ''}`.trim()
    if (row.image_path) {
        return `<div class="jr-avatar-wrap" data-preview-src="${escapeAttribute(row.image_path)}" data-preview-name="${escapeAttribute(name)}" style="width: 36px; height: 36px; border-radius: 50%; cursor: pointer;">
            <img src="${row.image_path}" style="width: 36px; height: 36px; border-radius: 50%; object-fit: cover; display: block;" alt="${escapeAttribute(name)}" loading="lazy" draggable="false" />
        </div>`
    }
    const initials = getInitials(name)
    const color = getAvatarColor(name)
    return `<div class="jr-avatar-wrap" data-preview-src="" data-preview-name="${escapeAttribute(name)}" style="width: 36px; height: 36px; border-radius: 50%; background: ${color}; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; cursor: pointer;" title="View photo">
        ${escapeHtml(initials)}
    </div>`
}

function hideJrAvatarPreview() {
    document.getElementById('jr-avatar-preview-overlay')?.remove()
}

function showJrAvatarPreview(src, name) {
    hideJrAvatarPreview()
    const overlay = document.createElement('div')
    overlay.className = 'avatar-preview-overlay'
    overlay.id = 'jr-avatar-preview-overlay'
    const initials = getInitials(name || '')
    const color = getAvatarColor(name || '')
    overlay.innerHTML = src
        ? `<div class="avatar-preview-image-wrap">
               <img src="${src}" alt="${escapeHtml(name || '')}" draggable="false">
               <div class="avatar-preview-meta">
                   <div class="avatar-preview-initials-sm" style="background:${color}">${escapeHtml(initials)}</div>
                   <div class="avatar-preview-name">${escapeHtml(name || '')}</div>
               </div>
           </div>`
        : `<div class="avatar-preview-initials-wrap">
               <div class="avatar-preview-initials-circle" style="background-color: ${color};">${escapeHtml(initials)}</div>
               <div class="avatar-preview-name">${escapeHtml(name || '')}</div>
           </div>`
    overlay.addEventListener('click', hideJrAvatarPreview)
    document.body.appendChild(overlay)
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') {
            hideJrAvatarPreview()
            document.removeEventListener('keydown', onKey)
        }
    })
}

function buildJoinRequestsHtml({ rows, isAdmin, error }) {
    const sortedRows = sortRows(rows)
    const arrow = (col) => jrSortKey === col ? (jrSortDir === 'asc' ? ' ▲' : ' ▼') : ''

    const tableHtml = error
        ? `<div style="padding: 2rem; text-align: center; color: var(--danger);">${escapeHtml(error)}</div>`
        : rows.length === 0
            ? `<div style="padding: 3rem 1rem; text-align: center; color: var(--text-muted);">
                <div style="font-size: 2rem; margin-bottom: 0.5rem;">🤝</div>
                <div style="font-weight: 700; color: var(--text-primary);">No join requests</div>
                <div style="font-size: 0.8rem;">New membership applications will appear here for review.</div>
            </div>`
            : `<table class="styled-table jr-table">
                <thead>
                    <tr style="position: sticky; top: 0; background: var(--bg-main); z-index: 10;">
                        <th data-sort="created_at" style="width: 120px; min-width: 110px; cursor: pointer; user-select: none;">Request Date<span class="sort-arrow">${arrow('created_at')}</span></th>
                        <th data-sort="name" style="width: auto; cursor: pointer; user-select: none;">Name<span class="sort-arrow">${arrow('name')}</span></th>
                        <th data-sort="mobile" style="width: 130px; min-width: 120px; cursor: pointer; user-select: none;">Mobile<span class="sort-arrow">${arrow('mobile')}</span></th>
                        <th style="width: 56px; min-width: 56px;">Photo</th>
                        <th style="width: 32%; min-width: 200px;">Address</th>
                        <th data-sort="status" style="width: 100px; min-width: 95px; cursor: pointer; user-select: none;">Status<span class="sort-arrow">${arrow('status')}</span></th>
                        ${isAdmin ? '<th style="width: 200px; min-width: 180px;">Actions</th>' : ''}
                    </tr>
                </thead>
                <tbody>
                    ${sortedRows.map(row => {
                        const name = `${row.last_name || ''} ${row.first_name || ''} ${row.middle_name || ''}`.trim()
                        const address = String(row.address || '')
                        const dateStr = row.created_at ? formatDate(row.created_at) : '—'
                        return `
                        <tr class="jr-row" data-request-id="${escapeAttribute(row.id)}">
                            <td class="jr-cell jr-cell-date">${escapeHtml(dateStr)}</td>
                            <td class="jr-cell jr-cell-name">${escapeHtml(name)}</td>
                            <td class="jr-cell jr-cell-mobile">${row.mobile ? `<a href="tel:${escapeHtml(String(row.mobile).replace(/\s+/g, ''))}" style="color: inherit; text-decoration: none;">${escapeHtml(row.mobile)}</a>` : '—'}</td>
                            <td class="jr-cell jr-cell-photo">${photoCell(row)}</td>
                            <td class="jr-cell jr-cell-address">${escapeHtml(address || '—')}</td>
                            <td class="jr-cell jr-cell-status">${statusPill(row.status)}</td>
                            ${isAdmin ? `
                            <td class="jr-cell jr-cell-actions">
                                <div class="jr-actions-wrap">
                                    <button class="jr-action-btn jr-approve-btn" data-approve="${escapeAttribute(row.id)}" title="Approve join request">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                        <span>Approve</span>
                                    </button>
                                    <button class="jr-action-btn jr-activate-btn" data-activate="${escapeAttribute(row.id)}" title="Approve and activate subscription (1 year)">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                                        <span>Accept & Activate</span>
                                    </button>
                                    <button class="jr-action-btn jr-decline-btn" data-decline="${escapeAttribute(row.id)}" title="Decline join request">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                        <span>Decline</span>
                                    </button>
                                </div>
                            </td>
                            ` : `
                            <td class="jr-cell jr-cell-actions">
                                <span class="jr-admin-only" title="Only admins can approve/decline join requests">🔒 Admin only</span>
                            </td>
                            `}
                        </tr>
                        `}).join('')}
                </tbody>
            </table>
            <style>
                .jr-table {
                    width: 100%;
                    table-layout: auto;
                }
                .jr-table thead th {
                    font-size: 0.7rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--text-muted);
                }
                .jr-table thead th:hover {
                    color: var(--text-primary);
                }
                .sort-arrow {
                    font-size: 0.65rem;
                    margin-left: 0.25rem;
                    color: var(--accent-primary);
                }
                .jr-row .jr-cell {
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    vertical-align: middle;
                    padding: 0.55rem 0.6rem;
                }
                .jr-row .jr-cell-address {
                    white-space: normal;
                    word-wrap: break-word;
                    overflow-wrap: anywhere;
                    line-height: 1.4;
                    font-size: 0.78rem;
                    color: var(--text-muted);
                }
                .jr-row .jr-cell-name {
                    white-space: normal;
                    word-wrap: break-word;
                    overflow-wrap: anywhere;
                    line-height: 1.3;
                }
                .jr-cell-date {
                    font-size: 0.78rem;
                    color: var(--text-muted);
                    font-variant-numeric: tabular-nums;
                }
                .jr-cell-name {
                    font-weight: 600;
                    color: var(--text-primary);
                    font-size: 0.85rem;
                }
                .jr-cell-mobile {
                    font-size: 0.82rem;
                    font-variant-numeric: tabular-nums;
                }
                .jr-cell-mobile a:hover {
                    color: var(--accent-primary);
                }
                .jr-cell-photo {
                    padding: 0.3rem 0.5rem;
                }
                .jr-avatar-wrap {
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                }
                .jr-avatar-wrap:hover {
                    transform: scale(1.08);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
                }
                .jr-actions-wrap {
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                    flex-wrap: wrap;
                    justify-content: flex-start;
                }
                .jr-action-btn {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 0.3rem;
                    padding: 0.38rem 0.7rem;
                    border-radius: var(--radius-md, 8px);
                    font-size: 0.76rem;
                    font-weight: 700;
                    border: 1.5px solid transparent;
                    cursor: pointer;
                    transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
                    white-space: nowrap;
                    line-height: 1.2;
                    letter-spacing: 0.01em;
                }
                .jr-action-btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                    transform: none !important;
                }
                .jr-approve-btn {
                    background: var(--success-bg, #dcfce7);
                    color: var(--success, #15803d);
                    border-color: color-mix(in srgb, var(--success, #15803d) 30%, transparent);
                }
                .jr-approve-btn:hover:not(:disabled) {
                    background: var(--success, #15803d);
                    color: #fff;
                    border-color: var(--success, #15803d);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 10px rgba(21, 128, 61, 0.25);
                }
                .jr-approve-btn:active:not(:disabled) {
                    transform: translateY(0);
                }
                .jr-decline-btn {
                    background: var(--danger-bg, #fee2e2);
                    color: var(--danger, #b91c1c);
                    border-color: color-mix(in srgb, var(--danger, #b91c1c) 30%, transparent);
                }
                .jr-decline-btn:hover:not(:disabled) {
                    background: var(--danger, #b91c1c);
                    color: #fff;
                    border-color: var(--danger, #b91c1c);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 10px rgba(185, 28, 28, 0.25);
                }
                .jr-decline-btn:active:not(:disabled) {
                    transform: translateY(0);
                }
                .jr-activate-btn {
                    background: var(--warning-bg, #fef3c7);
                    color: var(--warning, #d97706);
                    border-color: color-mix(in srgb, var(--warning, #d97706) 30%, transparent);
                }
                .jr-activate-btn:hover:not(:disabled) {
                    background: var(--warning, #d97706);
                    color: #fff;
                    border-color: var(--warning, #d97706);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 10px rgba(217, 119, 6, 0.25);
                }
                .jr-activate-btn:active:not(:disabled) {
                    transform: translateY(0);
                }
                .jr-admin-only {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25rem;
                    padding: 0.3rem 0.55rem;
                    border-radius: var(--radius-md, 8px);
                    background: var(--bg-elevated, #f8fafc);
                    border: 1px dashed var(--border-medium);
                    font-size: 0.72rem;
                    font-weight: 600;
                    color: var(--text-muted);
                }
                @media (max-width: 720px) {
                    .jr-table thead th {
                        font-size: 0.65rem;
                    }
                    .jr-row .jr-cell {
                        padding: 0.5rem 0.45rem;
                    }
                    .jr-cell-name { font-size: 0.82rem; }
                    .jr-cell-date, .jr-cell-mobile { font-size: 0.75rem; }
                    .jr-actions-wrap {
                        gap: 0.3rem;
                        flex-direction: row;
                        align-items: stretch;
                    }
                    .jr-action-btn {
                        padding: 0.45rem 0.55rem;
                        font-size: 0.72rem;
                        flex: 1 1 auto;
                        min-width: 0;
                    }
                    .jr-action-btn span {
                        display: none;
                    }
                    .jr-action-btn svg {
                        width: 16px;
                        height: 16px;
                    }
                    .jr-admin-only {
                        font-size: 0.68rem;
                        padding: 0.25rem 0.45rem;
                    }
                }
                @media (min-width: 1100px) {
                    .jr-row .jr-cell {
                        padding: 0.6rem 0.7rem;
                    }
                    .jr-action-btn {
                        padding: 0.45rem 0.9rem;
                        font-size: 0.8rem;
                    }
                }
            </style>`

    return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.25rem 0.25rem 0.5rem;">
            <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">Join Requests</div>
            <button type="button" class="action-btn" id="join-requests-back-btn" style="font-size: 0.72rem; padding: 0.3rem 0.7rem;">← Back to Members</button>
        </div>
        <div class="table-container" style="flex: 1; overflow-y: auto; border-radius: var(--radius-lg); background: var(--bg-card); border: 1px solid var(--border-light);">
            ${tableHtml}
        </div>
    `
}

export async function renderMembersJoinRequests(container, user) {
    const reviewerId = user.userDoc?.id || user.username
    const coopId = user.cooperativeId

    // Fallback: if user.permissions is missing/empty, try container dataset.
    if ((!user.permissions || user.permissions === '') && container.dataset.userPermissions && container.dataset.userPermissions !== 'undefined' && container.dataset.userPermissions !== '') {
        user.permissions = container.dataset.userPermissions
    }
    const isAdmin = user.isAdmin
        || user.role === 'admin'
        || hasPermission(user.permissions, 'admin')
        || hasPermission(user.permissions, 'member_approval')
        || user.username?.toLowerCase() === 'admin'

    let rows = []
    let error = ''

    async function loadRows() {
        try {
            rows = await listMembershipRequests(coopId, 'All')
            error = ''
        } catch (err) {
            console.error('[JoinRequests] Load failed:', err)
            error = err?.message || 'Failed to load join requests'
            rows = []
        }
    }

    function render() {
        container.innerHTML = buildJoinRequestsHtml({ rows, isAdmin, error })
        bindEvents()
    }

    function bindEvents() {
        container.querySelector('#join-requests-back-btn')?.addEventListener('click', () => {
            setSecondaryView('members')
            window.dispatchEvent(new CustomEvent('members-view-change'))
        })

        // Sort headers
        const thead = container.querySelector('.jr-table thead')
        if (thead && !thead.dataset.jrSortAttached) {
            thead.dataset.jrSortAttached = 'true'
            thead.addEventListener('click', (e) => {
                const th = e.target.closest('th[data-sort]')
                if (!th) return
                setJrSort(th.dataset.sort)
                render()
            })
        }

        // Avatar preview
        container.querySelectorAll('.jr-avatar-wrap').forEach(el => {
            const src = el.dataset.previewSrc
            const name = el.dataset.previewName
            el.style.cursor = 'pointer'
            el.title = 'View photo'
            el.addEventListener('click', (ev) => {
                ev.stopPropagation()
                showJrAvatarPreview(src, name)
            })
        })

        container.querySelectorAll('[data-approve]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const requestId = btn.dataset.approve
                if (!window.confirm('Approve this join request? A new member record will be created with default password 123456, and the applicant will be able to sign in.')) return
                btn.disabled = true
                try {
                    await approveMembershipRequest(requestId, reviewerId)
                    showToast('Member approved and created.', 'success')
                    await loadRows()
                    await refreshStats()
                    render()
                } catch (err) {
                    console.error('[JoinRequests] Approve failed:', err)
                    showToast(err?.message || 'Approval failed.', 'error')
                    btn.disabled = false
                }
            })
        })

        container.querySelectorAll('[data-decline]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const requestId = btn.dataset.decline
                const reason = window.prompt('Decline this join request? Enter a reason (optional):', '') || ''
                if (reason === null) return
                btn.disabled = true
                try {
                    await declineMembershipRequest(requestId, reviewerId, reason.trim())
                    showToast('Request declined.', 'warning')
                    await loadRows()
                    await refreshStats()
                    render()
                } catch (err) {
                    console.error('[JoinRequests] Decline failed:', err)
                    showToast(err?.message || 'Decline failed.', 'error')
                    btn.disabled = false
                }
            })
        })

        container.querySelectorAll('[data-activate]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const requestId = btn.dataset.activate
                if (!window.confirm('Approve and activate this join request? A new member record will be created with default password 123456, subscription set to ACTIVE for 1 year, and the applicant will be able to sign in immediately.')) return
                btn.disabled = true
                try {
                    await approveAndActivateMembershipRequest(requestId, reviewerId)
                    showToast('Member approved, activated (1 year), and created.', 'success')
                    await loadRows()
                    await refreshStats()
                    render()
                } catch (err) {
                    console.error('[JoinRequests] Activate failed:', err)
                    showToast(err?.message || 'Activation failed.', 'error')
                    btn.disabled = false
                }
            })
        })
    }

    async function refreshStats() {
        try {
            const page = document.querySelector('.members-page')
            if (!page) return
            const statsMount = page.querySelector('#members-stats-mount')
            if (statsMount) {
                const { getFilteredMembers } = await import('./membersState.js')
                const pendingCount = await countPendingMembershipRequests(coopId)
                statsMount.innerHTML = renderMembersStats(getFilteredMembers(), pendingCount)
                const statsMod = await import('./membersStats.js')
                statsMod.attachStatsListeners?.(page)
            }
        } catch (err) {
            console.warn('[JoinRequests] Stats refresh failed:', err?.message)
        }
    }

    await loadRows()
    render()
}
