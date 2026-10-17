import { generateId, hashPassword } from '../../utils/formatters.js'
import { normalizePhone } from '../../utils/normalize.js'
import { getAllForCoop, getDocById_Global, saveDoc } from '../sqliteService.js'
import { addMember } from './members.js'
import { getDb, doc, setDoc, serverTimestamp } from '../../firebase.js'
import { state } from '../../state/appState.js'

/**
 * Write a membership request directly to Firestore (bypasses local queue).
 * Throws if offline. Used for join requests that must reach admin immediately.
 * @param {Object} req — must have cooperative_id, last_name, first_name, mobile, etc.
 * @returns {Promise<string>} the new request id
 */
export async function submitMembershipRequestDirect(req) {
    if (!state.isOnline) {
        throw new Error('No internet connection. Please connect to submit your join request.')
    }
    const now = new Date().toISOString()
    const id = generateId(String(req.cooperative_id))
    const data = {
        id,
        cooperative_id: String(req.cooperative_id),
        last_name: req.last_name,
        first_name: req.first_name,
        middle_name: req.middle_name || '',
        mobile: normalizePhone(req.mobile || ''),
        address: req.address || '',
        image_path: req.image_path || null,
        status: 'Pending',
        reviewed_by: null,
        reviewed_at: null,
        member_id: null,
        decline_reason: null,
        created_at: now,
        created_by: 'self-register',
        modified_at: now,
        modified_by: 'self-register',
        is_deleted: 0,
        is_synced: 1,
        sync_at: now
    }
    const db = getDb()
    const ref = doc(db, 'membership_request', id)
    await setDoc(ref, {
        ...data,
        sync_at: serverTimestamp()
    })
    return id
}

/**
 * Update a membership request directly in Firestore (approve/decline).
 * Throws if offline.
 */
async function updateMembershipRequestDirect(requestId, updates) {
    if (!state.isOnline) {
        throw new Error('No internet connection. Please connect to review this request.')
    }
    const db = getDb()
    const ref = doc(db, 'membership_request', requestId)
    await setDoc(ref, {
        ...updates,
        sync_at: serverTimestamp()
    }, { merge: true })
}

/**
 * Submit a self-registration join request (pre-login).
 * WRITES DIRECTLY TO FIRESTORE (no local queue).
 * Throws if offline so the user knows immediately.
 * @param {Object} req — must have cooperative_id, last_name, first_name, mobile, etc.
 * @returns {Promise<string>} the new request id
 */
export async function submitMembershipRequest(req) {
    return submitMembershipRequestDirect(req)
}

/**
 * List membership_requests for THIS cooperative only.
 * @param {string} cooperativeId
 * @param {'Pending'|'All'} [filter='Pending']
 * @returns {Promise<Array>} sorted by created_at DESC
 */
export async function listMembershipRequests(cooperativeId, filter = 'Pending') {
    const all = await getAllForCoop(String(cooperativeId), 'membership_request')
    const rows = all.filter(r => {
        if (r.is_deleted === 1 || r.is_deleted === '1') return false
        if (filter === 'Pending') return r.status === 'Pending'
        return true
    })
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    return rows
}

/**
 * Count only Pending requests for the stat card.
 * @param {string} cooperativeId
 * @returns {Promise<number>}
 */
export async function countPendingMembershipRequests(cooperativeId) {
    const rows = await listMembershipRequests(cooperativeId, 'Pending')
    return rows.length
}

/**
 * Approve a join request:
 *   1. Load request → validate status === 'Pending' (else throw).
 *   2. Build memberData and call addMember(memberData, reviewedBy).
 *   3. Update request directly in Firestore (no queue) with status='Approved'.
 *   4. Update local for immediate UI consistency.
 * Default password is 123456 (hash passed through; addMember honors it).
 * @param {string} requestId
 * @param {string} reviewedByUserId
 * @returns {Promise<{memberId: string, generatedPassword: string}>}
 */
