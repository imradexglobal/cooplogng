import { generateId } from '../utils/formatters.js'
import { saveDoc, loadDoc, queryRows, runSql } from './sqliteService.js'

/**
 * Notification Service
 * Handles creation and management of in-app alerts.
 * Recipients can be member IDs, usernames (e.g., 'admin', coopShortName), or 'all'.
 */

/**
 * Create a single notification for multiple recipients.
 * @param {string} cooperativeId
 * @param {string[]} recipients - List of member IDs or usernames (e.g., ['admin', 'm123'])
 * @param {string} type 
 * @param {string} title 
 * @param {string} message 
 * @param {object} data 
 * @param {string} creator 
 */
export async function createNotification(cooperativeId, recipients, type, title, message, data = {}, creator = 'system') {
    const rList = Array.isArray(recipients) ? recipients : (recipients ? String(recipients).split(',') : [])
    const normalizedRecipients = rList.map(s => String(s).trim().toLowerCase()).filter(Boolean)

    const notification = {
        id: generateId(cooperativeId),
        cooperative_id: String(cooperativeId),
        recipient_id: normalizedRecipients.join(','),
        viewed: null, // Null by default
        type,
        title,
        message,
        data: JSON.stringify(data),
        is_read: 0,
        created_at: new Date().toISOString(),
        created_by: creator,
        modified_at: new Date().toISOString(),
        is_synced: 0,
        is_deleted: 0
    }

    await _persistNotification(notification)
}

/**
 * Compatibility wrapper for notifyMember
 */
export async function notifyMember(cooperativeId, memberId, type, title, message, data = {}, creator = 'system') {
    return createNotification(cooperativeId, [memberId], type, title, message, data, creator)
}

/**
 * Compatibility wrapper for notifyAdmins
 */
export async function notifyAdmins(cooperativeId, type, title, message, data = {}, creator = 'system') {
    return createNotification(cooperativeId, ['admin'], type, title, message, data, creator)
}

/**
 * Mark a notification as read for a specific user by appending their ID to the viewed list.
 */
export async function markAsRead(notificationId, cooperativeId, userIdOrUsername) {
    const now = new Date().toISOString()
    const idToMark = String(userIdOrUsername).toLowerCase().trim()
    
    const n = await loadDoc('notifications', notificationId, cooperativeId)
    if (n) {
        let viewed = n.viewed || ''
        const viewedList = viewed ? viewed.split(',').map(v => v.trim().toLowerCase()) : []
        if (!viewedList.includes(idToMark)) {
            viewedList.push(idToMark)
        }
        const newViewed = viewedList.join(',')
        
        n.viewed = newViewed
        n.is_synced = 0
        n.modified_at = now
        await saveDoc('notifications', n)
    }

    // Trigger UI refresh (e.g. update bell count)
    window.dispatchEvent(new CustomEvent('notification-received'))
}

/**
 * Mark all unread notifications for a user as read.
 */
export async function markAllAsRead(cooperativeId, userId, role, username, registrationNo = '') {
    const unread = await getUnreadNotifications(cooperativeId, userId, role, username, registrationNo)
    if (unread.length === 0) return

    const idToMark = String(role === 'member' ? (userId || username) : username).toLowerCase().trim()
    const now = new Date().toISOString()

    for (const item of unread) {
        const n = await loadDoc('notifications', item.id, cooperativeId)
        if (n) {
            let viewed = n.viewed || ''
            const viewedList = Array.isArray(viewed) 
                ? viewed.map(v => String(v).toLowerCase())
                : viewed.split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
                
            if (!viewedList.includes(idToMark)) {
                viewedList.push(idToMark)
            }
            const newViewedString = viewedList.join(',')

            n.viewed = newViewedString
            n.is_synced = 0
            n.modified_at = now
            await saveDoc('notifications', n)
        }
    }

    // Trigger UI refresh once at the end
    window.dispatchEvent(new CustomEvent('notification-received'))
}

/**
 * Fetch unread notifications for a user.
 * Unread means: User is in recipient_id AND User is NOT in viewed list.
 */
export async function getUnreadNotifications(cooperativeId, userId, role, username, registrationNo = '') {
    // Since we store comma-separated lists, we fetch all for the coop and filter in memory 
    // for accuracy and to handle varied ID formats (memberId vs username).
    const sql = `SELECT * FROM notifications 
                 WHERE cooperative_id = ? 
                 AND is_deleted = 0
                 ORDER BY created_at DESC`
    
    const rows = await queryRows(sql, [cooperativeId])
    
    const currentUserIds = [
        String(userId).toLowerCase(), 
        String(username).toLowerCase(), 
        String(role).toLowerCase(),
        String(registrationNo).toLowerCase()
    ].filter(v => v && v !== 'null' && v !== 'undefined' && v !== '0')

    return rows.filter(r => {
        // Handle both comma-separated strings (SQLite) and arrays (Firestore/Legacy)
        const recipients = Array.isArray(r.recipient_id) 
            ? r.recipient_id.map(s => String(s).toLowerCase()) 
            : (r.recipient_id || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
            
        const viewed = Array.isArray(r.viewed) 
            ? r.viewed.map(s => String(s).toLowerCase()) 
            : (r.viewed || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        
        // Is user a recipient?
        const isRecipient = currentUserIds.some(id => recipients.includes(id)) || recipients.includes('all')
        if (!isRecipient) return false

        // Has user viewed it?
        const hasViewed = currentUserIds.some(id => viewed.includes(id))
        return !hasViewed
    }).map(r => ({
        ...r,
        data: r.data ? (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) : {}
    }))
}

/**
 * Internal helper to save locally and enqueue for sync.
 */
async function _persistNotification(notification) {
    // 1. Local SQLite Write (enqueueWrite happens inside saveDoc)
    await saveDoc('notifications', notification)

    // 2. Trigger immediate UI refresh
    window.dispatchEvent(new CustomEvent('notification-received'))
}
