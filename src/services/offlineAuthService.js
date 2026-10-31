/**
 * offlineAuthService.js
 * Manages persistent offline sessions, offline login, and online revalidation.
 * 
 * Session key format: <cooperative_id>_<user_id>
 * This allows multiple users (and multiple cooperatives) to have independent sessions on the same device.
 * 
 * Security:
 * - Passwords are NEVER stored locally.
 * - Only a session token (SHA-256 of uid+coopId+timestamp+random) is stored.
 * - Session life depends ONLY on "Remember me" (same rule for members,
 *   staff and admins):
 *     Remember me ON  -> persistent session (no inactivity logout)
 *     Remember me OFF -> logout after 10 minutes of inactivity (sliding)
 * - Permissions snapshot is compared on revalidation; mismatches force logout.
 */

import {
    saveLocalSession,
    loadLocalSession,
    getAllLocalSessions,
    deleteLocalSession,
    getUsersByUsername,
    getUserByEmail,
    getMemberByMobile,
    getMemberByRegistrationNo,
    getMemberByEmail,
    queryRows,
} from './sqliteService.js'
import { hashPassword } from '../utils/formatters.js'

function generateSecureRandom(length) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_TTL_MS = 10 * 60 * 1000  // 10 minutes of inactivity ("Remember me" OFF)
// Remembered ("Remember me") sessions are persistent: they live 30 days and
// the inactivity watcher skips them, so only an explicit Log Out ends them.
export const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 days
const SYNC_SESSION_KEY = 'cooplog-web-session'
// Alias: how long a session may sit idle before auto-logout.
// Active users keep their session alive via recordActivity().
export const INACTIVITY_TIMEOUT_MS = SESSION_TTL_MS
const ACTIVITY_TOUCH_THROTTLE_MS = 60 * 1000  // extend IndexedDB expiry at most once/min
const WATCHER_CHECK_MS = 30 * 1000  // inactivity watcher tick

/**
 * Members (members collection / role === 'member'). Used ONLY for
 * member-specific features (cooperative switcher). The session lifetime no
 * longer depends on the role — see expiryForSession().
 */
function isMemberSession(s) {
    if (!s) return false
    return s.role === 'member' || s.user_collection === 'members' || s.userCollection === 'members'
}

/**
 * Session lifetime, driven solely by "Remember me" for every user type:
 * remembered = persistent (30 days), otherwise 10 minutes of inactivity.
 */
function expiryForSession(now, { remembered = false } = {}) {
    return now + (remembered ? REMEMBER_TTL_MS : SESSION_TTL_MS)
}

/**
 * Synchronous load for app initialization (main.js state).
 * Uses sessionStorage for immediate tab-session state.
 * Without "Remember me" a session returns null when idle past the timeout
 * (all user types, members included).
 * A remembered session never expires here: an idle one is returned with a
 * `__idleReturn` flag (and a refreshed clock) so bootstrap can count the
 * return visit (+1 login_count) without forcing a fresh login.
 */
export function loadSavedSession() {
    try {
        const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
        if (!raw) return null
        const session = JSON.parse(raw)
        // Basic validation
        if (!session.cooperativeId || (!session.memberId && session.role === 'member')) {
            window.sessionStorage.removeItem(SYNC_SESSION_KEY)
            return null
        }
        // Remembered ("Remember me") sessions stay logged in: preserve a pending
        // return-count flag across reloads, otherwise flag idle returns
        // (>10 min) and refresh the clock.
        if (session.remember) {
            if (session.__idleReturn) return session
            const lastActive = session.lastActivityTs || 0
            if (lastActive && Date.now() - lastActive > INACTIVITY_TIMEOUT_MS) {
                const refreshed = { ...session, lastActivityTs: Date.now(), __idleReturn: true }
                try { window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(refreshed)) } catch {}
                return refreshed
            }
            return session
        }
        // Inactivity expiry: idle past the timeout forces a fresh login
        const lastActive = session.lastActivityTs || 0
        if (lastActive && Date.now() - lastActive > INACTIVITY_TIMEOUT_MS) {
            window.sessionStorage.removeItem(SYNC_SESSION_KEY)
            return null
        }
        return session
    } catch {
        return null
    }
}

/**
 * Synchronous clear.
 */
export function clearSavedSession() {
    window.sessionStorage.removeItem(SYNC_SESSION_KEY)
}

let _lastTouchTs = 0
let _lastActivityWriteTs = 0
const ACTIVITY_WRITE_THROTTLE_MS = 5 * 1000  // sessionStorage stamp at most every 5s

/**
 * Record user activity: refreshes the idle clock in sessionStorage so
 * active users are never logged out. Extends the IndexedDB offline
 * session expiry at most once per minute (sliding 10-min window).
 * Cheap and safe to call from global interaction listeners.
 */
export function recordActivity() {
    try {
        const now = Date.now()
        // Throttle the sessionStorage read/write (fires on every mousemove)
        if (now - _lastActivityWriteTs < ACTIVITY_WRITE_THROTTLE_MS) return
        const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
        if (!raw) return
        const session = JSON.parse(raw)
        _lastActivityWriteTs = now
        session.lastActivityTs = now
        window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(session))

        // Sliding expiry for the persistent offline session (throttled)
        if (now - _lastTouchTs > ACTIVITY_TOUCH_THROTTLE_MS) {
            _lastTouchTs = now
            const coopId = session.cooperativeId
            const userId = session.userId || session.memberId || session.userDoc?.id
            if (coopId && userId) {
                touchSession(coopId, userId).catch(() => {})
            }
        }
    } catch {
        // never break the UI on activity bookkeeping
    }
}

let _watcherStarted = false

/**
 * Start the inactivity auto-logout watcher (idempotent).
 * Every 30s: if a session WITHOUT "Remember me" is idle longer than the
 * timeout, `onTimeout` is invoked (the app performs a full logout there).
 * This applies to every user type (members, staff, admins) — only remembered
 * sessions are skipped, because they are persistent.
 */
export function startInactivityWatcher(onTimeout) {
    if (_watcherStarted) return
    _watcherStarted = true
    setInterval(() => {
        try {
            const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
            if (!raw) return
            const session = JSON.parse(raw)
            if (!session?.cooperativeId) return
            // "Remember me" sessions are persistent: only manual Log Out ends them.
            if (session.remember) return
            const lastActive = session.lastActivityTs || 0
            if (Date.now() - lastActive > INACTIVITY_TIMEOUT_MS) {
                onTimeout && onTimeout()
            }
        } catch {
            // ignore
        }
    }, WATCHER_CHECK_MS)
}

/**
 * Persist the current tab so resume (reload / cold start) lands back on the
 * last page. Writes sessionStorage synchronously plus the IndexedDB session
 * row best-effort (the row is what cold starts read). Fire-and-forget safe.
 */
