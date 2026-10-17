import { getAllItems, getAllByIndex } from '../indexedDbService.js'
import { getLocalDateString } from './helpers.js'

async function _attachNestedRemittanceData(remittances) {
    if (!remittances || remittances.length === 0) return
    const allDetails = await getAllItems('remittance_detail')
    const allLoans = await getAllItems('loans')
    const allGuarantors = await getAllItems('loan_guarantors')

    const detailsMap = {}
    for (const d of allDetails) {
        if (!d.is_deleted) {
            if (!detailsMap[d.remittance_id]) detailsMap[d.remittance_id] = []
            detailsMap[d.remittance_id].push(d)
        }
    }

    const loansMap = {}
    const guarantorsMap = {}
    for (const g of allGuarantors) {
        if (!g.is_deleted) {
            if (!guarantorsMap[g.loan_id]) guarantorsMap[g.loan_id] = []
            guarantorsMap[g.loan_id].push(g)
        }
    }
    for (const l of allLoans) {
        if (!l.is_deleted) {
            if (!loansMap[l.remittance_id]) loansMap[l.remittance_id] = []
            l.guarantors = guarantorsMap[l.id] || []
            loansMap[l.remittance_id].push(l)
        }
    }

    for (const rem of remittances) {
        rem.details = detailsMap[rem.id] || []
        rem.loans = loansMap[rem.id] || []
    }
}

/**
 * Load the members directory ONCE for the staff RBAC branch
 * (previously re-read per remittance: O(R x M)). Returns null when the
 * caller's RBAC path doesn't need it (admin / memberId / member / no user).
 */
async function preloadMembersForRBAC(user, coopShortName) {
    if (!user) return null
    const _role = (user.role || '').toLowerCase()
    const _username = (user.username || '').trim().toLowerCase()
    const _isAdmin = _role === 'admin' || (user.permissions || '').includes('admin') || _username === 'admin' || _username === (coopShortName || '').toLowerCase()
    const _hasTarget = user.memberId && user.memberId !== '0000000000'
    if (_isAdmin || _hasTarget || _role === 'member') return null
    try {
        return await getAllItems('members')
    } catch (e) {
        return []
    }
}

function applyRBAC(user, tableAlias = 'r', preloadedMembers = null, coopShortName) {
    if (!user) return { filter: () => true }
    const role = (user.role || '').toLowerCase()
    const username = (user.username || '').trim().toLowerCase()
    const isAdmin = role === 'admin' || (user.permissions || '').includes('admin') || username === 'admin' || username === (coopShortName || '').toLowerCase()
    const isMember = role === 'member'
    const targetMemberId = (user.memberId && user.memberId !== '0000000000') ? String(user.memberId) : null

    if (isAdmin) return { filter: () => true }
    if (targetMemberId) {
        return { filter: (item) => String(item.member_id) === targetMemberId }
    }
    if (isMember) {
        return { filter: (item) => String(item.member_id) === String(user.memberId) }
    }

    const _rawRights = user.enterprises || user.enterprise_rights || ''
    const entIds = Array.isArray(_rawRights)
        ? _rawRights.map(String)
        : String(_rawRights).split(',').map(s => s.trim()).filter(Boolean)
    const hasAllEnts = entIds.some(id => id.toLowerCase() === 'all')

    const perms = String(user.permissions || '').toLowerCase()
    const canReadCoop = perms.includes('admin') || perms.includes('read_coop_ledger') || perms.includes('*')

    // Members directory is loaded ONCE by the caller (not per remittance).
    // Same predicate as before, just against the preloaded list.
    const findMember = (memberId) => {
        if (!preloadedMembers) return null
        const key = String(memberId).trim()
        return preloadedMembers.find(m => String(m.id).trim() === key) || null
    }

    return {
        filter: async (item) => {
            if (item.member_id === '0000000000') return canReadCoop
            if (hasAllEnts) return true
            if (entIds.length === 0) return false
            const member = findMember(item.member_id)
            if (member && member.account_manager) {
                const managers = String(member.account_manager).split(',').map(s => s.trim().toLowerCase())
                if (managers.includes(username)) return true
            }
            const details = item.details || []
            if (details.length > 0) {
                return details.some(d => entIds.includes(String(d.enterprise_id)))
            }
            return true
        }
    }
}

