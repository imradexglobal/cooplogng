import { generateId, hashPassword } from '../../utils/formatters.js'
import { saveDoc, enqueueWrite } from '../sqliteService.js'
import { getDb, doc, setDoc, getDocs, query, collection, where } from '../../firebase.js'

async function checkNameUniqueness(fullName, shortName) {
    const db = getDb()
    
    const fullNameSnap = await getDocs(
        query(collection(db, 'cooperatives'), where('full_name', '==', fullName), where('is_deleted', '!=', 1))
    )
    if (!fullNameSnap.empty) {
        throw new Error('A cooperative with this full name already exists.')
    }
    
    const shortNameSnap = await getDocs(
        query(collection(db, 'cooperatives'), where('short_name', '==', shortName.toUpperCase()), where('is_deleted', '!=', 1))
    )
    if (!shortNameSnap.empty) {
        throw new Error('A cooperative with this short name/acronym already exists.')
    }
}

function generateRandomChars(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = ''
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)]
    }
    return result
}

export async function registerCooperative(coopData) {
    // Actual cooperative registration requires internet connectivity.
    if (!navigator.onLine) {
        throw new Error('No internet connection. Cooperative registration requires online connection. Please connect to the internet and try again.')
    }
    
    // Check uniqueness before creating
    await checkNameUniqueness(coopData.full_name.trim(), coopData.short_name.trim())
    
    const now = new Date().toISOString()
    const shortNameUpper = coopData.short_name.trim().toUpperCase()
    const cooperativeId = shortNameUpper
    const adminId = generateId(cooperativeId)
    const adminPwd = '123456'
    const adminPasswordHash = await hashPassword(adminPwd)
    const subKey = `${generateRandomChars(3)}-${generateRandomChars(3)}-${generateRandomChars(3)}`
    const expiryDate = new Date()
    expiryDate.setFullYear(expiryDate.getFullYear() + 1)

    const coop = {
        id: cooperativeId,
        full_name: coopData.full_name.trim(),
        short_name: shortNameUpper,
        contact_number: coopData.contact_number || '',
        email: coopData.email,
        address: coopData.address || '',
        logo_path: coopData.logo_path || null,
        coop_first_month: coopData.coop_first_month || '',
        subscription_key: subKey,
        expiry_date: expiryDate.toISOString(),
        created_at: now,
        created_by: 'system',
        modified_at: now,
        modified_by: 'system',
        is_deleted: 0,
        is_synced: 0
    }

    const shortName = coopData.short_name.trim().toUpperCase()
    const adminUsername = shortName // Use coop short name as the admin username for new coops

    const adminUser = {
        id: adminId,
        username: adminUsername,
        username_lower: adminUsername.toLowerCase(),
        password_hash: adminPasswordHash,
        force_password_change: true,
        cooperative_id: cooperativeId,
        role: 'admin',
        permissions: 'admin',
        enterprise_rights: 'all',
        subscriptionStatus: 1,
        expiry_date: expiryDate.toISOString(),
        created_at: now,
        created_by: 'system',
        modified_at: now,
        modified_by: 'system',
        is_deleted: 0,
        is_synced: 0
    }

    await saveDoc('cooperatives', coop)
    await enqueueWrite(cooperativeId, 'cooperatives', cooperativeId, 'set', coop)
    // Also write directly to Firestore so the cooperative is immediately available for login
    const db = getDb()
    await setDoc(doc(db, 'cooperatives', cooperativeId), coop, { merge: true })
    await saveDoc('users', adminUser)
    // Also write directly to Firestore so the admin user is immediately available for login
    await setDoc(doc(db, 'users', adminId), adminUser, { merge: true })
    await enqueueWrite(cooperativeId, 'users', adminId, 'set', adminUser)
    // Clear the cooperative name localStorage cache so the next login fetches fresh data
    try { localStorage.removeItem('cooplog-coop-names') } catch {}

    return { generatedPassword: adminPwd, cooperativeId }
}