export async function persistActiveTab(tab) {
    if (!tab) return
    try {
        const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
        if (raw) {
            const s = JSON.parse(raw)
            s.activeTab = tab
            s.lastActivityTs = Date.now()
            window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(s))
            const coopId = s.cooperativeId
            const userId = s.userId || s.memberId || s.userDoc?.id
            if (coopId && userId) {
                const key = makeSessionKey(coopId, userId)
                const row = await loadLocalSession(key).catch(() => null)
                if (row && row.active_tab !== tab) {
                    await saveLocalSession(key, { ...row, active_tab: tab }).catch(() => {})
                }
            }
        }
    } catch {
        // never break navigation on bookkeeping
    }
}

/**
 * Repair a restored welcomeUser against the CURRENT local database.
 * Persisted snapshots (role/permissions/enterprises/coop name) can predate
 * admin changes or have been saved as '' by older builds. A fresh login
 * already rebuilds these from the live user doc (main.js), so restore must
 * do the same from the local users/members + cooperatives tables —
 * otherwise the dashboard filters on stale rights and shows the coop id.
 * Best-effort: never throws, returns the (possibly unrepaired) object.
 */
export async function repairWelcomeUser(welcomeUser) {
    if (!welcomeUser) return welcomeUser
    try {
        const { getDocById_Global } = await import('./sqliteService.js')
        const isMember = welcomeUser.role === 'member' || welcomeUser.userCollection === 'members'
        const collection = isMember ? 'members' : 'users'
        const id = welcomeUser.userId || welcomeUser.memberId
        if (id) {
            const row = await getDocById_Global(collection, String(id)).catch(() => null)
            if (row && !row.is_deleted) {
                welcomeUser.role = collection === 'members' ? 'member' : (row.role || welcomeUser.role)
                if (row.permissions !== undefined) welcomeUser.permissions = row.permissions
                const rights = row.enterprise_rights || row.enterprises
                if (rights !== undefined) {
                    welcomeUser.enterprises = rights
                    welcomeUser.enterprise_rights = rights
                }
                welcomeUser.username = row.username || row.mobile || welcomeUser.username
                welcomeUser.fullName = collection === 'members'
                    ? (`${row.last_name || ''} ${row.first_name || ''} ${row.middle_name || ''}`.trim() || welcomeUser.fullName)
                    : (row.full_name || row.username || welcomeUser.fullName)
            }
        }
        // memberId must mirror a fresh login: members keep it, staff/admin get
        // null. A stale user_id here member-scopes balance/remittance/member
        // queries (balance.js) and zeroes the whole dashboard.
        if (welcomeUser.role === 'member') {
            welcomeUser.memberId = welcomeUser.memberId || welcomeUser.userId || null
        } else {
            welcomeUser.memberId = null
        }
        if (welcomeUser.cooperativeId && (!welcomeUser.cooperativeName || welcomeUser.cooperativeName === welcomeUser.cooperativeId)) {
            const coop = await getDocById_Global('cooperatives', String(welcomeUser.cooperativeId)).catch(() => null)
            const name = coop?.full_name || coop?.short_name
            if (name) {
                welcomeUser.cooperativeName = name
                welcomeUser.coopShortName = coop?.short_name || ''
            }
        }
    } catch {
        // repair is best-effort; a partial session is better than no session
    }
    return welcomeUser
}

/**
 * Restore a persisted session from IndexedDB into sessionStorage.
 * Used after sessionStorage is cleared (e.g. browser crash).
 * The restored session is repaired against the local DB (see
 * repairWelcomeUser) and written back so the next restore is clean.
 */
export async function restoreSessionFromIndexedDB() {
    try {
        const session = await loadBestOfflineSession()
        if (!session) return null
        const welcomeUser = sessionToWelcomeUser(session)
        await repairWelcomeUser(welcomeUser)
        // Policy: no dashboard on a weak stored credential. A restored
        // session skips password entry, so re-check the live row here —
        // plaintext hash or explicit flag means fresh login + forced change.
        if (await sessionRequiresPasswordChange(welcomeUser).catch(() => false)) {
            console.warn('[OfflineAuth] Restored session requires password change; forcing fresh login.')
            return null
        }
        // Check if the cooperative's database has been extracted (logins blocked)
        try {
            const { getDocById_Global } = await import('./sqliteService.js')
            const coop = await getDocById_Global('cooperatives', String(welcomeUser.cooperativeId)).catch(() => null)
            if (coop && coop.is_extracted) {
                console.warn('[OfflineAuth] Cooperative is extracted; blocking restored session.')
                return null
            }
        } catch (e) {
            console.warn('[OfflineAuth] Failed to check is_extracted on restore:', e.message)
        }
        // Block unsubscribed/expired accounts from restoring a session —
        // they must go through the login screen to see the polite message.
        try {
            const { getDocById_Global: _getById } = await import('./sqliteService.js')
            const { isSubscriptionBlocked } = await import('./subscriptionService.js')
            const isMember = welcomeUser.role === 'member' || welcomeUser.userCollection === 'members'
            const _id = welcomeUser.userId || welcomeUser.memberId
            if (_id) {
                const row = await _getById(isMember ? 'members' : 'users', String(_id)).catch(() => null)
                if (row && !row.is_deleted && isSubscriptionBlocked(row, welcomeUser.username)) {
                    console.warn('[OfflineAuth] Restored session is unsubscribed; forcing fresh login.')
                    try {
                        const sk = `${session.cooperative_id}_${session.user_id}`
                        const { deleteLocalSession } = await import('./sqliteService.js')
                        await deleteLocalSession(sk).catch(() => {})
                    } catch {}
                    try {
                        window.sessionStorage.setItem(
                            'cooplog-login-blocked-msg',
                            'Your account subscription is inactive. Please contact your administrator for assistance.'
                        )
                    } catch {}
                    return null
                }
            }
        } catch (e) {
            console.warn('[OfflineAuth] Restore subscription check skipped:', e?.message)
        }
        welcomeUser.lastActivityTs = Date.now()
        // Restored members after >10 min idle count as a return visit (+1).
        // Only reachable for persistent (Remember-me) sessions: a session
        // without Remember me has already expired above and never restores.
        // The flag survives the reload below so bootstrap can bump the
        // counter once the DB is ready.
        if (isMemberSession(welcomeUser)) {
            const idleMs = Date.now() - (session.last_verified_ts || 0)
            if (session.last_verified_ts && idleMs > INACTIVITY_TIMEOUT_MS) {
                welcomeUser.__idleReturn = true
            }
        }
        window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(welcomeUser))
        // Persist the repaired snapshots back so future restores are clean
        try {
            await saveLocalSession(`${session.cooperative_id}_${session.user_id}`, {
                ...session,
                cooperative_name: welcomeUser.cooperativeName || session.cooperative_name || '',
                permissions_snapshot: JSON.stringify(welcomeUser.permissions ?? ''),
                enterprises_snapshot: JSON.stringify(welcomeUser.enterprises ?? welcomeUser.enterprise_rights ?? ''),
                full_name: welcomeUser.fullName || session.full_name || '',
                username: welcomeUser.username || session.username || '',
                last_verified_ts: Date.now(),
                // Remember me -> persistent, otherwise restart the 10-min
                // inactivity window from this restore.
                session_expires_ts: expiryForSession(Date.now(), { remembered: !!session.remember }),
            })
        } catch {
            // persist-back is best-effort
        }
        return welcomeUser
    } catch {
        return null
    }
}

