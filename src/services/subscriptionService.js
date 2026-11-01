/**
 * subscriptionService.js
 * Offline-first service for subscription management (members + users).
 *
 * Pattern: local IndexedDB is the source of truth (saveDoc),
 * cloud sync goes through the sync queue (enqueueWrite).
 */

import {
  queryRows,
  getDocById_Global,
  saveDoc,
  enqueueWrite,
} from './sqliteService.js';
import { getDb, doc, updateDoc } from '../firebase.js';

// Subscription status constants (matches members.js / users.js usage)
export const SUBSCRIPTION_STATUS = {
  UNSUBSCRIBED: 0,
  SUBSCRIBED: 1,
};

/**
 * Polite message shown when an unsubscribed/expired account is blocked
 * from logging in (or is signed out mid-session).
 */
export const SUBSCRIPTION_BLOCKED_MSG =
  'Your account subscription is inactive. Please contact your administrator for assistance.';

/**
 * Central login/session gate: does this account doc fail the subscription check?
 * - The built-in `admin` user is always exempt (matches dashboard bypass).
 * - Docs with NO subscription fields (legacy) fail-open to `false` so old
 *   data is never locked out — only explicit opt-outs block.
 * - Explicit `subscriptionStatus` of 0/'0' (or any defined non-1 value) blocks.
 * - A past `expiry_date`/`subscriptionExpiry` blocks even when subscribed.
 * @param {object|null} doc - users/members row (local or Firestore data)
 * @param {string} [usernameOverride] - falls back to doc.username when omitted
 * @param {string} [nowIso] - defaults to current time
 * @returns {boolean} true when the account must be blocked from login/session.
 */
