import {
    searchTerm, statusFilter, managerFilter,
    setSearchTerm, setStatusFilter, setManagerFilter, setSortExplicit,
    getAllMembers, getFilteredMembers, applyFilters,
    isSelectionMode, selectedIds, setSelectionMode, deselectAll, usersList,
    setSecondaryView, secondaryView
} from './membersState.js'
import { renderMembersTable } from './membersTable.js'
import { renderMembersStats } from './membersStats.js'
import { hasPermission } from '../../services/permissionService.js'
import { archiveMember, updateMember } from '../../services/dataService.js'
import { escapeHtml, getInitials, getAvatarColor } from '../../utils/formatters.js'
import { showToast } from '../../services/toastService.js'

let searchTimeout = null

/**
 * Handles DOM updates specifically for filters
 */
async function updateFilteredViews(container) {
    applyFilters()

    // Resolve cooperativeId from closest ancestor with data-coop-id (stat card click passes inner .members-page which lacks it)
    const coopEl = container.closest('[data-coop-id]') || container
    const coopId = coopEl.dataset.coopId

    // Resolve user info from the same ancestor — dataset attributes are set on the outer container,
    // not on the inner .members-page element that is sometimes passed (e.g. from stat-card click handler).
    const userEl = container.closest('[data-coop-id]') || container
    const dsUsername = userEl.dataset.username
    const dsPermissions = userEl.dataset.userPermissions
    const dsRole = userEl.dataset.userRole
    const dsIsAdminPre = userEl.dataset.isAdmin === 'true'

    // Update Stats
    const statsContainer = container.querySelector('#members-stats-mount')
    if (statsContainer) {
        try {
            const { countPendingMembershipRequests } = await import('../../services/data/membershipRequests.js')
            const pendingCount = await countPendingMembershipRequests(coopId ?? undefined)
            statsContainer.innerHTML = renderMembersStats(getFilteredMembers(), pendingCount)
        } catch (e) {
            statsContainer.innerHTML = renderMembersStats(getFilteredMembers(), 0)
        }
        // Re-attach progressive listeners (no-op until Phase 4)
        import('./membersStats.js').then(m => m.attachStatsListeners?.(container)).catch(() => {})
    }

    // Update Table or Join Requests view
    if (secondaryView === 'join-requests') {
        try {
            const { renderMembersJoinRequests } = await import('./membersJoinRequests.js')
            const dsIsAdmin = dsIsAdminPre
                || dsRole === 'admin'
                || hasPermission(dsPermissions, 'admin')
                || hasPermission(dsPermissions, 'member_approval')
                || (dsUsername || '').toLowerCase() === 'admin'
            await renderMembersJoinRequests(container, {
                cooperativeId: coopId,
                username: dsUsername,
                role: dsRole,
                permissions: dsPermissions,
                isAdmin: dsIsAdmin,
                userDoc: { id: dsUsername }
            })
        } catch (e) {
            console.warn('[Members] Join requests view failed:', e?.message)
        }
    } else {
        renderMembersTable(container)
    }

    // Update reset button visibility
    const resetBtn = container.querySelector('#search-reset-btn')
    if (resetBtn) {
        resetBtn.style.display = searchTerm ? 'flex' : 'none'
    }

    // Toggle the Clear-filters button when any filter is active
    const clearBtn = container.querySelector('#clear-filters-btn')
    if (clearBtn) {
        const active = Boolean(searchTerm)
            || (typeof statusFilter === 'string' && statusFilter !== 'All Status')
            || (typeof managerFilter === 'string' && managerFilter !== 'All Managers')
        clearBtn.style.display = active ? 'flex' : 'none'
    }

    // Update selection bar
    updateSelectionBar(container)
}