/**
 * Save session for both immediate use and long-term offline persistence.
 * `remember` (from the login screen's Remember-me checkbox) grants the
 * persistent session a 30-day life so launches auto-sign-in and the
 * inactivity watcher skips it; otherwise the standard 10-minute inactivity
 * expiry applies. Passwords are never stored.
 */
export async function saveSessionLocally(session, password, remember) {
    if (!session) {
        clearSavedSession()
        return
    }

    // Remember-me flag for the tab session: explicit true/false comes from a
    // login event; undefined means a background re-save (dashboard render,
    // tab switch) — inherit the stored flag so a re-render can never demote a
    // remembered session back to the 10-minute rule.
    let remembered = !!remember
    if (remember === undefined) {
        try {
            const prev = window.sessionStorage.getItem(SYNC_SESSION_KEY)
            if (prev) remembered = !!JSON.parse(prev).remember
        } catch {
            // inherit-best-effort only
        }
    }

    // 1. Sync save for main.js state (stamped so idle sessions can
    // expire; remembered ones never do). Strip the one-shot return flag:
    // a fresh login already counted via validateLogin/validateOfflineLogin.
    const { __idleReturn: _drop, ...sessionSansFlag } = session || {}
    const payload = { ...sessionSansFlag, lastActivityTs: Date.now(), remember: remembered }
    window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(payload))

    // 2. Async save for long-term offline login persistence
    // Map from authService format to offlineAuthService format if needed
    const offlineData = {
        userId: session.userDoc?.id || session.memberId || session.userId,
        userCollection: session.collection || session.userCollection || (session.role === 'member' ? 'members' : 'users'),
        cooperativeId: session.cooperativeId,
        username: session.username,
        role: session.role,
        permissions: session.permissions,
        enterprises: session.enterprises,
        memberId: session.memberId,
        fullName: session.fullName,
        cooperativeName: session.cooperativeName,
        activeTab: session.activeTab || 'history',
        // undefined = not a login event: keep whatever the stored row has
        // (dashboard re-renders must not demote remembered sessions).
        remember,
    }

    // Fire-and-forget: offline persistence is best-effort, non-critical for login
    saveOfflineSession(offlineData).catch(err => {
        console.warn('[OfflineAuth] saveOfflineSession failed (non-critical):', err.message)
    })

    // 3. Save the user document itself to SQLite users/members table
    // This is crucial so validateOfflineLogin can find the password hash later
    if (session.userDoc) {
        try {
            const { saveDoc } = await import('./sqliteService.js')
            // Fire-and-forget; errors are caught internally
            saveDoc(offlineData.userCollection, session.userDoc).catch(err => {
                console.warn('[OfflineAuth] Failed to save userDoc locally (non-critical):', err.message)
            })
        } catch (err) {
            console.warn('[OfflineAuth] Failed to import saveDoc (non-critical):', err.message)
        }
    }
}

/**
 * Wrapper for main.js login flow.
 * Enforces the same progressive back-off as online login (see authService.js:
 * 1-4 free, 5th->1min, 6th->5min, 7-8th->15min, 9th+->1h) and records a single
 * failure per call. Callers that already recorded an online failure for the
 * same tap should pass `skipRecordOnFail=true` to avoid double-counting.
 */
export async function attemptOfflineLogin(username, password, cooperativeId, skipRecordOnFail = false) {
    const normalizedUsername = String(username || '').trim().toLowerCase()
    const coopId = String(cooperativeId || '').trim()
    try {
        const { checkRateLimit, formatDelay } = await import('./authService.js')
        const gate = checkRateLimit(normalizedUsername, coopId)
        if (!gate.allowed) {
            throw new Error(`Too many failed attempts. Try again in ${formatDelay(gate.retryAfterMs)}.`)
        }
    } catch (e) {
        if (e && /too many failed attempts/i.test(e.message || '')) throw e
        // rate-limit storage unavailable — proceed with login
    }
    const { hashPassword } = await import('../utils/formatters.js')
    const pwdHash = await hashPassword(password)
    const session = await validateOfflineLogin(normalizedUsername, pwdHash, cooperativeId, String(password || ''))
    // Preserve the force-change signal: sessionToWelcomeUser only maps full
    // sessions and would strip it, leaving a hollow (all-undefined) user
    // that sails past the modal straight to an Access-Denied dashboard.
    if (session && session.forceChange) return session
    // Blocked accounts (subscription/extracted) surface as sentinel objects
    // so the polite message reaches the login screen instead of a generic
    // "invalid PIN" (validateOfflineLogin never throws — it returns null).
    if (session && session.subscriptionBlocked) {
        const { SUBSCRIPTION_BLOCKED_MSG } = await import('./subscriptionService.js')
        throw new Error(session.subscriptionBlockedMessage || SUBSCRIPTION_BLOCKED_MSG)
    }
    if (session && session.extractedBlocked) {
        throw new Error(session.extractedBlockedMessage || 'This cooperative\'s data has been extracted. Please contact your administrator for assistance.')
    }
    if (!session && !skipRecordOnFail) {
        try {
            const { recordFailedAttempt } = await import('./authService.js')
            recordFailedAttempt(normalizedUsername, coopId)
        } catch {}
    }
    return sessionToWelcomeUser(session)
}

function makeSessionKey(cooperativeId, userId) {
    return `${cooperativeId}_${userId}`
}

/**
 * Generate a secure session token (no password stored).
 */
async function generateSessionToken(userId, cooperativeId) {
    const raw = `${userId}|${cooperativeId}|${Date.now()}|${generateSecureRandom(16)}`
    return hashPassword(raw)
}

/**
 * Save a verified online session to persistent local storage.
 * Called after a successful Firestore login.
 */
