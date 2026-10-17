import { renderMembersFilters, attachFiltersListeners } from './membersFilters.js'
import { renderMembersTable, getTableStyles } from './membersTable.js'
import { renderMembersJoinRequests } from './membersJoinRequests.js'
import { hasPermission } from '../../services/permissionService.js'
import { showWorkspaceSpinner } from '../../components/workspaceSpinner.js'
import { countPendingMembershipRequests } from '../../services/data/membershipRequests.js'
import { secondaryView } from './membersState.js'

export async function renderMembersPage(container, user) {
    const isAdmin = user.isAdmin
        || user.role === 'admin'
        || hasPermission(user.permissions, 'admin')
        || hasPermission(user.permissions, 'member_approval')
        || user.username?.toLowerCase() === 'admin'
    const canCreate = isAdmin || hasPermission(user.permissions, 'create_member')

    // 1. Check if page scaffold is already rendered (prevents sync flickering)
    const existingPage = container.querySelector('.members-page')
    if (existingPage) {
        try {
            const { applyFilters, getFilteredMembers } = await import('./membersState.js')
            const statsMod = await import('./membersStats.js')

            // Re-apply current search/filters
            applyFilters()

            // Update stats
            const statsContainer = container.querySelector('#members-stats-mount')
            if (statsContainer) {
                let pendingCount = 0
                try {
                    pendingCount = await countPendingMembershipRequests(user.cooperativeId)
                } catch (e) {
                    console.warn('[MembersPage] countPendingMembershipRequests failed:', e?.message)
                }
                statsContainer.innerHTML = statsMod.renderMembersStats(getFilteredMembers(), pendingCount)
                statsMod.attachStatsListeners?.(container)
            }

            // Diff-render the table or join-requests view
            if (secondaryView === 'join-requests') {
                await renderMembersJoinRequests(container, user)
            } else {
                renderMembersTable(container)
            }
            return
        } catch (err) {
            console.error("[MembersPage] Silent Refresh Error, falling back to full render:", err)
        }
    }

    // 2. Initial Scaffold (spinner first — data load below can be slow)
    showWorkspaceSpinner(container);
    container.innerHTML = `
      ${getTableStyles()}
      <style>
          .members-page {
              width: 100%;
              height: calc(100vh - 4px); /* Full height minus minor buffer */
              display: flex;
              flex-direction: column;
              position: relative;
              font-family: 'Inter', system-ui, sans-serif;
              animation: fadeIn 0.3s ease-out;
              padding: 1.5rem;
              background: var(--bg-main);
              overflow: hidden; /* Only internal containers scroll */
          }
          
          .members-sticky-header {
              position: sticky;
              top: 0;
              z-index: 100;
              background: var(--bg-main);
              padding-bottom: 0.25rem;
          }

          .members-stats-grid {
              display: grid;
              grid-template-columns: repeat(5, 1fr);
              gap: 0.6rem;
              margin-top: 0.6rem;
          }
          .members-stats-grid .stat-card {
              background: var(--bg-card);
              border: 1px solid var(--border-light);
              border-radius: var(--radius-lg);
              padding: 0.65rem 0.9rem;
              box-shadow: var(--shadow-sm);
              min-width: 0;
          }
          .members-stats-grid .stat-label {
              font-size: 0.68rem;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.07em;
              color: var(--text-muted);
          }
          .members-stats-grid .stat-value {
              font-size: 1.25rem;
              font-weight: 800;
              color: var(--text-primary);
              font-variant-numeric: tabular-nums;
              line-height: 1.2;
          }
          .members-stats-grid .stat-sub {
              font-size: 0.68rem;
              color: var(--text-muted);
              font-weight: 600;
              margin-top: 0.15rem;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
          }
          .members-stats-grid .stat-card[data-stat] {
              cursor: pointer;
              transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
          }
          .members-stats-grid .stat-card[data-stat]:hover {
              transform: translateY(-1px);
              box-shadow: var(--shadow-md, var(--shadow-sm));
              border-color: var(--border-medium);
          }
          .members-stats-grid .stat-card[data-stat].active {
              border-color: var(--accent-primary);
              box-shadow: 0 0 0 2px var(--accent-soft);
          }
          .members-stats-grid .stat-card[data-stat]:focus-visible {
              outline: 2px solid var(--accent-primary);
              outline-offset: 2px;
          }
          @media (max-width: 999px) {
              .members-stats-grid { gap: 0.4rem; grid-template-columns: repeat(3, 1fr); }
              .members-stats-grid .stat-card { padding: 0.5rem 0.6rem; border-radius: var(--radius-md); }
              .members-stats-grid .stat-value { font-size: 1.05rem; }
          }

          .members-content-area {
              flex: 1;
              width: 100%;
              display: flex;
              flex-direction: column;
              margin-top: 0.5rem;
              min-height: 0; /* Allow flex shrinking */
              overflow: hidden;
          }

          .table-container {
              flex: 1;
              overflow-y: auto;
              border-radius: var(--radius-lg);
              background: var(--bg-card);
              border: 1px solid var(--border-light);
              box-shadow: var(--shadow-sm);
              scrollbar-width: thin;
              scrollbar-color: var(--border-medium) transparent;
              position: relative;
          }
          .members-count {
              font-size: 0.75rem;
              color: var(--text-muted);
              font-weight: 600;
              padding: 0.15rem 0.25rem 0.4rem;
              font-variant-numeric: tabular-nums;
          }
          #members-back-to-top {
              position: sticky;
              bottom: 1rem;
              margin-left: calc(100% - 3rem);
              width: 2.25rem;
              height: 2.25rem;
              border-radius: 50%;
              border: 1px solid var(--border-medium);
              background: var(--bg-card);
              color: var(--text-primary);
              box-shadow: var(--shadow-lg);
              display: none;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              z-index: 20;
          }
          #members-back-to-top.show { display: inline-flex; }
          .table-container::-webkit-scrollbar { width: 6px; }
          .table-container::-webkit-scrollbar-thumb { background: var(--border-medium); border-radius: 10px; }

          .fab-container {
              position: fixed;
              bottom: 2rem;
              right: 2rem;
              z-index: 100;
          }
          
          .fab {
              width: 56px;
              height: 56px;
              border-radius: 50%;
              background: var(--accent-primary);
              color: var(--text-inverse);
              border: none;
              box-shadow: var(--shadow-lg);
              display: flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          }
          .fab:hover {
              background: var(--accent-hover);
              transform: scale(1.08);
          }

          /* Mobile filter toggle: hidden on desktop, reveals the filter panel */
          #members-filter-toggle { display: none; }
          @media (max-width: 999px) {
              .members-page {
                padding: 0 !important;
                padding-top: 0.25rem !important;
                height: 100% !important;
                overflow: hidden;
              }
              .members-sticky-header { padding-bottom: 0; }
              .members-content-area { margin-top: 0; }
              .table-container {
                border-radius: 0;
                border: none;
                box-shadow: none;
                background: transparent;
              }
              .fab-container { display: none !important; }
              /* Audit columns crowd small screens — name/mobile/status stay.
                 (Full card layout deferred as follow-up; see Phase 7 notes.) */
              .styled-table th[data-sort="last_login"],
              .styled-table th[data-sort="modified"],
              .styled-table td.col-last-login,
              .styled-table td.col-modified { display: none !important; }
              #members-filter-toggle {
                  display: inline-flex;
                  align-items: center;
                  gap: 0.4rem;
                  margin: 0.4rem 0.5rem 0;
                  padding: 0.45rem 0.9rem;
                  border-radius: 999px;
                  border: 1px solid var(--border-medium);
                  background: var(--bg-card);
                  color: var(--text-primary);
                  font-size: 0.78rem;
                  font-weight: 700;
                  cursor: pointer;
                  align-self: flex-start;
              }
              #members-filter-toggle[aria-expanded="true"] {
                  background: var(--accent-soft);
                  border-color: var(--accent-primary);
                  color: var(--accent-primary);
              }
              #members-count { padding-left: 0.75rem; }
          }
      </style>

      <div class="members-page">
          <div class="members-sticky-header">
              <div id="members-filters-mount"></div>
              <div id="members-stats-mount"></div>
          </div>

          <button type="button" id="members-filter-toggle" aria-expanded="false" aria-controls="members-filters-mount">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"></path></svg>
              Filters
          </button>
          <div class="members-content-area">
              <div id="members-count" class="members-count" aria-live="polite"></div>
              <div class="table-container" id="members-table-container">
                  <table class="styled-table">
        <thead>
            <tr style="position: sticky; top: 0; background: var(--bg-main); z-index: 10;">
            <th class="col-profile"></th>
            <th class="col-reg-no" data-sort="reg" style="width: 55px; text-align: center;">Reg No<span class="sort-arrow"></span></th>
            <th class="desktop-only" data-sort="special">Special ID<span class="sort-arrow"></span></th>
            <th data-sort="name">Name<span class="sort-arrow"></span></th>
            <th class="col-mobile" data-sort="mobile">Mobile<span class="sort-arrow"></span></th>
            <th data-sort="status">Status<span class="sort-arrow"></span></th>
            <th data-sort="last_login" style="width: 160px;">Last Login<span class="sort-arrow"></span></th>
            <th data-sort="modified">Last Modified<span class="sort-arrow"></span></th>
        </tr>
        </thead>
        <tbody id="members-table-body"></tbody>
    </table>
    <div id="infinite-scroll-indicator"></div>
</div>
</div>

          <div class="fab-container">
              ${canCreate ? `
              <button type="button" class="fab" id="fab-add-btn" title="Add Member">
                  <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"></path></svg>
              </button>
              ` : ''}
          </div>
      </div>
    `

        // 2. Component Rendering
        try {
            const filtersMount = container.querySelector('#members-filters-mount')
            if (filtersMount) {
                filtersMount.innerHTML = renderMembersFilters(container, user)
                attachFiltersListeners(container, user)
            }
            // Render stats on first paint (data already loaded by index.js).
            // Silent-refresh path above handles subsequent updates.
            try {
                const { getFilteredMembers } = await import('./membersState.js')
                const statsMod2 = await import('./membersStats.js')
                const statsMount = container.querySelector('#members-stats-mount')
                if (statsMount) {
                    let pendingCount = 0
                    try {
                        pendingCount = await countPendingMembershipRequests(user.cooperativeId)
                    } catch (e) {
                        console.warn('[MembersPage] countPendingMembershipRequests failed:', e?.message)
                    }
                    statsMount.innerHTML = statsMod2.renderMembersStats(getFilteredMembers(), pendingCount)
                    statsMod2.attachStatsListeners?.(container)
                }
            } catch (e) {
                console.warn('[MembersPage] Stats render skipped:', e?.message)
            }
        } catch (err) {
            console.error("[MembersPage] Render Error:", err)
            const errorMsg = document.createElement('div')
            errorMsg.style.color = 'red'
            errorMsg.style.padding = '1rem'
            errorMsg.innerText = "Error rendering components: " + err.message
            container.prepend(errorMsg)
        }

        container.querySelector('#fab-add-btn')?.addEventListener('click', () => {
            window.location.hash = 'members/add'
        })

        // Mobile filter panel toggle (desktop button stays hidden via CSS;
        // the panel itself is governed by .show-on-mobile in membersFilters).
        container.querySelector('#members-filter-toggle')?.addEventListener('click', (e) => {
            const btn = e.currentTarget
            const panel = container.querySelector('.members-filters-row')
            const expanded = btn.getAttribute('aria-expanded') === 'true'
            btn.setAttribute('aria-expanded', String(!expanded))
            panel?.classList.toggle('show-on-mobile', !expanded)
        })

        // Listen for view changes dispatched by the join-requests view
        if (!window._membersViewChangeAttached) {
            window._membersViewChangeAttached = true
            window.addEventListener('members-view-change', () => {
                const page = document.querySelector('.members-page')
                if (page) {
                    renderMembersPage(page, user)
                }
            })
        }


    try {
        if (secondaryView === 'join-requests') {
            await renderMembersJoinRequests(container, user)
        } else {
            renderMembersTable(container)
        }
    } catch (err) {
        console.error("[MembersPage] Table Render Error:", err)
    }
}