function updateSelectionBar(container) {
    const bar = container.querySelector('#members-selection-bar')
    if (!bar) return

    if (!isSelectionMode || selectedIds.size === 0) {
        bar.style.display = 'none'
        return
    }

    // Resolve user info from ancestor (dataset attrs may live on outer container)
    const userEl = container.closest('[data-coop-id]') || container
    const isAdmin = userEl.dataset.isAdmin === 'true'
        || userEl.dataset.userRole === 'admin'
        || hasPermission(userEl.dataset.userPermissions, 'admin')
        || hasPermission(userEl.dataset.userPermissions, 'member_approval')
        || (userEl.dataset.username || '').toLowerCase() === 'admin'
    const canDelete = isAdmin || hasPermission(userEl.dataset.userPermissions, 'delete_member')
    const canUpdate = isAdmin || hasPermission(userEl.dataset.userPermissions, 'update_member')

    bar.style.display = 'flex'
    bar.innerHTML = `
        <div class="selection-info">
            <strong>${selectedIds.size}</strong> members selected
            <button class="ghost-link" id="cancel-selection-btn">Cancel</button>
        </div>
        <div class="selection-actions">
            ${canUpdate ? `
                <div class="bulk-assign-wrap" style="position: relative;">
                    <button class="action-btn" id="bulk-manager-dropdown-btn">
                        Assign Managers...
                        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="margin-left: 4px;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </button>
                    <div id="bulk-manager-menu" class="dropdown-menu hidden" style="position: absolute; top: 100%; right: 0; margin-top: 8px; width: 300px; background: var(--bg-card); border: 1px solid var(--border-medium); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); z-index: 1100; padding: 0.75rem;">
                        <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); margin-bottom: 0.75rem; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center;">
                            Select Managers
                        </div>
                        
                        <div style="margin-bottom: 0.75rem;">
                            <input type="text" id="mgr-dropdown-search" placeholder="Search managers..." style="width: 100%; padding: 0.4rem; border-radius: 4px; border: 1px solid var(--border-medium); font-size: 0.8rem; background: var(--bg-input); color: var(--text-primary);">
                        </div>

                        <div class="managers-list" style="max-height: 250px; overflow-y: auto; margin-bottom: 0.75rem;">
                            <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem; cursor: pointer; border-radius: 4px;" class="hover-bg">
                                <input type="checkbox" id="bulk-mgr-chk-all">
                                <span style="font-weight: 700; font-size: 0.85rem;">All Managers</span>
                            </label>
                            ${usersList.map(u => {
                                const displayName = u.full_name || u.username;
                                return `
                                <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem; cursor: pointer; border-radius: 4px;" class="hover-bg mgr-item" data-search="${escapeHtml(displayName.toLowerCase())}">
                                    <input type="checkbox" class="bulk-mgr-chk" value="${escapeHtml(u.username)}">
                                    <div style="display: flex; flex-direction: column;">
                                        <span style="font-size: 0.85rem; color: var(--text-primary); font-weight: 500;">${escapeHtml(displayName)}</span>
                                        ${u.full_name ? `<span style="font-size: 0.7rem; color: var(--text-muted);">@${escapeHtml(u.username)}</span>` : ''}
                                    </div>
                                </label>
                            `}).join('')}
                        </div>
                        <div style="display: flex; gap: 0.5rem;">
                            <button class="primary-button" id="apply-bulk-mgr" style="flex: 1; height: 1.85rem; font-size: 0.7rem; border-radius: 999px;">Apply</button>
                            <button class="secondary-button" id="close-bulk-mgr" style="flex: 1; height: 1.85rem; font-size: 0.7rem; border-radius: 999px; background: white; color: black;">Cancel</button>
                        </div>
                    </div>
                </div>
            ` : ''}
            ${canDelete ? `
                <button class="action-btn danger" id="bulk-delete-btn">Archive Selected</button>
            ` : ''}
        </div>
    `

    // Attach Bar Listeners
    bar.querySelector('#cancel-selection-btn')?.addEventListener('click', () => {
        setSelectionMode(false)
        updateFilteredViews(container)
    })

    const dropdownBtn = bar.querySelector('#bulk-manager-dropdown-btn')
    const menu = bar.querySelector('#bulk-manager-menu')
    
    dropdownBtn?.addEventListener('click', (e) => {
        e.stopPropagation()
        menu?.classList.toggle('hidden')
        if (!menu?.classList.contains('hidden')) {
            menu.querySelector('#mgr-dropdown-search')?.focus()
        }
    })

    // Search inside dropdown
    menu?.querySelector('#mgr-dropdown-search')?.addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase()
        menu.querySelectorAll('.mgr-item').forEach(item => {
            const text = item.dataset.search || ''
            item.style.display = text.includes(val) ? 'flex' : 'none'
        })
    })

    // All Managers checkbox
    menu?.querySelector('#bulk-mgr-chk-all')?.addEventListener('change', (e) => {
        menu.querySelectorAll('.bulk-mgr-chk').forEach(cb => {
            cb.checked = e.target.checked
        })
    })

    bar.querySelector('#close-bulk-mgr')?.addEventListener('click', (e) => {
        e.stopPropagation()
        menu?.classList.add('hidden')
    })

    bar.querySelector('#apply-bulk-mgr')?.addEventListener('click', async (e) => {
        e.stopPropagation()
        const selectedMgrs = Array.from(menu.querySelectorAll('.bulk-mgr-chk:checked')).map(cb => cb.value)
        
        if (selectedMgrs.length === 0) {
            showToast("Please select at least one manager.", "warning")
            return
        }

        const newManagerString = selectedMgrs.join(', ')
        
        if (confirm(`Assign managers (${newManagerString}) to ${selectedIds.size} members?`)) {
            const allMembers = getAllMembers()
            const username = container.dataset.username
            const coopId = container.dataset.coopId
            
            let successCount = 0
            let failCount = 0

            // Import necessary services for direct low-level update
            const { saveDoc, enqueueWrite } = await import('../../services/sqliteService.js')
            
            for (const id of selectedIds) {
                const member = allMembers.find(m => m.id === id)
                if (member) {
                    try {
                        const now = new Date().toISOString()
                        // Fast path: Direct low-level SQLite update bypassing validation/notifications
                        const updateData = { 
                            ...member, 
                            account_manager: newManagerString, 
                            cooperative_id: coopId,
                            modified_at: now,
                            modified_by: username,
                            is_synced: 0
                        }
                        
                        // 1. Local Write
                        await saveDoc('members', updateData)
                        
                        // 2. Queue for Sync
                        await enqueueWrite(coopId, 'members', id, 'update', { 
                            account_manager: newManagerString,
                            modified_at: now,
                            modified_by: username,
                            is_synced: 0
                        })
                        
                        successCount++
                    } catch (err) {
                        console.error(`[Bulk Assign] Failed for member ${id}:`, err)
                        failCount++
                    }
                } else {
                    failCount++
                }
            }
            
            showToast(`Operation Complete:\n- ${successCount} members updated successfully\n- ${failCount} members failed`, "success")
            
            setSelectionMode(false)
            window.dispatchEvent(new CustomEvent('refresh-members'))
            const { loadMembersData } = await import('./membersState.js')
            const dsIsAdmin1 = container.dataset.isAdmin === 'true'
                || container.dataset.userRole === 'admin'
                || hasPermission(container.dataset.userPermissions, 'admin')
                || hasPermission(container.dataset.userPermissions, 'member_approval')
                || (container.dataset.username || '').toLowerCase() === 'admin'
            await loadMembersData({ 
                cooperativeId: coopId, 
                username: username, 
                permissions: container.dataset.userPermissions,
                role: container.dataset.userRole,
                isAdmin: dsIsAdmin1
            })
            updateFilteredViews(container)
        }
    })

    bar.querySelector('#bulk-delete-btn')?.addEventListener('click', async () => {
        if (confirm(`Archive ${selectedIds.size} selected members? Their transaction history will be retained.`)) {
            let archivedCount = 0
            let errorCount = 0
            const username = container.dataset.username
            const coopId = container.dataset.coopId

            for (const id of selectedIds) {
                try {
                    await archiveMember(id, username)
                    archivedCount++
                } catch (err) {
                    console.error(`[Bulk Archive] Failed for member ${id}:`, err)
                    errorCount++
                }
            }

            showToast(`Operation Complete:\n- ${archivedCount} members archived\n- ${errorCount} errors encountered`, "success")
            
            setSelectionMode(false)
            const { loadMembersData } = await import('./membersState.js')
            const dsIsAdmin2 = container.dataset.isAdmin === 'true'
                || container.dataset.userRole === 'admin'
                || hasPermission(container.dataset.userPermissions, 'admin')
                || hasPermission(container.dataset.userPermissions, 'member_approval')
                || (container.dataset.username || '').toLowerCase() === 'admin'
            await loadMembersData({ 
                cooperativeId: coopId, 
                username: username, 
                permissions: container.dataset.userPermissions,
                role: container.dataset.userRole,
                isAdmin: dsIsAdmin2
            })
            updateFilteredViews(container)
        }
    })
}

