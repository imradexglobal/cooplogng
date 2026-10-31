#!/usr/bin/env node
/**
 * patch-coop-SiD9mFKs6g.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot patch for cooperative  SiD9mFKs6g :
 *
 *   1. members collection
 *      - Sets  password_hash  to SHA-256("123456") for every member in the coop
 *      - Sets  force_password_change = true  so members must reset on next login
 *      - Sets  modified_by  = "Imradex Global"
 *      - Sets  modified_at  = now  (ISO string, same shape the app uses)
 *      - Sets  sync_at      = Firestore server timestamp  (triggers device pull)
 *
 *   2. remittance collection
 *      - Sets  bank_name    = "Internal Transfer"  on every remittance in the coop
 *      - Sets  created_by   = "Imradex Global"
 *      - Sets  modified_by  = "Imradex Global"
 *      - Sets  created_at   = now  (ISO string)
 *      - Sets  modified_at  = now  (ISO string)
 *      - Sets  sync_at      = Firestore server timestamp
 *
 * Safety:
 *   - DRY-RUN by default. No writes happen unless you pass  --execute .
 *   - Reads only documents where  cooperative_id == COOP_ID .
 *   - Uses 400-doc Firestore batches (hard limit is 500).
 *   - On any batch error the script exits non-zero with the doc count already
 *     committed — safe to re-run (Firestore where() query only matches
 *     surviving docs; already-patched docs get the same values again which
 *     is harmless).
 *
 * Requirements:
 *   - Node 18+  (native crypto for SHA-256)
 *   - firebase-admin  (already in the project's package.json)
 *   - serviceAccountKey.json next to this script  OR
 *     GOOGLE_APPLICATION_CREDENTIALS env var pointing to the JSON key
 *
 * Usage:
 *   node scripts/patch-coop-SiD9mFKs6g.mjs              ← dry-run (safe preview)
 *   node scripts/patch-coop-SiD9mFKs6g.mjs --execute    ← live write
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── Config ─────────────────────────────────────────────────────────────────

const COOP_ID    = 'SiD9mFKs6g';
const PLAIN_PWD  = '123456';
const MODIFIED_BY = 'Imradex Global';
const CREATED_BY  = 'Imradex Global';
const BANK_NAME  = 'Internal Transfer';
const BATCH_SIZE = 400; // Firestore hard limit is 500; stay safe

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const EXECUTE = args.includes('--execute');

if (!EXECUTE) {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  DRY-RUN mode — nothing will be written to Firestore.   ║');
    console.log('║  Re-run with  --execute  to apply changes.              ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
}

const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    join(dirname(fileURLToPath(import.meta.url)), 'serviceAccountKey.json');

if (!existsSync(KEY_PATH)) {
    console.error(`\n❌  Service account key not found: ${KEY_PATH}`);
    console.error('    Place serviceAccountKey.json next to this script, or set:');
    console.error('    $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\\path\\to\\key.json"');
    process.exit(1);
}

// ─── SHA-256 helper (Node crypto — no browser API needed) ───────────────────

function sha256Hex(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

const PASSWORD_HASH = sha256Hex(PLAIN_PWD);
console.log(`SHA-256("${PLAIN_PWD}") = ${PASSWORD_HASH}\n`);

// ─── Firebase Admin init ─────────────────────────────────────────────────────

const adminNs      = await import('firebase-admin');
const initializeApp = adminNs.initializeApp  ?? adminNs.default?.initializeApp;
const certFn        = adminNs.cert            ?? adminNs.default?.cert;
const { getFirestore, FieldValue } = await import('firebase-admin/firestore');

initializeApp({ credential: certFn(JSON.parse(readFileSync(KEY_PATH, 'utf8'))) });
const db = getFirestore();

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Commit an array of DocumentReferences in ≤BATCH_SIZE chunks. */
async function commitInBatches(refs, buildUpdate, label) {
    if (refs.length === 0) {
        console.log(`  (no ${label} documents found for coop ${COOP_ID})`);
        return;
    }

    console.log(`  Found ${refs.length} ${label} document(s) to patch.`);

    if (!EXECUTE) {
        console.log(`  [DRY-RUN] Would update ${refs.length} ${label} doc(s).`);
        return;
    }

    let done = 0;
    const remaining = [...refs];

    while (remaining.length > 0) {
        const chunk = remaining.splice(0, BATCH_SIZE);
        const batch = db.batch();

        for (const ref of chunk) {
            batch.update(ref, buildUpdate());
        }

        try {
            await batch.commit();
        } catch (err) {
            console.error(`\n❌  Batch failed after ${done}/${refs.length} updates: ${err.message}`);
            console.error('    Re-run --execute to resume (idempotent).');
            process.exit(1);
        }

        done += chunk.length;
        console.log(`    ✔ ${label}: ${done}/${refs.length} updated`);
    }
}

// ─── Timestamp (ISO string matching the app's convention) ───────────────────

const nowIso = new Date().toISOString();

// ════════════════════════════════════════════════════════════════════════════
// 1. Patch  members  collection — reset password_hash
// ════════════════════════════════════════════════════════════════════════════

console.log('── Step 1: members ──────────────────────────────────────────');

const membersSnap = await db
    .collection('members')
    .where('cooperative_id', '==', COOP_ID)
    .get();

const memberRefs = membersSnap.docs.map(d => d.ref);

await commitInBatches(
    memberRefs,
    () => ({
        password_hash:           PASSWORD_HASH,
        force_password_change:   true,        // force re-set on next login
        modified_by:             MODIFIED_BY,
        modified_at:             nowIso,
        sync_at:                 FieldValue.serverTimestamp(),
    }),
    'members'
);

// ════════════════════════════════════════════════════════════════════════════
// 2. Patch  remittance  collection — set bank_name + audit fields
// ════════════════════════════════════════════════════════════════════════════

console.log('\n── Step 2: remittance ───────────────────────────────────────');

const remittanceSnap = await db
    .collection('remittance')
    .where('cooperative_id', '==', COOP_ID)
    .get();

const remittanceRefs = remittanceSnap.docs.map(d => d.ref);

await commitInBatches(
    remittanceRefs,
    () => ({
        bank_name:   BANK_NAME,
        created_by:  CREATED_BY,
        modified_by: MODIFIED_BY,
        created_at:  nowIso,
        modified_at: nowIso,
        sync_at:     FieldValue.serverTimestamp(),
    }),
    'remittance'
);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(62));
if (EXECUTE) {
    console.log(`✅  Done.`);
    console.log(`    members   : password_hash → SHA-256("${PLAIN_PWD}"), force_password_change → true`);
    console.log(`    remittance: bank_name → "${BANK_NAME}"`);
    console.log(`    Both collections: modified_by/created_by → "${MODIFIED_BY}"`);
    console.log(`    All sync_at bumped → devices will pull changes on next delta sync.`);
} else {
    console.log('ℹ️   DRY-RUN complete. No data was changed.');
    console.log('    Re-run with  --execute  to apply the changes.');
}
