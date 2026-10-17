import { generateId, hashPassword, generateRandom6Digit, isSha256Hex } from '../../utils/formatters.js'
import { normalizePhone, normalizeSpecialId, specialIdKey, normalizeEmail, normalizeRegNo, regNoKey } from '../../utils/normalize.js'
import {
    getAllForCoop, getDocById_Global, queryOne, queryRows,
    saveDoc, upsertRow
} from '../sqliteService.js'

export async function fetchAllMembers(cooperativeId, username = null, allAccess = false) {
    const members = await getAllForCoop(cooperativeId, 'members')
    if (!username || allAccess) return members
    const normalized = String(username).toLowerCase()
    return members.filter(m => {
        const managers = String(m.account_manager || '').split(',').map(s => s.trim().toLowerCase())
        return managers.includes(normalized)
    })
}

export async function fetchMembersBySearch(cooperativeId, searchTerm) {
    const members = await getAllForCoop(cooperativeId, 'members')
    if (!searchTerm) return members
    const term = String(searchTerm).toLowerCase()
    return members.filter(m =>
        String(m.last_name || '').toLowerCase().includes(term) ||
        String(m.first_name || '').toLowerCase().includes(term) ||
        String(m.middle_name || '').toLowerCase().includes(term) ||
        String(m.mobile || '').includes(term) ||
        String(m.registration_no || '').toLowerCase().includes(term) ||
        String(m.special_id || '').toLowerCase().includes(term)
    )
}

export async function fetchMemberDoc(memberId) {
    if (!memberId) return null
    try {
        return await getDocById_Global('members', memberId)
    } catch (e) {
        console.error('[dataService] fetchMemberDoc error:', e.message)
        return null
    }
}

export async function fetchMemberPaymentAdvise(memberId) {
    if (!memberId) return []
    try {
        return await queryRows('SELECT * FROM payment_advise WHERE member_id = ? AND is_deleted = 0', [memberId])
    } catch (e) {
        console.error('[dataService] fetchMemberPaymentAdvise error:', e.message)
        return []
    }
}

function generateRandom4Digit() {
    return generateRandom6Digit()
}

// Coop-scoped duplicate guard (defense in depth — all callers benefit).
// Offline-capable: checks local IndexedDB coop dataset, not Firestore.
// Empty mobile / empty special_id never collide.
function findLocalDuplicate(allMembers, { mobile, specialIdLower, excludeId }) {
    if (mobile) {
        const dup = allMembers.find(m =>
            String(m.id) !== String(excludeId) &&
            normalizePhone(m.mobile || '') === mobile &&
            normalizePhone(m.mobile || '') !== ''
        )
        if (dup) throw new Error('This mobile number is already registered to another member.')
    }
    if (specialIdLower) {
        const dup = allMembers.find(m =>
            String(m.id) !== String(excludeId) &&
            String(m.special_id || '').trim().toLowerCase() === specialIdLower &&
            String(m.special_id || '').trim() !== ''
        )
        if (dup) throw new Error('This Special ID is already registered to another member.')
    }
}

export async function findDuplicateMembers(cooperativeId) {
    const all = await getAllForCoop(String(cooperativeId), 'members')
    const byMobile = new Map()
    const bySpecial = new Map()
    const byName = new Map()
    const byEmail = new Map()
    const byRegNo = new Map()
    for (const m of all) {
        const mk = normalizePhone(m.mobile || '')
        if (mk) {
            if (!byMobile.has(mk)) byMobile.set(mk, [])
            byMobile.get(mk).push(m)
        }
        const sk = String(m.special_id || '').trim().toLowerCase()
        if (sk) {
            if (!bySpecial.has(sk)) bySpecial.set(sk, [])
            bySpecial.get(sk).push(m)
        }
        const nk = `${String(m.last_name || '').trim().toLowerCase()}|${String(m.first_name || '').trim().toLowerCase()}|${String(m.middle_name || '').trim().toLowerCase()}`
        if (nk !== '||') {
            if (!byName.has(nk)) byName.set(nk, [])
            byName.get(nk).push(m)
        }
        const ek = String(m.email || '').trim().toLowerCase()
        if (ek) {
            if (!byEmail.has(ek)) byEmail.set(ek, [])
            byEmail.get(ek).push(m)
        }
        const rnk = String(m.registration_no || '').toString().trim()
        if (rnk && rnk !== '0') {
            if (!byRegNo.has(rnk)) byRegNo.set(rnk, [])
            byRegNo.get(rnk).push(m)
        }
    }
    const groups = []
    for (const [key, members] of byMobile) {
        if (members.length > 1) groups.push({ type: 'mobile', key, members })
    }
    for (const [key, members] of bySpecial) {
        if (members.length > 1) groups.push({ type: 'special_id', key, members })
    }
    for (const [key, members] of byName) {
        if (members.length > 1) groups.push({ type: 'name', key: key.split('|').filter(Boolean).join(' ') || 'Unknown', members })
    }
    for (const [key, members] of byEmail) {
        if (members.length > 1) groups.push({ type: 'email', key, members })
    }
    for (const [key, members] of byRegNo) {
        if (members.length > 1) groups.push({ type: 'registration_no', key, members })
    }
    return groups
}