export async function getRemittances(cooperativeId, user = null) {
    let remittances
    try {
        remittances = await getAllByIndex('remittance', 'cooperative_id', String(cooperativeId))
        if (!remittances || remittances.length === 0) {
            const all = await getAllItems('remittance')
            if (all.length > 0) {
                remittances = all.filter(r => r.cooperative_id === String(cooperativeId))
            }
        }
    } catch (e) {
        const all = await getAllItems('remittance')
        remittances = all.filter(r => r.cooperative_id === String(cooperativeId))
    }
    remittances = remittances.filter(r => !r.is_deleted)

    // Preload the members directory ONCE for the staff RBAC branch below
    // (previously it was re-read per remittance: O(R x M)).
    const preloadedMembers = await preloadMembersForRBAC(user, user?.coopShortName)
    const rbac = applyRBAC(user, 'r', preloadedMembers, user?.coopShortName)
    if (user) {
        const filtered = []
        for (const rem of remittances) {
            if (await rbac.filter(rem)) filtered.push(rem)
        }
        remittances = filtered
    }

    remittances.sort((a, b) => {
        const dateStrA = getLocalDateString(a.remittance_date)
        const dateStrB = getLocalDateString(b.remittance_date)

        const dateCmp = dateStrB.localeCompare(dateStrA)
        if (dateCmp !== 0) return dateCmp

        // Ordering follows creation time, then id as final tiebreak.
        const createdCmp = String(b.created_at || '').localeCompare(String(a.created_at || ''))
        if (createdCmp !== 0) return createdCmp
        return String(b.id).localeCompare(String(a.id))
    })

    if (remittances.length > 0) {
        await _attachNestedRemittanceData(remittances)
    }
    return remittances
}

