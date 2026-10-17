// Shared dues/penalty settlement-transfer helpers (live single + bulk flows
// and the Dev. Audit backfill). The transfer is the 4th record of the group:
//
//   Header member = 0
//   Detail = -XXX from the parent's savings line(s) + +XXX split per due/penalty
//   enterprise (one record covers all charges of the parent).
//
// Net-zero header, so member totals don't double-count: it documents that the
// dues were funded out of this payment's savings. Same family conventions as
// the DUE/INCOME children (autogen=1, loan_id=parent id, Internal Transfer)
// so approve/decline/delete/reverse cascades follow the parent.
//
// The INCOME pickup (Child B) now uses the enterprise name as transaction type
// dynamically: if the enterprise is marked revenue, classification is
// "Operating Income"; otherwise "Member Liability".
import { generateId } from '../../utils/formatters.js';
import { addRemittance } from './remittances.js';
import { getDocById_Global, saveDoc } from '../sqliteService.js';

// Re-stamp a child header onto its parent's timestamps (backfill creates
// present-day records for old payments; without this the children sort and
// filter as "today"). Details are untouched — only header timestamps move.
// Returns true when a write happened.
export async function alignChildToParent(child, { created_at, modified_at, actor } = {}) {
    if (!child || !child.id || !created_at) return false;
    const sameCreated = String(child.created_at || '') === String(created_at);
    const wantModified = modified_at || created_at;
    const sameModified = String(child.modified_at || '') === String(wantModified);
    if (sameCreated && sameModified) return false;
    const { details, loans, ...header } = child;
    await saveDoc('remittance', {
        ...header,
        created_at,
        modified_at: wantModified,
        modified_by: actor || child.modified_by || child.created_by || 'system',
        is_synced: 0
    });
    child.created_at = created_at;
    child.modified_at = wantModified;
    return true;
}

// Collision-safe child id (addRemittance/saveDoc upserts by id, so never reuse).
export async function freeChildId(baseId) {
    let id = baseId;
    let n = 1;
    while (await getDocById_Global('remittance', id).catch(() => null)) {
        n++;
        id = `${baseId}-FIX-${n}`;
        if (n > 50) id = `${baseId}-FIX-${Date.now()}-${n}`;
        if (n > 60) break;
    }
    return id;
}

// Group +ve charge items by enterprise: { entId: { amount, name } }.
export function duesTotalsByEnt(duesItems) {
    const out = {};
    for (const it of duesItems || []) {
        const x = Math.abs(parseFloat(it.amount || 0));
        if (!(x > 0)) continue;
        const eid = String(it.enterprise_id || it.item || '');
        if (!eid) continue;
        if (!out[eid]) out[eid] = { amount: 0, name: it.name || it.notes || eid };
        out[eid].amount += x;
        if (!out[eid].name && (it.name || it.notes)) out[eid].name = it.name || it.notes;
    }
    return out;
}

export function sumDuesTotals(totalsByEnt) {
    return Object.values(totalsByEnt).reduce((s, v) => s + (v.amount || 0), 0);
}

// Build the transfer detail lines. savingsLines are +ve parent distribution
// lines (NOT on due/penalty enterprises), in distribution order. The -side
// peels across them in order; the +side is one line per due enterprise.
// Throws when savings can't cover the dues (live flows reject the remittance).
// Backfill may pass allowShortfall to book the remainder onto the first
// savings line instead (legacy data predates the guard).
export function buildTransferDetails({ savingsLines, duesItems, allowShortfall = false, cooperativeId }) {
    const totalsByEnt = duesTotalsByEnt(duesItems);
    const total = sumDuesTotals(totalsByEnt);
    if (!(total > 0)) return { details: [], total: 0 };
    const lines = (savingsLines || [])
        .map(l => ({ enterprise_id: String(l.enterprise_id || l.item || ''), amount: Math.abs(parseFloat(l.amount || 0)) }))
        .filter(l => l.enterprise_id && l.amount > 0);
    const savingsTotal = lines.reduce((s, l) => s + l.amount, 0);
    if (total > savingsTotal + 1e-9 && !allowShortfall) {
        throw new Error(
            `Dues & penalties (₦${total.toLocaleString()}) exceed savings in this payment (₦${savingsTotal.toLocaleString()}). Reduce the charges or increase the payment.`
        );
    }
    const details = [];
    let remaining = total;
    for (const l of lines) {
        if (remaining <= 1e-9) break;
        const take = Math.min(l.amount, remaining);
        if (take <= 0) continue;
        details.push({
            id: generateId(String(cooperativeId)),
            enterprise_id: l.enterprise_id,
            amount: -take,
            notes: 'Transfer to dues & penalties'
        });
        remaining -= take;
    }
    if (remaining > 1e-9) {
        if (!allowShortfall || lines.length === 0) {
            throw new Error(
                `Dues & penalties (₦${total.toLocaleString()}) exceed savings in this payment (₦${savingsTotal.toLocaleString()}). Reduce the charges or increase the payment.`
            );
        }
        details.push({
            id: generateId(String(cooperativeId)),
            enterprise_id: lines[0].enterprise_id,
            amount: -remaining,
            notes: 'Transfer to dues & penalties (shortfall)'
        });
    }
    for (const [eid, v] of Object.entries(totalsByEnt)) {
        details.push({
            id: generateId(String(cooperativeId)),
            enterprise_id: eid,
            amount: v.amount,
            notes: `Funded from savings (${v.name || eid})`
        });
    }
    return { details, total };
}

