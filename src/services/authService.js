import { getDb, doc, getDoc, collection, query, where, getDocs, limit, updateDoc, serverTimestamp } from '../firebase.js'
import { isNotDeleted } from './dataService.js'
import { SUBSCRIPTION_BLOCKED_MSG, isSubscriptionBlocked } from './subscriptionService.js'
import { hashPassword, isSha256Hex, needsForceChangeAfterMatch } from '../utils/formatters.js'
import { usernameKey, normalizePhone } from '../utils/normalize.js'

/** Run a Firestore query safely — missing-index errors return [] so login can fall back. */
async function qSafe(promise) {
  try {
    return await promise;
  } catch (e) {
    console.warn('[authService] query failed, falling back:', e?.message || e);
    return { docs: [] };
  }
}

const RATE_LIMIT_KEY = 'cooplog-login-attempts';
// Progressive back-off between failed passcode attempts (per username+coop):
//   Attempts 1-4 -> no delay
//   Attempt 5  -> 1 minute
//   Attempt 6  -> 5 minutes
//   Attempts 7-8 -> 15 minutes
//   Attempt 9+ -> 1 hour (stays at 1 hour until a successful login clears it)
const DELAY_1_MIN = 1 * 60 * 1000;
const DELAY_5_MIN = 5 * 60 * 1000;
const DELAY_15_MIN = 15 * 60 * 1000;
const DELAY_1_HOUR = 60 * 60 * 1000;
const RATE_LIMIT_RESET_MS = 24 * 60 * 60 * 1000; // stale counters reset after 24h

export function getDelayForAttemptCount(count) {
    if (count >= 9) return DELAY_1_HOUR;
    if (count >= 7) return DELAY_15_MIN;
    if (count >= 6) return DELAY_5_MIN;
    if (count >= 5) return DELAY_1_MIN;
    return 0;
}

