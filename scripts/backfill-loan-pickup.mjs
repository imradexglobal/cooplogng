#!/usr/bin/env node
/**
 * backfill-loan-pickup.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * Backfill the missing "+ve loan-charge income pickup" child for loan families
 * created BEFORE the pickup feature (commit aa6c34d, 2026-09-13).
 *
 * What the feature does today (see remittancePage.js handleSubmit):
 *   parent (principal, negative)
 *     └─ child: Loan Charge        (member debit, negative, category "Loan Asset")
 *     └─ child: pickup             (member 0000000000, POSITIVE, "Loan Income")
 *
 * Legacy families (created before the feature) only have the charge children,
 * and those charges were categorised "Loan Income" (negative) instead of
 * "Loan Asset". So this script does two things per legacy family:
 *
 *   1. Creates one pickup child per loan_id inside the family:
 *        member_id '0000000000', amount = sum(abs(charges)), category
 *        "Loan Income", transaction_type "Loan Charges", autogen 1,
 *        parent_remittance_id = parent ref, bank_name "Internal Transfer".
 *      (Header only, no details — same shape as the app-generated pickup,
 *      e.g. remittance "SiD9mFKs6g-20261027143126-03".)
 *
 *   2. Re-categorises the family's charge children from "Loan Income" to
 *      "Loan Asset" so the family matches the current convention exactly.
 *      (Skip with --keep-legacy-categories; then the pickup merely offsets
 *      the legacy negative income instead of reproducing current behavior.)
 *
 * Families that already have a live pickup child are skipped (idempotent).
 *
 * Safety:
 *   - DRY-RUN by default. No writes happen unless you pass --execute.
 *   - Reads only remittances where cooperative_id == COOP_ID.
 *   - Never touches the parent or the charge amounts — only adds pickup
 *     children and updates the charge rows' category.
 *   - 400-doc Firestore batches (hard limit is 500). Re-run to resume.
 *
 * Accounting impact (read this):
 *   Legacy charges currently post NEGATIVE income (category "Loan Income",
 *   negative amount). After the default backfill (pickup + re-categorise)
 *   those families post POSITIVE income, exactly like new families. The dry
 *   run prints the per-family and total income delta so you can review it.
 *
 * Requirements:
 *   - Node 18+, firebase-admin (in package.json)
 *   - scripts/serviceAccountKey.json OR GOOGLE_APPLICATION_CREDENTIALS
 *
 * Usage:
 *   node scripts/backfill-loan-pickup.mjs                          ← dry run
 *   node scripts/backfill-loan-pickup.mjs --execute                ← live write
 *   node scripts/backfill-loan-pickup.mjs --execute --keep-legacy-categories
 *   node scripts/backfill-loan-pickup.mjs SiD9mFKs6g --execute     ← other coop
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import adminNs from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ─── Config ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const KEEP_LEGACY_CATEGORIES = args.includes('--keep-legacy-categories');
const COOP_ID = args.find((a) => !a.startsWith('--')) || 'SiD9mFKs6g';
const BATCH_SIZE = 400;
const ADMIN_MEMBER_ID = '0000000000';
const PICKUP_CATEGORY = 'Loan Income';
const CHARGE_CATEGORY_NEW = 'Loan Asset';
const CHARGE_CATEGORY_LEGACY = 'Loan Income';

// Feature landed in commit aa6c34d (2026-09-13). Families newer than this
// are expected to already have pickups; they are NOT excluded here (the
// "already has a pickup" check covers them) — the date is only used to
// label families in the dry-run output.
const FEATURE_DATE = '2026-09-13';

// ─── Bootstrap ──────────────────────────────────────────────────────────────

const initializeApp = adminNs.initializeApp ?? adminNs.default?.initializeApp;
const certFn = adminNs.cert ?? adminNs.default?.cert;
const adminEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const adminKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (adminEmail && adminKey) {
  initializeApp({ credential: { privateKey: adminKey, clientEmail: adminEmail } });
} else {
  const keyPath = join(dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');
  if (!existsSync(keyPath)) {
    console.error(`Missing ${keyPath} (or GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY env vars).`);
    process.exit(1);
  }
  initializeApp({ credential: certFn(JSON.parse(readFileSync(keyPath, 'utf8'))) });
}
const db = getFirestore();

// ─── Helpers ────────────────────────────────────────────────────────────────

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

function memberName(m) {
  if (!m) return 'Cooperative Income';
  const full = [m.last_name, m.first_name, m.middle_name].filter(Boolean).join(' ').trim();
  return full || 'Cooperative Income';
}

// Legacy ids embed YYYYMMDDHHMMSS ("SiD9m-20260814141018"); app-generated
// ones embed the coop prefix ("SiD9mFKs6g-20261027143125"). Either way the
// child id is `${parentRef}-NN`, so the parent ref is everything before the
// LAST dash-suffix. Returns the date part for labeling only.
function refDateLabel(ref) {
  const m = String(ref).match(/(20\d{6})/);
  if (!m) return '(no date in id)';
  const d = m[1];
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}${d < FEATURE_DATE.replace(/-/g, '') ? ' (pre-feature)' : ''}`;
}

async function commitBatch(ops) {
  if (ops.length === 0) return;
  let done = 0;
  const remaining = [...ops];
  while (remaining.length > 0) {
    const chunk = remaining.splice(0, BATCH_SIZE);
    const batch = db.batch();
    for (const op of chunk) {
      if (op.type === 'set') batch.set(op.ref, op.data);
      else batch.update(op.ref, op.data);
    }
    try {
      await batch.commit();
    } catch (err) {
      console.error(`\n❌ Batch failed after ${done}/${ops.length} ops: ${err.message}`);
      console.error('    Re-run --execute to resume (idempotent — families with a pickup are skipped).');
      process.exit(1);
    }
    done += chunk.length;
    console.log(`    ✔ ${done}/${ops.length} ops committed`);
  }
}

// ─── Load ───────────────────────────────────────────────────────────────────

console.log(`Loading remittances + members for coop ${COOP_ID}...`);
const [remSnap, memSnap] = await Promise.all([
  db.collection('remittance').where('cooperative_id', '==', COOP_ID).get(),
  db.collection('members').where('cooperative_id', '==', COOP_ID).get(),
]);
const rows = remSnap.docs.map((d) => ({ ref: d.ref, id: d.id, ...d.data() }));
const members = new Map(memSnap.docs.map((d) => [String(d.id), d.data()]));
console.log(`remittances: ${rows.length}, members: ${members.size}`);

// ─── Find legacy families ───────────────────────────────────────────────────

const live = rows.filter((r) => !r.is_deleted);

// Children keyed by parent_remittance_id (primary link) with an id-prefix
// fallback, mirroring remittancePage.js grouping: legacy children (created
// before parent_remittance_id existed) only carry an id like "PARENT-01".
const kidsByParent = new Map();
function attachChild(child) {
  const pid = child.parent_remittance_id ? String(child.parent_remittance_id) : null;
  if (pid) {
    if (!kidsByParent.has(pid)) kidsByParent.set(pid, []);
    kidsByParent.get(pid).push(child);
    return;
  }
  // ID-prefix fallback: child "PARENT-01" (or "PARENT-PICKUP") → parent "PARENT"
  const childId = String(child.id);
  const dashIdx = childId.lastIndexOf('-');
  if (dashIdx > 0) {
    const prefix = childId.substring(0, dashIdx);
    if (!kidsByParent.has(prefix)) kidsByParent.set(prefix, []);
    kidsByParent.get(prefix).push(child);
  }
}
for (const r of live) attachChild(r);
const byId = new Map(live.map((r) => [String(r.id), r]));

const families = [];
for (const [pid, kids] of kidsByParent) {
  const parent = byId.get(pid);
  if (!parent) continue; // orphan children — leave alone
  const charges = kids.filter(
    (k) => k.transaction_type === 'Loan Charges' && String(k.member_id) !== ADMIN_MEMBER_ID
  );
  if (charges.length === 0) continue;
  const hasPickup = kids.some((k) => String(k.member_id) === ADMIN_MEMBER_ID);
  if (hasPickup) continue; // current-convention family — nothing to do
  families.push({ pid, parent, charges });
}

console.log(`\nLoan families with charge children but NO pickup: ${families.length}`);

if (families.length === 0) {
  console.log('Nothing to backfill. ✅');
  process.exit(0);
}

// ─── Plan ───────────────────────────────────────────────────────────────────

const ops = [];
const nowIso = new Date().toISOString();
let totalIncomeDelta = 0; // change to coop income implied by the backfill
const legacyRecat = [];

for (const { pid, parent, charges } of families) {
  const name = memberName(members.get(String(parent.member_id)));
  const dateLabel = refDateLabel(pid);

  // One pickup per loan_id inside the family (current behavior); fall back
  // to a single family-level pickup when legacy rows carry no loan_id.
  const byLoan = new Map();
  for (const c of charges) {
    const lid = c.loan_id ? String(c.loan_id) : '';
    if (!byLoan.has(lid)) byLoan.set(lid, []);
    byLoan.get(lid).push(c);
  }

  let familyDelta = 0;
  const pickups = [];
  let seq = 0;
  for (const [loanId, loanCharges] of byLoan) {
    const total = money(loanCharges.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0));
    if (!(total > 0)) continue;
    seq += 1;
    const suffix = byLoan.size > 1 ? `PICKUP${seq}` : 'PICKUP';
    const pickupId = `${pid}-${suffix}`;
    if (byId.has(pickupId)) continue; // defensive: never overwrite
    pickups.push({
      id: pickupId,
      loanId,
      total,
    });
    familyDelta += total;
  }

  // Income delta: pickup adds +total "Loan Income". Re-categorising a legacy
  // charge row from "Loan Income" to "Loan Asset" removes its -amount from
  // income too, so the per-family delta is total + sum(abs(legacy charges)).
  const legacyCharges = charges.filter((c) => (c.category || PICKUP_CATEGORY) === CHARGE_CATEGORY_LEGACY);
  const recatDelta = KEEP_LEGACY_CATEGORIES
    ? 0
    : money(legacyCharges.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0));
  totalIncomeDelta = money(totalIncomeDelta + familyDelta + recatDelta);

  console.log(
    `\n  family ${pid}  [${dateLabel}]  bank=${parent.bank_name || '(blank)'}  status=${parent.status || 'Pending'}`
  );
  console.log(`    member: ${name} (${parent.member_id})`);
  for (const p of pickups) {
    console.log(`    + pickup ${p.id}  amount +${p.total}${p.loanId ? `  loan_id=${p.loanId}` : '  (no loan_id)'}`);
  }
  if (legacyCharges.length > 0 && !KEEP_LEGACY_CATEGORIES) {
    console.log(`    ~ re-categorise ${legacyCharges.length} charge row(s): "Loan Income" → "${CHARGE_CATEGORY_NEW}"`);
  }

  for (const p of pickups) {
    ops.push({
      type: 'set',
      ref: db.collection('remittance').doc(p.id),
      data: {
        id: p.id,
        cooperative_id: String(parent.cooperative_id || COOP_ID),
        member_id: ADMIN_MEMBER_ID,
        amount: p.total,
        remittance_date: parent.remittance_date ?? nowIso,
        bank_name: 'Internal Transfer',
        transaction_type: 'Loan Charges',
        description: `Auto Loan Charges Income - ${name}`,
        status: parent.status || 'Pending',
        category: PICKUP_CATEGORY,
        cheque_number: '',
        recipient_id: '',
        loan_id: p.loanId || null,
        autogen: 1,
        parent_remittance_id: pid,
        isLoanRequest: false,
        isWithdrawalRequest: false,
        details: [],
        loans: [],
        created_at: nowIso,
        created_by: 'backfill-loan-pickup',
        modified_at: nowIso,
        modified_by: 'backfill-loan-pickup',
        is_deleted: 0,
        is_synced: 0,
        sync_at: FieldValue.serverTimestamp(),
      },
    });
  }

  if (!KEEP_LEGACY_CATEGORIES) {
    for (const c of legacyCharges) {
      legacyRecat.push(c);
      ops.push({
        type: 'update',
        ref: c.ref,
        data: {
          category: CHARGE_CATEGORY_NEW,
          modified_at: nowIso,
          modified_by: 'backfill-loan-pickup',
          is_synced: 0,
          sync_at: FieldValue.serverTimestamp(),
        },
      });
    }
  }
}

console.log(`\n─────────────────────────────────────────────────────────────`);
console.log(`families to backfill : ${families.length}`);
console.log(`pickup children to create : ${ops.filter((o) => o.type === 'set').length}`);
console.log(`charge rows to re-categorise : ${legacyRecat.length}${KEEP_LEGACY_CATEGORIES ? ' (skipped: --keep-legacy-categories)' : ''}`);
console.log(`implied coop-income delta : ${totalIncomeDelta >= 0 ? '+' : ''}${totalIncomeDelta}`);
console.log(`─────────────────────────────────────────────────────────────`);

if (!EXECUTE) {
  console.log(`\n[DRY-RUN] No writes performed. Re-run with --execute to apply.`);
  process.exit(0);
}

await commitBatch(ops);
console.log(`\n✅ Backfill complete: ${families.length} families updated.`);
process.exit(0);