export async function approveMembershipRequest(requestId, reviewedByUserId) {
    const existing = await getDocById_Global('membership_request', requestId)
    if (!existing) throw new Error('Join request not found')
    if (existing.status !== 'Pending') throw new Error('This request has already been reviewed')
    const now = new Date().toISOString()
    const coopId = String(existing.cooperative_id)

    const memberData = {
        cooperative_id: coopId,
        last_name: existing.last_name,
        first_name: existing.first_name,
        middle_name: existing.middle_name || '',
        mobile: normalizePhone(existing.mobile || ''),
        address: existing.address || '',
        image_path: existing.image_path || null,
        date_joined: now,
        status: 'Active',
        password_hash: await hashPassword('123456'),
        force_password_change: true
    }

    let result
    try {
        result = await addMember(memberData, reviewedByUserId)
    } catch (e) {
        // Duplicate guard etc.: surface, leave the request Pending.
        throw e
    }

    const memberId = result.memberId || null
    // Update directly in Firestore (no queue)
    await updateMembershipRequestDirect(requestId, {
        status: 'Approved',
        reviewed_by: reviewedByUserId,
        reviewed_at: now,
        member_id: memberId,
        is_deleted: 1,
        modified_at: now,
        modified_by: reviewedByUserId
    })
    // Also update local for immediate UI consistency
    await saveDoc('membership_request', {
        ...existing,
        status: 'Approved',
        reviewed_by: reviewedByUserId,
        reviewed_at: now,
        member_id: memberId,
        is_deleted: 1,
        modified_at: now,
        modified_by: reviewedByUserId,
        is_synced: 1,
        sync_at: now
    })
    return { memberId, generatedPassword: result.generatedPassword }
}

/**
 * Decline a request — direct Firestore update (no queue).
 * Throws if offline.
 * @param {string} requestId
 * @param {string} reviewedByUserId
 * @param {string} [reason='']
 */
export async function declineMembershipRequest(requestId, reviewedByUserId, reason = '') {
    const existing = await getDocById_Global('membership_request', requestId)
    if (!existing) throw new Error('Join request not found')
    if (existing.status !== 'Pending') throw new Error('This request has already been reviewed')
    const now = new Date().toISOString()
    // Update directly in Firestore (no queue)
    await updateMembershipRequestDirect(requestId, {
        status: 'Declined',
        reviewed_by: reviewedByUserId,
        reviewed_at: now,
        decline_reason: reason || null,
        is_deleted: 1,
        modified_at: now,
        modified_by: reviewedByUserId
    })
    // Also update local for immediate UI consistency
    await saveDoc('membership_request', {
        ...existing,
        status: 'Declined',
        reviewed_by: reviewedByUserId,
        reviewed_at: now,
        decline_reason: reason || null,
        is_deleted: 1,
        modified_at: now,
        modified_by: reviewedByUserId,
        is_synced: 1,
        sync_at: now
    })
}

/**
 * Approve a join request AND activate subscription (1 year expiry).
 *   1. Load request → validate status === 'Pending' (else throw).
 *   2. Build memberData with subscriptionStatus=1 and expiry_date +1 year.
 *   3. Call addMember(memberData, reviewedBy).
 *   4. Update request directly in Firestore (no queue) with status='Approved'.
 *   5. Update local for immediate UI consistency.
 * Default password is 123456.
 * @param {string} requestId
 * @param {string} reviewedByUserId
 * @returns {Promise<{memberId: string, generatedPassword: string}>}
 */
export async function approveAndActivateMembershipRequest(requestId, reviewedByUserId) {
    const existing = await getDocById_Global('membership_request', requestId)
    if (!existing) throw new Error('Join request not found')
    if (existing.status !== 'Pending') throw new Error('This request has already been reviewed')
    const now = new Date().toISOString()
    const coopId = String(existing.cooperative_id)

    // Calculate expiry: +1 year from now
    const expiryDate = new Date(now)
    expiryDate.setFullYear(expiryDate.getFullYear() + 1)
    const expiryIso = expiryDate.toISOString()

    const memberData = {
        cooperative_id: coopId,
        last_name: existing.last_name,
        first_name: existing.first_name,
        middle_name: existing.middle_name || '',
        mobile: normalizePhone(existing.mobile || ''),
        address: existing.address || '',
        image_path: existing.image_path || null,
        date_joined: now,
        status: 'Active',
        password_hash: await hashPassword('123456'),
        force_password_change: true,
        subscriptionStatus: 1,
        expiry_date: expiryIso
    }

    let result
    try {
        result = await addMember(memberData, reviewedByUserId)
    } catch (e) {
        throw e
    }

    const memberId = result.memberId || null
    // Update directly in Firestore (no queue)
    await updateMembershipRequestDirect(requestId, {
        status: 'Approved',
        reviewed_by: reviewedByUserId,
        reviewed_at: now,
        member_id: memberId,
        is_deleted: 1,
        modified_at: now,
        modified_by: reviewedByUserId
    })
    // Also update local for immediate UI consistency
    await saveDoc('membership_request', {
        ...existing,
        status: 'Approved',
        reviewed_by: reviewedByUserId,
        reviewed_at: now,
        member_id: memberId,
        is_deleted: 1,
        modified_at: now,
        modified_by: reviewedByUserId,
        is_synced: 1,
        sync_at: now
    })
    return { memberId, generatedPassword: result.generatedPassword }
}