export async function addMember(data, createdBy) {
    const now = new Date().toISOString()
    const id = generateId(String(data.cooperative_id))
    const rawPwd = data.password_hash || generateRandom4Digit()
    const pwd = isSha256Hex(rawPwd) ? rawPwd : rawPwd
    const password_hash = isSha256Hex(rawPwd) ? rawPwd : await hashPassword(rawPwd)

    let nextReg = 1
    try {
        const allLocal = await getAllForCoop(String(data.cooperative_id), 'members')
        if (allLocal.length > 0) {
            nextReg = Math.max(...allLocal.map(m => parseInt(m.registration_no || 0))) + 1
        }
    } catch (e) { console.warn('[addMember] RegNo calculation error:', e) }

    const mobile = normalizePhone(data.mobile || '')
    const special_id = normalizeSpecialId(data.special_id || '')
    const email = normalizeEmail(data.email)
    // Coop-scoped guard (non-deleted, same cooperative only).
    try {
        const dupScope = await getAllForCoop(String(data.cooperative_id), 'members')
        findLocalDuplicate(dupScope, {
            mobile: mobile || '',
            specialIdLower: specialIdKey(special_id),
            excludeId: null
        })
    } catch (e) {
        if (String(e.message || '').includes('already registered')) throw e
        console.warn('[addMember] Duplicate-guard lookup failed, proceeding:', e?.message)
    }
    const doc = {
        id,
        cooperative_id: String(data.cooperative_id),
        registration_no: nextReg,
        registration_no_str: regNoKey(nextReg),
        last_name: data.last_name,
        first_name: data.first_name,
        middle_name: data.middle_name || '',
        mobile,
        special_id,
        special_id_lower: specialIdKey(special_id),
        status: data.status || 'Active',
        sex: data.sex || '',
        email,
        email_lower: email ? specialIdKey(email) : null,
        firebase_uid: data.firebase_uid || null,
        date_joined: data.date_joined || '',
        dob: data.dob || '',
        marital_status: data.marital_status || '',
        employer: data.employer || '',
        department: data.department || '',
        position: data.position || '',
        address: data.address || '',
        nok_name: data.nok_name || '',
        nok_relationship: data.nok_relationship || '',
        nok_mobile: data.nok_mobile !== undefined ? normalizePhone(data.nok_mobile) : '',
        nok_address: data.nok_address || '',
        bank_name: data.bank_name || '',
        account_number: data.account_number || '',
        account_name: data.account_name || '',
        account_manager: data.account_manager || '',
        image_path: data.image_path || null,
        signature_path: data.signature_path || null,
        password_hash,
        subscriptionStatus: data.subscriptionStatus !== undefined ? data.subscriptionStatus : 0,
        expiry_date: data.expiry_date !== undefined ? data.expiry_date : null,
        force_password_change: true,
        created_at: now,
        created_by: createdBy || 'system',
        modified_at: now,
        modified_by: createdBy || 'system',
        last_login: null,
        login_count: 0,
        is_deleted: 0,
        is_synced: 0
    }
    if (data.payment_advise && Array.isArray(data.payment_advise)) {
        doc.payment_advise = data.payment_advise.map(a => ({
            id: generateId(String(data.cooperative_id)),
            enterprise_id: String(a.enterprise_id),
            amount: parseFloat(a.amount || 0),
            created_at: now,
            created_by: createdBy || 'system',
            modified_at: now,
            modified_by: createdBy || 'system',
            is_deleted: 0,
            is_synced: 0
        }))
    }
    await saveDoc('members', doc)
    return { generatedPassword: pwd, memberId: id }
}