// Per-enterprise member debits (Child A). Returns { count, total, ids }.
// Pass parentCreatedAt/parentModifiedAt (backfill) to stamp newborns with the
// parent's timestamps instead of "now".
export async function createDueDebitChildren({ cooperativeId, parentId, memberId, date, status, actor, role, duesItems, parentCreatedAt, parentModifiedAt }) {
    let idx = 0, total = 0;
    const ids = [];
    for (const it of duesItems || []) {
        const x = Math.abs(parseFloat(it.amount || 0));
        if (!(x > 0)) continue;
        idx++;
        total += x;
        const neg = -x;
        const id = await freeChildId(`${String(parentId)}-DUE-${String(idx).padStart(2, '0')}`);
        await addRemittance({
            id,
            cooperative_id: String(cooperativeId),
            member_id: memberId,
            amount: neg,
            remittance_date: date,
            bank_name: 'Internal Transfer',
            transaction_type: 'Internal Transfer',
            description: `Auto Internal Charges (${it.name || it.enterprise_id})`,
            autogen: 1,
            loan_id: String(parentId),
            parent_remittance_id: String(parentId),
            status,
            user_role: role || 'admin',
            user_roles: [role || 'admin'],
            details: [{
                id: generateId(String(cooperativeId)),
                enterprise_id: it.enterprise_id,
                amount: neg,
                notes: it.name || it.enterprise_id
            }]
        }, actor);
        ids.push(id);
        if (parentCreatedAt) {
            const hdr = await getDocById_Global('remittance', id).catch(() => null);
            if (hdr) await alignChildToParent(hdr, { created_at: parentCreatedAt, modified_at: parentModifiedAt, actor });
        }
    }
    return { count: idx, total, ids };
}

// Admin pickup (Child B): header-only, Detail = none. One pickup per
// due/penalty enterprise. Transaction type is the enterprise name
// (dynamic per cooperative); classification is "Operating Income"
// when the enterprise is marked revenue, else "Member Liability".
// Returns array of ids or empty array.
export async function createDuesIncomePickup({ cooperativeId, parentId, duesItems, enterpriseData, memberName, date, status, actor, role, parentCreatedAt, parentModifiedAt }) {
    if (!duesItems || duesItems.length === 0) return [];
    const totalsByEnt = duesTotalsByEnt(duesItems);
    const ids = [];
    for (const [eid, v] of Object.entries(totalsByEnt)) {
        const ent = (enterpriseData || []).find(e => String(e.id) === String(eid));
        const entName = ent?.account_name || eid;
        const isRevenue = !!ent?.revenue;
        const classification = isRevenue ? 'Operating Income' : 'Member Liability';
        const id = await freeChildId(`${String(parentId)}-INCOME`);
        await addRemittance({
            id,
            cooperative_id: String(cooperativeId),
            member_id: '0000000000',
            amount: v.amount,
            remittance_date: date,
            bank_name: 'Internal Transfer',
            transaction_type: entName,
            category: classification,
            description: `Auto ${entName} (Dues & Penalties) - ${memberName || ''}`.trim(),
            autogen: 1,
            loan_id: String(parentId),
            parent_remittance_id: String(parentId),
            status,
            user_role: role || 'admin',
            user_roles: [role || 'admin']
        }, actor);
        ids.push(id);
        if (parentCreatedAt) {
            const hdr = await getDocById_Global('remittance', id).catch(() => null);
            if (hdr) await alignChildToParent(hdr, { created_at: parentCreatedAt, modified_at: parentModifiedAt, actor });
        }
    }
    return ids;
}