export function isSubscriptionBlocked(doc, usernameOverride, nowIso = new Date().toISOString()) {
  try {
    if (!doc) return false;
    const username = usernameOverride ?? doc.username ?? doc.mobile ?? '';
    // Exempt administrator accounts by role, even when their login name is
    // not literally "admin". Also retain the legacy username exemptions.
    const isAdminUsername = String(username || '').toLowerCase() === 'admin'
      || String(doc.role || '').toLowerCase() === 'admin'
      || (usernameOverride && String(usernameOverride).toLowerCase() === (doc.coopShortName || '').toLowerCase())
    if (isAdminUsername) return false;
    const status = doc.subscriptionStatus;
    const hasStatus = status !== undefined && status !== null && status !== '';
    if (hasStatus) {
      const n = Number(status);
      // Explicit opt-out (0) or any defined value that is not subscribed (1).
      if (n !== 1) return true;
    }
    const expiry = getExpiry(doc) ?? doc.subscriptionExpiry ?? null;
    const expiryDate = expiry ? new Date(expiry) : null;
    if (expiryDate && isNaN(expiryDate.getTime())) return true;
    if (expiryDate && expiryDate < new Date(nowIso)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Get the expiry date from a document (handles expiry_date / subscriptionExpiry).
 */
export function getExpiry(doc) {
  return doc?.expiry_date ?? doc?.subscriptionExpiry ?? null;
}

function isActiveDoc(doc, nowIso) {
  const subscribed =
    doc?.subscriptionStatus === SUBSCRIPTION_STATUS.SUBSCRIBED ||
    doc?.subscriptionStatus === '1' ||
    doc?.subscriptionStatus === 1;
  if (!subscribed) return false;
  const expiry = getExpiry(doc);
  if (!expiry) return true; // subscribed with no expiry counts as active (legacy)
  const expiryDate = new Date(expiry);
  if (isNaN(expiryDate.getTime())) return true;
  return expiryDate >= new Date(nowIso);
}

/**
 * Classify a doc as 'active' | 'expired' | 'inactive'.
 * - active: subscribed && (no expiry || expiry >= now)
 * - expired: subscribed && expiry < now
 * - inactive: not subscribed
 */
export function getSubscriptionState(doc, nowIso = new Date().toISOString()) {
  const subscribed =
    doc?.subscriptionStatus === SUBSCRIPTION_STATUS.SUBSCRIBED ||
    doc?.subscriptionStatus === '1' ||
    doc?.subscriptionStatus === 1;
  if (!subscribed) return 'inactive';
  const expiry = getExpiry(doc);
  const expiryDate = expiry ? new Date(expiry) : null;
  if (expiryDate && isNaN(expiryDate.getTime())) return 'expired';
  if (expiryDate && expiryDate < new Date(nowIso)) return 'expired';
  return 'active';
}

function countStats(rows, nowIso) {
  const stats = { total: rows.length, active: 0, expired: 0, inactive: 0 };
  for (const r of rows) {
    stats[getSubscriptionState(r, nowIso)]++;
  }
  return stats;
}

/**
 * Get subscription statistics for a cooperative (members + users).
 */
export async function getSubscriptionStatistics(cooperativeId) {
  const coopId = String(cooperativeId);
  const nowIso = new Date().toISOString();
  const [members, users] = await Promise.all([
    queryRows('SELECT id, subscriptionStatus, expiry_date FROM members WHERE cooperative_id = ? AND is_deleted = 0', [coopId]).catch(() => []),
    queryRows('SELECT id, subscriptionStatus, expiry_date FROM users WHERE cooperative_id = ? AND is_deleted = 0', [coopId]).catch(() => []),
  ]);
  const memberStats = countStats(members || [], nowIso);
  const userStats = countStats(users || [], nowIso);
  return {
    members: memberStats,
    users: userStats,
    total: {
      total: memberStats.total + userStats.total,
      active: memberStats.active + userStats.active,
      expired: memberStats.expired + userStats.expired,
      inactive: memberStats.inactive + userStats.inactive,
    },
  };
}

function memberDisplayName(m) {
  const full = `${m.last_name || ''} ${m.first_name || ''} ${m.middle_name || ''}`.trim().replace(/\s+/g, ' ');
  return full || m.mobile || m.special_id || m.registration_no_str || m.id;
}

function memberSecondary(m) {
  return m.registration_no_str || (m.registration_no ?? '') || m.mobile || m.special_id || '';
}

/**
 * Get a unified account list for subscription management.
 * @param {string} cooperativeId
 * @param {object} opts - { type: 'all'|'members'|'users', status: 'all'|'active'|'expired'|'inactive', search: string }
 */
export async function getAllAccounts(cooperativeId, opts = {}) {
  const { type = 'all', status = 'all', search = '' } = opts;
  const coopId = String(cooperativeId);
  const nowIso = new Date().toISOString();
  const term = String(search || '').trim().toLowerCase();

  const [members, users] = await Promise.all([
    type === 'users'
      ? []
      : queryRows('SELECT * FROM members WHERE cooperative_id = ? AND is_deleted = 0', [coopId]).catch(() => []),
    type === 'members'
      ? []
      : queryRows('SELECT * FROM users WHERE cooperative_id = ? AND is_deleted = 0', [coopId]).catch(() => []),
  ]);

  const out = [];
  for (const m of members || []) {
    const state = getSubscriptionState(m, nowIso);
    if (status !== 'all' && state !== status) continue;
    out.push({
      collection: 'members',
      id: m.id,
      displayName: memberDisplayName(m),
      secondary: memberSecondary(m),
      detail: m.mobile || m.special_id || '',
      state,
      expiry_date: getExpiry(m),
      isAdmin: false,
      raw: m,
    });
  }
  for (const u of users || []) {
    const state = getSubscriptionState(u, nowIso);
    if (status !== 'all' && state !== status) continue;
    const isAdmin = String(u.username || '').toLowerCase() === 'admin' || String(u.username || '').toLowerCase() === String(u.coopShortName || '').toLowerCase();
    out.push({
      collection: 'users',
      id: u.id,
      displayName: u.username || '',
      secondary: u.role || '',
      detail: u.email || '',
      state: isAdmin ? 'admin' : state,
      expiry_date: getExpiry(u),
      isAdmin,
      raw: u,
    });
  }

  if (term) {
    return out.filter(
      (a) =>
        String(a.displayName || '').toLowerCase().includes(term) ||
        String(a.secondary || '').toLowerCase().includes(term) ||
        String(a.detail || '').toLowerCase().includes(term),
    );
  }
  out.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
  return out;
}

/**
 * Activate a subscription (members or users).
 * Extends current expiry when still active, otherwise +1 year from now.
 */
export async function activateSubscription(collectionName, docId, username, cooperativeId) {
  if (!['members', 'users'].includes(collectionName)) throw new Error(`Unknown collection: ${collectionName}`);
  const existing = await getDocById_Global(collectionName, docId);
  if (!existing) throw new Error('Record not found');

  const now = new Date();
  const nowIso = now.toISOString();
  let expiry = new Date(now);
  expiry.setFullYear(expiry.getFullYear() + 1);
  const currentExpiry = getExpiry(existing);
  if (currentExpiry && String(currentExpiry) >= nowIso) {
    const d = new Date(currentExpiry);
    if (!isNaN(d.getTime())) {
      d.setFullYear(d.getFullYear() + 1);
      expiry = d;
    }
  }
  const expiryIso = expiry.toISOString();

  await saveDoc(collectionName, {
    ...existing,
    subscriptionStatus: SUBSCRIPTION_STATUS.SUBSCRIBED,
    expiry_date: expiryIso,
    modified_at: nowIso,
    modified_by: username || 'system',
    is_synced: 0,
  });

  await enqueueWrite(String(cooperativeId ?? existing.cooperative_id), collectionName, docId, 'update', {
    subscriptionStatus: SUBSCRIPTION_STATUS.SUBSCRIBED,
    expiry_date: expiryIso,
    modified_at: nowIso,
    modified_by: username || 'system',
  });

  // Also write directly to Firestore so the activation is immediately
  // visible to devices doing fresh online logins (not just via the async
  // sync queue). Best-effort: never blocks the activation result.
  try {
    const db = getDb()
    await updateDoc(doc(db, collectionName, String(docId)), {
      subscriptionStatus: SUBSCRIPTION_STATUS.SUBSCRIBED,
      expiry_date: expiryIso,
      modified_at: nowIso,
      modified_by: username || 'system',
    }).catch(() => {})
  } catch {}

  return { success: true, expiry: expiryIso };
}

/**
 * Deactivate a subscription (members or users).
 */
export async function deactivateSubscription(collectionName, docId, username, cooperativeId) {
  if (!['members', 'users'].includes(collectionName)) throw new Error(`Unknown collection: ${collectionName}`);
  const existing = await getDocById_Global(collectionName, docId);
  if (!existing) throw new Error('Record not found');
  const nowIso = new Date().toISOString();

  await saveDoc(collectionName, {
    ...existing,
    subscriptionStatus: SUBSCRIPTION_STATUS.UNSUBSCRIBED,
    expiry_date: null,
    modified_at: nowIso,
    modified_by: username || 'system',
    is_synced: 0,
  });

  await enqueueWrite(String(cooperativeId ?? existing.cooperative_id), collectionName, docId, 'update', {
    subscriptionStatus: SUBSCRIPTION_STATUS.UNSUBSCRIBED,
    expiry_date: null,
    modified_at: nowIso,
    modified_by: username || 'system',
  });

  // Also write directly to Firestore so the deactivation is immediately
  // visible to devices doing fresh online logins. Best-effort only.
  try {
    const db = getDb()
    await updateDoc(doc(db, collectionName, String(docId)), {
      subscriptionStatus: SUBSCRIPTION_STATUS.UNSUBSCRIBED,
      expiry_date: null,
      modified_at: nowIso,
      modified_by: username || 'system',
    }).catch(() => {})
  } catch {}

  return { success: true };
}

/**
 * Bulk activate/deactivate a list of { collection, id } accounts.
 * Admin users collection rows flagged isAdmin are skipped by callers.
 */
export async function bulkSetSubscription(accounts, active, username, cooperativeId) {
  let done = 0;
  const failed = [];
  for (const acc of accounts || []) {
    try {
      if (active) await activateSubscription(acc.collection, acc.id, username, cooperativeId);
      else await deactivateSubscription(acc.collection, acc.id, username, cooperativeId);
      done++;
    } catch (e) {
      failed.push({ ...acc, error: e?.message || String(e) });
    }
  }
  return { done, failed };
}

/**
 * Get subscription status for a member or user.
 */
export async function getSubscriptionStatus(collectionName, docId) {
  const doc = await getDocById_Global(collectionName, docId).catch(() => null);
  if (!doc) return { status: SUBSCRIPTION_STATUS.UNSUBSCRIBED, expiry: null };
  return { status: doc.subscriptionStatus ?? SUBSCRIPTION_STATUS.UNSUBSCRIBED, expiry: getExpiry(doc) };
}