export async function updateMember(id, data, modifiedBy) {
    const existing = await getDocById_Global('members', id)
    if (!existing) throw new Error('Member not found')
    const now = new Date().toISOString()
    const mobile = data.mobile !== undefined ? normalizePhone(data.mobile) : existing.mobile
    const special_id = data.special_id !== undefined ? normalizeSpecialId(data.special_id) : existing.special_id
    const email = data.email !== undefined ? normalizeEmail(data.email) : existing.email
    const regNo = data.registration_no !== undefined ? normalizeRegNo(data.registration_no) || existing.registration_no : existing.registration_no
    // Coop-scoped guard on edit (exclude self so unchanged values pass).
    try {
        const dupScope = await getAllForCoop(String(existing.cooperative_id), 'members')
        findLocalDuplicate(dupScope, {
            mobile: normalizePhone(mobile || ''),
            specialIdLower: specialIdKey(special_id),
            excludeId: id
        })
    } catch (e) {
        if (String(e.message || '').includes('already registered')) throw e
        console.warn('[updateMember] Duplicate-guard lookup failed, proceeding:', e?.message)
    }
    const doc = {
        ...existing,
        ...data,
        id: existing.id,
        mobile,
        special_id,
        special_id_lower: specialIdKey(special_id),
        registration_no: regNo,
        registration_no_str: regNo !== undefined && regNo !== null && regNo !== '' ? regNoKey(regNo) : (existing.registration_no_str || ''),
        nok_mobile: data.nok_mobile !== undefined ? normalizePhone(data.nok_mobile) : existing.nok_mobile,
        email,
        email_lower: email ? specialIdKey(email) : null,
        firebase_uid: data.firebase_uid !== undefined ? data.firebase_uid : existing.firebase_uid,
        subscriptionStatus: existing.subscriptionStatus,
        expiry_date: existing.expiry_date,
        modified_at: now,
        modified_by: modifiedBy || 'system',
        is_synced: 0
    }
    delete doc.password_hash
    if (data.password_hash) {
        doc.password_hash = isSha256Hex(data.password_hash) ? data.password_hash : await hashPassword(data.password_hash)
    } else if (existing.password_hash) {
        doc.password_hash = existing.password_hash
    }
    if (data.payment_advise && Array.isArray(data.payment_advise)) {
        doc.payment_advise = data.payment_advise.map(a => ({
            id: a.id || generateId(String(existing.cooperative_id)),
            member_id: id,
            cooperative_id: String(existing.cooperative_id),
            enterprise_id: String(a.enterprise_id),
            amount: parseFloat(a.amount || 0),
            created_at: a.created_at || now,
            created_by: a.created_by || modifiedBy || 'system',
            modified_at: now,
            modified_by: modifiedBy || 'system',
            is_deleted: 0,
            is_synced: 0
        }))
    }
    delete doc.image_path
    delete doc.signature_path
    if (data.image_path !== undefined) doc.image_path = data.image_path
    if (data.signature_path !== undefined) doc.signature_path = data.signature_path
    await saveDoc('members', doc)
}

export async function deleteMember(id, modifiedBy) {
    const existing = await getDocById_Global('members', id)
    if (!existing) throw new Error('Member not found')
    const used = await queryOne(
        'SELECT id FROM remittance WHERE cooperative_id = ? AND member_id = ? AND is_deleted = 0 LIMIT 1',
        [existing.cooperative_id, id]
    )
    if (used) throw new Error('Cannot delete member with existing remittance records.')
    const now = new Date().toISOString()
    await saveDoc('members', {
        ...existing,
        is_deleted: 1,
        modified_at: now,
        modified_by: modifiedBy || 'system',
        is_synced: 0
    })
}

export async function mergeDuplicateMembers(survivorId, loserId, modifiedBy) {
    if (String(survivorId) === String(loserId)) throw new Error('Cannot merge a member into itself.')
    const survivor = await getDocById_Global('members', survivorId)
    const loser = await getDocById_Global('members', loserId)
    if (!survivor || !loser) throw new Error('Member not found')
    if (String(survivor.cooperative_id) !== String(loser.cooperative_id)) {
        throw new Error('Members belong to different cooperatives and cannot be merged.')
    }
    // Safe merge only: never auto-reassign financial history. If the loser has
    // remittance records, refuse and guide admin to reassign manually first.
    // (deleteMember enforces the same rule for plain deletes.)
    const used = await queryOne(
        'SELECT id FROM remittance WHERE cooperative_id = ? AND member_id = ? AND is_deleted = 0 LIMIT 1',
        [loser.cooperative_id, loserId]
    )
    if (used) throw new Error('Cannot auto-merge: the duplicate has remittance records. Reassign them to the survivor first.')
    const now = new Date().toISOString()
    await saveDoc('members', {
        ...loser,
        is_deleted: 1,
        modified_at: now,
        modified_by: modifiedBy || 'system',
        is_synced: 0
    })
    return { survivorId, loserId }
}

export async function updateMemberPaymentAdvice(memberId, paymentAdvice, modifiedBy, cooperativeId) {
    if (!memberId || !cooperativeId) return
    const now = new Date().toISOString()
    const { loadDoc } = await import('../sqliteService.js')
    const member = await loadDoc('members', memberId, cooperativeId)
    if (member) {
        member.payment_advise = paymentAdvice
        member.modified_at = now
        member.modified_by = modifiedBy || 'system'
        member.is_synced = 0
        await saveDoc('members', member)
    }
}