export async function saveOfflineSession(sessionData) {
    const {
        userId,
        userCollection,   // 'users' or 'members'
        cooperativeId,
        username,
        role,
        permissions,
        enterprises,
        memberId,
        fullName,
        cooperativeName,
        activeTab,
    } = sessionData

    if (!userId || !cooperativeId) return

    const token = await generateSessionToken(userId, cooperativeId)
    const now = Date.now()
    const sessionKey = makeSessionKey(cooperativeId, userId)
    // Explicit true/false comes from a login event; undefined means a
    // background re-save (e.g. dashboard render) — inherit the stored flag
    // so those never demote a remembered session back to 10 minutes.
    let remembered = !!sessionData.remember
    if (sessionData.remember === undefined) {
        try {
            const existing = await loadLocalSession(sessionKey).catch(() => null)
            if (existing && existing.remember) remembered = true
        } catch {
            // inherit-best-effort only
        }
    }

    await saveLocalSession(sessionKey, {
        user_id: userId,
        user_collection: userCollection || 'users',
        cooperative_id: String(cooperativeId),
        username,
        role,
        permissions_snapshot: JSON.stringify(permissions || ''),
        enterprises_snapshot: JSON.stringify(enterprises || sessionData.enterprise_rights || ''),
        member_id: role === 'member' ? (memberId || userId) : null,
        full_name: fullName || '',
        registration_no: sessionData.registrationNo || sessionData.registration_no || '',
        cooperative_name: cooperativeName || '',
        active_tab: activeTab || 'history',
        session_token: token,
        remember: remembered,
        last_verified_ts: now,
        // Remember me -> persistent; otherwise 10-min inactivity window.
        session_expires_ts: expiryForSession(now, { remembered }),
        created_ts: now,
    })

    return sessionKey
}

/**
 * Load the most recent valid local session.
 * A session is valid while unexpired: 30 days with "Remember me", otherwise
 * 10 minutes of inactivity (sliding, extended by recordActivity/touchSession).
 * Returns null if no valid session exists.
 */
export async function loadBestOfflineSession() {
    try {
        const all = await getAllLocalSessions()
        if (!all || all.length === 0) return null

        const now = Date.now()
        // Filter to non-expired sessions, pick most recently verified
        const valid = all
            .filter(s => s.session_expires_ts > now)
            .sort((a, b) => b.last_verified_ts - a.last_verified_ts)

        return valid.length > 0 ? valid[0] : null
    } catch (err) {
        console.error('[OfflineAuth] Failed to load sessions:', err)
        return null
    }
}

/**
 * Load a specific session by cooperativeId + userId.
 * Expired sessions are deleted (no "Remember me" + 10 min idle, for every
 * user type) so the app cannot resume them.
 */
export async function loadOfflineSession(cooperativeId, userId) {
    try {
        const sessionKey = makeSessionKey(cooperativeId, userId)
        const session = await loadLocalSession(sessionKey)
        if (!session) return null
        if (Date.now() > session.session_expires_ts) {
            await deleteLocalSession(sessionKey)
            return null
        }
        return session
    } catch (err) {
        console.error('[OfflineAuth] loadOfflineSession error:', err)
        return null
    }
}

/**
 * Validate an offline login attempt (no network).
 * Checks local session and local password hash.
 * 
 * @param {string} username
 * @param {string} passwordHash - SHA-256 hash of entered password
 * @param {string} cooperativeId
 * @returns session object or null
 */
export async function validateOfflineLogin(username, passwordHash, cooperativeId, plaintextPassword = '') {
    try {
        const coopId = String(cooperativeId)
        const normalizedInput = String(username || '').toLowerCase()
        const normalizedInputNum = !isNaN(parseInt(normalizedInput, 10)) ? parseInt(normalizedInput, 10) : null;

        let userDoc = null
        let collection = ''

        // 1. Try to find in users table
        const users = await getUsersByUsername(coopId, username)
        const usersByE = await getUserByEmail(coopId, username)
        for (const u of [...users, ...usersByE]) {
            const stored = u.password_hash || ''
            if (stored && (stored === passwordHash || (plaintextPassword && stored === plaintextPassword))) {
                userDoc = u
                collection = 'users'
                break
            }
        }

        // 2. If not in users, try all member fields
        if (!userDoc) {
            const allMembers = await queryRows('SELECT * FROM members WHERE cooperative_id = ? AND is_deleted = 0', [coopId])
            for (const m of allMembers) {
                const fieldsToCheck = [
                    String(m.mobile || ''),
                    String(m.registration_no || ''),
                    String(m.special_id || ''),
                    String(m.email || '')
                ]
                const matches = fieldsToCheck.some(field => {
                    const fieldLower = field.toLowerCase()
                    return fieldLower === normalizedInput || 
                           (normalizedInputNum !== null && String(field) === String(normalizedInputNum))
                })
                if (matches) {
                    const stored = m.password_hash || ''
                    if (stored && (stored === passwordHash || (plaintextPassword && stored === plaintextPassword))) {
                        userDoc = m
                        collection = 'members'
                        break
                    }
                }
            }
        }

        if (!userDoc) return null

        // Check if the cooperative's database has been extracted (logins blocked).
        // Returned as a sentinel (not thrown) because this function's catch-all
        // below would otherwise swallow it into a generic "invalid PIN".
        try {
            const { getDocById_Global } = await import('./sqliteService.js')
            const coop = await getDocById_Global('cooperatives', String(coopId)).catch(() => null)
            if (coop && coop.is_extracted) {
                return { extractedBlocked: true, extractedBlockedMessage: 'This cooperative\'s data has been extracted. Please contact your administrator for assistance.', userDoc, collection };
            }
        } catch (e) {
            if (e && e.extractedBlocked) return e;
            if (e && /extracted/i.test(e.message || '')) {
                return { extractedBlocked: true, extractedBlockedMessage: e.message, userDoc, collection };
            }
            console.warn('[OfflineAuth] Failed to check is_extracted:', e.message)
        }

        // Block unsubscribed/expired accounts completely (admin exempt).
        // Sentinel (not throw) for the same catch-all reason above; the
        // subscription check runs BEFORE force-change so blocked accounts
        // cannot reach the PIN-change modal either.
        try {
            const { isSubscriptionBlocked, SUBSCRIPTION_BLOCKED_MSG } = await import('./subscriptionService.js')
            if (isSubscriptionBlocked(userDoc)) {
                return { subscriptionBlocked: true, subscriptionBlockedMessage: SUBSCRIPTION_BLOCKED_MSG, userDoc, collection };
            }
        } catch (e) {
            if (e && e.subscriptionBlocked) return e;
            console.warn('[OfflineAuth] Subscription gate check skipped:', e?.message)
        }

        // Same PIN policy as online login (see formatters.js): 123456 always
        // requires a change, regardless of whether its stored value is hashed.
        // Other valid PINs and grandfathered passwords keep existing behavior.
        const { needsForceChangeAfterMatch } = await import('../utils/formatters.js')
        if (needsForceChangeAfterMatch(userDoc.password_hash || '', plaintextPassword, userDoc.force_password_change === true)) {
            return { forceChange: true, userDoc, collection };
        }

        if (collection === 'members' && userDoc) {
            const lastLoginStr = new Date().toISOString()
            const currentCount = parseInt(userDoc.login_count || 0, 10)
            const newCount = currentCount + 1
            
            userDoc.last_login = lastLoginStr
            userDoc.login_count = newCount
            
            try {
                const { saveDoc } = await import('./sqliteService.js')
                await saveDoc('members', {
                    ...userDoc,
                    last_login: lastLoginStr,
                    login_count: newCount
                })
            } catch (err) {
                console.warn('[OfflineAuth] Failed to update offline member stats:', err.message)
            }
        }

        // 3. We have a valid user/password. Now find or build a session.
        const userId = userDoc.id
        const sessionKey = makeSessionKey(coopId, userId)
        let session = await loadLocalSession(sessionKey)
        const _now = Date.now()

        if (!session) {
            // Build a "synthetic" session if one doesn't exist.
            // Snapshots come straight from the live local userDoc, and the
            // coop name is resolved locally so restores never show the id.
            const role = collection === 'members' ? 'member' : (userDoc.role || 'user')
            const now = Date.now()
            let coopName = ''
            try {
                const { getDocById_Global } = await import('./sqliteService.js')
                const coop = await getDocById_Global('cooperatives', String(coopId)).catch(() => null)
                coopName = coop?.full_name || coop?.short_name || ''
            } catch {
                // name lookup is best-effort
            }
            session = {
                user_id: userId,
                user_collection: collection,
                cooperative_id: coopId,
                username: userDoc.username || userDoc.mobile,
                role: role,
                permissions_snapshot: JSON.stringify(userDoc.permissions || ''),
                enterprises_snapshot: JSON.stringify(userDoc.enterprise_rights || userDoc.enterprises || ''),
                member_id: collection === 'members' ? userId : null,
                full_name: collection === 'members' 
                    ? `${userDoc.last_name || ''} ${userDoc.first_name || ''} ${userDoc.middle_name || ''}`.trim() || (userDoc.username || userDoc.mobile)
                    : (userDoc.full_name || userDoc.username),
                registration_no: userDoc.registration_no || '',
                cooperative_name: coopName,
                active_tab: 'history',
                session_token: 'offline_' + now,
                last_verified_ts: now,
                session_expires_ts: expiryForSession(now),
                created_ts: now,
            }
            await saveLocalSession(sessionKey, session)
        } else {
            // Refresh snapshots from the live local userDoc on every offline
            // login, so permission/enterprise changes apply without an
            // online round-trip (same repair as restoreSessionFromIndexedDB).
            session.permissions_snapshot = JSON.stringify(userDoc.permissions || '');
            session.enterprises_snapshot = JSON.stringify(userDoc.enterprise_rights || userDoc.enterprises || '');
            session.username = userDoc.username || userDoc.mobile || session.username;
            session.role = collection === 'members' ? 'member' : (userDoc.role || session.role);
            session.full_name = collection === 'members'
                ? (`${userDoc.last_name || ''} ${userDoc.first_name || ''} ${userDoc.middle_name || ''}`.trim() || (userDoc.username || userDoc.mobile))
                : (userDoc.full_name || userDoc.username || session.full_name);
            if (!session.cooperative_name || session.cooperative_name === String(coopId)) {
                try {
                    const { getDocById_Global: _getById } = await import('./sqliteService.js')
                    const _coop = await _getById('cooperatives', String(coopId)).catch(() => null)
                    const _name = _coop?.full_name || _coop?.short_name
                    if (_name) session.cooperative_name = _name
                } catch {
                    // best-effort
                }
            }
            session.last_verified_ts = _now
            // Preserve long-lived remembered sessions; otherwise restart the
            // 10-minute inactivity window.
            session.session_expires_ts = expiryForSession(_now, {
                remembered: !!session.remember,
            })
            await saveLocalSession(sessionKey, session)
        }

        return session
    } catch (err) {
        console.error('[OfflineAuth] validateOfflineLogin error:', err)
        return null
    }
}

