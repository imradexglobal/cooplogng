// READ-ONLY probe #3 — ALL coops: post-feature (>=2026-09-13) loan families
// that have charge children but no +ve coop pickup. If zero, there is no bug.
import { readFileSync } from 'node:fs';
import adminNs from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const KEY = 'C:/Users/User/Documents/GitHub/cooplogng/scripts/serviceAccountKey.json';
const initializeApp = adminNs.initializeApp ?? adminNs.default?.initializeApp;
const certFn = adminNs.cert ?? adminNs.default?.cert;
initializeApp({ credential: certFn(JSON.parse(readFileSync(KEY, 'utf8'))) });
const db = getFirestore();

const rows = [];
let last = null;
for (;;) {
  let q = db.collection('remittance').limit(400);
  if (last) q = q.startAfter(last);
  const snap = await q.get();
  if (snap.empty) break;
  rows.push(...snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  last = snap.docs[snap.docs.length - 1];
}
console.log('total remittance docs:', rows.length);

const live = rows.filter((r) => !r.is_deleted);
const byCoop = new Map();
for (const r of live) {
  const c = String(r.cooperative_id || '(none)');
  if (!byCoop.has(c)) byCoop.set(c, []);
  byCoop.get(c).push(r);
}
console.log('coops:', byCoop.size);

// ref id embeds YYYYMMDDHHMMSS; feature landed 2026-09-13
function refDate(ref) {
  const m = String(ref).match(/(20\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return d >= '2026-09-13' ? d : null;
}

let ok = 0;
let bad = 0;
const badSamples = [];
const bankTally = {};

for (const [coop, rs] of byCoop) {
  const kidMap = new Map();
  for (const r of rs) {
    if (r.parent_remittance_id) {
      const p = String(r.parent_remittance_id);
      if (!kidMap.has(p)) kidMap.set(p, []);
      kidMap.get(p).push(r);
    }
  }
  const parents = rs.filter((r) => !r.parent_remittance_id && r.transaction_type === 'Member Loan');
  for (const p of parents) {
    const ref = String(p.id);
    const d = refDate(ref);
    if (!d) continue;
    const kids = (kidMap.get(ref) || []).concat(rs.filter((r) => typeof r.id === 'string' && r.id.startsWith(ref + '-')));
    const charges = kids.filter((k) => k.transaction_type === 'Loan Charges' && String(k.member_id) !== '0000000000');
    if (!charges.length) continue;
    const hasPickup = kids.some((k) => String(k.member_id) === '0000000000');
    const bank = String(p.bank_name || '(blank)');
    const key = `${d.slice(0, 7)} bank=${bank}`;
    bankTally[key] = bankTally[key] || { ok: 0, bad: 0 };
    if (hasPickup) {
      ok++;
      bankTally[key].ok++;
    } else {
      bad++;
      bankTally[key].bad++;
      if (badSamples.length < 15) badSamples.push({ coop, ref, date: d, bank });
    }
  }
}

console.log('\npost-feature loan families WITH pickup:', ok);
console.log('post-feature loan families WITHOUT pickup:', bad);
console.log('\nby month+bank:', JSON.stringify(bankTally, null, 1));
if (badSamples.length) {
  console.log('\nsamples missing pickup:');
  for (const s of badSamples) console.log(`  coop=${s.coop} ref=${s.ref} date=${s.date} bank=${s.bank}`);
}
process.exit(0);
