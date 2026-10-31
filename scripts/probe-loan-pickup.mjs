// READ-ONLY probe: do loan-charge income pickups exist for every loan family?
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import adminNs from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

const KEY = 'C:/Users/User/Documents/GitHub/cooplogng/scripts/serviceAccountKey.json';
const COOP = process.argv[2] || 'SiD9mFKs6g';

const initializeApp = adminNs.initializeApp ?? adminNs.default?.initializeApp;
const certFn = adminNs.cert ?? adminNs.default?.cert;
initializeApp({ credential: certFn(JSON.parse(readFileSync(KEY, 'utf8'))) });
const db = getFirestore();

const snap = await db.collection('remittance').where('cooperative_id', '==', COOP).get();
const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
console.log(`coop ${COOP}: ${rows.length} remittance docs`);

const live = rows.filter(r => !r.is_deleted && r.status === 'Approved');
const byId = new Map(live.map(r => [String(r.id), r]));

// Loan parents = non-autogen rows that own a loan record link or a negative loan header
const childrenOf = new Map();
for (const r of live) {
    if (Number(r.autogen) !== 1) continue;
    const pid = String(r.parent_remittance_id || r.loan_id || '');
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(r);
}

const loanParents = live.filter(r => Number(r.autogen) !== 1 && (r.transaction_type === 'Member Loan' || String(r.id).match(/loan/i)));
console.log(`loan-ish parents: ${loanParents.length}`);

let withPickup = 0, withoutPickup = 0;
const rowsOut = [];
for (const p of loanParents) {
    const kids = childrenOf.get(String(p.id)) || [];
    const charges = kids.filter(k => k.transaction_type === 'Loan Charges' && Number(k.amount) < 0);
    const pickups = kids.filter(k => Number(k.amount) > 0 && String(k.member_id) === '0000000000');
    const otherPos = kids.filter(k => Number(k.amount) > 0);
    const bank = String(p.bank_name || '(blank)');
    if (charges.length > 0) {
        if (pickups.length > 0) withPickup++; else withoutPickup++;
        rowsOut.push({
            bank,
            parent: String(p.id),
            header: Number(p.amount),
            chargeRows: charges.length,
            chargeTotal: Math.round(charges.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0) * 100) / 100,
            pickupRows: pickups.length,
            pickupTotal: Math.round(pickups.reduce((s, c) => s + Number(c.amount || 0), 0) * 100) / 100,
            otherPositive: otherPos.length,
            kids: kids.length
        });
    }
}
console.log(`\nLoan parents that HAVE charge children: ${withPickup + withoutPickup}`);
console.log(`  ...and also have a +ve cooperative pickup: ${withPickup}`);
console.log(`  ...but NO pickup:                           ${withoutPickup}`);

const byBank = {};
for (const r of rowsOut) {
    byBank[r.bank] = byBank[r.bank] || { families: 0, missingPickup: 0, chargeTotals: 0, pickupTotals: 0 };
    byBank[r.bank].families++;
    if (r.pickupRows === 0) byBank[r.bank].missingPickup++;
    byBank[r.bank].chargeTotals += r.chargeTotal;
    byBank[r.bank].pickupTotals += r.pickupTotal;
}
console.log('\nBy parent bank:');
for (const [b, v] of Object.entries(byBank)) {
    console.log(`  ${b.padEnd(24)} families=${String(v.families).padStart(4)}  missingPickup=${String(v.missingPickup).padStart(4)}  charges=${Math.round(v.chargeTotals * 100) / 100}  income=${Math.round(v.pickupTotals * 100) / 100}`);
}

console.log('\nSample families missing a pickup (up to 15):');
for (const r of rowsOut.filter(x => x.pickupRows === 0).slice(0, 15)) {
    console.log(`  bank=${r.bank.padEnd(20)} parent=${r.parent} header=${r.header} charges=${r.chargeRows}(${r.chargeTotal}) kids=${r.kids}`);
}

console.log('\nSample families WITH a pickup (up to 8):');
for (const r of rowsOut.filter(x => x.pickupRows > 0).slice(0, 8)) {
    console.log(`  bank=${r.bank.padEnd(20)} parent=${r.parent} header=${r.header} charges=${r.chargeRows}(${r.chargeTotal}) pickup=${r.pickupRows}(${r.pickupTotal})`);
}

process.exit(0);