/**
 * Revalidate a session against Firestore when internet is available.
 * Checks: user still exists, not deleted, subscription active,
 * permissions/role unchanged.
 * Returns: { valid: true } or { valid: false, reason: string, code: string }
 * Codes: 'SUBSCRIPTION' | 'PERMISSIONS' | 'ROLE' | 'DELETED' | 'NOT_FOUND' | 'COOP_MISMATCH'
 */
export async function revalidateOnline(session) {
    try {
        const { getDb } = await import('../firebase.js')
        const db = getDb()

        // Get userId and coopId from session
        const userId = session.user_id
        const coopId = session.cooperative_id

        // Fetch from Firestore
        let userDoc = null
        if (session.user_collection === 'members') {
            const { getDoc, doc } = await import('../firebase.js')
            const snap = await getDoc(doc(db, 'members', userId))
            if (!snap.exists()) return { valid: false, reason: 'Account not found.', code: 'NOT_FOUND' }
            userDoc = { id: snap.id, ...snap.data() }
        } else {
            const { getDoc, doc } = await import('../firebase.js')
            const snap = await getDoc(doc(db, 'users', userId))
            if (!snap.exists()) return { valid: false, reason: 'Account not found.', code: 'NOT_FOUND' }
            userDoc = { id: snap.id, ...snap.data() }
        }

        // Check deleted
        if (userDoc.is_deleted) return { valid: false, reason: 'Account has been deactivated.', code: 'DELETED' }

        // Check cooperative match
        if (String(userDoc.cooperative_id) !== coopId) {
            return { valid: false, reason: 'Cooperative mismatch.', code: 'COOP_MISMATCH' }
        }

        // Check subscription revoked/expired (admin exempt inside helper).
        try {
            const { isSubscriptionBlocked, SUBSCRIPTION_BLOCKED_MSG } = await import('./subscriptionService.js')
            if (isSubscriptionBlocked(userDoc)) {
                return { valid: false, reason: SUBSCRIPTION_BLOCKED_MSG, code: 'SUBSCRIPTION' }
            }
        } catch {
            // fail-open on helper errors; local policy check covers it later
        }

        // Check permissions changed
        const currentPerms = JSON.stringify(userDoc.permissions || '')
        const storedPerms = session.permissions_snapshot || ''
        if (currentPerms !== storedPerms) {
            return { valid: false, reason: 'Your permissions have changed. Please log in again.', code: 'PERMISSIONS' }
        }

        // Check role changed
        const currentRole = session.user_collection === 'members' ? 'member' : (userDoc.role || 'user')
        if (currentRole !== session.role) {
            return { valid: false, reason: 'Your role has changed. Please log in again.', code: 'ROLE' }
        }

        return { valid: true, userDoc }
    } catch (err) {
        console.error('[OfflineAuth] revalidateOnline error:', err)
        // Network might be flaky — don't invalidate on network errors
        return { valid: true, networkError: true }
    }
}

/**
 * Local policy check for a live session against a fresh users/members row.
 * Used by the background-sync guard (delta pulls update the local row while
 * the user is logged in). Compares the in-memory welcomeUser against the
 * freshly-synced row — NOT against stored snapshots (which lag by design).
 * Returns: null when the session is still valid, else
 * { code: 'SUBSCRIPTION'|'PERMISSIONS'|'ROLE'|'DELETED', message }.
 * Admin (`username === 'admin'`) is exempt from SUBSCRIPTION only.
 */