export function formatDelay(ms) {
    const totalSec = Math.max(1, Math.ceil(ms / 1000));
    if (totalSec < 60) return `${totalSec} second(s)`;
    const mins = Math.ceil(totalSec / 60);
    if (mins < 60) return `${mins} minute(s)`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${hrs} hour(s) ${rem} minute(s)` : `${hrs} hour(s)`;
}

function getRateLimitKey(username, cooperativeId) {
    return `${username.toLowerCase()}|${cooperativeId}`;
}

export function checkRateLimit(username, cooperativeId) {
    try {
        const raw = localStorage.getItem(RATE_LIMIT_KEY);
        if (!raw) return { allowed: true, remaining: 5, attempts: 0, lockoutUntil: 0, retryAfterMs: 0 };
        const data = JSON.parse(raw);
        const key = getRateLimitKey(username, cooperativeId);
        const entry = data[key];
        if (!entry) return { allowed: true, remaining: 5, attempts: 0, lockoutUntil: 0, retryAfterMs: 0 };
        const now = Date.now();
        // Stale counters (no failure in 24h) reset so old mistakes don't haunt users.
        if (entry.lastAttemptTs && now - entry.lastAttemptTs > RATE_LIMIT_RESET_MS) {
            delete data[key];
            try { localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data)); } catch {}
            return { allowed: true, remaining: 5, attempts: 0, lockoutUntil: 0, retryAfterMs: 0 };
        }
        // An active lockout blocks the attempt. Keep the failure count so the
        // next failure after expiry escalates (5->1min, 6->5min, 7-8->15min, 9+->1h).
        if (entry.lockoutUntil && now < entry.lockoutUntil) {
            return {
                allowed: false,
                remaining: 0,
                attempts: entry.count || 0,
                lockoutUntil: entry.lockoutUntil,
                retryAfterMs: entry.lockoutUntil - now,
            };
        }
        // Lock expired: clear the lock but keep the count for escalation.
        if (entry.lockoutUntil && now >= entry.lockoutUntil) {
            entry.lockoutUntil = 0;
            data[key] = entry;
            try { localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data)); } catch {}
        }
        return { allowed: true, remaining: Math.max(0, 5 - (entry.count || 0)), attempts: entry.count || 0, lockoutUntil: 0, retryAfterMs: 0 };
    } catch {
        return { allowed: true, remaining: 5, attempts: 0, lockoutUntil: 0, retryAfterMs: 0 };
    }
}

export function recordFailedAttempt(username, cooperativeId) {
    try {
        const raw = localStorage.getItem(RATE_LIMIT_KEY);
        const data = raw ? JSON.parse(raw) : {};
        const key = getRateLimitKey(username, cooperativeId);
        const entry = data[key] || { count: 0, lockoutUntil: 0, lastAttemptTs: 0 };
        entry.count = (entry.count || 0) + 1;
        entry.lastAttemptTs = Date.now();
        const delay = getDelayForAttemptCount(entry.count);
        if (delay > 0) {
            entry.lockoutUntil = Date.now() + delay;
        }
        data[key] = entry;
        localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data));
        return entry;
    } catch { return null }
}

export function clearRateLimit(username, cooperativeId) {
    try {
        const raw = localStorage.getItem(RATE_LIMIT_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const key = getRateLimitKey(username, cooperativeId);
        delete data[key];
        localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(data));
    } catch { }
}

function isLegacyOrWeakHash(storedHash) {
    // Pre-match check (no verified input yet): force when the flag is set,
    // when nothing is stored, or when the stored value is plain text.
    // Valid hashes defer to the post-match input evaluation in validateLogin.
    if (!storedHash) return true;
    if (!isSha256Hex(storedHash)) return true;
    return false;
}

function docForceFlagSet(foundDoc) {
    return foundDoc && foundDoc.force_password_change === true;
}

// A successful login reads the same cooperative doc twice (extracted-check,
// then display name). Cache the most recent read briefly so the second call is
// free. The security-sensitive extracted check itself NEVER serves from cache —
// it always does a fresh network read and only refreshes the cache.
const _coopDocReadCache = new Map(); // coop id -> { exists, data, fetchedAt }
const COOP_DOC_READ_TTL_MS = 60_000;

async function _readCooperativeDoc(db, cooperativeId) {
  const key = String(cooperativeId);
  const snap = await getDoc(doc(db, 'cooperatives', key));
  const entry = { exists: snap.exists(), data: snap.exists() ? snap.data() : null, fetchedAt: Date.now() };
  try { _coopDocReadCache.set(key, entry); } catch { /* best-effort */ }
  return entry;
}

function _cachedCooperativeDoc(cooperativeId) {
  const hit = _coopDocReadCache.get(String(cooperativeId));
  return hit && Date.now() - hit.fetchedAt < COOP_DOC_READ_TTL_MS ? hit : null;
}

/** Resolve a cooperative's display name (best-effort; falls back to the id). */
async function fetchCooperativeName(db, cooperativeId) {
  try {
    const entry = _cachedCooperativeDoc(cooperativeId) || await _readCooperativeDoc(db, cooperativeId);
    if (entry.exists) {
      const data = entry.data;
      return data.full_name || data.short_name || String(cooperativeId);
    }
  } catch (e) {
    console.warn('[authService] Cooperative name lookup failed:', e?.message || e);
  }
  return String(cooperativeId);
}

/** Check if a cooperative's database has been extracted (logins blocked). */
async function isCooperativeExtracted(db, cooperativeId) {
  try {
    // Always a fresh network read (never the cache): this gates logins.
    const entry = await _readCooperativeDoc(db, cooperativeId);
    if (entry.exists) {
      return entry.data.is_extracted === true;
    }
  } catch (e) {
    console.warn('[authService] Cooperative extracted check failed:', e?.message || e);
  }
  return false;
}

export async function discoverLoginCooperatives(username) {
  const db = getDb()
  const key = usernameKey(username);
  if (!key) return [];

  const cooperativeIds = new Set();
  const collect = (snap) => {
    for (const d of snap.docs) {
      const data = d.data();
      if (isNotDeleted(data) && data.cooperative_id) cooperativeIds.add(data.cooperative_id);
    }
  };

  // Minimal indexed lookups on normalized `_lower` fields (single-field indexes, no composites).
  // Each query is bounded with limit() — a handful of reads instead of full scans.
  const phoneKey = normalizePhone(username);
  const queries = [
    qSafe(getDocs(query(collection(db, 'users'), where('username_lower', '==', key), limit(20)))),
    qSafe(getDocs(query(collection(db, 'users'), where('email_lower', '==', key), limit(10)))),
    qSafe(getDocs(query(collection(db, 'members'), where('special_id_lower', '==', key), limit(20)))),
    qSafe(getDocs(query(collection(db, 'members'), where('email_lower', '==', key), limit(10)))),
    qSafe(getDocs(query(collection(db, 'members'), where('registration_no_str', '==', key), limit(10)))),
  ];
  if (phoneKey) {
    queries.push(qSafe(getDocs(query(collection(db, 'members'), where('mobile', '==', phoneKey), limit(20)))));
  }
  const snaps = await Promise.all(queries);
  snaps.forEach(collect);

  // Transitional fallback for docs written before the backfill ran (no `_lower` fields yet).
  // Bounded legacy lookups — still limit()ed, never a full collection scan.
  if (cooperativeIds.size === 0) {
    const raw = String(username || '').trim();
    const variants = [...new Set([raw.toLowerCase(), raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(), raw.toUpperCase()])];
    const legacy = [];
    for (const v of variants) {
      legacy.push(qSafe(getDocs(query(collection(db, 'users'), where('username', '==', v), limit(5)))));
      legacy.push(qSafe(getDocs(query(collection(db, 'members'), where('mobile', '==', v), limit(5)))));
      legacy.push(qSafe(getDocs(query(collection(db, 'members'), where('registration_no', '==', v), limit(5)))));
      legacy.push(qSafe(getDocs(query(collection(db, 'members'), where('special_id', '==', v), limit(5)))));
    }
    legacy.push(qSafe(getDocs(query(collection(db, 'users'), where('email', '==', key), limit(5)))));
    const legacySnaps = await Promise.all(legacy);
    for (const snap of legacySnaps) {
      for (const d of snap.docs) {
        const data = d.data();
        if (!isNotDeleted(data) || !data.cooperative_id) continue;
        // Verify case-insensitively client-side before accepting legacy match
        const fields = [data.username, data.email, data.mobile, data.registration_no, data.special_id]
          .map(f => String(f ?? '').toLowerCase());
        if (fields.includes(key) || (phoneKey && String(data.mobile ?? '') === phoneKey)) {
          cooperativeIds.add(data.cooperative_id);
        }
      }
    }
  }

  const cooperatives = await fetchCooperativeNames([...cooperativeIds]);
  return cooperatives.sort((left, right) => left.name.localeCompare(right.name));
}

export async function discoverLoginCooperativesByEmail(email) {
  const db = getDb()
  const key = usernameKey(email);
  if (!key) return [];

  const cooperativeIds = new Set();
  const [usersSnap, membersSnap] = await Promise.all([
    qSafe(getDocs(query(collection(db, 'users'), where('email_lower', '==', key), limit(10)))),
    qSafe(getDocs(query(collection(db, 'members'), where('email_lower', '==', key), limit(10)))),
  ]);

  for (const snap of [usersSnap, membersSnap]) {
    for (const d of snap.docs) {
      const data = d.data();
      if (isNotDeleted(data) && data.cooperative_id) cooperativeIds.add(data.cooperative_id);
    }
  }
  // Legacy fallback (pre-backfill docs without email_lower)
  if (cooperativeIds.size === 0) {
    const [lu, lm] = await Promise.all([
      qSafe(getDocs(query(collection(db, 'users'), where('email', '==', key), limit(5)))),
      qSafe(getDocs(query(collection(db, 'members'), where('email', '==', key), limit(5)))),
    ]);
    for (const snap of [lu, lm]) {
      for (const d of snap.docs) {
        const data = d.data();
        if (isNotDeleted(data) && String(data.email || '').toLowerCase() === key && data.cooperative_id) {
          cooperativeIds.add(data.cooperative_id);
        }
      }
    }
  }

  const cooperatives = await fetchCooperativeNames([...cooperativeIds]);
  return cooperatives.sort((left, right) => left.name.localeCompare(right.name));
}

// Shared cooperative directory: the login search and the public join page both
// need the full cooperatives list. Previously each one fetched the ENTIRE
// unbounded collection from Firestore on every keystroke (400 ms debounce) /
// every screen render. Cache it briefly (memory + localStorage, best-effort)
// and serve subsequent requests locally — the client-side filtering and the
// returned shapes are unchanged, and a failed refresh still throws exactly as
// the old direct getDocs did.
const DIRECTORY_CACHE_KEY = 'cooplog-coop-directory';
const DIRECTORY_TTL_MS = 300_000; // 5 minutes
let _directoryMemCache = null; // { ts, list }
let _directoryInFlight = null;

function _loadCachedDirectory() {
  if (_directoryMemCache && Date.now() - _directoryMemCache.ts <= DIRECTORY_TTL_MS) {
    return _directoryMemCache.list;
  }
  try {
    const raw = localStorage.getItem(DIRECTORY_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.list) && Number.isFinite(parsed.ts) && Date.now() - parsed.ts <= DIRECTORY_TTL_MS) {
        _directoryMemCache = { ts: parsed.ts, list: parsed.list };
        return parsed.list;
      }
    }
  } catch { /* storage unavailable */ }
  return null;
}

function _saveCachedDirectory(list) {
  _directoryMemCache = { ts: Date.now(), list };
  try {
    localStorage.setItem(DIRECTORY_CACHE_KEY, JSON.stringify(_directoryMemCache));
  } catch { /* quota exceeded – memory cache still serves this session */ }
}

/**
 * Full cooperatives list (raw fields + id), from cache when fresh, otherwise
 * one network read shared by concurrent callers.
 */
export async function getAllCooperativesCached() {
  const cached = _loadCachedDirectory();
  if (cached) return cached;
  if (!_directoryInFlight) {
    const run = (async () => {
      const db = getDb();
      const snap = await getDocs(collection(db, 'cooperatives'));
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _saveCachedDirectory(list);
      return list;
    })();
    _directoryInFlight = run;
    const done = () => { if (_directoryInFlight === run) _directoryInFlight = null; };
    run.then(done, done);
  }
  return _directoryInFlight;
}

export async function searchAllCooperatives(searchTerm) {
  const cooperativesSnap = await getAllCooperativesCached();
  const term = String(searchTerm || '').toLowerCase()

  return cooperativesSnap
    .filter(data => {
      const name = String(data.full_name || data.short_name || '').toLowerCase()
      return name.includes(term)
    })
    .map(data => ({
      id: data.id,
      name: data.full_name || data.short_name || data.id
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

const COOP_CACHE_KEY = 'cooplog-coop-names';
const COOP_CACHE_TTL = 300_000; // 5 minutes

function loadCachedCooperativeNames() {
  try {
    const raw = localStorage.getItem(COOP_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.ts > COOP_CACHE_TTL) {
      localStorage.removeItem(COOP_CACHE_KEY);
      return null;
    }
    return cached.data;
  } catch { return null }
}

function saveCachedCooperativeNames(data) {
  try {
    localStorage.setItem(COOP_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota exceeded – ignore */ }
}

async function fetchCooperativeNames(ids) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];

  // Check cache for hit
  const cached = loadCachedCooperativeNames();
  const cacheMap = cached ? new Map(cached.map(c => [c.id, c])) : new Map();
  const missing = uniqueIds.filter(id => !cacheMap.has(id));

  if (missing.length > 0) {
    const db = getDb()
    const fetched = await Promise.all(missing.map(async (id) => {
      const docRef = doc(db, 'cooperatives', String(id))
      const docSnap = await getDoc(docRef)
      const data = docSnap.exists() ? docSnap.data() : {}
      return { id, name: data.full_name || data.short_name || id }
    }));
    for (const c of fetched) cacheMap.set(c.id, c);
    saveCachedCooperativeNames([...cacheMap.values()]);
  }

  return uniqueIds.map(id => cacheMap.get(id)).filter(Boolean);
}

export async function validateGoogleLogin(email, cooperativeId) {
  const db = getDb()
  const key = usernameKey(email);
  const normalizedCooperativeId = String(cooperativeId || '').trim();

  if (!key || !normalizedCooperativeId) return null;

  // Minimal: 2 indexed lookups instead of downloading the whole cooperative.
  const [usersSnap, membersSnap] = await Promise.all([
    qSafe(getDocs(query(
      collection(db, 'users'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('email_lower', '==', key),
      limit(2)
    ))),
    qSafe(getDocs(query(
      collection(db, 'members'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('email_lower', '==', key),
      limit(2)
    ))),
  ]);

  let foundDoc = null;
  let collectionName = '';

  for (const d of usersSnap.docs) {
    const data = d.data();
    if (isNotDeleted(data) && String(data.email || '').toLowerCase() === key) {
      foundDoc = { id: d.id, ...data };
      collectionName = 'users';
      break;
    }
  }

  if (!foundDoc) {
    for (const d of membersSnap.docs) {
      const data = d.data();
      if (isNotDeleted(data) && String(data.email || '').toLowerCase() === key) {
        foundDoc = { id: d.id, ...data };
        collectionName = 'members';
        break;
      }
    }
  }

  // Legacy fallback for pre-backfill docs without email_lower
  if (!foundDoc) {
    const [lu, lm] = await Promise.all([
      qSafe(getDocs(query(
        collection(db, 'users'),
        where('cooperative_id', '==', normalizedCooperativeId),
        where('email', '==', key),
        limit(2)
      ))),
      qSafe(getDocs(query(
        collection(db, 'members'),
        where('cooperative_id', '==', normalizedCooperativeId),
        where('email', '==', key),
        limit(2)
      ))),
    ]);
    for (const d of lu.docs) {
      const data = d.data();
      if (isNotDeleted(data) && String(data.email || '').toLowerCase() === key) {
        foundDoc = { id: d.id, ...data };
        collectionName = 'users';
        break;
      }
    }
    if (!foundDoc) {
      for (const d of lm.docs) {
        const data = d.data();
        if (isNotDeleted(data) && String(data.email || '').toLowerCase() === key) {
          foundDoc = { id: d.id, ...data };
          collectionName = 'members';
          break;
        }
      }
    }
  }

  if (foundDoc) {
    clearRateLimit(key, normalizedCooperativeId);

    // Check if the cooperative's database has been extracted (logins blocked)
    if (await isCooperativeExtracted(db, normalizedCooperativeId)) {
      throw new Error('This cooperative\'s data has been extracted. Please contact your administrator for assistance.');
    }

    // Block unsubscribed/expired accounts completely (admin exempt).
    if (isSubscriptionBlocked(foundDoc)) {
      throw new Error(SUBSCRIPTION_BLOCKED_MSG);
    }

    const stored = foundDoc.password_hash || '';
    // Google flow has no typed password: force on explicit flag or non-hash storage.
    // Grandfathered legacy-complex hashes pass without a change.
    if (docForceFlagSet(foundDoc) || isLegacyOrWeakHash(stored)) {
      return { forceChange: true, userDoc: foundDoc, collection: collectionName, subscriptionStatus: foundDoc.subscriptionStatus, subscriptionExpiry: foundDoc.expiry_date };
    }

    const role = collectionName === 'members' ? 'member' : (foundDoc.role || 'user');
    const fullName = collectionName === 'members' 
      ? `${foundDoc.last_name || ''} ${foundDoc.first_name || ''} ${foundDoc.middle_name || ''}`.trim()
      : (foundDoc.full_name || foundDoc.username);

    if (collectionName === 'members') {
      const lastLoginStr = new Date().toISOString();
      const currentCount = parseInt(foundDoc.login_count || 0, 10);
      const newCount = currentCount + 1;
      
      foundDoc.last_login = lastLoginStr;
      foundDoc.login_count = newCount;
      
      try {
        const mRef = doc(db, 'members', foundDoc.id);
        await updateDoc(mRef, {
          cooperative_id: String(foundDoc.cooperative_id),
          last_login: lastLoginStr,
          login_count: newCount,
          sync_at: serverTimestamp()
        });
      } catch (err) {
        console.warn('[authService] Failed to update member login stats in Firestore:', err.message);
      }
    }

    return {
      memberId: collectionName === 'members' ? foundDoc.id : null,
      username: foundDoc.username || foundDoc.mobile || foundDoc.email,
      fullName: fullName || foundDoc.full_name || foundDoc.username || foundDoc.mobile || 'User',
      role,
      permissions: foundDoc.permissions || '',
      enterprises: foundDoc.enterprise_rights || foundDoc.enterprises || '',
      cooperativeId: foundDoc.cooperative_id,
      cooperativeName: await fetchCooperativeName(db, foundDoc.cooperative_id),
      userDoc: foundDoc,
      collection: collectionName,
      subscriptionStatus: foundDoc.subscriptionStatus,
      subscriptionExpiry: foundDoc.expiry_date
    }
  }
  return null;
}

/** Normalize a person name for link comparison (case-insensitive, trimmed). */
export function normalizeLinkName(val) {
  return String(val ?? '').trim().toLowerCase();
}

/**
 * Score a member doc against typed identity details.
 * Rule: mobile MUST match (normalized) AND (last_name OR first_name must match).
 * Returns { mobileOk, lastOk, firstOk, matched } where matched = mobileOk && (lastOk || firstOk).
 */
export function verifyMemberLinkCandidate(memberDoc, { mobile, firstName, lastName }) {
  const expectedMobile = normalizePhone(mobile);
  const mobileOk = !!expectedMobile && normalizePhone(memberDoc?.mobile) === expectedMobile;
  const lastOk = !!normalizeLinkName(lastName) && normalizeLinkName(memberDoc?.last_name) === normalizeLinkName(lastName);
  const firstOk = !!normalizeLinkName(firstName) && normalizeLinkName(memberDoc?.first_name) === normalizeLinkName(firstName);
  return { mobileOk, lastOk, firstOk, matched: mobileOk && (lastOk || firstOk) };
}

/**
 * Find all cooperatives that have a member with this mobile number.
 * Bounded single-field query on `mobile` — no composite index needed.
 * Returns [{ id, name }] sorted by name.
 */
export async function discoverCooperativesByMobile(mobile) {
  const db = getDb();
  const phoneKey = normalizePhone(mobile);
  if (!phoneKey) return [];
  const rawDigits = String(mobile ?? '').replace(/\D/g, '');

  const queries = [qSafe(getDocs(query(collection(db, 'members'), where('mobile', '==', phoneKey), limit(50))))];
  if (rawDigits && rawDigits !== phoneKey) {
    queries.push(qSafe(getDocs(query(collection(db, 'members'), where('mobile', '==', rawDigits), limit(50)))));
  }
  const snaps = await Promise.all(queries);
  const cooperativeIds = new Set();
  for (const snap of snaps) {
    for (const d of snap.docs) {
      const data = d.data();
      if (!isNotDeleted(data) || !data.cooperative_id) continue;
      // Client-side re-check: stored value must normalize to the same key.
      if (normalizePhone(data.mobile) === phoneKey) cooperativeIds.add(data.cooperative_id);
    }
  }
  const cooperatives = await fetchCooperativeNames([...cooperativeIds]);
  return cooperatives.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Fetch non-deleted member docs in one cooperative whose mobile matches.
 * Used by the Google-link step to run the 2-of-3 name check + duplicate guard.
 */
export async function fetchMemberCandidatesByMobileForCoop(mobile, cooperativeId) {
  const db = getDb();
  const phoneKey = normalizePhone(mobile);
  const normalizedCooperativeId = String(cooperativeId || '').trim();
  if (!phoneKey || !normalizedCooperativeId) return [];
  const rawDigits = String(mobile ?? '').replace(/\D/g, '');

  const attempts = [qSafe(getDocs(query(
    collection(db, 'members'),
    where('cooperative_id', '==', normalizedCooperativeId),
    where('mobile', '==', phoneKey),
    limit(10)
  )))];
  if (rawDigits && rawDigits !== phoneKey) {
    attempts.push(qSafe(getDocs(query(
      collection(db, 'members'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('mobile', '==', rawDigits),
      limit(10)
    ))));
  }
  const snaps = await Promise.all(attempts);
  const out = [];
  const seen = new Set();
  for (const snap of snaps) {
    for (const d of snap.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const data = d.data();
      if (!isNotDeleted(data)) continue;
      if (String(data.cooperative_id || '') !== normalizedCooperativeId) continue;
      if (normalizePhone(data.mobile) !== phoneKey) continue;
      out.push({ id: d.id, ...data });
    }
  }
  return out;
}

/**
 * Link a Google-verified email onto a member doc (overwrite policy).
 * Stores both `email` and `email_lower` so the next Google sign-in
 * hits the fast path in discoverLoginCooperativesByEmail/validateGoogleLogin.
 */
export async function linkGoogleEmailToMember(memberId, cooperativeId, verifiedEmail) {
  const db = getDb();
  const email = String(verifiedEmail || '').trim().toLowerCase();
  const normalizedCooperativeId = String(cooperativeId || '').trim();
  if (!memberId || !normalizedCooperativeId || !email || !email.includes('@')) {
    throw new Error('A valid email and cooperative are required to link this account.');
  }
  const nowIso = new Date().toISOString();
  await updateDoc(doc(db, 'members', String(memberId)), {
    cooperative_id: normalizedCooperativeId,
    email,
    email_lower: email,
    modified_at: nowIso,
    modified_by: 'google-link',
    sync_at: serverTimestamp(),
  });
  return email;
}

export async function validateLogin(username, password, cooperativeId) {
  const db = getDb()
  const key = usernameKey(username);
  const normalizedPassword = String(password || '');
  const normalizedCooperativeId = String(cooperativeId || '').trim();

  if (!key || !normalizedPassword || !normalizedCooperativeId) return null;

  const rateLimit = checkRateLimit(key, normalizedCooperativeId);
  if (!rateLimit.allowed) {
    throw new Error(`Too many failed attempts. Try again in ${formatDelay(rateLimit.retryAfterMs)}.`);
  }

  const hashedInput = await hashPassword(normalizedPassword);
  const phoneKey = normalizePhone(username);

  // Minimal: targeted `username == input` style lookups (bounded, ~6 queries x limit 2).
  // NOTE: composite indexes on (cooperative_id + *_lower) are required — the
  // first failed run logs a Firebase console link to create them with one click.
  const qUsers = [
    qSafe(getDocs(query(
      collection(db, 'users'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('username_lower', '==', key),
      limit(2)
    ))),
    qSafe(getDocs(query(
      collection(db, 'users'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('email_lower', '==', key),
      limit(2)
    ))),
  ];
  const qMembers = [
    qSafe(getDocs(query(
      collection(db, 'members'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('special_id_lower', '==', key),
      limit(2)
    ))),
    qSafe(getDocs(query(
      collection(db, 'members'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('email_lower', '==', key),
      limit(2)
    ))),
    qSafe(getDocs(query(
      collection(db, 'members'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('registration_no_str', '==', key),
      limit(2)
    ))),
  ];
  if (phoneKey) {
    qMembers.push(qSafe(getDocs(query(
      collection(db, 'members'),
      where('cooperative_id', '==', normalizedCooperativeId),
      where('mobile', '==', phoneKey),
      limit(2)
    ))));
  }

  const [userSnaps, memberSnaps] = await Promise.all([
    Promise.all(qUsers),
    Promise.all(qMembers),
  ]);

  let foundDoc = null;
  let collectionName = '';

  const matchUser = (data) => {
    if (!isNotDeleted(data)) return false;
    return String(data.username || '').toLowerCase() === key ||
           String(data.email || '').toLowerCase() === key ||
           (data.username_lower && data.username_lower === key) ||
           (data.email_lower && data.email_lower === key);
  };
  const matchMember = (data) => {
    if (!isNotDeleted(data)) return false;
    if ((data.special_id_lower && data.special_id_lower === key) ||
        (data.email_lower && data.email_lower === key) ||
        (data.registration_no_str && data.registration_no_str === key)) return true;
    const fields = [
      String(data.mobile || ''),
      String(data.registration_no || '').toLowerCase(),
      String(data.special_id || '').toLowerCase(),
      String(data.email || '').toLowerCase(),
    ];
    return fields.includes(key) || (phoneKey && String(data.mobile || '') === phoneKey);
  };

  for (const snap of userSnaps) {
    for (const d of snap.docs) {
      const data = d.data();
      if (matchUser(data)) {
        foundDoc = { id: d.id, ...data };
        collectionName = 'users';
        break;
      }
    }
    if (foundDoc) break;
  }

  if (!foundDoc) {
    for (const snap of memberSnaps) {
      for (const d of snap.docs) {
        const data = d.data();
        if (matchMember(data)) {
          foundDoc = { id: d.id, ...data };
          collectionName = 'members';
          break;
        }
      }
      if (foundDoc) break;
    }
  }

  // Fallback when composite indexes aren't built yet (or pre-backfill docs):
  // global `_lower` lookups + client-side cooperative filter. Bounded, no full scans.
  if (!foundDoc) {
    const [gu, gm] = await Promise.all([
      Promise.all([
        qSafe(getDocs(query(collection(db, 'users'), where('username_lower', '==', key), limit(50)))),
        qSafe(getDocs(query(collection(db, 'users'), where('email_lower', '==', key), limit(20)))),
      ]),
      Promise.all([
        qSafe(getDocs(query(collection(db, 'members'), where('special_id_lower', '==', key), limit(50)))),
        qSafe(getDocs(query(collection(db, 'members'), where('email_lower', '==', key), limit(20)))),
        qSafe(getDocs(query(collection(db, 'members'), where('registration_no_str', '==', key), limit(20)))),
        ...(phoneKey ? [qSafe(getDocs(query(collection(db, 'members'), where('mobile', '==', phoneKey), limit(50))))] : []),
      ]),
    ]);
    for (const snap of gu) {
      for (const d of snap.docs) {
        const data = d.data();
        if (String(data.cooperative_id || '') !== normalizedCooperativeId) continue;
        if (matchUser(data)) {
          foundDoc = { id: d.id, ...data };
          collectionName = 'users';
          break;
        }
      }
      if (foundDoc) break;
    }
    if (!foundDoc) {
      for (const snap of gm) {
        for (const d of snap.docs) {
          const data = d.data();
          if (String(data.cooperative_id || '') !== normalizedCooperativeId) continue;
          if (matchMember(data)) {
            foundDoc = { id: d.id, ...data };
            collectionName = 'members';
            break;
          }
        }
        if (foundDoc) break;
      }
    }
  }

  if (foundDoc) {
    const stored = foundDoc.password_hash || '';
    const isMatch = stored === hashedInput || stored === normalizedPassword;

    if (isMatch) {
      clearRateLimit(key, normalizedCooperativeId);

      // Check if the cooperative's database has been extracted (logins blocked)
      if (await isCooperativeExtracted(db, normalizedCooperativeId)) {
        throw new Error('This cooperative\'s data has been extracted. Please contact your administrator for assistance.');
      }

      // Block unsubscribed/expired accounts completely (admin exempt).
      if (isSubscriptionBlocked(foundDoc)) {
        throw new Error(SUBSCRIPTION_BLOCKED_MSG);
      }

      // The temporary PIN 123456 always forces a password change, even if its
      // stored hash verifies. Other valid PINs and grandfathered passwords
      // pass unless the explicit force-change flag requires a change.
      if (needsForceChangeAfterMatch(stored, normalizedPassword, docForceFlagSet(foundDoc))) {
        return { forceChange: true, userDoc: foundDoc, collection: collectionName, subscriptionStatus: foundDoc.subscriptionStatus, subscriptionExpiry: foundDoc.expiry_date };
      }

      const role = collectionName === 'members' ? 'member' : (foundDoc.role || 'user');
      const fullName = collectionName === 'members' 
        ? `${foundDoc.last_name || ''} ${foundDoc.first_name || ''} ${foundDoc.middle_name || ''}`.trim()
        : (foundDoc.full_name || foundDoc.username);

      if (collectionName === 'members') {
        const lastLoginStr = new Date().toISOString();
        const currentCount = parseInt(foundDoc.login_count || 0, 10);
        const newCount = currentCount + 1;
        
        foundDoc.last_login = lastLoginStr;
        foundDoc.login_count = newCount;
        
        try {
          const mRef = doc(db, 'members', foundDoc.id);
          await updateDoc(mRef, {
            cooperative_id: String(foundDoc.cooperative_id),
            last_login: lastLoginStr,
            login_count: newCount,
            sync_at: serverTimestamp()
          });
        } catch (err) {
          console.warn('[authService] Failed to update member login stats in Firestore:', err.message);
        }
      }

      return {
        memberId: collectionName === 'members' ? foundDoc.id : null,
        username: foundDoc.username || foundDoc.mobile || foundDoc.email,
        fullName: fullName || foundDoc.full_name || foundDoc.username || foundDoc.mobile || 'User',
        role,
        permissions: foundDoc.permissions || '',
        enterprises: foundDoc.enterprise_rights || foundDoc.enterprises || '',
        cooperativeId: foundDoc.cooperative_id,
        cooperativeName: await fetchCooperativeName(db, foundDoc.cooperative_id),
        userDoc: foundDoc,
        collection: collectionName,
        subscriptionStatus: foundDoc.subscriptionStatus,
        subscriptionExpiry: foundDoc.expiry_date
      }
    }
  }

  recordFailedAttempt(key, normalizedCooperativeId);
  return null;
}