export function renderMembersFilters(container, user) {
    const isAdmin = user.isAdmin
        || user.role === 'admin'
        || hasPermission(user.permissions, 'admin')
        || hasPermission(user.permissions, 'member_approval')
        || user.username?.toLowerCase() === 'admin'
    const canUpdate = isAdmin || hasPermission(user.permissions, 'update_member')
    
    // Store user info for listeners
    container.dataset.username = user.username
    container.dataset.coopId = user.cooperativeId
    container.dataset.userPermissions = user.permissions
    container.dataset.userRole = user.role || ''
    container.dataset.isAdmin = String(isAdmin)

    // Also copy dataset attributes to the inner .members-page element so that callers
    // who query document.querySelector('.members-page') and pass it still work.
    try {
        const innerPage = container.querySelector('.members-page')
        if (innerPage) {
            innerPage.dataset.username = user.username
            innerPage.dataset.coopId = user.cooperativeId
            innerPage.dataset.userPermissions = user.permissions
            innerPage.dataset.userRole = user.role || ''
            innerPage.dataset.isAdmin = String(isAdmin)
        }
    } catch (_) { /* no-op */ }

    // Extract unique managers with safety check (sorted A–Z for scanability)
    const allMembers = getAllMembers()
    const managers = [...new Set(allMembers
        .map(m => String(m.account_manager || ''))
        .filter(Boolean)
        .flatMap(m => m.split(',').map(s => s.trim()))
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    const filtersActive = searchTerm
        || (typeof statusFilter === 'string' && statusFilter !== 'All Status')
        || (typeof managerFilter === 'string' && managerFilter !== 'All Managers')
    
    return `
      <div id="members-selection-bar" class="selection-bar-wrap" style="display: none;"></div>
      <div class="members-filters-row">
          <div class="search-and-selectors">
              <div class="search-input-wrap">
                  <svg class="search-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                  <input type="text" id="member-search-input" placeholder="Search name, mobile, Reg No…" value="${escapeHtml(searchTerm)}">
                  <button id="search-reset-btn" style="display: ${searchTerm ? 'flex' : 'none'};">×</button>
              </div>
              
              <div class="selectors-row">
                  <select id="status-filter" class="adaptive-select">
                      <option value="All Status">Status</option>
                      <option value="Active" ${statusFilter === 'Active' ? 'selected' : ''}>Active</option>
                      <option value="Inactive" ${statusFilter === 'Inactive' ? 'selected' : ''}>Inactive</option>
                      <option value="Suspended" ${statusFilter === 'Suspended' ? 'selected' : ''}>Suspended</option>
                      <option value="Archived" ${statusFilter === 'Archived' ? 'selected' : ''}>Archived</option>
                      <option value="Issues" ${statusFilter === 'Issues' ? 'selected' : ''}>Issues (Inact + Susp)</option>
                  </select>

                  <select id="manager-filter" class="adaptive-select">
                      <option value="All Managers">Manager</option>
                      ${managers.map(m => `<option value="${escapeHtml(m)}" ${managerFilter === m ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                  </select>

                  <div class="action-buttons-group">
                      <button class="action-btn" id="clear-filters-btn" title="Clear search and filters" style="display: ${filtersActive ? 'flex' : 'none'};">Clear</button>
                      <button class="action-btn ${isSelectionMode ? 'active' : ''}" id="toggle-selection-btn" title="Bulk Selection">
                          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path></svg>
                          <span class="btn-text">Select</span>
                      </button>
                      <button class="action-btn" id="export-members-btn" title="Export filtered members to Excel">
                          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                          <span class="btn-text">Export</span>
                      </button>
                      ${canUpdate ? `
                      <button class="action-btn" id="import-members-btn" title="Bulk import members from Excel template">
                          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" d="M12 15v-6m0 0l-3 3m3-3l3 3M5 20h14a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0014.586 3H5a2 2 0 00-2 2v13a2 2 0 002 2z"/><path stroke-width="2" d="M17 8H7"/></svg>
                          <span class="btn-text">Import</span>
                      </button>
                      <button class="action-btn" id="duplicates-btn" title="Review possible duplicate members (same mobile / special ID)">
                          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-width="2" d="M8 7h13M8 12h13M8 17h13M3 7h.01M3 12h.01M3 17h.01"></path></svg>
                          <span class="btn-text">Duplicates</span>
                      </button>
                      ` : ''}
                  </div>
              </div>
          </div>
      </div>
      
      <style>
          .selection-bar-wrap {
              display: none;
              background: var(--bg-sidebar);
              border: 1px solid var(--border-medium);
              border-radius: var(--radius-lg);
              padding: 0.75rem 1.25rem;
              margin-bottom: 0.75rem;
              justify-content: space-between;
              align-items: center;
              animation: slideDown 0.3s ease;
          }
          .selection-info { font-size: 0.9rem; color: var(--text-primary); }
          .ghost-link { background: none; border: none; color: var(--text-muted); text-decoration: underline; cursor: pointer; margin-left: 0.5rem; font-size: 0.8rem; }
          .selection-actions { display: flex; gap: 0.75rem; align-items: center; }
          .action-btn.danger { background: var(--danger-bg); color: var(--danger); border-color: var(--danger); }
          .action-btn.active { background: var(--accent-soft); border-color: var(--accent-primary); color: var(--accent-primary); }

          .dropdown-menu.hidden { display: none !important; }
          .hover-bg:hover { background: var(--bg-secondary); }
          .managers-list::-webkit-scrollbar { width: 6px; }
          .managers-list::-webkit-scrollbar-thumb { background: var(--border-medium); border-radius: 10px; }

          .members-filters-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 0.5rem;
              margin-bottom: 0.75rem;
              background: var(--bg-card);
              padding: 0.5rem;
              border-radius: var(--radius-lg);
              border: 1px solid var(--border-light);
          }
          .search-and-selectors {
              display: flex;
              gap: 0.5rem;
              flex: 1;
              align-items: center;
          }
          .selectors-row {
              display: flex;
              gap: 0.5rem;
              align-items: center;
          }
          .search-input-wrap {
              position: relative;
              flex: 1;
              max-width: 300px;
          }
          .search-input-wrap input {
              width: 100%;
              padding: 0.5rem 2rem;
              border-radius: var(--radius-md);
              border: 1px solid var(--border-medium);
              font-size: 0.85rem;
              outline: none;
              background: var(--bg-input);
              color: var(--text-primary);
          }
          .search-icon {
              position: absolute;
              left: 0.6rem;
              top: 50%;
              transform: translateY(-50%);
              color: var(--text-muted);
          }
          #search-reset-btn {
              position: absolute;
              right: 0.5rem;
              top: 50%;
              transform: translateY(-50%);
              background: var(--border-medium);
              border: none;
              width: 18px;
              height: 18px;
              border-radius: 50%;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              color: var(--text-muted);
              font-size: 1rem;
          }
          .adaptive-select {
              padding: 0.5rem;
              border-radius: var(--radius-md);
              border: 1px solid var(--border-medium);
              font-size: 0.8rem;
              background: var(--bg-input);
              color: var(--text-primary);
              outline: none;
              cursor: pointer;
          }
          .action-buttons-group {
              display: flex;
              gap: 0.4rem;
          }
          .action-btn {
              display: flex;
              align-items: center;
              gap: 0.3rem;
              padding: 0.5rem 0.75rem;
              border-radius: var(--radius-md);
              border: 1px solid var(--border-medium);
              background: var(--bg-card);
              font-size: 0.8rem;
              font-weight: 600;
              color: var(--text-primary);
              cursor: pointer;
              transition: all 0.2s;
          }
          .action-btn:hover {
              background: var(--bg-secondary);
          }
          
          @keyframes slideDown {
              from { transform: translateY(-10px); opacity: 0; }
              to { transform: translateY(0); opacity: 1; }
          }

          @media (max-width: 999px) {
              .members-filters-row {
                  display: none !important;
                  padding: 0.5rem;
                  background: var(--bg-card);
                  border-bottom: 1px solid var(--border-light);
                  animation: slideDown 0.25s ease-out;
              }
              .members-filters-row.show-on-mobile {
                  display: flex !important;
                  flex-direction: column !important;
              }
              .search-and-selectors {
                  display: flex;
                  flex-direction: column;
                  width: 100%;
                  gap: 0.5rem;
              }
              .members-filters-row .search-input-wrap {
                  display: none !important;
              }
              .selectors-row {
                  display: flex;
                  gap: 0.4rem;
                  width: 100%;
                  align-items: center;
              }
              .adaptive-select {
                  flex: 1;
                  min-width: 0;
                  padding: 0.4rem;
                  font-size: 0.75rem;
              }
              .action-buttons-group {
                  display: flex;
                  gap: 0.35rem;
              }
              .action-btn {
                  padding: 0.4rem;
                  min-width: 36px;
                  justify-content: center;
              }
              .btn-text { display: none !important; }
          }    }
      </style>
    `
}

export function attachFiltersListeners(container, user) {
    const searchInput = container.querySelector('#member-search-input')
    const searchInputMobile = document.getElementById('member-search-input-mobile')
    const resetBtn = container.querySelector('#search-reset-btn')

    if (searchInputMobile) {
        searchInputMobile.value = searchTerm
    }

    const handleSearchInput = (val) => {
        setSearchTerm(val)
        if (searchInput) searchInput.value = val
        const currentMobileInput = document.getElementById('member-search-input-mobile')
        if (currentMobileInput) currentMobileInput.value = val
        updateFilteredViews(container)
    }

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            if (searchTimeout) clearTimeout(searchTimeout)
            searchTimeout = setTimeout(() => {
                handleSearchInput(e.target.value)
            }, 300)
        })
    }

    // Set initial value for mobile search if element exists
    const initialMobileInput = document.getElementById('member-search-input-mobile')
    if (initialMobileInput) {
        initialMobileInput.value = searchTerm
    }

    // Clean up old window mobile search listener to prevent stale closure references
    if (window._currentMobileSearchListener) {
        window.removeEventListener('mobile-member-search', window._currentMobileSearchListener)
    }
    window._currentMobileSearchListener = (e) => {
        if (searchTimeout) clearTimeout(searchTimeout)
        searchTimeout = setTimeout(() => {
            handleSearchInput(e.detail.value)
        }, 300)
    }
    window.addEventListener('mobile-member-search', window._currentMobileSearchListener)

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            handleSearchInput('')
            if (searchInput) searchInput.focus()
            const currentMobileInput = document.getElementById('member-search-input-mobile')
            if (currentMobileInput) currentMobileInput.focus()
        })
    }

    const clearAllFilters = () => {
        setSearchTerm('')
        setStatusFilter('All Status')
        setManagerFilter('All Managers')
        const si = container.querySelector('#member-search-input')
        if (si) si.value = ''
        const mi = document.getElementById('member-search-input-mobile')
        if (mi) mi.value = ''
        const sf = container.querySelector('#status-filter')
        if (sf) sf.value = 'All Status'
        const mf = container.querySelector('#manager-filter')
        if (mf) mf.value = 'All Managers'
        updateFilteredViews(container)
    }
    container.querySelector('#clear-filters-btn')?.addEventListener('click', clearAllFilters)

    // Empty-state CTA in the table dispatches this (registered once globally
    // so full re-renders don't stack duplicate window listeners).
    if (!window._membersClearFiltersAttached) {
        window._membersClearFiltersAttached = true
        window.addEventListener('members-clear-filters', () => {
            const root = document.querySelector('#members-table-container')?.closest('div')
            const scope = document.querySelector('.members-page') || root || document
            try {
                setSearchTerm('')
                setStatusFilter('All Status')
                setManagerFilter('All Managers')
                scope.querySelector?.('#member-search-input') && (scope.querySelector('#member-search-input').value = '')
                const mi2 = document.getElementById('member-search-input-mobile')
                if (mi2) mi2.value = ''
                const sf2 = scope.querySelector?.('#status-filter')
                if (sf2) sf2.value = 'All Status'
                const mf2 = scope.querySelector?.('#manager-filter')
                if (mf2) mf2.value = 'All Managers'
                const page = document.querySelector('.members-page')
                if (page) updateFilteredViews(page)
            } catch {}
        })
    }

    // Dropdowns
    container.querySelector('#status-filter')?.addEventListener('change', (e) => {
        setStatusFilter(e.target.value === 'All Status' ? 'All Status' : e.target.value)
        updateFilteredViews(container)
    })
    container.querySelector('#manager-filter')?.addEventListener('change', (e) => {
        setManagerFilter(e.target.value === 'All Managers' ? 'All Managers' : e.target.value)
        updateFilteredViews(container)
    })

    // Toggle Selection Mode
    container.querySelector('#toggle-selection-btn')?.addEventListener('click', () => {
        setSelectionMode(!isSelectionMode)
        updateFilteredViews(container)
        // Update the filter button visual state immediately
        const btn = container.querySelector('#toggle-selection-btn')
        if (btn) btn.classList.toggle('active', isSelectionMode)
    })

    // Replaced (not stacked): this setup re-runs on every members render and
    // the old closure retained the dead container + full member list.
    if (window._membersSelChanged) {
        window.removeEventListener('members-selection-changed', window._membersSelChanged)
    }
    window._membersSelChanged = () => {
        updateSelectionBar(container)
    }
    window.addEventListener('members-selection-changed', window._membersSelChanged)

    // Stat-card shortcuts (dispatched by membersStats; registered once globally)
    if (!window._membersStatFilterAttached) {
        window._membersStatFilterAttached = true
        window.addEventListener('members-stat-filter', (e) => {
            const page = document.querySelector('.members-page')
            if (!page) return
            const stat = e.detail?.stat
            try {
                if (stat === 'join-requests') {
                    setSecondaryView('join-requests')
                    updateFilteredViews(page)
                    return
                }
                setSecondaryView('members')
                let nextStatus = null
                if (stat === 'total') {
                    nextStatus = 'All Status'
                } else if (stat === 'active') {
                    nextStatus = 'Active'
                } else if (stat === 'issues') {
                    nextStatus = 'Issues'
                } else if (stat === 'new') {
                    setSortExplicit('created', 'desc')
                    showToast('Sorted by newest first.', 'success')
                } else {
                    return
                }
                if (nextStatus) {
                    setStatusFilter(nextStatus)
                    const sf = page.querySelector('#status-filter')
                    if (sf) sf.value = nextStatus
                }
                updateFilteredViews(page)
            } catch (err) {
                console.warn('[Members] Stat filter failed:', err?.message)
            }
        })
    }

    // Excel Actions — lazy import keeps dashboard bundle light (ExcelJS ~900KB)
    container.querySelector('#export-members-btn')?.addEventListener('click', async () => {
        try {
            const { showExportModal } = await import('./membersImportExport.js')
            const user = {
                cooperativeId: container.dataset.coopId,
                username: container.dataset.username,
                permissions: container.dataset.userPermissions
            }
            await showExportModal(user)
        } catch (err) {
            showToast('Export failed to open: ' + (err?.message || err), 'error')
        }
    })
    container.querySelector('#import-members-btn')?.addEventListener('click', async () => {
        try {
            const { showImportModal } = await import('./membersImportExport.js')
            const user = {
                cooperativeId: container.dataset.coopId,
                username: container.dataset.username,
                permissions: container.dataset.userPermissions
            }
            await showImportModal(user)
        } catch (err) {
            showToast('Import failed to open: ' + (err?.message || err), 'error')
        }
    })
    container.querySelector('#duplicates-btn')?.addEventListener('click', () => {
        showDuplicateReviewModal(container, user)
    })
}

// Avatar colors shared with table/modal via utils/formatters.js
function dupAvatarColor(name) { return getAvatarColor(name) }

async function showDuplicateReviewModal(container, user) {
    document.getElementById('duplicates-modal')?.remove()
    document.getElementById('dup-modal-style')?.remove()
    const style = document.createElement('style')
    style.id = 'dup-modal-style'
    style.textContent = `
        #duplicates-modal .dup-modal { width: min(100%, 720px); max-height: 88vh; display: flex; flex-direction: column; }
        #duplicates-modal .dup-toolbar { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--border-light); background: var(--bg-card); position: sticky; top: 0; z-index: 2; }
        #duplicates-modal .dup-search { flex: 1; min-width: 180px; padding: 0.5rem 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-medium); background: var(--bg-input); color: var(--text-primary); font-size: 0.82rem; outline: none; }
        #duplicates-modal .dup-pill { border: 1px solid var(--border-medium); background: var(--bg-card); color: var(--text-muted); border-radius: 999px; padding: 0.35rem 0.8rem; font-size: 0.75rem; font-weight: 700; cursor: pointer; }
        #duplicates-modal .dup-pill.active { background: var(--accent-soft); border-color: var(--accent-primary); color: var(--accent-primary); }
        #duplicates-modal .dup-count-badge { background: var(--danger-bg); color: var(--danger); border-radius: 999px; font-size: 0.72rem; font-weight: 800; padding: 0.15rem 0.6rem; }
        #duplicates-modal .dup-body { padding: 1rem 1.25rem; overflow-y: auto; }
        #duplicates-modal .dup-card { border: 1px solid var(--border-light); border-radius: var(--radius-lg); margin-bottom: 0.9rem; overflow: hidden; background: var(--bg-card); }
        #duplicates-modal .dup-card-head { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.85rem; background: var(--bg-secondary); flex-wrap: wrap; }
        #duplicates-modal .dup-type { font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; border-radius: 999px; padding: 0.15rem 0.55rem; }
        #duplicates-modal .dup-type.mobile { background: #fef3c7; color: #92400e; }
        #duplicates-modal .dup-type.special { background: #e0e7ff; color: #3730a3; }
        #duplicates-modal .dup-type.name { background: #dcfce7; color: #166534; }
        #duplicates-modal .dup-type.email { background: #fef9c3; color: #854d0e; }
        #duplicates-modal .dup-type.regno { background: #f3e8ff; color: #6b21a8; }
        #duplicates-modal .dup-key { font-family: monospace; font-weight: 700; font-size: 0.82rem; }
        #duplicates-modal .dup-row { display: flex; gap: 0.7rem; align-items: center; padding: 0.65rem 0.85rem; border-top: 1px solid var(--border-light); cursor: pointer; transition: background 0.15s; }
        #duplicates-modal .dup-row:hover { background: var(--bg-secondary); }
        #duplicates-modal .dup-row.selected { background: var(--accent-soft); }
        #duplicates-modal .dup-avatar { width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 0.78rem; flex-shrink: 0; }
        #duplicates-modal .dup-name { font-weight: 700; font-size: 0.86rem; color: var(--text-primary); }
        #duplicates-modal .dup-meta { font-size: 0.74rem; color: var(--text-muted); margin-top: 1px; }
        #duplicates-modal .dup-chips { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.3rem; }
        #duplicates-modal .dup-chip { font-size: 0.68rem; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px; padding: 0.1rem 0.5rem; color: var(--text-muted); }
        #duplicates-modal .dup-radio { width: 18px; height: 18px; accent-color: var(--accent-primary); flex-shrink: 0; }
        #duplicates-modal .dup-card-foot { display: flex; justify-content: space-between; align-items: center; gap: 0.6rem; padding: 0.6rem 0.85rem; border-top: 1px solid var(--border-light); background: var(--bg-card); flex-wrap: wrap; }
        #duplicates-modal .dup-hint { font-size: 0.72rem; color: var(--text-muted); }
        #duplicates-modal .dup-merge-btn { background: var(--accent-primary); color: #fff; border: none; border-radius: 999px; padding: 0.45rem 1.1rem; font-size: 0.78rem; font-weight: 700; cursor: pointer; }
        #duplicates-modal .dup-merge-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        #duplicates-modal .dup-merge-btn.confirm { background: var(--danger); }
        #duplicates-modal .dup-skel { border: 1px solid var(--border-light); border-radius: var(--radius-lg); padding: 0.85rem; margin-bottom: 0.75rem; background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-card) 50%, var(--bg-secondary) 75%); background-size: 200% 100%; animation: dupShimmer 1.2s infinite; height: 74px; }
        @keyframes dupShimmer { to { background-position: -200% 0; } }
        #duplicates-modal .dup-empty { text-align: center; padding: 2.5rem 1rem; }
        #duplicates-modal .dup-empty-icon { width: 56px; height: 56px; border-radius: 50%; background: #dcfce7; color: #15803d; display: grid; place-items: center; margin: 0 auto 0.75rem; font-size: 1.5rem; font-weight: 800; }
        @media (max-width: 640px) { #duplicates-modal .dup-modal { width: 100%; max-height: 94vh; } }
    `
    document.head.appendChild(style)

    const overlay = document.createElement('div')
    overlay.id = 'duplicates-modal'
    overlay.className = 'modal-overlay open'
    overlay.innerHTML = `
      <div class="modal-content dup-modal">
        <div class="modal-header">
            <div>
                <div style="display:flex; align-items:center; gap:0.5rem;">
                    <h3 style="margin:0; color:var(--text-primary); font-size:1.05rem;">Possible duplicates</h3>
                    <span class="dup-count-badge" id="dup-count" style="display:none;"></span>
                </div>
                <p style="font-size:0.78rem; color:var(--text-muted); margin:0.2rem 0 0;">Same mobile, Special ID, name, email, or registration number in this cooperative. Choose the member to keep, then review transactions before merging; duplicate members are archived.</p>
            </div>
            <button class="modal-close" id="dup-close" aria-label="Close">✕</button>
        </div>
        <div class="dup-toolbar">
            <input class="dup-search" id="dup-search" placeholder="Search name, reg no, mobile…">
            <button class="dup-pill active" data-f="all">All</button>
            <button class="dup-pill" data-f="mobile">Mobile</button>
            <button class="dup-pill" data-f="special_id">Special ID</button>
            <button class="dup-pill" data-f="name">Name</button>
            <button class="dup-pill" data-f="email">Email</button>
            <button class="dup-pill" data-f="registration_no">Reg No</button>
        </div>
        <div class="modal-body dup-body" id="dup-body"></div>
      </div>`
    document.body.appendChild(overlay)
    const close = () => { overlay.remove(); style.remove(); document.removeEventListener('keydown', onKey) }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    overlay.querySelector('#dup-close')?.addEventListener('click', close)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

    const body = overlay.querySelector('#dup-body')
    const countBadge = overlay.querySelector('#dup-count')
    const searchInput = overlay.querySelector('#dup-search')
    let groups = []
    let filter = 'all'
    let term = ''
    const selections = new Map() // gi -> survivorId

    body.innerHTML = `<div class="dup-skel"></div><div class="dup-skel"></div><div class="dup-skel"></div>`

    const defaultSurvivor = (members) => [...members].sort((a, b) =>
        String(a.created_at || '').localeCompare(String(b.created_at || '')))[0]

    function render() {
        const visible = groups.map((g, gi) => ({ g, gi })).filter(({ g }) => {
            if (filter !== 'all' && g.type !== filter) return false
            if (!term) return true
            const hay = g.members.map(m => `${m.first_name || ''} ${m.last_name || ''} ${m.registration_no || ''} ${m.mobile || ''} ${m.special_id || ''}`.toLowerCase()).join(' ')
            return term.split(/\s+/).every(t => hay.includes(t))
        })
        const totalDupes = visible.reduce((n, { g }) => n + g.members.length, 0)
        countBadge.style.display = groups.length ? '' : 'none'
        countBadge.textContent = groups.length ? `${groups.length} groups • ${totalDupes} records` : ''
        if (!visible.length) {
            body.innerHTML = groups.length
                ? `<div class="dup-empty"><div class="dup-empty-icon">∅</div><div style="font-weight:700;">No matches for this filter</div><div class="dup-hint">Try a different search or tab.</div></div>`
                : `<div class="dup-empty"><div class="dup-empty-icon">✓</div><div style="font-weight:700;">All clear — no duplicates</div><div class="dup-hint">Mobile, Special IDs, names, emails, and registration numbers are unique in this cooperative.</div></div>`
            return
        }
        body.innerHTML = visible.map(({ g, gi }) => {
            const survivor = selections.get(gi) || defaultSurvivor(g.members)?.id
            if (!selections.has(gi) && survivor) selections.set(gi, String(survivor))
            const sel = selections.get(gi)
            return `
            <div class="dup-card" data-gi="${gi}">
                <div class="dup-card-head">
                    <span class="dup-type ${g.type === 'mobile' ? 'mobile' : g.type === 'special_id' ? 'special' : g.type === 'name' ? 'name' : g.type === 'email' ? 'email' : 'regno'}">${g.type === 'mobile' ? 'Mobile' : g.type === 'special_id' ? 'Special ID' : g.type === 'name' ? 'Name' : g.type === 'email' ? 'Email' : 'Reg No'}</span>
                    <span class="dup-key">${escapeHtml(g.key)}</span>
                    <span class="dup-hint">${g.members.length} records — tap one to keep</span>
                </div>
                ${g.members.map(m => {
                    const name = `${m.first_name || ''} ${m.last_name || ''}`.trim() || 'Unnamed'
                    const isSel = String(m.id) === String(sel)
                    return `
                    <label class="dup-row ${isSel ? 'selected' : ''}" data-pick="${escapeHtml(String(m.id))}" data-gi="${gi}">
                        <input type="radio" class="dup-radio" name="dup-${gi}" ${isSel ? 'checked' : ''}>
                        <span class="dup-avatar" style="background:${dupAvatarColor(name)}">${escapeHtml(getInitials(name))}</span>
                        <span style="flex:1; min-width:0;">
                            <span class="dup-name">${escapeHtml(name)}</span>
                            <span class="dup-meta">Reg ${escapeHtml(String(m.registration_no ?? '—'))} • ${escapeHtml(m.mobile || '—')} • ${escapeHtml(m.special_id || '—')}</span>
                            <span class="dup-chips">
                                <span class="dup-chip">${escapeHtml(m.status || 'Active')}</span>
                                ${m.created_at ? `<span class="dup-chip">Joined ${escapeHtml(String(m.created_at).slice(0, 10))}</span>` : ''}
                                ${m.created_by ? `<span class="dup-chip">by ${escapeHtml(String(m.created_by))}</span>` : ''}
                            </span>
                        </span>
                    </label>`
                }).join('')}
                <div class="dup-card-foot">
                    <span class="dup-hint">All remaining transactions transfer to the member you keep.</span>
                    <button class="dup-merge-btn" data-merge="${gi}">Review &amp; merge</button>
                </div>
            </div>`
        }).join('')

        body.querySelectorAll('[data-pick]').forEach(row => {
            row.addEventListener('click', (e) => {
                e.preventDefault()
                selections.set(Number(row.dataset.gi), String(row.dataset.pick))
                render()
            })
        })
        body.querySelectorAll('[data-merge]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const gi = Number(btn.dataset.merge)
                const group = groups[gi]
                const survivorId = selections.get(gi)
                if (!group || !survivorId) return
                btn.disabled = true
                try {
                    const result = await showDuplicateMergeDialog(group, survivorId, user)
                    if (!result) { btn.disabled = false; return }
                    showToast(`Members merged. ${result.deletedRemittanceIds.length} duplicate transaction(s) and linked children removed; remaining history moved to the survivor.`, 'success')
                    const { findDuplicateMembers } = await import('../../services/dataService.js')
                    groups = await findDuplicateMembers(user.cooperativeId)
                    selections.clear()
                    render()
                    const { loadMembersData } = await import('./membersState.js')
                    await loadMembersData(user)
                    updateFilteredViews(container)
                    if (!groups.length) setTimeout(close, 900)
                } catch (err) {
                    showToast('Merge blocked: ' + err.message, 'error')
                    btn.disabled = false
                }
            })
        })
    }

    overlay.querySelectorAll('.dup-pill').forEach(p => {
        p.addEventListener('click', () => {
            overlay.querySelectorAll('.dup-pill').forEach(x => x.classList.remove('active'))
            p.classList.add('active')
            filter = p.dataset.f
            render()
        })
    })
    searchInput?.addEventListener('input', (e) => {
        term = String(e.target.value || '').trim().toLowerCase()
        render()
    })
    setTimeout(() => searchInput?.focus(), 100)

    try {
        const { findDuplicateMembers } = await import('../../services/dataService.js')
        groups = await findDuplicateMembers(user.cooperativeId)
        render()
    } catch (err) {
        body.innerHTML = `<div style="color:var(--danger); padding:1rem;">Scan failed: ${escapeHtml(err.message)}</div>`
    }
}


async function showDuplicateMergeDialog(group, survivorId, user) {
    const survivor = group.members.find(m => String(m.id) === String(survivorId))
    if (!survivor) throw new Error('Choose a member to keep before merging.')
    const memberIds = new Set(group.members.map(m => String(m.id)))
    const memberName = (m) => [m.first_name, m.middle_name, m.last_name].filter(Boolean).join(' ') || m.name || String(m.id)
    const { fetchRemittances } = await import('../../services/dataService.js')
    const all = await fetchRemittances(user.cooperativeId, null)
    const transactions = (all || []).filter(r => memberIds.has(String(r.member_id)) && Number(r.autogen) !== 1)
    transactions.sort((a, b) => String(b.remittance_date || b.created_at || '').localeCompare(String(a.remittance_date || a.created_at || '')))

    return new Promise((resolve) => {
        const overlay = document.createElement('div')
        overlay.className = 'modal-overlay open'
        overlay.style.zIndex = '1200'
        overlay.innerHTML = `
          <div class="modal-content" style="width:min(760px,96vw);max-height:90vh;display:flex;flex-direction:column;">
            <div class="modal-header">
              <div><h3>Review member merge</h3><p style="margin:.25rem 0 0;color:var(--text-muted);font-size:.8rem;">Keeping <strong>${escapeHtml(memberName(survivor))}</strong>. Unchecked transactions are kept and reassigned; check only duplicate transactions to remove.</p></div>
              <button type="button" class="modal-close" data-close aria-label="Close">✕</button>
            </div>
            <div style="padding:.75rem 1.1rem;color:var(--text-muted);font-size:.78rem;border-bottom:1px solid var(--border-light);">Deleting a parent transaction also cascade-deletes its remittance details, loans, guarantors, and generated child transactions. Automatically generated children are handled with their parent.</div>
            <div style="padding:.5rem 1.1rem;overflow:auto;flex:1;">
              ${transactions.length ? transactions.map(r => {
                  const owner = group.members.find(m => String(m.id) === String(r.member_id))
                  const date = String(r.remittance_date || r.created_at || '').slice(0, 10) || 'No date'
                  const amount = Number(r.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  return `<label style="display:flex;align-items:flex-start;gap:.7rem;padding:.7rem .3rem;border-bottom:1px solid var(--border-light);cursor:pointer;">
                    <input type="checkbox" class="merge-delete-remittance" value="${escapeHtml(String(r.id))}" style="margin-top:.25rem;accent-color:var(--danger);">
                    <span style="flex:1;min-width:0;"><strong>${escapeHtml(date)} · ${escapeHtml(String(r.bank_name || ''))} · ${escapeHtml(String(r.transaction_type || 'Transaction'))}</strong><span style="display:block;font-size:.75rem;color:var(--text-muted);">${escapeHtml(memberName(owner))} · ₦${escapeHtml(amount)} · ${escapeHtml(String(r.description || 'No description'))} · Ref ${escapeHtml(String(r.id))}</span></span>
                    <span style="font-size:.72rem;font-weight:700;color:var(--danger);white-space:nowrap;">Mark duplicate to delete</span>
                  </label>`
              }).join('') : '<div style="padding:1.5rem;text-align:center;color:var(--text-muted);">No parent remittances found. The member records can still be merged.</div>'}
            </div>
            <div class="modal-footer"><button type="button" class="secondary-button" data-cancel>Cancel</button><button type="button" class="primary-button" data-confirm>Merge members and keep history</button></div>
          </div>`
        document.body.appendChild(overlay)
        let finished = false
        const finish = (value) => { if (finished) return; finished = true; overlay.remove(); resolve(value) }
        overlay.querySelector('[data-close]')?.addEventListener('click', () => finish(null))
        overlay.querySelector('[data-cancel]')?.addEventListener('click', () => finish(null))
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null) })
        overlay.querySelector('[data-confirm]')?.addEventListener('click', async (e) => {
            const button = e.currentTarget
            const duplicateIds = Array.from(overlay.querySelectorAll('.merge-delete-remittance:checked')).map(input => input.value)
            if (duplicateIds.length && !confirm(`Permanently mark ${duplicateIds.length} selected duplicate transaction(s) deleted? Linked child transactions will be deleted too.`)) return
            button.disabled = true
            button.textContent = 'Merging…'
            try {
                const { mergeDuplicateMembers } = await import('../../services/dataService.js')
                const loserIds = group.members.filter(m => String(m.id) !== String(survivorId)).map(m => String(m.id))
                const result = await mergeDuplicateMembers(survivorId, loserIds, user.username, duplicateIds)
                finish(result)
            } catch (err) {
                showToast('Merge failed: ' + (err?.message || err), 'error')
                button.disabled = false
                button.textContent = 'Try again'
            }
        })
    })
}