export async function getSessionPolicyViolation(welcomeUser, freshRow) {
    try {
        if (!welcomeUser || !freshRow) return null
        if (freshRow.is_deleted === 1 || freshRow.is_deleted === true) {
            return { code: 'DELETED', message: 'Account has been deactivated.' }
        }
        const { isSubscriptionBlocked, SUBSCRIPTION_BLOCKED_MSG } = await import('./subscriptionService.js')
        if (isSubscriptionBlocked(freshRow, welcomeUser.username)) {
            return { code: 'SUBSCRIPTION', message: SUBSCRIPTION_BLOCKED_MSG }
        }
        const isMember = welcomeUser.role === 'member' || welcomeUser.userCollection === 'members'
        const liveRole = isMember ? 'member' : (freshRow.role || welcomeUser.role || 'user')
        if (liveRole !== welcomeUser.role) {
            return { code: 'ROLE', message: 'Your role has changed. Please log in again.' }
        }
        if (!isMember) {
            const livePerms = String(freshRow.permissions ?? '')
            const curPerms = String(welcomeUser.permissions ?? '')
            if (livePerms !== curPerms) {
                return { code: 'PERMISSIONS', message: 'Your permissions have changed. Please log in again.' }
            }
        }
        return null
    } catch {
        return null
    }
}

/**
 * Convenience wrapper: loads the current user's fresh row from the local DB
 * and runs getSessionPolicyViolation. Returns null when valid/unknown.
 */
export async function checkCurrentSessionPolicy(welcomeUser) {
    try {
        if (!welcomeUser) return null
        const { getDocById_Global } = await import('./sqliteService.js')
        const isMember = welcomeUser.role === 'member' || welcomeUser.userCollection === 'members'
        const id = welcomeUser.userId || welcomeUser.memberId
        if (!id) return null
        const row = await getDocById_Global(isMember ? 'members' : 'users', String(id)).catch(() => null)
        if (!row) return null
        return getSessionPolicyViolation(welcomeUser, row)
    } catch {
        return null
    }
}

/**
 * Update the last_verified_ts and extend expiry after successful revalidation.
 * Remembered sessions stay persistent; others get a fresh 10-min inactivity
 * window.
 */
export async function touchSession(cooperativeId, userId) {
    const sessionKey = makeSessionKey(cooperativeId, userId)
    const session = await loadLocalSession(sessionKey)
    if (!session) return
    const now = Date.now()
    await saveLocalSession(sessionKey, {
        ...session,
        last_verified_ts: now,
        session_expires_ts: expiryForSession(now, {
            remembered: !!session.remember,
        }),
    })
}

/**
 * Count a member return visit: a member re-opening/refreshing the app after
 * >10 min idle stays logged in (no password entry) but still gets
 * `login_count + 1` and a fresh `last_login` — mirroring a real login.
 * Driven by the `__idleReturn` flag set by loadSavedSession() /
 * restoreSessionFromIndexedDB(). Best-effort: never throws, returns true
 * when a visit was counted.
 */
export async function maybeCountMemberReturnVisit(welcomeUser) {
    try {
        if (!welcomeUser || !welcomeUser.__idleReturn) return false
        if (welcomeUser.role !== 'member') {
            delete welcomeUser.__idleReturn
            return false
        }
        const memberId = welcomeUser.memberId || welcomeUser.userId
        const coopId = welcomeUser.cooperativeId
        if (!memberId || !coopId) {
            delete welcomeUser.__idleReturn
            return false
        }
        const lastLoginStr = new Date().toISOString()
        // 1. Local SQLite (drives reports when offline).
        try {
            const { getDocById_Global, saveDoc } = await import('./sqliteService.js')
            const row = await getDocById_Global('members', String(memberId)).catch(() => null)
            if (row && !row.is_deleted) {
                const newCount = parseInt(row.login_count || welcomeUser.login_count || 0, 10) + 1
                await saveDoc('members', { ...row, last_login: lastLoginStr, login_count: newCount }).catch(() => {})
                welcomeUser.login_count = newCount
                welcomeUser.last_login = lastLoginStr
            }
        } catch (e) {
            console.warn('[OfflineAuth] Member return local count failed:', e?.message)
        }
        // 2. Firestore (best-effort when online; syncs down on next pull).
        try {
            if (typeof navigator === 'undefined' || navigator.onLine) {
                const { getDb, doc, getDoc, updateDoc, serverTimestamp } = await import('../firebase.js')
                const db = getDb()
                const ref = doc(db, 'members', String(memberId))
                let base = parseInt(welcomeUser.login_count || 0, 10)
                try {
                    const snap = await getDoc(ref)
                    if (snap.exists()) {
                        const data = snap.data() || {}
                        const cloudCount = parseInt(data.login_count || 0, 10)
                        if (cloudCount >= base) base = cloudCount + 1
                        else base = base + 1
                    } else {
                        base = base + 1
                    }
                } catch {
                    base = base + 1
                }
                await updateDoc(ref, {
                    cooperative_id: String(coopId),
                    last_login: lastLoginStr,
                    login_count: base,
                    sync_at: serverTimestamp(),
                }).catch(() => {})
                welcomeUser.login_count = base
                welcomeUser.last_login = lastLoginStr
            }
        } catch (e) {
            console.warn('[OfflineAuth] Member return cloud count failed:', e?.message)
        }
        // 3. Refresh the persistent session clock so the next 10-min window
        // starts now (prevents double-counting on immediate refreshes).
        try {
            const key = makeSessionKey(String(coopId), String(memberId))
            const existing = await loadLocalSession(key).catch(() => null)
            if (existing) {
                const now = Date.now()
                await saveLocalSession(key, {
                    ...existing,
                    last_verified_ts: now,
                    session_expires_ts: expiryForSession(now, { remembered: !!existing.remember }),
                }).catch(() => {})
            }
        } catch {}
        // 4. Clear the flag in memory + tab storage.
        delete welcomeUser.__idleReturn
        try {
            const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
            if (raw) {
                const s = JSON.parse(raw)
                if (s.__idleReturn) {
                    delete s.__idleReturn
                    s.lastActivityTs = Date.now()
                    window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(s))
                }
            }
        } catch {}
        return true
    } catch {
        return false
    }
}

/**
 * Remove a specific user's offline session (logout).
 */
export async function clearOfflineSession(cooperativeId, userId) {
    const sessionKey = makeSessionKey(cooperativeId, userId)
    await deleteLocalSession(sessionKey)
}

/**
 * List the cooperatives where the CURRENT logged-in member exists in the
 * local members table — matched by MOBILE ONLY (no PIN check; the member is
 * already authenticated on this device).
 * Returns [{ id, name, memberId }]. Empty when not a member / no mobile.
 */
