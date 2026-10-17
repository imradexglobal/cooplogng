import { fetchAllMembers, fetchCooperativeUsers, fetchEnterprises } from '../../services/dataService.js'
import { save as persistState, load as loadPersisted } from '../../services/statePersistence.js'
import { hasPermission } from '../../services/permissionService.js'

// Global state for the members module instance
let _allMembers = []
let _filteredMembers = []
export let usersList = []
export let enterpriseList = []

export const getAllMembers = () => _allMembers
export const getFilteredMembers = () => _filteredMembers

// Pagination state
export let visibleLimit = 50

// Restore persisted filter/sort state (survives F5)
const _saved = loadPersisted('members-state') || {}

// Filter state
export let searchTerm = _saved.searchTerm || ""
export let statusFilter = _saved.statusFilter || "All Status"
export let managerFilter = _saved.managerFilter || "All Managers"

// Column-sort state. Default 'reg' = Reg No, then Special ID (ascending).
export let sortKey = _saved.sortKey || "reg"
export let sortDir = _saved.sortDir || "asc"

const sortVal = (m, key) => {
    switch (key) {
        case 'reg': return String(m.registration_no ?? m.reg_no ?? '').trim()
        case 'special': return String(m.special_id ?? '').trim()
        case 'name': return String(m.name ?? '').trim()
        case 'mobile': return String(m.mobile ?? '').trim()
        case 'status': return String(m.status ?? '').trim()
        case 'last_login': return m.last_login ?? ''
        case 'login_count': return String(m.login_count ?? 0).padStart(6, '0')
        case 'modified': return m.modified_at ?? m.created_at ?? ''
        default: return ''
    }
}

// Natural order (2 before 10), empties always last in both directions.
const cmpNatural = (a, b, dir) => {
    const ae = !a
    const be = !b
    if (ae && be) return 0
    if (ae) return 1
    if (be) return -1
    const r = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    return dir === 'desc' ? -r : r
}

const cmpDate = (a, b, dir) => {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    const ae = isNaN(ta)
    const be = isNaN(tb)
    if (ae && be) return 0
    if (ae) return 1
    if (be) return -1
    return dir === 'desc' ? tb - ta : ta - tb
}

function _saveFilterState() {
    persistState('members-state', { searchTerm, statusFilter, managerFilter, sortKey, sortDir })
}

export function applySort() {
    const dateKey = sortKey === 'last_login' || sortKey === 'modified'
    _filteredMembers.sort((ma, mb) => {
        let r = dateKey
            ? cmpDate(sortVal(ma, sortKey), sortVal(mb, sortKey), sortDir)
            : cmpNatural(sortVal(ma, sortKey), sortVal(mb, sortKey), sortDir)
        if (r === 0 && sortKey === 'reg') r = cmpNatural(sortVal(ma, 'special'), sortVal(mb, 'special'), sortDir)
        if (r === 0) r = cmpNatural(sortVal(ma, 'name'), sortVal(mb, 'name'), sortDir)
        return r
    })
}

// Explicit sort setter (used by stats shortcuts; no toggle surprises).
export function setSortExplicit(key, dir = 'asc') {
    if (!key) return
    sortKey = key
    sortDir = dir === 'desc' ? 'desc' : 'asc'
    applySort()
    _saveFilterState()
}

// Header click: same column toggles A-Z/Z-A, new column starts at A-Z.
export function setSort(key) {
    if (!key) return
    if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
        sortKey = key
        sortDir = 'asc'
    }
    applySort()
    _saveFilterState()
}

// Selection state
export let isSelectionMode = false
export let selectedIds = new Set()

// Secondary view toggle: 'members' (default table) | 'join-requests'
export let secondaryView = 'members'
export function setSecondaryView(v) { secondaryView = v }

export function setSelectionMode(val) {
    isSelectionMode = val
    if (!val) selectedIds.clear()
}

export function toggleSelection(id) {
    if (selectedIds.has(id)) selectedIds.delete(id)
    else selectedIds.add(id)
}

export function selectAllFiltered() {
    _filteredMembers.forEach(m => selectedIds.add(m.id))
}