function buildRemittanceFilter(items, options, memberMap = {}) {
    if (!options) return items
    let filtered = [...items]

    if (options.status && options.status !== 'All') {
        filtered = filtered.filter(r => String(r.status).toLowerCase() === String(options.status).toLowerCase())
    }
    if (options.bank && options.bank !== 'All') {
        filtered = filtered.filter(r => r.bank_name === options.bank)
    }
    if (options.transactionType && options.transactionType !== 'All') {
        filtered = filtered.filter(r => r.transaction_type === options.transactionType)
    }
    if (options.memberId && options.memberId !== 'All') {
        filtered = filtered.filter(r => r.member_id === String(options.memberId))
    }
    if (options.minAmount !== null && options.minAmount !== undefined) {
        filtered = filtered.filter(r => Number(r.amount) >= Number(options.minAmount))
    }
    if (options.maxAmount !== null && options.maxAmount !== undefined) {
        filtered = filtered.filter(r => Number(r.amount) <= Number(options.maxAmount))
    }
    
    if (options.dateRange && options.dateRange !== 'All' && options.dateRange !== 'All Time' && options.dateRange !== 'Custom') {
        const now = new Date()
        let start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        let end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        if (options.dateRange === 'Today') {
        } else if (options.dateRange === 'This Week') {
            const day = start.getDay()
            const diff = start.getDate() - day + (day === 0 ? -6 : 1)
            start.setDate(diff)
        } else if (options.dateRange === 'This Month') {
            start.setDate(1)
        } else if (options.dateRange === 'This Year') {
            start.setMonth(0, 1)
        }
        
        const toLocalISODate = (d) => {
            const z = n => ('0' + n).slice(-2)
            return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`
        }
        
        const sDate = toLocalISODate(start)
        const eDate = toLocalISODate(end)
        
        if (!options.dateFrom) options.dateFrom = sDate
        if (!options.dateTo) options.dateTo = eDate
    }

    if (options.dateFrom) {
        const fromDateStr = options.dateFrom.includes('T') ? options.dateFrom : `${options.dateFrom}T00:00:00.000Z`;
        filtered = filtered.filter(r => {
            const rDate = String(r.remittance_date || '');
            const compareDate = rDate.includes('T') ? rDate : `${rDate}T00:00:00.000Z`;
            return compareDate >= fromDateStr;
        });
    }
    if (options.dateTo) {
        const toDateStr = options.dateTo.includes('T') ? options.dateTo : `${options.dateTo}T23:59:59.999Z`;
        filtered = filtered.filter(r => {
            const rDate = String(r.remittance_date || '');
            const compareDate = rDate.includes('T') ? rDate : `${rDate}T00:00:00.000Z`;
            return compareDate <= toDateStr;
        });
    }
    
    if (options.searchTerm) {
        const rawTerm = String(options.searchTerm).toLowerCase()
        const term = rawTerm.trim()
        
        const cleanTerm = term.replace(/,/g, '')
        const numTermMatch = parseFloat(cleanTerm)

        let dateTerm = null;
        let pd = new Date(term);
        if (!isNaN(pd.getTime())) {
            dateTerm = pd.toISOString().split('T')[0];
        } else {
            const digits = term.replace(/[^0-9]/g, '');
            if (digits.length === 8) {
                pd = new Date(`${digits.slice(4,8)}-${digits.slice(2,4)}-${digits.slice(0,2)}`);
                if (!isNaN(pd.getTime())) dateTerm = pd.toISOString().split('T')[0];
            }
        }

        const searchColumn = options.searchColumn || 'All Columns'
        if (searchColumn === 'Remittance ID') {
            filtered = filtered.filter(r => String(r.id).toLowerCase().includes(term))
        } else if (searchColumn === 'Member Number') {
            filtered = filtered.filter(r => String(r.member_id || '').toLowerCase().includes(term))
        } else if (searchColumn === 'Member Name') {
            filtered = filtered.filter(r => {
                const member = memberMap[String(r.member_id)]
                if (member) {
                    const searchable = [
                        member.name,
                        member.first_name,
                        member.last_name,
                        member.middle_name
                    ].filter(Boolean).join(' ').toLowerCase()
                    return searchable.includes(term)
                }
                const m = r.member_name ? r.member_name.toLowerCase() : ''
                return m.includes(term)
            })
        } else if (searchColumn === 'Special ID') {
            filtered = filtered.filter(r => {
                const member = memberMap[String(r.member_id)]
                if (member && member.special_id) {
                    return String(member.special_id).toLowerCase().includes(term)
                }
                return false
            })
        } else if (searchColumn === 'Mobile') {
            filtered = filtered.filter(r => {
                const member = memberMap[String(r.member_id)]
                if (member && member.mobile) {
                    return String(member.mobile).toLowerCase().includes(term)
                }
                return false
            })
        } else if (searchColumn === 'Registration No') {
            filtered = filtered.filter(r => {
                const member = memberMap[String(r.member_id)]
                if (member && member.registration_no) {
                    return String(member.registration_no).toLowerCase().includes(term)
                }
                return false
            })
        } else if (searchColumn === 'Transaction Date') {
            filtered = filtered.filter(r => String(r.remittance_date).includes(term) || (dateTerm && String(r.remittance_date).startsWith(dateTerm)))
        } else if (searchColumn === 'Bank') {
            filtered = filtered.filter(r => String(r.bank_name || '').toLowerCase().includes(term))
        } else if (searchColumn === 'Amount') {
            filtered = filtered.filter(r => String(r.amount).includes(term) || (!isNaN(numTermMatch) && Number(r.amount) === numTermMatch))
        } else if (searchColumn === 'Status') {
            filtered = filtered.filter(r => String(r.status).toLowerCase().includes(term))
        } else if (searchColumn === 'Created By') {
            filtered = filtered.filter(r => String(r.created_by || '').toLowerCase().includes(term))
        } else if (searchColumn === 'Note/Description') {
            filtered = filtered.filter(r => String(r.description || '').toLowerCase().includes(term))
        } else {
            filtered = filtered.filter(r => {
                const member = memberMap[String(r.member_id)]
                const memberName = member ? [member.name, member.first_name, member.last_name, member.middle_name].filter(Boolean).join(' ').toLowerCase() : ''
                const memberSpecialId = member ? String(member.special_id || '').toLowerCase() : ''
                const memberMobile = member ? String(member.mobile || '').toLowerCase() : ''
                const memberRegNo = member ? String(member.registration_no || '').toLowerCase() : ''
                return String(r.id).toLowerCase().includes(term) ||
                    String(r.member_id || '').includes(term) ||
                    memberName.includes(term) ||
                    memberSpecialId.includes(term) ||
                    memberMobile.includes(term) ||
                    memberRegNo.includes(term) ||
                    String(r.bank_name || '').toLowerCase().includes(term) ||
                    String(r.description || '').toLowerCase().includes(term) ||
                    String(r.transaction_type || '').toLowerCase().includes(term) ||
                    String(r.amount).includes(term) ||
                    (!isNaN(numTermMatch) && Number(r.amount) === numTermMatch) ||
                    String(r.status).toLowerCase().includes(term) ||
                    String(r.created_by || '').toLowerCase().includes(term) ||
                    String(r.remittance_date).includes(term) ||
                    (dateTerm && String(r.remittance_date) === dateTerm)
            })
        }
    }
    return filtered
}

export async function getRemittancesPage(cooperativeId, user = null, offset = 0, limitCount = 100, options = null) {
    let remittances
    try {
        remittances = await getAllByIndex('remittance', 'cooperative_id', String(cooperativeId))
        if (!remittances || remittances.length === 0) {
            const all = await getAllItems('remittance')
            if (all.length > 0) {
                remittances = all.filter(r => r.cooperative_id === String(cooperativeId))
            }
        }
    } catch (e) {
        const all = await getAllItems('remittance')
        remittances = all.filter(r => r.cooperative_id === String(cooperativeId))
    }
    remittances = remittances.filter(r => !r.is_deleted)

    if (user) {
        const rbac = applyRBAC(user, 'r', await preloadMembersForRBAC(user))
        const filtered = []
        for (const rem of remittances) {
            if (await rbac.filter(rem)) filtered.push(rem)
        }
        remittances = filtered
    }

    // Fetch members for enhanced search (name, special_id, mobile, registration_no)
    let memberMap = {}
    if (options && options.searchTerm && (options.searchColumn === 'Member Name' || options.searchColumn === 'Special ID' || options.searchColumn === 'Mobile' || options.searchColumn === 'Registration No' || options.searchColumn === 'All Columns')) {
        try {
            const members = await getAllByIndex('members', 'cooperative_id', String(cooperativeId))
            if (members && members.length > 0) {
                memberMap = Object.fromEntries(members.filter(m => !m.is_deleted).map(m => [String(m.id), m]))
            }
        } catch (e) {
            console.warn('Failed to fetch members for search:', e)
        }
    }

    remittances = buildRemittanceFilter(remittances, options, memberMap)

    remittances.sort((a, b) => {
        const dateStrA = getLocalDateString(a.remittance_date)
        const dateStrB = getLocalDateString(b.remittance_date)

        const dateCmp = dateStrB.localeCompare(dateStrA)
        if (dateCmp !== 0) return dateCmp

        const createdCmp = String(b.created_at || '').localeCompare(String(a.created_at || ''))
        if (createdCmp !== 0) return createdCmp
        return String(b.id).localeCompare(String(a.id))
    })

    const page = remittances.slice(offset, offset + limitCount)
    if (page.length === 0) return { remittances: [], nextOffset: null }

    await _attachNestedRemittanceData(page)
    const nextOffset = Number(offset || 0) + page.length
    return { remittances: page, nextOffset }
}

export async function getRemittancesPageForUser(cooperativeId, user, offset = 0, limitCount = 100, options = null) {
    return getRemittancesPage(cooperativeId, user, offset, limitCount, options)
}