// The settlement transfer (Child C): header 0, -side peeled from the parent's
// savings lines, +side split per due enterprise. Returns { id, total }.
export async function createDuesTransfer({ cooperativeId, parentId, memberId, memberName, date, status, actor, role, savingsLines, duesItems, allowShortfall = false, parentCreatedAt, parentModifiedAt }) {
    const { details, total } = buildTransferDetails({ savingsLines, duesItems, allowShortfall });
    if (!(total > 0) || details.length === 0) return { id: null, total: 0 };
    const id = await freeChildId(`${String(parentId)}-TR-01`);
    await addRemittance({
        id,
        cooperative_id: String(cooperativeId),
        member_id: memberId,
        amount: 0,
        remittance_date: date,
        bank_name: 'Internal Transfer',
        transaction_type: 'Internal Transfer',
        description: `Auto Dues Transfer (Savings \u2192 Dues & Penalties) - ${memberName || ''}`.trim(),
        autogen: 1,
        loan_id: String(parentId),
        parent_remittance_id: String(parentId),
        status,
        user_role: role || 'admin',
        user_roles: [role || 'admin'],
        details
    }, actor);
    if (parentCreatedAt) {
        const hdr = await getDocById_Global('remittance', id).catch(() => null);
        if (hdr) await alignChildToParent(hdr, { created_at: parentCreatedAt, modified_at: parentModifiedAt, actor });
    }
    return { id, total };
}

// All-or-nothing funding source for a standalone due/penalty charge: the FULL
// amount must land on exactly one account (no progressive peeling).
//   1. the wizard-selected savings account, only if opening >= amount
//   2. else the first OTHER savings account funded enough (list order)
//   3. else the first chargeable loan account (never needs funding: loan
//      balances are <= 0, so the debit just increases the debt)
// Returns { enterprise_id, kind: 'savings'|'loan' } or null when no source exists.
export function resolveDueFunding({ selectedEntId, amount, openings, savingsEnts, loanEnts }) {
    const X = Math.abs(parseFloat(amount || 0));
    if (!(X > 0)) return null;
    const funded = (entId) => parseFloat((openings || {})[entId] || 0) >= X - 1e-9;
    if (selectedEntId && funded(selectedEntId)) {
        return { enterprise_id: String(selectedEntId), kind: 'savings' };
    }
    const nextFunded = (savingsEnts || [])
        .map(e => String(e.id))
        .find(id => id !== String(selectedEntId) && funded(id));
    if (nextFunded) return { enterprise_id: nextFunded, kind: 'savings' };
    if (loanEnts && loanEnts.length) return { enterprise_id: String(loanEnts[0].id), kind: 'loan' };
    return null;
}

// Standalone due/penalty funding transfer (Child D for the bulk due/penalty
// branch): header 0, -side (full amount) on the resolved funding account
// (savings or loan), +side on the charge enterprise so the member's
// due/penalty balance nets back to zero. Plain detail lines only — never
// spawns a loan record or extra charges. Same family conventions as the other
// autogen children (autogen=1, loan_id=parent id, Internal Transfer) so
// approve/decline/delete/reverse cascades follow the parent.
export async function createDueFundingTransfer({ cooperativeId, parentId, memberId, memberName, date, status, actor, role, fundingEntId, fundingKind, amount, chargeEntId, chargeEntName, parentCreatedAt, parentModifiedAt }) {
    const X = Math.abs(parseFloat(amount || 0));
    if (!(X > 0)) return { id: null, total: 0 };
    const id = await freeChildId(`${String(parentId)}-TR-01`);
    const isLoan = fundingKind === 'loan';
    const sourceLabel = isLoan ? 'loan' : 'savings';
    const details = [
        {
            id: generateId(String(cooperativeId)),
            enterprise_id: String(fundingEntId),
            amount: -X,
            notes: isLoan ? 'Dues & penalties funded from loan' : 'Transfer to dues & penalties'
        },
        {
            id: generateId(String(cooperativeId)),
            enterprise_id: String(chargeEntId),
            amount: X,
            notes: `Funded from ${sourceLabel} (${chargeEntName || ''})`
        }
    ];
    await addRemittance({
        id,
        cooperative_id: String(cooperativeId),
        member_id: memberId,
        amount: 0,
        remittance_date: date,
        bank_name: 'Internal Transfer',
        transaction_type: 'Internal Transfer',
        description: `Auto Dues Transfer (${isLoan ? 'Loan' : 'Savings'} \u2192 Dues & Penalties) - ${memberName || ''}`.trim(),
        autogen: 1,
        loan_id: String(parentId),
        status,
        user_role: role || 'admin',
        user_roles: [role || 'admin'],
        details
    }, actor);
    if (parentCreatedAt) {
        const hdr = await getDocById_Global('remittance', id).catch(() => null);
        if (hdr) await alignChildToParent(hdr, { created_at: parentCreatedAt, modified_at: parentModifiedAt, actor });
    }
    return { id, total: X };
}