export function deselectAll() {
    selectedIds.clear()
}

/**
 * Loads all required initial data from Firebase/SQLite.
 */
export async function loadMembersData(user) {
    const isAdmin = user.isAdmin
        || user.role === 'admin'
        || hasPermission(user.permissions, 'admin')
        || hasPermission(user.permissions, 'member_approval')
        || user.username?.toLowerCase() === 'admin'
    
    // Run all fetches in parallel for speed
    const [members, users, enterprises] = await Promise.all([
        fetchAllMembers(user.cooperativeId, user.username, isAdmin),
        fetchCooperativeUsers(user.cooperativeId),
        fetchEnterprises(user.cooperativeId, true)
    ])

    _allMembers = members || []
    usersList = users || []
    enterpriseList = enterprises || []
    
    // Sort by Reg No, then Special ID (natural order: 2 before 10).
    // Members missing an ID sort last rather than floating to the top.
    const idRank = (m) => {
        const reg = String(m.registration_no ?? m.reg_no ?? '').trim()
        const sid = String(m.special_id ?? '').trim()
        return { reg, sid }
    }
    const cmpId = (a, b) => {
        if (!a && !b) return 0
        if (!a) return 1
        if (!b) return -1
        return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    }
    _allMembers.sort((a, b) => {
        const ra = idRank(a)
        const rb = idRank(b)
        return cmpId(ra.reg, rb.reg) || cmpId(ra.sid, rb.sid) || (a.name || '').localeCompare(b.name || '')
    })
    
    applyFilters()
}

/**
 * Applies the current search, status, and quick filters to compute filteredMembers.
 */
export function applyFilters() {
    const s = searchTerm.toLowerCase()
    
    _filteredMembers = _allMembers.filter(m => {
        // 1. Status Dropdown Filter ('Issues' pseudo-status = Inactive OR Suspended)
        const matchesStatus = statusFilter === "All Status"
            || (statusFilter === "Issues" && (m.status === "Inactive" || m.status === "Suspended"))
            || m.status === statusFilter
        if (!matchesStatus) return false

        // 2. Manager Dropdown Filter
        let matchesManager = managerFilter === "All Managers"
        if (!matchesManager) {
            const currentManagers = String(m.account_manager || "").split(',').map(s => s.trim().toLowerCase())
            matchesManager = currentManagers.includes(managerFilter.toLowerCase())
        }
        if (!matchesManager) return false

        // 3. Search Term — token-based LIKE search.
        // Each space-separated word must appear somewhere in the member's data (AND logic).
        // e.g. typing "John Lagos" returns members named John who live in Lagos.
        if (s) {
            const SKIP_FIELDS = new Set([
                'id', 'cooperative_id', 'image_path', 'signature_path',
                'password_hash', 'is_synced', 'is_deleted', 'sync_at',
                'deleted_at', 'device_id', 'latitude', 'longitude',
                'account_balance', 'account_balance_total'
            ])
            const searchable = Object.entries(m)
                .filter(([k, v]) =>
                    !SKIP_FIELDS.has(k) &&
                    v !== null && v !== undefined &&
                    typeof v !== 'object'
                )
                .map(([, v]) => String(v).toLowerCase())
                .join(' ')

            // Split input into individual tokens and require ALL to match
            const tokens = s.trim().split(/\s+/).filter(Boolean)
            const allMatch = tokens.every(token => searchable.includes(token))
            if (!allMatch) return false
        }

        return true
    })

    applySort()
    
    // Reset pagination to first batch when filters change
    visibleLimit = 50
    _saveFilterState()
}

export function setSearchTerm(term) { searchTerm = term }
export function setStatusFilter(status) { statusFilter = status }
export function setManagerFilter(manager) { managerFilter = manager }
export function increaseVisibleLimit(amount = 50) { visibleLimit += amount }

export function clearMembersState() {
    searchTerm = ""
    statusFilter = "All Status"
    managerFilter = "All Managers"
    sortKey = "reg"
    sortDir = "asc"
    visibleLimit = 50
    persistState('members-state', { searchTerm, statusFilter, managerFilter, sortKey, sortDir })
}