export async function getMemberCooperatives() {
    try {
        const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
        if (!raw) return []
        const current = JSON.parse(raw)
        if (!isMemberSession(current)) return []
        const myId = current.memberId || current.userId
        if (!myId) return []
        const { getDocById_Global, queryRows } = await import('./sqliteService.js')
        const { normalizePhone } = await import('../utils/normalize.js')
        const me = await getDocById_Global('members', String(myId)).catch(() => null)
        // Fall back to the session username when the row is missing (pruned DB).
        const myMobileKey = normalizePhone(me?.mobile || current.username || '')
        if (!myMobileKey) return []
        const rows = await queryRows(
            'SELECT id, cooperative_id, mobile FROM members WHERE is_deleted = 0'
        ).catch(() => [])
        const byCoop = new Map()
        for (const r of rows || []) {
            if (normalizePhone(r.mobile || '') !== myMobileKey) continue
            const cid = String(r.cooperative_id || '')
            if (!cid || byCoop.has(cid)) continue
            byCoop.set(cid, String(r.id))
        }
        const out = []
        for (const [cid, mid] of byCoop) {
            let name = cid
            try {
                const coop = await getDocById_Global('cooperatives', cid).catch(() => null)
                name = coop?.full_name || coop?.short_name || cid
            } catch {}
            out.push({ id: cid, name, memberId: mid })
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
        return out
    } catch {
        return []
    }
}

/**
 * Stamp legacy sync-queue rows that carry no cooperative_id with the coop of
 * their local document. New rows always carry it (see enqueueWrite); this
 * closes the one leak vector where a Coop A write could be picked up while
 * pushing Coop B's queue (getPendingQueue includes orphans in every scope).
 * Best-effort, never throws.
 */
async function stampQueueCooperativeIds() {
    try {
        const { getAllItems, getItem, putItem } = await import('./indexedDbService.js')
        const q = await getAllItems('sync_queue').catch(() => [])
        for (const item of q || []) {
            if (item.cooperative_id) continue
            if (!item.collection_name || !item.document_id) continue
            try {
                const doc = await getItem(item.collection_name, String(item.document_id)).catch(() => null)
                const cid = doc?.cooperative_id || (item.collection_name === 'cooperatives' ? doc?.id : null)
                if (cid) {
                    item.cooperative_id = String(cid)
                    await putItem('sync_queue', item).catch(() => {})
                }
            } catch {}
        }
    } catch {}
}

/**
 * Switch the active session to another cooperative where the current member
 * exists (mobile match, no PIN re-entry). Storage-level only: pushes the
 * CURRENT coop's queue first when online (leaves it queued when offline),
 * then swaps sessionStorage to the target coop's session.
 *
 * Queue isolation: pushQueue() is strictly per-cooperative_id, the resync
 * wipe is `WHERE cooperative_id = <new>`, and member pruning only touches
 * the new coop — Coop A rows + queued writes are never merged into Coop B.
 * Returns { ok:true, welcomeUser, prevCoopId, pushed } or { ok:false, error }.
 */
export async function switchMemberCooperative(targetCoopId) {
    try {
        const raw = window.sessionStorage.getItem(SYNC_SESSION_KEY)
        if (!raw) return { ok: false, error: 'No active session. Please log in.' }
        const current = JSON.parse(raw)
        if (!isMemberSession(current)) return { ok: false, error: 'Only members can switch cooperative.' }
        const target = String(targetCoopId || '')
        const prevCoopId = String(current.cooperativeId || '')
        if (!target || target === prevCoopId) return { ok: false, error: 'Already on this cooperative.' }

        const coops = await getMemberCooperatives()
        const match = (coops || []).find(c => String(c.id) === target)
        if (!match) return { ok: false, error: 'Your mobile was not found in that cooperative.' }

        // Seal the leak vector: orphan queue rows get their owner's coop id.
        await stampQueueCooperativeIds()

        // Push CURRENT coop's writes when online; leave them queued offline.
        // Strictly scoped: Coop A items can never upload as Coop B items —
        // every item carries its own cooperative_id.
        let pushed = false
        try {
            if (typeof navigator === 'undefined' || navigator.onLine) {
                const { pushQueue } = await import('./syncService.js')
                await pushQueue(prevCoopId).catch(() => {})
                pushed = true
            }
        } catch {}

        const { getDocById_Global } = await import('./sqliteService.js')
        const mrow = await getDocById_Global('members', String(match.memberId)).catch(() => null)
        if (!mrow || mrow.is_deleted) {
            return { ok: false, error: 'Member record not found on this device. Connect to the internet and try again.' }
        }
        // Unsubscribed target accounts cannot be switched into.
        try {
            const { isSubscriptionBlocked, SUBSCRIPTION_BLOCKED_MSG } = await import('./subscriptionService.js')
            if (isSubscriptionBlocked(mrow)) {
                return { ok: false, error: SUBSCRIPTION_BLOCKED_MSG }
            }
        } catch {}

        let sess = await loadOfflineSession(target, String(match.memberId)).catch(() => null)
        const sessExisted = !!sess
        const prevVerifiedTs = sessExisted ? (sess.last_verified_ts || 0) : 0
        const now = Date.now()
        if (sess) {
            // Refresh snapshots from the live local row (same repair as login).
            sess.permissions_snapshot = JSON.stringify(mrow.permissions || '')
            sess.enterprises_snapshot = JSON.stringify(mrow.enterprise_rights || mrow.enterprises || '')
            sess.username = mrow.username || mrow.mobile || sess.username
            sess.role = 'member'
            sess.full_name = (`${mrow.last_name || ''} ${mrow.first_name || ''} ${mrow.middle_name || ''}`.trim()
                || (mrow.username || mrow.mobile || sess.full_name))
            sess.last_verified_ts = now
            sess.session_expires_ts = expiryForSession(now, { remembered: !!sess.remember })
            await saveLocalSession(makeSessionKey(target, String(match.memberId)), sess)
        } else {
            let coopName = target
            try {
                const coop = await getDocById_Global('cooperatives', target).catch(() => null)
                coopName = coop?.full_name || coop?.short_name || target
            } catch {}
            await saveOfflineSession({
                userId: String(match.memberId),
                userCollection: 'members',
                cooperativeId: target,
                username: mrow.username || mrow.mobile,
                role: 'member',
                permissions: mrow.permissions,
                enterprises: mrow.enterprise_rights || mrow.enterprises,
                memberId: String(match.memberId),
                fullName: (`${mrow.last_name || ''} ${mrow.first_name || ''} ${mrow.middle_name || ''}`.trim()
                    || (mrow.username || mrow.mobile)),
                cooperativeName: coopName,
                activeTab: 'dashboard',
                // Carry the login's Remember-me choice: a switch must not turn a
                // persistent session into a 10-minute one (or the reverse).
                remember: !!current.remember,
            })
            sess = await loadOfflineSession(target, String(match.memberId)).catch(() => null)
            if (!sess) return { ok: false, error: 'Could not open that cooperative. Please try again.' }
        }

        const welcomeUser = sessionToWelcomeUser(sess)
        await repairWelcomeUser(welcomeUser)
        welcomeUser.lastActivityTs = Date.now()
        // First-ever visit to this coop OR return after >10 min idle counts +1
        // (counted by maybeCountMemberReturnVisit after the swap, no logout).
        if (!sessExisted || (prevVerifiedTs && now - prevVerifiedTs > INACTIVITY_TIMEOUT_MS)) {
            welcomeUser.__idleReturn = true
        }
        if (welcomeUser.subscriptionStatus === undefined) welcomeUser.subscriptionStatus = 1
        window.sessionStorage.setItem(SYNC_SESSION_KEY, JSON.stringify(welcomeUser))
        try {
            const uname = String(welcomeUser.username || '').toLowerCase()
            if (uname) localStorage.setItem('cooplog-last-coop-' + uname, target)
        } catch {}
        return { ok: true, welcomeUser, prevCoopId, pushed }
    } catch (e) {
        return { ok: false, error: e?.message || 'Could not switch cooperative.' }
    }
}

/**
 * Remove ALL local persistent sessions from IndexedDB.
 * Called on full logout to prevent any session from being restored on refresh.
 */
export async function clearAllOfflineSessions() {
    try {
        const all = await getAllLocalSessions()
        for (const s of all) {
            const sk = `${s.cooperative_id}_${s.user_id}`
            await deleteLocalSession(sk).catch(() => {})
        }
    } catch (e) {
        console.warn('[OfflineAuth] Failed to clear all sessions:', e)
    }
}

/**
 * Convert a local_session row into the app's welcomeUser format.
 */
export function sessionToWelcomeUser(session) {
    if (!session) return null
    const isMember = session.role === 'member'
    return {
        // Staff/admin must have memberId null (like a fresh online login);
        // a spurious memberId would member-scope every dashboard query to zero rows.
        memberId: isMember ? (session.member_id || session.user_id) : null,
        userId: session.user_id,
        userCollection: session.user_collection,
        username: session.username,
        role: session.role,
        permissions: JSON.parse(session.permissions_snapshot || '""'),
        enterprises: JSON.parse(session.enterprises_snapshot || '""'),
        cooperativeId: session.cooperative_id,
        cooperativeName: session.cooperative_name || session.cooperative_id,
        fullName: session.full_name || session.username,
        registrationNo: session.registration_no || '',
        activeTab: session.active_tab || 'history',
        // Carried so sessionStorage (written on restore / coop switch) keeps
        // the persistent-vs-10-min rule.
        remember: !!session.remember,
        isOfflineSession: true,
    }
}

/**
 * Policy check: must this session set a new password before ANY dashboard
 * access — including session restores, which skip password entry?
 * Plaintext storage, a stored hash of 123456, or an explicit flag is
 * sufficient evidence on its own. Fail-open on lookup errors so a broken DB never
 * bricks logins; callers run this only after initDb.
 */
export async function sessionRequiresPasswordChange(welcomeUser) {
    try {
        if (!welcomeUser) return false
        const { getDocById_Global } = await import('./sqliteService.js')
        const { isSha256Hex, hashPassword } = await import('../utils/formatters.js')
        const isMember = welcomeUser.role === 'member' || welcomeUser.userCollection === 'members'
        const collection = isMember ? 'members' : 'users'
        const id = welcomeUser.userId || welcomeUser.memberId
        if (!id) return false
        const row = await getDocById_Global(collection, String(id)).catch(() => null)
        if (!row || row.is_deleted) return false
        const flag = row.force_password_change
        if (flag === true || flag === 1 || flag === '1') return true
        const stored = String(row.password_hash || '')
        if (!isSha256Hex(stored)) return true
        const defaultPinHash = await hashPassword('123456')
        if (stored.toLowerCase() === defaultPinHash.toLowerCase()) return true
        return false
    } catch {
        return false
    }
}

/**
 * Discover which cooperatives a username/mobile has sessions for (offline mode).
 */
export async function discoverCooperativesOffline(username) {
    try {
        const coopIds = new Set()
        const normalizedInput = String(username || '').trim().toLowerCase()
        if (!normalizedInput) return []

        console.log('[OfflineAuth] Discovering cooperatives for:', normalizedInput)

        // 1. Check existing sessions (highest priority for names)
        const allSessions = await getAllLocalSessions()
        const now = Date.now()
        allSessions.forEach(s => {
            if ((s.session_expires_ts > now) && (
                String(s.username || '').toLowerCase() === normalizedInput || 
                String(s.member_id || '').toLowerCase() === normalizedInput || 
                String(s.registration_no || '').toLowerCase() === normalizedInput ||
                String(s.email || '').toLowerCase() === normalizedInput
            )) {
                coopIds.add(String(s.cooperative_id))
            }
        })

        // 2. Check users table (globally)
        const userMatches = await queryRows('SELECT cooperative_id, username, email FROM users WHERE is_deleted = 0')
        userMatches.forEach(u => {
            if (String(u.username || '').toLowerCase() === normalizedInput || String(u.email || '').toLowerCase() === normalizedInput) {
                coopIds.add(String(u.cooperative_id))
            }
        })

        // 3. Check members table (globally) - by mobile, registration_no, special_id, email
        const memberMatches = await queryRows('SELECT cooperative_id, mobile, registration_no, special_id, email FROM members WHERE is_deleted = 0')
        memberMatches.forEach(m => {
            if (
                String(m.mobile || '').toLowerCase() === normalizedInput || 
                String(m.registration_no || '').toLowerCase() === normalizedInput || 
                String(m.special_id || '').toLowerCase() === normalizedInput ||
                String(m.email || '').toLowerCase() === normalizedInput
            ) {
                coopIds.add(String(m.cooperative_id))
            }
        })

        // 4. Look up cooperative names from the cooperatives table
        const allCoops = await queryRows('SELECT id, full_name, short_name FROM cooperatives WHERE is_deleted = 0')
        const coopNameMap = new Map()
        allCoops.forEach(c => coopNameMap.set(String(c.id), c.full_name || c.short_name || c.id))

        const result = Array.from(coopIds).map(id => ({
            id,
            name: coopNameMap.get(id) || id
        }))
        console.log('[OfflineAuth] Discovery results:', result)
        return result
    } catch (err) {
        console.error('[OfflineAuth] discoverCooperativesOffline error:', err)
        return []
    }
}

export async function hasLocalAuthData() {
    try {
        const users = await queryRows('SELECT 1 FROM users WHERE is_deleted = 0 LIMIT 1')
        if (users.length > 0) return true
        const members = await queryRows('SELECT 1 FROM members WHERE is_deleted = 0 LIMIT 1')
        if (members.length > 0) return true
        return false
    } catch {
        return false
    }
}
