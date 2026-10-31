// READ-ONLY probe #2 — Member Loan families: charge children vs +ve coop pickup.
// Usage: node scripts/probe-loan-pickup2.mjs [coopId]
import { readFileSync } from 'node:fs';
import adminNs from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const KEY = 'C:/Users/User/Documents/GitHub/cooplogng/scripts/serviceAccountKey.json';
const COOP = process.argv[2] || 'SiD9mFKs6g';

const initializeApp = adminNs.initializeApp ?? adminNs.default?.initializeApp;
const certFn = adminNs.cert ?? adminNs.default?.cert;
initializeApp({ credential: certFn(JSON.parse(readFileSync(KEY, 'utf8'))) });
const db = getFirestore();

const [remSnap, loanSnap] = await Promise.all([
  db.collection('remittance').where('cooperative_id', '==', COOP).get(),
  db.collection('loans').where('cooperative_id', '==', COOP).get(),
]);
const rows = remSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
const loans = loanSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
console.log(`coop ${COOP}: ${rows.length} remittance docs, ${loans.length} loans`);

// NO filters: include deleted, any status, any autogen.
const byId = new Map(rows.map((r) => [String(r.id), r]));
const loanByRem = new Map();
for (const l of loans) if (l.remittance_id) loanByRem.set(String(l.remittance_id), l);

// children = anything with parent_remittance_id OR id prefixed `${ref}-` (bulk flow)
function kidsOf(ref) {
  return rows.filter(
    (r) => String(r.parent_remittance_id || '') === ref || (typeof r.id === 'string' && r.id.startsWith(ref + '-'))
  );
}

const parents = rows.filter(
  (r) => !r.parent_remittance_id && !r.is_deleted && (r.transaction_type === 'Member Loan' || loanByRem.has(String(r.id)))
);
console.log(`Member Loan parents: ${parents.length}`);

const stats = { noLoanRec: 0, noCharges: 0, chargesNoPickup: 0, ok: 0 };
const bankSplit = { internal: { ok: 0, noCharges: 0, noPickup: 0 }, other: { ok: 0, noCharges: 0, noPickup: 0 } };
const noPickupSamples = [];
const noChargeSamples = [];

for (const p of parents) {
  const ref = String(p.id);
  const loanRec = loanByRem.get(ref);
  const kids = kidsOf(ref);
  const charges = kids.filter((k) => k.transaction_type === 'Loan Charges' && String(k.member_id) !== '0000000000' && !k.is_deleted);
  const pickups = kids.filter((k) => String(k.member_id) === '0000000000' && !k.is_deleted);
  const isInt = p.bank_name === 'Internal Transfer';
  const b = isInt ? bankSplit.internal : bankSplit.other;
  if (!loanRec) stats.noLoanRec++;
  if (charges.length === 0) {
    stats.noCharges++;
    b.noCharges++;
    noChargeSamples.push({ ref, bank: p.bank_name, status: p.status, kids: kids.map((k) => `${k.transaction_type}:${k.amount}:${k.member_id}`) });
    continue;
  }
  if (pickups.length === 0) {
    stats.chargesNoPickup++;
    b.noPickup++;
    noPickupSamples.push({
      ref,
      bank: p.bank_name,
      status: p.status,
      amount: p.amount,
      charges: charges.map((c) => `${c.amount}:${c.status ?? ''}${c.is_deleted ? ':DEL' : ''}`),
      loan: loanRec ? `${loanRec.status} principal=${loanRec.principal}` : 'NO LOAN REC',
      allKids: kids.map((k) => `id=${k.id} t=${k.transaction_type} a=${k.amount} m=${k.member_id} del=${!!k.is_deleted}`),
    });
  } else {
    stats.ok++;
    b.ok++;
  }
}

console.log('\n=== Member Loan families (incl. deleted children check) ===');
console.log(`no linked loan record:        ${stats.noLoanRec}`);
console.log(`linked, NO charge children:   ${stats.noCharges}`);
console.log(`charges but NO pickup:        ${stats.chargesNoPickup}`);
console.log(`charges + pickup (ok):        ${stats.ok}`);
console.log(`\nInternal Transfer parents: ok=${bankSplit.internal.ok} noCharges=${bankSplit.internal.noCharges} noPickup=${bankSplit.internal.noPickup}`);
console.log(`Other bank parents:          ok=${bankSplit.other.ok} noCharges=${bankSplit.other.noCharges} noPickup=${bankSplit.other.noPickup}`);

// global pickup census
const pickups = rows.filter((r) => String(r.member_id) === '0000000000');
const census = {};
for (const p of pickups) {
  const k = `${p.transaction_type || '(none)'}|${p.is_deleted ? 'DEL' : 'live'}`;
  census[k] = (census[k] || 0) + 1;
}
console.log(`\nAll member_id=0000000000 rows (${pickups.length}):`, JSON.stringify(census, null, 2));

console.log(`\n=== Samples: charges but NO pickup (${noPickupSamples.length}) ===`);
for (const s of noPickupSamples.slice(0, 6)) {
  console.log(`\nref=${s.ref} bank=${s.bank} status=${s.status} amount=${s.amount}`);
  console.log(`  loan: ${s.loan}`);
  console.log(`  charges: ${s.charges.join(', ')}`);
  for (const line of s.allKids) console.log(`    ${line}`);
}

console.log(`\n=== Samples: NO charge children (${noChargeSamples.length}) ===`);
for (const s of noChargeSamples.slice(0, 6)) {
  console.log(`\nref=${s.ref} bank=${s.bank} status=${s.status} kidCount=${s.kids.length}`);
  for (const line of s.kids.slice(0, 12)) console.log(`    ${line}`);
}

process.exit(0);
